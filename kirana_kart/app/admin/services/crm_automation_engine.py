"""
app/admin/services/crm_automation_engine.py
===========================================
Cardinal-aware CRM Automation Rules Engine.

Evaluates trigger-based rules against hitl_queue items and applies
configurable actions (assign to group, change priority, add tag, etc.).

Triggers:
  TICKET_CREATED  — called immediately after enqueue_ticket()
  TICKET_UPDATED  — called after take_action()
  SLA_WARNING     — called by Celery Beat for tickets approaching SLA
  SLA_BREACHED    — called by Celery Beat for tickets past SLA

Cardinal signal fields available as rule conditions:
  ai_action_code, ai_confidence, ai_fraud_segment,
  ai_refund_amount, automation_pathway, queue_type,
  status, priority, customer_segment
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import text

from app.admin.db import get_db_session

logger = logging.getLogger("kirana_kart.crm.automation")

# ---------------------------------------------------------------------------
# Condition field → hitl_queue column mapping
# ---------------------------------------------------------------------------

CONDITION_FIELDS: dict[str, str] = {
    "queue_type":           "queue_type",
    "status":               "status",
    "priority":             "priority",
    "customer_segment":     "customer_segment",
    "ai_action_code":       "ai_action_code",
    "ai_confidence":        "ai_confidence",
    "ai_fraud_segment":     "ai_fraud_segment",
    "ai_refund_amount":     "ai_refund_amount",
    "automation_pathway":   "automation_pathway",
    # Computed time-based fields (not DB columns; computed at eval time)
    "hours_since_created":  "__computed__",
    "hours_since_updated":  "__computed__",
}

CONDITION_FIELD_LABELS: dict[str, str] = {
    "queue_type":           "Queue Type",
    "status":               "Status",
    "priority":             "Priority",
    "customer_segment":     "Customer Segment",
    "ai_action_code":       "AI Action Code",
    "ai_confidence":        "AI Confidence",
    "ai_fraud_segment":     "Fraud Segment",
    "ai_refund_amount":     "AI Refund Amount",
    "automation_pathway":   "Automation Pathway",
    "hours_since_created":  "Hours Since Created",
    "hours_since_updated":  "Hours Since Last Update",
}

OPERATORS = ["eq", "ne", "gt", "lt", "gte", "lte", "contains", "in"]

ACTION_TYPES = [
    "assign_to_group",
    "assign_to_agent",
    "change_priority",
    "change_queue_type",
    "add_tag",
    "change_status",
    "send_notification",
    "escalate",
]

# ---------------------------------------------------------------------------
# Cardinal pre-seeded rules
# ---------------------------------------------------------------------------

CARDINAL_SEED_RULES = [
    {
        "name": "Auto-route confirmed fraud to Fraud Review",
        "description": "Cardinal VERY_HIGH fraud segment → Fraud Review group with Critical priority",
        "trigger_event": "TICKET_CREATED",
        "condition_logic": "OR",
        "conditions": [
            {"field": "ai_fraud_segment", "operator": "eq", "value": "VERY_HIGH"},
        ],
        "actions": [
            {"action_type": "change_priority", "params": {"priority": 1}},
            {"action_type": "change_queue_type", "params": {"queue_type": "ESCALATION_QUEUE"}},
            {"action_type": "add_tag", "params": {"tag_name": "confirmed-fraud", "tag_color": "#DC2626"}},
        ],
        "priority": 10,
    },
    {
        "name": "Flag suspicious high-refund cases",
        "description": "Cardinal HIGH fraud + refund ≥ ₹500 → Senior Review with High priority",
        "trigger_event": "TICKET_CREATED",
        "condition_logic": "AND",
        "conditions": [
            {"field": "ai_fraud_segment", "operator": "eq", "value": "HIGH"},
            {"field": "ai_refund_amount", "operator": "gte", "value": "500"},
        ],
        "actions": [
            {"action_type": "change_priority", "params": {"priority": 2}},
            {"action_type": "change_queue_type", "params": {"queue_type": "SENIOR_REVIEW"}},
            {"action_type": "add_tag", "params": {"tag_name": "fraud-review", "tag_color": "#F59E0B"}},
        ],
        "priority": 20,
    },
    {
        "name": "Escalate low-confidence Cardinal decisions",
        "description": "AI confidence < 0.45 means Cardinal is uncertain → Senior Review",
        "trigger_event": "TICKET_CREATED",
        "condition_logic": "AND",
        "conditions": [
            {"field": "ai_confidence", "operator": "lt", "value": "0.45"},
        ],
        "actions": [
            {"action_type": "change_priority", "params": {"priority": 2}},
            {"action_type": "change_queue_type", "params": {"queue_type": "SENIOR_REVIEW"}},
            {"action_type": "add_tag", "params": {"tag_name": "low-confidence", "tag_color": "#8B5CF6"}},
        ],
        "priority": 30,
    },
    {
        "name": "Auto-escalate SLA-breached tickets",
        "description": "When SLA is breached and ticket is not already in Escalation queue → move up",
        "trigger_event": "SLA_BREACHED",
        "condition_logic": "AND",
        "conditions": [
            {"field": "queue_type", "operator": "ne", "value": "ESCALATION_QUEUE"},
            {"field": "status", "operator": "ne", "value": "RESOLVED"},
            {"field": "status", "operator": "ne", "value": "CLOSED"},
        ],
        "actions": [
            {"action_type": "change_queue_type", "params": {"queue_type": "SLA_BREACH_REVIEW"}},
            {"action_type": "change_priority", "params": {"priority": 2}},
        ],
        "priority": 40,
    },
    {
        "name": "Tag refund-related tickets",
        "description": "Cardinal action code contains REFUND → add 'refund-case' tag for easy filtering",
        "trigger_event": "TICKET_CREATED",
        "condition_logic": "AND",
        "conditions": [
            {"field": "ai_action_code", "operator": "contains", "value": "REFUND"},
        ],
        "actions": [
            {"action_type": "add_tag", "params": {"tag_name": "refund-case", "tag_color": "#059669"}},
        ],
        "priority": 50,
    },
]


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

def _coerce(value: Any, target: Any) -> Any:
    """Try to cast value to the type of target for numeric comparisons."""
    try:
        if isinstance(target, float) or (isinstance(target, str) and "." in str(target)):
            return float(value)
        if isinstance(target, int) or (isinstance(target, str) and str(target).lstrip("-").isdigit()):
            return float(value)  # use float for all numeric to avoid int/float mismatch
    except (TypeError, ValueError):
        pass
    return str(value) if value is not None else ""


def _matches_condition(condition: dict, queue_item: dict) -> bool:
    from datetime import datetime, timezone as _tz
    field = condition.get("field")
    operator = condition.get("operator")
    expected = condition.get("value")

    if field not in CONDITION_FIELDS:
        return False

    # Computed time fields
    if field == "hours_since_created":
        created = queue_item.get("created_at")
        if created is None:
            return False
        if isinstance(created, str):
            from datetime import datetime
            try:
                created = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except ValueError:
                return False
        now = datetime.now(_tz.utc)
        if created.tzinfo is None:
            created = created.replace(tzinfo=_tz.utc)
        actual = (now - created).total_seconds() / 3600.0
    elif field == "hours_since_updated":
        updated = queue_item.get("updated_at")
        if updated is None:
            return False
        if isinstance(updated, str):
            try:
                updated = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            except ValueError:
                return False
        now = datetime.now(_tz.utc)
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=_tz.utc)
        actual = (now - updated).total_seconds() / 3600.0
    else:
        actual = queue_item.get(field)
    if actual is None:
        # None only matches "eq None" (not typically used)
        return operator == "eq" and (expected is None or expected == "")

    actual_str = str(actual).upper() if isinstance(actual, str) else actual
    expected_str = str(expected).upper() if isinstance(expected, str) else str(expected)

    if operator == "eq":
        return str(actual).upper() == expected_str
    if operator == "ne":
        return str(actual).upper() != expected_str
    if operator == "contains":
        return expected_str in str(actual).upper()
    if operator == "in":
        # expected is comma-separated list
        vals = [v.strip().upper() for v in str(expected).split(",")]
        return str(actual).upper() in vals
    # Numeric operators
    try:
        a_num = float(actual)
        e_num = float(expected)
        if operator == "gt":  return a_num > e_num
        if operator == "lt":  return a_num < e_num
        if operator == "gte": return a_num >= e_num
        if operator == "lte": return a_num <= e_num
    except (TypeError, ValueError):
        pass
    return False


def _evaluate_conditions(conditions: list[dict], logic: str, queue_item: dict) -> bool:
    if not conditions:
        return True
    results = [_matches_condition(c, queue_item) for c in conditions]
    if logic == "OR":
        return any(results)
    return all(results)  # AND (default)


# ---------------------------------------------------------------------------
# Action execution
# ---------------------------------------------------------------------------

def _apply_action(action: dict, queue_id: int, ticket_id: int, session) -> None:
    action_type = action.get("action_type")
    params = action.get("params", {})
    system_actor = 1  # system user ID for audit log

    try:
        if action_type == "change_priority":
            priority = int(params.get("priority", 3))
            if priority not in (1, 2, 3, 4):
                return
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET priority = :p, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"p": priority, "qid": queue_id},
            )
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_agent_actions
                        (ticket_id, queue_id, actor_id, action_type, before_value, after_value, reason)
                    VALUES
                        (:tid, :qid, :actor, 'CHANGE_PRIORITY', NULL,
                         CAST(:after AS jsonb), 'Automation rule')
                """),
                {
                    "tid": ticket_id, "qid": queue_id, "actor": system_actor,
                    "after": json.dumps({"priority": priority}),
                },
            )

        elif action_type == "change_queue_type":
            qt = params.get("queue_type", "STANDARD_REVIEW")
            valid = {"STANDARD_REVIEW", "SENIOR_REVIEW", "SLA_BREACH_REVIEW", "ESCALATION_QUEUE", "MANUAL_REVIEW"}
            if qt not in valid:
                return
            # Recalculate SLA for new queue type
            sla_minutes = _get_sla_minutes(qt, session)
            fr_minutes  = _get_fr_minutes(qt, session)
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET queue_type    = :qt,
                        sla_due_at    = NOW() + make_interval(mins => :sla_min),
                        first_response_due_at = NOW() + make_interval(mins => :fr_min),
                        updated_at    = NOW()
                    WHERE id = :qid
                """),
                {"qt": qt, "sla_min": sla_minutes, "fr_min": fr_minutes, "qid": queue_id},
            )
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_agent_actions
                        (ticket_id, queue_id, actor_id, action_type, after_value, reason)
                    VALUES (:tid, :qid, :actor, 'CHANGE_QUEUE', CAST(:after AS jsonb), 'Automation rule')
                """),
                {
                    "tid": ticket_id, "qid": queue_id, "actor": system_actor,
                    "after": json.dumps({"queue_type": qt}),
                },
            )

        elif action_type == "change_status":
            status = params.get("status", "OPEN")
            valid_s = {"OPEN", "IN_PROGRESS", "PENDING_CUSTOMER", "ESCALATED", "RESOLVED", "CLOSED"}
            if status not in valid_s:
                return
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET status = :s, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"s": status, "qid": queue_id},
            )

        elif action_type == "assign_to_group":
            group_id = params.get("group_id")
            if not group_id:
                return
            # Check group exists and is active
            grp = session.execute(
                text("SELECT id, routing_strategy FROM kirana_kart.crm_groups WHERE id = :gid AND is_active = TRUE"),
                {"gid": group_id},
            ).fetchone()
            if not grp:
                return
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET group_id = :gid, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"gid": group_id, "qid": queue_id},
            )
            # Auto-dispatch if strategy is ROUND_ROBIN or LEAST_BUSY
            if grp.routing_strategy in ("ROUND_ROBIN", "LEAST_BUSY"):
                _auto_dispatch_to_group(group_id, queue_id, ticket_id, grp.routing_strategy, session)

        elif action_type == "assign_to_agent":
            agent_id = params.get("agent_id")
            if not agent_id:
                return
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET assigned_to = :aid, assigned_at = NOW(),
                        auto_assigned = TRUE, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"aid": agent_id, "qid": queue_id},
            )
            # Notify agent
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_notifications
                        (recipient_id, ticket_id, queue_id, type, title, body)
                    VALUES (:rid, :tid, :qid, 'ASSIGNED',
                            'Ticket auto-assigned to you',
                            'An automation rule assigned this ticket to you.')
                """),
                {"rid": agent_id, "tid": ticket_id, "qid": queue_id},
            )

        elif action_type == "add_tag":
            tag_name  = params.get("tag_name", "").strip()
            tag_color = params.get("tag_color", "#6B7280")
            if not tag_name:
                return
            # Upsert tag
            tag_row = session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_tags (name, color)
                    VALUES (:name, :color)
                    ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
                    RETURNING id
                """),
                {"name": tag_name, "color": tag_color},
            ).fetchone()
            if tag_row:
                session.execute(
                    text("""
                        INSERT INTO kirana_kart.crm_ticket_tags (ticket_id, tag_id)
                        VALUES (:tid, :tag_id)
                        ON CONFLICT DO NOTHING
                    """),
                    {"tid": ticket_id, "tag_id": tag_row.id},
                )

        elif action_type == "send_notification":
            message = params.get("message", "Automation rule triggered")
            # Notify all admins (system-level notification)
            admins = session.execute(
                text("""
                    SELECT u.id FROM kirana_kart.users u
                    JOIN kirana_kart.user_permissions p ON p.user_id = u.id
                    WHERE p.module_name = 'crm' AND p.can_admin = TRUE AND u.is_active = TRUE
                """)
            ).fetchall()
            for admin in admins:
                session.execute(
                    text("""
                        INSERT INTO kirana_kart.crm_notifications
                            (recipient_id, ticket_id, queue_id, type, title, body)
                        VALUES (:rid, :tid, :qid, 'STATUS_CHANGED', 'Automation Rule Fired', :body)
                    """),
                    {"rid": admin.id, "tid": ticket_id, "qid": queue_id, "body": message},
                )

        elif action_type == "escalate":
            reason = params.get("reason", "Automation rule escalation")
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET status        = 'ESCALATED',
                        queue_type    = 'ESCALATION_QUEUE',
                        escalation_reason = :reason,
                        updated_at    = NOW()
                    WHERE id = :qid
                """),
                {"reason": reason, "qid": queue_id},
            )
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_agent_actions
                        (ticket_id, queue_id, actor_id, action_type, reason)
                    VALUES (:tid, :qid, :actor, 'ESCALATE', :reason)
                """),
                {"tid": ticket_id, "qid": queue_id, "actor": system_actor, "reason": reason},
            )

    except Exception as exc:
        logger.warning("Automation action %s failed for queue_id=%s: %s", action_type, queue_id, exc)


def _auto_dispatch_to_group(
    group_id: int, queue_id: int, ticket_id: int, strategy: str, session
) -> None:
    """Pick the best online group member and assign the ticket."""
    if strategy == "ROUND_ROBIN":
        agent = session.execute(
            text("""
                SELECT m.user_id
                FROM kirana_kart.crm_group_members m
                JOIN kirana_kart.users u ON u.id = m.user_id
                WHERE m.group_id = :gid
                  AND u.crm_availability = 'ONLINE'
                  AND u.is_active = TRUE
                ORDER BY (
                    SELECT MAX(hq.assigned_at)
                    FROM kirana_kart.hitl_queue hq
                    WHERE hq.assigned_to = m.user_id
                ) ASC NULLS FIRST
                LIMIT 1
            """),
            {"gid": group_id},
        ).fetchone()
    else:  # LEAST_BUSY
        agent = session.execute(
            text("""
                SELECT m.user_id,
                       COUNT(hq.id) AS open_count
                FROM kirana_kart.crm_group_members m
                JOIN kirana_kart.users u ON u.id = m.user_id
                LEFT JOIN kirana_kart.hitl_queue hq
                    ON hq.assigned_to = m.user_id
                    AND hq.status IN ('OPEN','IN_PROGRESS')
                WHERE m.group_id = :gid
                  AND u.crm_availability = 'ONLINE'
                  AND u.is_active = TRUE
                GROUP BY m.user_id
                ORDER BY COUNT(hq.id) ASC
                LIMIT 1
            """),
            {"gid": group_id},
        ).fetchone()

    if agent:
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET assigned_to = :aid, assigned_at = NOW(),
                    auto_assigned = TRUE, updated_at = NOW()
                WHERE id = :qid
            """),
            {"aid": agent.user_id, "qid": queue_id},
        )
        session.execute(
            text("""
                INSERT INTO kirana_kart.crm_notifications
                    (recipient_id, ticket_id, queue_id, type, title, body)
                VALUES (:rid, :tid, :qid, 'ASSIGNED',
                        'Ticket auto-assigned to you',
                        'Auto-dispatched via group routing.')
            """),
            {"rid": agent.user_id, "tid": ticket_id, "qid": queue_id},
        )


# ---------------------------------------------------------------------------
# SLA helpers (reads from DB, falls back to hardcoded)
# ---------------------------------------------------------------------------

_SLA_FALLBACK = {
    "ESCALATION_QUEUE": 60, "SLA_BREACH_REVIEW": 120,
    "SENIOR_REVIEW": 240, "MANUAL_REVIEW": 240, "STANDARD_REVIEW": 480,
}
_FR_FALLBACK = {
    "ESCALATION_QUEUE": 15, "SLA_BREACH_REVIEW": 20,
    "SENIOR_REVIEW": 30, "MANUAL_REVIEW": 30, "STANDARD_REVIEW": 60,
}


def _get_sla_minutes(queue_type: str, session) -> int:
    try:
        row = session.execute(
            text("""
                SELECT resolution_minutes FROM kirana_kart.crm_sla_policies
                WHERE queue_type = :qt AND is_active = TRUE
            """),
            {"qt": queue_type},
        ).fetchone()
        return row.resolution_minutes if row else _SLA_FALLBACK.get(queue_type, 480)
    except Exception:
        return _SLA_FALLBACK.get(queue_type, 480)


def _get_fr_minutes(queue_type: str, session) -> int:
    try:
        row = session.execute(
            text("""
                SELECT first_response_minutes FROM kirana_kart.crm_sla_policies
                WHERE queue_type = :qt AND is_active = TRUE
            """),
            {"qt": queue_type},
        ).fetchone()
        return row.first_response_minutes if row else _FR_FALLBACK.get(queue_type, 60)
    except Exception:
        return _FR_FALLBACK.get(queue_type, 60)


# ---------------------------------------------------------------------------
# Main engine entry point
# ---------------------------------------------------------------------------

def run_for_ticket(trigger: str, queue_id: int) -> int:
    """
    Fetch queue item, evaluate all active rules for the trigger,
    apply matched rules in priority order. Returns count of rules applied.
    """
    try:
        with get_db_session() as session:
            # Fetch queue item as dict
            row = session.execute(
                text("""
                    SELECT hq.id, hq.ticket_id, hq.queue_type, hq.status, hq.priority,
                           hq.customer_segment, hq.ai_action_code, hq.ai_confidence,
                           hq.ai_fraud_segment, hq.ai_refund_amount, hq.automation_pathway,
                           hq.created_at, hq.updated_at
                    FROM kirana_kart.hitl_queue hq
                    WHERE hq.id = :qid
                """),
                {"qid": queue_id},
            ).fetchone()
            if not row:
                return 0

            queue_item = dict(row._mapping)

            # Load active rules for this trigger, ordered by priority
            rules = session.execute(
                text("""
                    SELECT id, name, condition_logic, conditions, actions
                    FROM kirana_kart.crm_automation_rules
                    WHERE trigger_event = :trigger AND is_active = TRUE
                    ORDER BY priority ASC, id ASC
                """),
                {"trigger": trigger},
            ).fetchall()

            applied = 0
            for rule in rules:
                conditions = rule.conditions if isinstance(rule.conditions, list) else json.loads(rule.conditions or "[]")
                actions    = rule.actions    if isinstance(rule.actions, list)    else json.loads(rule.actions or "[]")
                logic      = rule.condition_logic or "AND"

                if _evaluate_conditions(conditions, logic, queue_item):
                    for action in actions:
                        _apply_action(action, queue_id, queue_item["ticket_id"], session)
                    applied += 1
                    # Update run stats
                    session.execute(
                        text("""
                            UPDATE kirana_kart.crm_automation_rules
                            SET run_count  = run_count + 1,
                                last_run_at = NOW()
                            WHERE id = :rid
                        """),
                        {"rid": rule.id},
                    )
                    logger.info(
                        "Automation rule '%s' applied to queue_id=%s (trigger=%s)",
                        rule.name, queue_id, trigger,
                    )

            return applied

    except Exception as exc:
        logger.error("Automation engine error for queue_id=%s trigger=%s: %s", queue_id, trigger, exc)
        return 0


def run_sla_checks() -> dict[str, int]:
    """
    Called by Celery Beat every 5 minutes.
    Fires SLA_WARNING (15 min before breach) and SLA_BREACHED triggers.
    """
    warned = 0
    breached = 0
    try:
        with get_db_session() as session:
            # SLA_BREACHED: past due, not yet notified, not resolved/closed
            breached_rows = session.execute(
                text("""
                    SELECT id FROM kirana_kart.hitl_queue
                    WHERE sla_due_at < NOW()
                      AND sla_breach_notified = FALSE
                      AND status NOT IN ('RESOLVED','CLOSED')
                """)
            ).fetchall()

            for r in breached_rows:
                session.execute(
                    text("""
                        UPDATE kirana_kart.hitl_queue
                        SET sla_breached = TRUE,
                            sla_breach_notified = TRUE,
                            updated_at = NOW()
                        WHERE id = :qid
                    """),
                    {"qid": r.id},
                )
                run_for_ticket("SLA_BREACHED", r.id)
                breached += 1

            # SLA_WARNING: 15 min before breach, not yet warned
            warning_rows = session.execute(
                text("""
                    SELECT id FROM kirana_kart.hitl_queue
                    WHERE sla_due_at BETWEEN NOW() AND NOW() + INTERVAL '15 minutes'
                      AND sla_breach_notified = FALSE
                      AND sla_breached = FALSE
                      AND status NOT IN ('RESOLVED','CLOSED')
                """)
            ).fetchall()

            for r in warning_rows:
                run_for_ticket("SLA_WARNING", r.id)
                warned += 1

    except Exception as exc:
        logger.error("run_sla_checks failed: %s", exc)

    if warned or breached:
        logger.info("SLA checks: %d warned, %d breached", warned, breached)
    return {"warned": warned, "breached": breached}


# ---------------------------------------------------------------------------
# Preview (dry-run)
# ---------------------------------------------------------------------------

def preview_rule(conditions: list[dict], logic: str, trigger: str, limit: int = 20) -> list[dict]:
    """
    Return matching open queue items without applying any actions.
    Used by the automation UI 'Preview' button.
    """
    try:
        with get_db_session() as session:
            rows = session.execute(
                text("""
                    SELECT hq.id AS queue_id, hq.ticket_id, hq.queue_type, hq.status,
                           hq.priority, hq.customer_segment, hq.ai_action_code,
                           hq.ai_confidence, hq.ai_fraud_segment, hq.ai_refund_amount,
                           hq.automation_pathway, hq.subject, hq.cx_email
                    FROM kirana_kart.hitl_queue hq
                    WHERE hq.status NOT IN ('RESOLVED','CLOSED')
                    ORDER BY hq.created_at DESC
                    LIMIT 200
                """)
            ).fetchall()

            matches = []
            for row in rows:
                item = dict(row._mapping)
                if _evaluate_conditions(conditions, logic, item):
                    matches.append({
                        "queue_id":      item["queue_id"],
                        "ticket_id":     item["ticket_id"],
                        "subject":       item.get("subject"),
                        "cx_email":      item.get("cx_email"),
                        "queue_type":    item.get("queue_type"),
                        "status":        item.get("status"),
                        "priority":      item.get("priority"),
                        "ai_action_code": item.get("ai_action_code"),
                        "ai_fraud_segment": item.get("ai_fraud_segment"),
                        "ai_confidence": item.get("ai_confidence"),
                    })
                    if len(matches) >= limit:
                        break
            return matches
    except Exception as exc:
        logger.error("preview_rule failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Seed Cardinal rules
# ---------------------------------------------------------------------------

def seed_cardinal_rules() -> None:
    """Insert the 5 pre-built Cardinal rules if not already seeded."""
    try:
        with get_db_session() as session:
            for rule in CARDINAL_SEED_RULES:
                existing = session.execute(
                    text("SELECT id FROM kirana_kart.crm_automation_rules WHERE name = :name"),
                    {"name": rule["name"]},
                ).fetchone()
                if existing:
                    continue
                conds_json   = json.dumps(rule["conditions"])
                actions_json = json.dumps(rule["actions"])
                session.execute(
                    text("""
                        INSERT INTO kirana_kart.crm_automation_rules
                            (name, description, trigger_event, condition_logic,
                             conditions, actions, is_active, priority, is_seeded)
                        VALUES
                            (:name, :desc, :trigger, :logic,
                             CAST(:conds AS jsonb), CAST(:actions AS jsonb),
                             TRUE, :priority, TRUE)
                    """),
                    {
                        "name":     rule["name"],
                        "desc":     rule["description"],
                        "trigger":  rule["trigger_event"],
                        "logic":    rule["condition_logic"],
                        "conds":    conds_json,
                        "actions":  actions_json,
                        "priority": rule["priority"],
                    },
                )
                logger.info("Seeded Cardinal automation rule: %s", rule["name"])
    except Exception as exc:
        logger.error("seed_cardinal_rules failed: %s", exc)


# ---------------------------------------------------------------------------
# Metadata helpers (for UI)
# ---------------------------------------------------------------------------

def get_condition_schema() -> dict:
    return {
        "fields": [
            {"key": k, "label": v} for k, v in CONDITION_FIELD_LABELS.items()
        ],
        "operators": [
            {"key": "eq",       "label": "equals"},
            {"key": "ne",       "label": "not equals"},
            {"key": "gt",       "label": "greater than"},
            {"key": "lt",       "label": "less than"},
            {"key": "gte",      "label": "≥"},
            {"key": "lte",      "label": "≤"},
            {"key": "contains", "label": "contains"},
            {"key": "in",       "label": "is one of (comma-separated)"},
        ],
        "action_types": [
            {"key": "assign_to_group",  "label": "Assign to Group"},
            {"key": "assign_to_agent",  "label": "Assign to Agent"},
            {"key": "change_priority",  "label": "Change Priority"},
            {"key": "change_queue_type","label": "Change Queue Type"},
            {"key": "add_tag",          "label": "Add Tag"},
            {"key": "change_status",    "label": "Change Status"},
            {"key": "send_notification","label": "Send Notification"},
            {"key": "escalate",         "label": "Escalate"},
        ],
        "triggers": [
            {"key": "TICKET_CREATED",  "label": "Ticket Created",                     "description": "Fires immediately when a new ticket enters the queue"},
            {"key": "TICKET_UPDATED",  "label": "Ticket Updated",                     "description": "Fires when any field on a ticket is changed by an agent"},
            {"key": "SLA_WARNING",     "label": "SLA Warning (15 min before breach)", "description": "Fires 15 minutes before the SLA deadline is hit"},
            {"key": "SLA_BREACHED",    "label": "SLA Breached",                       "description": "Fires when the SLA deadline is exceeded"},
            {"key": "TIME_BASED",      "label": "Time-Based (Periodic)",              "description": "Evaluated periodically; use hours_since_created / hours_since_updated conditions"},
        ],
        "time_fields": [
            {"key": "hours_since_created", "label": "Hours Since Created"},
            {"key": "hours_since_updated", "label": "Hours Since Last Update"},
        ],
    }


# ---------------------------------------------------------------------------
# TIME_BASED periodic runner (Celery Beat helper)
# ---------------------------------------------------------------------------

def run_time_based_rules() -> int:
    """
    Called by Celery Beat (every 15 min).
    Evaluates all active TIME_BASED rules against open/in-progress tickets.
    Returns total number of rule applications.
    """
    total_applied = 0
    try:
        with get_db_session() as session:
            # Fetch all open/in-progress queue IDs
            rows = session.execute(
                text("""
                    SELECT id FROM kirana_kart.hitl_queue
                    WHERE status NOT IN ('RESOLVED','CLOSED')
                    ORDER BY created_at ASC
                    LIMIT 500
                """)
            ).fetchall()

        for row in rows:
            n = run_for_ticket("TIME_BASED", row.id)
            total_applied += n

    except Exception as exc:
        logger.error("run_time_based_rules failed: %s", exc)

    if total_applied:
        logger.info("TIME_BASED rules: %d applications across open tickets", total_applied)
    return total_applied


# ---------------------------------------------------------------------------
# TICKET_UPDATED integration helper
# ---------------------------------------------------------------------------

def on_ticket_updated(queue_id: int) -> int:
    """
    Call this after any agent action mutates a ticket.
    Evaluates TICKET_UPDATED automation rules for the ticket.
    Non-fatal — errors are logged and swallowed.
    """
    try:
        return run_for_ticket("TICKET_UPDATED", queue_id)
    except Exception as exc:
        logger.warning("on_ticket_updated failed for queue_id=%s: %s", queue_id, exc)
        return 0
