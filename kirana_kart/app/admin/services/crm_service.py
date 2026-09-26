"""
app/admin/services/crm_service.py
==================================
Full Freshdesk-like CRM service layer for Kirana Kart.

Covers:
  - DDL creation (ensure_crm_tables)
  - Queue management (enqueue, list, detail)
  - Agent actions (approve/reject/modify AI rec, reply, escalate, resolve, etc.)
  - Notes, tags, watchers
  - Bulk operations
  - Notifications
  - Saved filter views
  - Agent + Admin dashboards
  - Reports
  - Auto-escalation (Celery Beat task helper)
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.services.auth_service import UserContext
from app.admin.services.email_service import send_email
from app.utils.customer_pii import reveal_customer

logger = logging.getLogger("kirana_kart.crm")

# ---------------------------------------------------------------------------
# SLA Configuration
# ---------------------------------------------------------------------------

SLA_RESOLUTION_MINUTES: dict[str, int] = {
    "ESCALATION_QUEUE": 60,
    "SLA_BREACH_REVIEW": 120,
    "SENIOR_REVIEW": 240,
    "MANUAL_REVIEW": 240,
    "STANDARD_REVIEW": 480,
}

SLA_FIRST_RESPONSE_MINUTES: dict[str, int] = {
    "ESCALATION_QUEUE": 15,
    "SLA_BREACH_REVIEW": 20,
    "SENIOR_REVIEW": 30,
    "MANUAL_REVIEW": 30,
    "STANDARD_REVIEW": 60,
}

VALID_STATUSES = {"OPEN", "IN_PROGRESS", "PENDING_CUSTOMER", "ESCALATED", "RESOLVED", "CLOSED"}
VALID_QUEUE_TYPES = {"STANDARD_REVIEW", "SENIOR_REVIEW", "SLA_BREACH_REVIEW", "ESCALATION_QUEUE", "MANUAL_REVIEW"}
VALID_PRIORITIES = {1, 2, 3, 4}
VALID_TICKET_TYPES = {"INCIDENT", "SERVICE_REQUEST", "QUESTION", "PROBLEM"}
VALID_NOTE_TYPES = {"INTERNAL", "CUSTOMER_REPLY", "ESCALATION", "SYSTEM"}
VALID_AVAILABILITY = {"ONLINE", "BUSY", "AWAY", "OFFLINE"}

# ---------------------------------------------------------------------------
# DDL
# ---------------------------------------------------------------------------


def ensure_crm_tables() -> None:
    """Create all 9 CRM tables + ALTER users. Fully idempotent (IF NOT EXISTS)."""
    ddl_statements = [
        # 1. hitl_queue — central work queue
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.hitl_queue (
            id                      SERIAL PRIMARY KEY,
            ticket_id               INTEGER NOT NULL UNIQUE
                                        REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            automation_pathway      VARCHAR(30) NOT NULL
                                        CHECK (automation_pathway IN ('HITL','MANUAL_REVIEW')),
            queue_type              VARCHAR(40) NOT NULL DEFAULT 'STANDARD_REVIEW'
                                        CHECK (queue_type IN (
                                            'STANDARD_REVIEW','SENIOR_REVIEW',
                                            'SLA_BREACH_REVIEW','ESCALATION_QUEUE','MANUAL_REVIEW')),
            status                  VARCHAR(30) NOT NULL DEFAULT 'OPEN'
                                        CHECK (status IN (
                                            'OPEN','IN_PROGRESS','PENDING_CUSTOMER',
                                            'ESCALATED','RESOLVED','CLOSED')),
            priority                SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
            ticket_type             VARCHAR(30) DEFAULT 'INCIDENT'
                                        CHECK (ticket_type IN ('INCIDENT','SERVICE_REQUEST','QUESTION','PROBLEM')),
            assigned_to             INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            assigned_at             TIMESTAMPTZ,
            sla_due_at              TIMESTAMPTZ NOT NULL,
            sla_breached            BOOLEAN NOT NULL DEFAULT FALSE,
            sla_breach_notified     BOOLEAN NOT NULL DEFAULT FALSE,
            first_response_due_at   TIMESTAMPTZ NOT NULL,
            first_response_at       TIMESTAMPTZ,
            first_response_breached BOOLEAN NOT NULL DEFAULT FALSE,
            ai_action_code          VARCHAR(50),
            ai_refund_amount        NUMERIC(12,2),
            ai_reasoning            TEXT,
            ai_confidence           NUMERIC(5,4),
            ai_discrepancy_details  TEXT,
            ai_fraud_segment        VARCHAR(30),
            final_action_code       VARCHAR(50),
            final_refund_amount     NUMERIC(12,2),
            resolution_note         TEXT,
            resolved_by             INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            resolved_at             TIMESTAMPTZ,
            customer_id             VARCHAR(50),
            order_id                VARCHAR(50),
            cx_email                VARCHAR(255),
            customer_segment        VARCHAR(20),
            subject                 TEXT,
            viewing_agent_id        INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            viewing_since           TIMESTAMPTZ,
            escalated_from          INTEGER REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL,
            escalation_reason       TEXT,
            auto_assigned           BOOLEAN NOT NULL DEFAULT FALSE,
            csat_requested_at       TIMESTAMPTZ,
            merged_into             INTEGER REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_hitl_status       ON kirana_kart.hitl_queue(status)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_queue_type   ON kirana_kart.hitl_queue(queue_type)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_assigned_to  ON kirana_kart.hitl_queue(assigned_to)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_sla_due      ON kirana_kart.hitl_queue(sla_due_at)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_customer_id  ON kirana_kart.hitl_queue(customer_id)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_created_at   ON kirana_kart.hitl_queue(created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_hitl_priority_sla ON kirana_kart.hitl_queue(priority ASC, sla_due_at ASC)",

        # 2. crm_notes
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_notes (
            id          SERIAL PRIMARY KEY,
            ticket_id   INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            queue_id    INTEGER REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL,
            author_id   INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            note_type   VARCHAR(20) NOT NULL DEFAULT 'INTERNAL'
                            CHECK (note_type IN ('INTERNAL','CUSTOMER_REPLY','ESCALATION','SYSTEM')),
            body        TEXT NOT NULL,
            is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_notes_ticket  ON kirana_kart.crm_notes(ticket_id)",
        "CREATE INDEX IF NOT EXISTS idx_crm_notes_queue   ON kirana_kart.crm_notes(queue_id)",
        "CREATE INDEX IF NOT EXISTS idx_crm_notes_created ON kirana_kart.crm_notes(created_at DESC)",

        # 3. crm_agent_actions (immutable audit log)
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_agent_actions (
            id                   SERIAL PRIMARY KEY,
            ticket_id            INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            queue_id             INTEGER REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL,
            actor_id             INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            action_type          VARCHAR(40) NOT NULL CHECK (action_type IN (
                                     'APPROVE_AI_REC','REJECT_AI_REC','MODIFY_REFUND',
                                     'ESCALATE','SELF_ASSIGN','REASSIGN','ADD_NOTE',
                                     'REPLY_CUSTOMER','RESOLVE','REOPEN','CLOSE',
                                     'CHANGE_PRIORITY','CHANGE_STATUS','CHANGE_TYPE',
                                     'CHANGE_QUEUE','ADD_TAG','REMOVE_TAG',
                                     'ADD_WATCHER','REMOVE_WATCHER','MERGE',
                                     'BULK_ASSIGN','BULK_ESCALATE','BULK_CLOSE','BULK_STATUS'
                                 )),
            before_value         JSONB,
            after_value          JSONB,
            reason               TEXT,
            refund_amount_before NUMERIC(12,2),
            refund_amount_after  NUMERIC(12,2),
            created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_actions_ticket  ON kirana_kart.crm_agent_actions(ticket_id)",
        "CREATE INDEX IF NOT EXISTS idx_crm_actions_actor   ON kirana_kart.crm_agent_actions(actor_id)",
        "CREATE INDEX IF NOT EXISTS idx_crm_actions_created ON kirana_kart.crm_agent_actions(created_at DESC)",

        # 4. crm_tags
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_tags (
            id          SERIAL PRIMARY KEY,
            name        VARCHAR(50) NOT NULL UNIQUE,
            color       VARCHAR(7) NOT NULL DEFAULT '#6B7280',
            created_by  INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,

        # 5. crm_ticket_tags
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_ticket_tags (
            ticket_id   INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES kirana_kart.crm_tags(id) ON DELETE CASCADE,
            added_by    INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (ticket_id, tag_id)
        )
        """,

        # 6. crm_watchers
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_watchers (
            ticket_id   INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (ticket_id, user_id)
        )
        """,

        # 7. crm_notifications
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_notifications (
            id              SERIAL PRIMARY KEY,
            recipient_id    INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            ticket_id       INTEGER REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE,
            queue_id        INTEGER REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL,
            type            VARCHAR(40) NOT NULL CHECK (type IN (
                                'ASSIGNED','UNASSIGNED','SLA_WARNING','SLA_BREACHED',
                                'FIRST_RESPONSE_BREACH','NOTE_ADDED','REPLY_SENT',
                                'STATUS_CHANGED','ESCALATED','MENTIONED',
                                'WATCHER_UPDATE','MERGE','BULK_ACTION'
                            )),
            title           VARCHAR(200) NOT NULL,
            body            TEXT,
            is_read         BOOLEAN NOT NULL DEFAULT FALSE,
            read_at         TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_notif_recipient ON kirana_kart.crm_notifications(recipient_id, is_read, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_crm_notif_ticket    ON kirana_kart.crm_notifications(ticket_id)",

        # 8. crm_saved_views
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_saved_views (
            id          SERIAL PRIMARY KEY,
            owner_id    INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            name        VARCHAR(100) NOT NULL,
            is_default  BOOLEAN NOT NULL DEFAULT FALSE,
            filters     JSONB NOT NULL DEFAULT '{}',
            sort_by     VARCHAR(40) DEFAULT 'sla_due_at',
            sort_dir    VARCHAR(4)  DEFAULT 'asc',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,

        # 9. crm_merge_log
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_merge_log (
            id              SERIAL PRIMARY KEY,
            source_ticket   INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id),
            target_ticket   INTEGER NOT NULL REFERENCES kirana_kart.fdraw(ticket_id),
            merged_by       INTEGER NOT NULL REFERENCES kirana_kart.users(id),
            reason          TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,

        # ALTER users — add crm_availability
        """
        ALTER TABLE kirana_kart.users
          ADD COLUMN IF NOT EXISTS crm_availability VARCHAR(20) DEFAULT 'ONLINE'
              CHECK (crm_availability IN ('ONLINE','BUSY','AWAY','OFFLINE'))
        """,

        # 10. crm_groups — agent teams
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_groups (
            id               SERIAL PRIMARY KEY,
            name             VARCHAR(100) NOT NULL UNIQUE,
            description      TEXT,
            group_type       VARCHAR(30) NOT NULL DEFAULT 'SUPPORT'
                                 CHECK (group_type IN ('SUPPORT','FRAUD_REVIEW','ESCALATION','SENIOR_REVIEW','CUSTOM')),
            routing_strategy VARCHAR(20) NOT NULL DEFAULT 'ROUND_ROBIN'
                                 CHECK (routing_strategy IN ('ROUND_ROBIN','LEAST_BUSY','MANUAL')),
            is_active        BOOLEAN NOT NULL DEFAULT TRUE,
            created_by       INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,

        # 11. crm_group_members
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_group_members (
            group_id  INTEGER NOT NULL REFERENCES kirana_kart.crm_groups(id) ON DELETE CASCADE,
            user_id   INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            role      VARCHAR(20) NOT NULL DEFAULT 'AGENT'
                          CHECK (role IN ('AGENT','LEAD','MANAGER')),
            added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (group_id, user_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_group_members_user ON kirana_kart.crm_group_members(user_id)",

        # 12. crm_automation_rules
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_automation_rules (
            id              SERIAL PRIMARY KEY,
            name            VARCHAR(150) NOT NULL,
            description     TEXT,
            trigger_event   VARCHAR(40) NOT NULL
                                CHECK (trigger_event IN (
                                    'TICKET_CREATED','TICKET_UPDATED',
                                    'SLA_WARNING','SLA_BREACHED','TIME_BASED')),
            condition_logic VARCHAR(3) NOT NULL DEFAULT 'AND'
                                CHECK (condition_logic IN ('AND','OR')),
            conditions      JSONB NOT NULL DEFAULT '[]',
            actions         JSONB NOT NULL DEFAULT '[]',
            is_active       BOOLEAN NOT NULL DEFAULT TRUE,
            priority        INTEGER NOT NULL DEFAULT 100,
            run_count       INTEGER NOT NULL DEFAULT 0,
            last_run_at     TIMESTAMPTZ,
            is_seeded       BOOLEAN NOT NULL DEFAULT FALSE,
            created_by      INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_auto_rules_trigger ON kirana_kart.crm_automation_rules(trigger_event, is_active)",

        # 13. crm_sla_policies (DB-driven, replaces hardcoded dict)
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_sla_policies (
            id                     SERIAL PRIMARY KEY,
            queue_type             VARCHAR(40) NOT NULL UNIQUE,
            resolution_minutes     INTEGER NOT NULL,
            first_response_minutes INTEGER NOT NULL,
            is_active              BOOLEAN NOT NULL DEFAULT TRUE,
            updated_by             INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,

        # 14. crm_group_integrations
        """
        CREATE TABLE IF NOT EXISTS kirana_kart.crm_group_integrations (
            id           SERIAL PRIMARY KEY,
            group_id     INTEGER NOT NULL REFERENCES kirana_kart.crm_groups(id) ON DELETE CASCADE,
            type         VARCHAR(30) NOT NULL CHECK (type IN ('SMTP_INBOUND','API_KEY','WEBHOOK','CARDINAL_RULE')),
            name         VARCHAR(100) NOT NULL,
            config       JSONB NOT NULL DEFAULT '{}',
            is_active    BOOLEAN NOT NULL DEFAULT TRUE,
            api_key      VARCHAR(100) UNIQUE,
            created_by   INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_crm_integrations_group  ON kirana_kart.crm_group_integrations(group_id)",
        "CREATE INDEX IF NOT EXISTS idx_crm_integrations_apikey ON kirana_kart.crm_group_integrations(api_key) WHERE api_key IS NOT NULL",

        # group_id column on hitl_queue
        """
        ALTER TABLE kirana_kart.hitl_queue
          ADD COLUMN IF NOT EXISTS group_id INTEGER
              REFERENCES kirana_kart.crm_groups(id) ON DELETE SET NULL
        """,
        "CREATE INDEX IF NOT EXISTS idx_hitl_group_id ON kirana_kart.hitl_queue(group_id)",
    ]

    with get_db_session() as session:
        for stmt in ddl_statements:
            session.execute(text(stmt.strip()))
        logger.info("CRM tables ensured.")

    # Seed SLA policies with default values (idempotent)
    _seed_sla_policies()


def _seed_sla_policies() -> None:
    """Insert default SLA policy rows if not present."""
    defaults = [
        ("ESCALATION_QUEUE", 60, 15),
        ("SLA_BREACH_REVIEW", 120, 20),
        ("SENIOR_REVIEW", 240, 30),
        ("MANUAL_REVIEW", 240, 30),
        ("STANDARD_REVIEW", 480, 60),
    ]
    with get_db_session() as session:
        for qt, res, fr in defaults:
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_sla_policies
                        (queue_type, resolution_minutes, first_response_minutes)
                    VALUES (:qt, :res, :fr)
                    ON CONFLICT (queue_type) DO NOTHING
                """),
                {"qt": qt, "res": res, "fr": fr},
            )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_sla_minutes_db(queue_type: str) -> tuple[int, int]:
    """Read resolution + first_response minutes from crm_sla_policies table."""
    try:
        with get_db_session() as session:
            row = session.execute(
                text("""
                    SELECT resolution_minutes, first_response_minutes
                    FROM kirana_kart.crm_sla_policies
                    WHERE queue_type = :qt AND is_active = TRUE
                """),
                {"qt": queue_type},
            ).fetchone()
            if row:
                return row.resolution_minutes, row.first_response_minutes
    except Exception:
        pass
    # Fallback to hardcoded
    return (
        SLA_RESOLUTION_MINUTES.get(queue_type, 480),
        SLA_FIRST_RESPONSE_MINUTES.get(queue_type, 60),
    )


def _sla_due(queue_type: str, from_ts: datetime | None = None) -> datetime:
    ts = from_ts or _now()
    res_min, _ = _get_sla_minutes_db(queue_type)
    return ts + timedelta(minutes=res_min)


def _first_response_due(queue_type: str, from_ts: datetime | None = None) -> datetime:
    ts = from_ts or _now()
    _, fr_min = _get_sla_minutes_db(queue_type)
    return ts + timedelta(minutes=fr_min)


def _log_action(
    session,
    ticket_id: int,
    queue_id: int | None,
    actor_id: int,
    action_type: str,
    before_value: Any = None,
    after_value: Any = None,
    reason: str | None = None,
    refund_amount_before: float | None = None,
    refund_amount_after: float | None = None,
) -> None:
    import json
    session.execute(
        text("""
            INSERT INTO kirana_kart.crm_agent_actions
                (ticket_id, queue_id, actor_id, action_type,
                 before_value, after_value, reason,
                 refund_amount_before, refund_amount_after)
            VALUES
                (:ticket_id, :queue_id, :actor_id, :action_type,
                 CAST(:before_val AS jsonb), CAST(:after_val AS jsonb), :reason,
                 :refund_before, :refund_after)
        """),
        {
            "ticket_id": ticket_id,
            "queue_id": queue_id,
            "actor_id": actor_id,
            "action_type": action_type,
            "before_val": json.dumps(before_value) if before_value is not None else None,
            "after_val": json.dumps(after_value) if after_value is not None else None,
            "reason": reason,
            "refund_before": refund_amount_before,
            "refund_after": refund_amount_after,
        },
    )


def _create_notification(
    session,
    recipient_id: int,
    notif_type: str,
    title: str,
    body: str | None = None,
    ticket_id: int | None = None,
    queue_id: int | None = None,
) -> None:
    session.execute(
        text("""
            INSERT INTO kirana_kart.crm_notifications
                (recipient_id, ticket_id, queue_id, type, title, body)
            VALUES (:recipient_id, :ticket_id, :queue_id, :type, :title, :body)
        """),
        {
            "recipient_id": recipient_id,
            "ticket_id": ticket_id,
            "queue_id": queue_id,
            "type": notif_type,
            "title": title,
            "body": body,
        },
    )


def _notify_watchers(session, ticket_id: int, queue_id: int | None,
                     notif_type: str, title: str, body: str | None,
                     exclude_user_id: int | None = None) -> None:
    rows = session.execute(
        text("SELECT user_id FROM kirana_kart.crm_watchers WHERE ticket_id = :tid"),
        {"tid": ticket_id},
    ).fetchall()
    for r in rows:
        if exclude_user_id and r.user_id == exclude_user_id:
            continue
        _create_notification(session, r.user_id, notif_type, title, body, ticket_id, queue_id)


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------


def enqueue_ticket(
    ticket_id: int,
    automation_pathway: str,
    queue_type: str,
    ai_action_code: str | None,
    ai_refund_amount: float | None,
    ai_reasoning: str | None,
    ai_confidence: float | None,
    ai_discrepancy_details: str | None,
    ai_fraud_segment: str | None,
    customer_id: str,
    order_id: str,
    cx_email: str | None,
    customer_segment: str | None,
    subject: str | None,
    priority: int = 3,
) -> int:
    """Insert or update hitl_queue row. Returns queue row id."""
    now = _now()
    sla_due = _sla_due(queue_type, now)
    fr_due = _first_response_due(queue_type, now)

    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.hitl_queue
                    (ticket_id, automation_pathway, queue_type, priority,
                     sla_due_at, first_response_due_at,
                     ai_action_code, ai_refund_amount, ai_reasoning,
                     ai_confidence, ai_discrepancy_details, ai_fraud_segment,
                     customer_id, order_id, cx_email, customer_segment, subject,
                     created_at, updated_at)
                VALUES
                    (:ticket_id, :pathway, :queue_type, :priority,
                     :sla_due, :fr_due,
                     :ai_code, :ai_refund, :ai_reasoning,
                     :ai_conf, :ai_disc, :ai_fraud,
                     :cid, :oid, :email, :segment, :subject,
                     NOW(), NOW())
                ON CONFLICT (ticket_id) DO UPDATE SET
                    automation_pathway     = EXCLUDED.automation_pathway,
                    queue_type             = EXCLUDED.queue_type,
                    priority               = EXCLUDED.priority,
                    ai_action_code         = EXCLUDED.ai_action_code,
                    ai_refund_amount       = EXCLUDED.ai_refund_amount,
                    ai_reasoning           = EXCLUDED.ai_reasoning,
                    ai_confidence          = EXCLUDED.ai_confidence,
                    ai_discrepancy_details = EXCLUDED.ai_discrepancy_details,
                    ai_fraud_segment       = EXCLUDED.ai_fraud_segment,
                    updated_at             = NOW()
                RETURNING id
            """),
            {
                "ticket_id": ticket_id,
                "pathway": automation_pathway,
                "queue_type": queue_type,
                "priority": priority,
                "sla_due": sla_due,
                "fr_due": fr_due,
                "ai_code": ai_action_code,
                "ai_refund": ai_refund_amount,
                "ai_reasoning": ai_reasoning,
                "ai_conf": ai_confidence,
                "ai_disc": ai_discrepancy_details,
                "ai_fraud": ai_fraud_segment,
                "cid": customer_id,
                "oid": order_id,
                "email": cx_email,
                "segment": customer_segment,
                "subject": subject,
            },
        ).fetchone()
        queue_id = row.id
        logger.info("CRM enqueued ticket_id=%s → queue_id=%s", ticket_id, queue_id)

    # Run automation rules (non-fatal, outside the session)
    try:
        from app.admin.services.crm_automation_engine import run_for_ticket
        applied = run_for_ticket("TICKET_CREATED", queue_id)
        if applied:
            logger.info("Automation: %d rule(s) applied on enqueue for queue_id=%s", applied, queue_id)
    except Exception as exc:
        logger.warning("Automation engine skipped on enqueue (queue_id=%s): %s", queue_id, exc)

    return queue_id


# ---------------------------------------------------------------------------
# List Queue
# ---------------------------------------------------------------------------


def list_queue(
    page: int = 1,
    limit: int = 25,
    queue_type: str | None = None,
    status: str | None = None,
    assigned_to: int | None = None,
    priority: int | None = None,
    sla_breached: bool | None = None,
    search: str | None = None,
    tags: list[int] | None = None,
    sort_by: str = "sla_due_at",
    sort_dir: str = "asc",
    current_user_id: int | None = None,
) -> dict:
    """Paginated queue list with inline SLA breach refresh."""
    limit = min(limit, 200)
    offset = (page - 1) * limit

    # Inline update stale sla_breached flags
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET sla_breached = TRUE, updated_at = NOW()
                WHERE sla_due_at < NOW()
                  AND sla_breached = FALSE
                  AND status NOT IN ('RESOLVED','CLOSED')
            """)
        )

    # Whitelist sort columns
    allowed_sort = {
        "sla_due_at", "created_at", "updated_at", "priority", "status", "queue_type"
    }
    if sort_by not in allowed_sort:
        sort_by = "sla_due_at"
    sort_dir = "ASC" if sort_dir.lower() == "asc" else "DESC"

    filters = []
    params: dict[str, Any] = {}

    if queue_type:
        filters.append("hq.queue_type = :queue_type")
        params["queue_type"] = queue_type
    if status:
        filters.append("hq.status = :status")
        params["status"] = status
    if assigned_to is not None:
        filters.append("hq.assigned_to = :assigned_to")
        params["assigned_to"] = assigned_to
    if priority is not None:
        filters.append("hq.priority = :priority")
        params["priority"] = priority
    if sla_breached is not None:
        filters.append("hq.sla_breached = :sla_breached")
        params["sla_breached"] = sla_breached
    if search:
        filters.append("(hq.subject ILIKE :search OR hq.cx_email ILIKE :search OR CAST(hq.ticket_id AS TEXT) = :exact_search)")
        params["search"] = f"%{search}%"
        params["exact_search"] = search
    if tags:
        filters.append("""
            hq.ticket_id IN (
                SELECT ticket_id FROM kirana_kart.crm_ticket_tags WHERE tag_id = ANY(:tag_ids)
            )
        """)
        params["tag_ids"] = tags

    where_clause = ("WHERE " + " AND ".join(filters)) if filters else ""

    query = f"""
        SELECT
            hq.*,
            u.full_name AS assigned_to_name,
            u.avatar_url AS assigned_to_avatar,
            vu.full_name AS viewing_agent_name,
            COALESCE(
                (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
                 FROM kirana_kart.crm_ticket_tags ct
                 JOIN kirana_kart.crm_tags t ON t.id = ct.tag_id
                 WHERE ct.ticket_id = hq.ticket_id), '[]'::json
            ) AS tags,
            CASE WHEN w.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS watching
        FROM kirana_kart.hitl_queue hq
        LEFT JOIN kirana_kart.users u  ON u.id = hq.assigned_to
        LEFT JOIN kirana_kart.users vu ON vu.id = hq.viewing_agent_id
        LEFT JOIN kirana_kart.crm_watchers w
            ON w.ticket_id = hq.ticket_id AND w.user_id = :current_user_id
        {where_clause}
        ORDER BY hq.{sort_by} {sort_dir}
        LIMIT :limit OFFSET :offset
    """
    count_query = f"""
        SELECT COUNT(*) FROM kirana_kart.hitl_queue hq {where_clause}
    """
    params["limit"] = limit
    params["offset"] = offset
    params["current_user_id"] = current_user_id

    with get_db_session() as session:
        rows = session.execute(text(query), params).mappings().fetchall()
        total = session.execute(text(count_query), params).scalar()

    items = [dict(r) for r in rows]
    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "pages": max(1, -(-total // limit)),
    }


# ---------------------------------------------------------------------------
# Get full queue item detail
# ---------------------------------------------------------------------------


def get_queue_item(queue_id: int, current_user_id: int | None = None) -> dict | None:
    """Full detail: queue row + ticket + LLM outputs + customer + notes + actions + tags + watchers."""
    with get_db_session() as session:
        # Refresh stale viewing lock (>5 min old → clear it)
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET viewing_agent_id = NULL, viewing_since = NULL, updated_at = NOW()
                WHERE id = :qid
                  AND viewing_since < NOW() - INTERVAL '5 minutes'
            """),
            {"qid": queue_id},
        )

        row = session.execute(
            text("""
                SELECT
                    hq.*,
                    u.full_name AS assigned_to_name,
                    u.avatar_url AS assigned_to_avatar,
                    vu.full_name AS viewing_agent_name,
                    CASE WHEN w.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS watching
                FROM kirana_kart.hitl_queue hq
                LEFT JOIN kirana_kart.users u  ON u.id = hq.assigned_to
                LEFT JOIN kirana_kart.users vu ON vu.id = hq.viewing_agent_id
                LEFT JOIN kirana_kart.crm_watchers w
                    ON w.ticket_id = hq.ticket_id AND w.user_id = :cuid
                WHERE hq.id = :qid
            """),
            {"qid": queue_id, "cuid": current_user_id},
        ).mappings().first()

        if not row:
            return None

        detail = dict(row)
        ticket_id = detail["ticket_id"]

        # fdraw
        ticket = session.execute(
            text("SELECT * FROM kirana_kart.fdraw WHERE ticket_id = :tid"),
            {"tid": ticket_id},
        ).mappings().first()
        detail["ticket"] = dict(ticket) if ticket else {}

        # LLM outputs
        for tbl in ("llm_output_1", "llm_output_2", "llm_output_3"):
            lr = session.execute(
                text(f"SELECT * FROM kirana_kart.{tbl} WHERE ticket_id = :tid ORDER BY id DESC LIMIT 1"),
                {"tid": ticket_id},
            ).mappings().first()
            detail[tbl] = dict(lr) if lr else None

        # Customer
        cust = session.execute(
            text("SELECT * FROM kirana_kart.customers WHERE customer_id = :cid LIMIT 1"),
            {"cid": detail.get("customer_id")},
        ).mappings().first()
        detail["customer"] = reveal_customer(cust) if cust else {}

        # Notes (pinned first)
        notes = session.execute(
            text("""
                SELECT n.*, u.full_name AS author_name, u.avatar_url AS author_avatar
                FROM kirana_kart.crm_notes n
                JOIN kirana_kart.users u ON u.id = n.author_id
                WHERE n.ticket_id = :tid
                ORDER BY n.is_pinned DESC, n.created_at ASC
            """),
            {"tid": ticket_id},
        ).mappings().fetchall()
        detail["notes"] = [dict(n) for n in notes]

        # Audit actions
        actions = session.execute(
            text("""
                SELECT a.*, u.full_name AS actor_name
                FROM kirana_kart.crm_agent_actions a
                JOIN kirana_kart.users u ON u.id = a.actor_id
                WHERE a.ticket_id = :tid
                ORDER BY a.created_at DESC
                LIMIT 100
            """),
            {"tid": ticket_id},
        ).mappings().fetchall()
        detail["actions"] = [dict(a) for a in actions]

        # Tags
        tags = session.execute(
            text("""
                SELECT t.id, t.name, t.color
                FROM kirana_kart.crm_ticket_tags ct
                JOIN kirana_kart.crm_tags t ON t.id = ct.tag_id
                WHERE ct.ticket_id = :tid
            """),
            {"tid": ticket_id},
        ).mappings().fetchall()
        detail["tags"] = [dict(t) for t in tags]

        # Watchers
        watchers = session.execute(
            text("""
                SELECT w.user_id, u.full_name, u.avatar_url
                FROM kirana_kart.crm_watchers w
                JOIN kirana_kart.users u ON u.id = w.user_id
                WHERE w.ticket_id = :tid
            """),
            {"tid": ticket_id},
        ).mappings().fetchall()
        detail["watchers"] = [dict(w) for w in watchers]

    return detail


# ---------------------------------------------------------------------------
# Customer 360°
# ---------------------------------------------------------------------------


def get_customer_360(queue_id: int) -> dict:
    with get_db_session() as session:
        hq = session.execute(
            text("SELECT ticket_id, customer_id, cx_email, customer_segment FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": queue_id},
        ).mappings().first()
        if not hq:
            return {}

        customer_id = hq["customer_id"]

        cust = session.execute(
            text("SELECT * FROM kirana_kart.customers WHERE customer_id = :cid LIMIT 1"),
            {"cid": customer_id},
        ).mappings().first()

        lifetime_orders = session.execute(
            text("SELECT COUNT(*) FROM kirana_kart.orders WHERE customer_id = :cid"),
            {"cid": customer_id},
        ).scalar() or 0

        recent_tickets = session.execute(
            text("""
                SELECT f.ticket_id, hq2.id AS queue_id, f.subject, hq2.status, f.created_at
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.hitl_queue hq2 ON hq2.ticket_id = f.ticket_id
                WHERE f.cx_email = :email
                ORDER BY f.created_at DESC
                LIMIT 10
            """),
            {"email": hq["cx_email"]},
        ).mappings().fetchall()

        recent_refunds = session.execute(
            text("""
                SELECT refund_id, refund_amount, applied_action_code, created_at
                FROM kirana_kart.refunds
                WHERE customer_id = :cid
                ORDER BY created_at DESC
                LIMIT 10
            """),
            {"cid": customer_id},
        ).mappings().fetchall()

        csat_row = session.execute(
            text("""
                SELECT AVG(csat_score) AS avg, COUNT(*) AS cnt
                FROM kirana_kart.csat_responses
                WHERE customer_id = :cid
            """),
            {"cid": customer_id},
        ).mappings().first()

        return {
            "customer_id": customer_id,
            "email": hq["cx_email"],
            "segment": hq["customer_segment"],
            "lifetime_order_count": int(lifetime_orders),
            "customer": reveal_customer(cust) if cust else {},
            "recent_tickets": [dict(r) for r in recent_tickets],
            "recent_refunds": [dict(r) for r in recent_refunds],
            "csat_average": float(csat_row["avg"]) if csat_row and csat_row["avg"] else None,
            "csat_count": int(csat_row["cnt"]) if csat_row else 0,
        }


# ---------------------------------------------------------------------------
# Viewing lock
# ---------------------------------------------------------------------------


def set_viewing(queue_id: int, user_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET viewing_agent_id = :uid, viewing_since = NOW(), updated_at = NOW()
                WHERE id = :qid
            """),
            {"qid": queue_id, "uid": user_id},
        )


def release_viewing(queue_id: int, user_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET viewing_agent_id = NULL, viewing_since = NULL, updated_at = NOW()
                WHERE id = :qid AND viewing_agent_id = :uid
            """),
            {"qid": queue_id, "uid": user_id},
        )


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


def assign_ticket(queue_id: int, assignee_id: int, actor: UserContext) -> None:
    with get_db_session() as session:
        hq = session.execute(
            text("SELECT ticket_id, assigned_to, status FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": queue_id},
        ).mappings().first()
        if not hq:
            raise ValueError(f"Queue item {queue_id} not found")

        prev_assignee = hq["assigned_to"]
        action_type = "SELF_ASSIGN" if assignee_id == actor.id else "REASSIGN"

        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET assigned_to = :aid, assigned_at = NOW(),
                    status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                    updated_at = NOW()
                WHERE id = :qid
            """),
            {"qid": queue_id, "aid": assignee_id},
        )
        _log_action(
            session, hq["ticket_id"], queue_id, actor.id, action_type,
            before_value={"assigned_to": prev_assignee},
            after_value={"assigned_to": assignee_id},
        )
        _create_notification(
            session, assignee_id, "ASSIGNED",
            f"Ticket #{hq['ticket_id']} assigned to you",
            ticket_id=hq["ticket_id"], queue_id=queue_id,
        )


# ---------------------------------------------------------------------------
# Central action dispatcher
# ---------------------------------------------------------------------------


def take_action(
    queue_id: int,
    actor: UserContext,
    action_type: str,
    final_action_code: str | None = None,
    final_refund_amount: float | None = None,
    reason: str | None = None,
    reply_body: str | None = None,
    new_priority: int | None = None,
    new_status: str | None = None,
    new_queue_type: str | None = None,
    new_ticket_type: str | None = None,
) -> dict:
    with get_db_session() as session:
        hq = session.execute(
            text("SELECT * FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": queue_id},
        ).mappings().first()
        if not hq:
            raise ValueError(f"Queue item {queue_id} not found")
        hq = dict(hq)
        ticket_id = hq["ticket_id"]

        if action_type == "APPROVE_AI_REC":
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET final_action_code = ai_action_code,
                        final_refund_amount = ai_refund_amount,
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "APPROVE_AI_REC",
                        after_value={"action_code": hq["ai_action_code"], "refund_amount": str(hq["ai_refund_amount"])})

        elif action_type == "REJECT_AI_REC":
            if not reason:
                raise ValueError("reason is required for REJECT_AI_REC")
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET final_action_code = NULL, final_refund_amount = NULL, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "REJECT_AI_REC",
                        before_value={"action_code": hq["ai_action_code"]}, reason=reason)

        elif action_type == "MODIFY_REFUND":
            old_amt = hq["final_refund_amount"]
            update_fields = []
            update_params: dict[str, Any] = {"qid": queue_id}
            if final_refund_amount is not None:
                update_fields.append("final_refund_amount = :refund")
                update_params["refund"] = final_refund_amount
            if final_action_code:
                update_fields.append("final_action_code = :fcode")
                update_params["fcode"] = final_action_code
            if update_fields:
                session.execute(
                    text(f"UPDATE kirana_kart.hitl_queue SET {', '.join(update_fields)}, updated_at = NOW() WHERE id = :qid"),
                    update_params,
                )
            _log_action(session, ticket_id, queue_id, actor.id, "MODIFY_REFUND",
                        refund_amount_before=old_amt, refund_amount_after=final_refund_amount, reason=reason)

        elif action_type == "REPLY_CUSTOMER":
            if not reply_body:
                raise ValueError("reply_body is required for REPLY_CUSTOMER")
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_notes (ticket_id, queue_id, author_id, note_type, body)
                    VALUES (:tid, :qid, :aid, 'CUSTOMER_REPLY', :body)
                """),
                {"tid": ticket_id, "qid": queue_id, "aid": actor.id, "body": reply_body},
            )
            # Set first_response_at if not yet set
            if not hq["first_response_at"]:
                session.execute(
                    text("""
                        UPDATE kirana_kart.hitl_queue
                        SET first_response_at = NOW(), updated_at = NOW()
                        WHERE id = :qid AND first_response_at IS NULL
                    """),
                    {"qid": queue_id},
                )
            _log_action(session, ticket_id, queue_id, actor.id, "REPLY_CUSTOMER")
            _notify_watchers(session, ticket_id, queue_id, "REPLY_SENT",
                             f"Reply sent on ticket #{ticket_id}", None, exclude_user_id=actor.id)
            # Send actual email to customer if cx_email is available
            cx_email = hq.get("cx_email") or hq.get("subject", "")
            if hq.get("cx_email"):
                subject_line = hq.get("subject") or f"Re: Your support request #{ticket_id}"
                if not subject_line.lower().startswith("re:"):
                    subject_line = f"Re: {subject_line}"
                send_email(
                    to=hq["cx_email"],
                    subject=subject_line,
                    body_html=f"<p>{reply_body}</p>",
                    body_text=reply_body,
                )

        elif action_type == "ESCALATE":
            if not reason:
                raise ValueError("reason is required for ESCALATE")
            target_queue = new_queue_type or "ESCALATION_QUEUE"
            now = _now()
            new_sla = _sla_due(target_queue, now)
            new_fr = _first_response_due(target_queue, now)
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET queue_type = :qt, status = 'ESCALATED',
                        escalation_reason = :reason,
                        sla_due_at = :sla, first_response_due_at = :fr,
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id, "qt": target_queue, "reason": reason, "sla": new_sla, "fr": new_fr},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "ESCALATE",
                        before_value={"queue_type": hq["queue_type"]},
                        after_value={"queue_type": target_queue}, reason=reason)
            _notify_watchers(session, ticket_id, queue_id, "ESCALATED",
                             f"Ticket #{ticket_id} escalated to {target_queue}", reason)

        elif action_type == "RESOLVE":
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET status = 'RESOLVED', resolved_by = :actor,
                        resolved_at = NOW(), resolution_note = :note,
                        csat_requested_at = NOW(), updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id, "actor": actor.id, "note": reason},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "RESOLVE", reason=reason)
            _notify_watchers(session, ticket_id, queue_id, "STATUS_CHANGED",
                             f"Ticket #{ticket_id} resolved", None)

        elif action_type == "REOPEN":
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET status = 'OPEN', resolved_by = NULL,
                        resolved_at = NULL, updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "REOPEN", reason=reason)

        elif action_type == "CLOSE":
            if not reason:
                raise ValueError("reason is required for CLOSE")
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET status = 'CLOSED', updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "CLOSE", reason=reason)

        elif action_type == "CHANGE_PRIORITY":
            if new_priority not in VALID_PRIORITIES:
                raise ValueError(f"Invalid priority: {new_priority}")
            session.execute(
                text("UPDATE kirana_kart.hitl_queue SET priority = :p, updated_at = NOW() WHERE id = :qid"),
                {"qid": queue_id, "p": new_priority},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "CHANGE_PRIORITY",
                        before_value={"priority": hq["priority"]},
                        after_value={"priority": new_priority})

        elif action_type == "CHANGE_STATUS":
            if new_status not in VALID_STATUSES:
                raise ValueError(f"Invalid status: {new_status}")
            session.execute(
                text("UPDATE kirana_kart.hitl_queue SET status = :s, updated_at = NOW() WHERE id = :qid"),
                {"qid": queue_id, "s": new_status},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "CHANGE_STATUS",
                        before_value={"status": hq["status"]},
                        after_value={"status": new_status})
            _notify_watchers(session, ticket_id, queue_id, "STATUS_CHANGED",
                             f"Ticket #{ticket_id} status → {new_status}", None)

        elif action_type == "CHANGE_TYPE":
            if new_ticket_type and new_ticket_type not in VALID_TICKET_TYPES:
                raise ValueError(f"Invalid ticket_type: {new_ticket_type}")
            session.execute(
                text("UPDATE kirana_kart.hitl_queue SET ticket_type = :tt, updated_at = NOW() WHERE id = :qid"),
                {"qid": queue_id, "tt": new_ticket_type},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "CHANGE_TYPE",
                        before_value={"ticket_type": hq["ticket_type"]},
                        after_value={"ticket_type": new_ticket_type})

        elif action_type == "CHANGE_QUEUE":
            if new_queue_type not in VALID_QUEUE_TYPES:
                raise ValueError(f"Invalid queue_type: {new_queue_type}")
            now = _now()
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET queue_type = :qt,
                        sla_due_at = :sla, first_response_due_at = :fr,
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": queue_id, "qt": new_queue_type,
                 "sla": _sla_due(new_queue_type, now),
                 "fr": _first_response_due(new_queue_type, now)},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "CHANGE_QUEUE",
                        before_value={"queue_type": hq["queue_type"]},
                        after_value={"queue_type": new_queue_type})

        else:
            raise ValueError(f"Unknown action_type: {action_type}")

    # Fire TICKET_UPDATED automation rules (non-fatal, outside session)
    try:
        from app.admin.services.crm_automation_engine import on_ticket_updated
        on_ticket_updated(queue_id)
    except Exception as _ae:
        logger.debug("TICKET_UPDATED automation skipped for queue_id=%s: %s", queue_id, _ae)

    return get_queue_item(queue_id) or {}


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------


def add_note(
    ticket_id: int,
    queue_id: int | None,
    author: UserContext,
    body: str,
    note_type: str = "INTERNAL",
) -> dict:
    if note_type not in VALID_NOTE_TYPES:
        raise ValueError(f"Invalid note_type: {note_type}")
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_notes (ticket_id, queue_id, author_id, note_type, body)
                VALUES (:tid, :qid, :aid, :ntype, :body)
                RETURNING *
            """),
            {"tid": ticket_id, "qid": queue_id, "aid": author.id, "ntype": note_type, "body": body},
        ).mappings().first()
        note = dict(row)
        _log_action(session, ticket_id, queue_id, author.id, "ADD_NOTE",
                    after_value={"note_type": note_type})
        _notify_watchers(session, ticket_id, queue_id, "NOTE_ADDED",
                         f"New note on ticket #{ticket_id}",
                         body[:100] if body else None,
                         exclude_user_id=author.id)
    return note


def update_note(note_id: int, actor: UserContext, body: str | None = None, is_pinned: bool | None = None) -> dict:
    with get_db_session() as session:
        updates = []
        params: dict[str, Any] = {"nid": note_id}
        if body is not None:
            updates.append("body = :body")
            params["body"] = body
        if is_pinned is not None:
            updates.append("is_pinned = :pinned")
            params["pinned"] = is_pinned
        if not updates:
            raise ValueError("Nothing to update")
        updates.append("updated_at = NOW()")
        row = session.execute(
            text(f"UPDATE kirana_kart.crm_notes SET {', '.join(updates)} WHERE id = :nid RETURNING *"),
            params,
        ).mappings().first()
        return dict(row) if row else {}


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


def manage_tags(
    ticket_id: int,
    queue_id: int | None,
    tag_ids_add: list[int],
    tag_ids_remove: list[int],
    actor: UserContext,
) -> None:
    with get_db_session() as session:
        for tid in tag_ids_add:
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_ticket_tags (ticket_id, tag_id, added_by)
                    VALUES (:ticket_id, :tag_id, :actor)
                    ON CONFLICT DO NOTHING
                """),
                {"ticket_id": ticket_id, "tag_id": tid, "actor": actor.id},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "ADD_TAG",
                        after_value={"tag_id": tid})
        for tid in tag_ids_remove:
            session.execute(
                text("DELETE FROM kirana_kart.crm_ticket_tags WHERE ticket_id = :ticket_id AND tag_id = :tag_id"),
                {"ticket_id": ticket_id, "tag_id": tid},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "REMOVE_TAG",
                        before_value={"tag_id": tid})


def get_tags() -> list:
    with get_db_session() as session:
        rows = session.execute(
            text("SELECT * FROM kirana_kart.crm_tags ORDER BY name")
        ).mappings().fetchall()
    return [dict(r) for r in rows]


def create_tag(name: str, color: str, creator: UserContext) -> dict:
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_tags (name, color, created_by)
                VALUES (:name, :color, :creator)
                RETURNING *
            """),
            {"name": name, "color": color, "creator": creator.id},
        ).mappings().first()
    return dict(row)


# ---------------------------------------------------------------------------
# Watchers
# ---------------------------------------------------------------------------


def manage_watchers(
    ticket_id: int,
    queue_id: int | None,
    user_ids_add: list[int],
    user_ids_remove: list[int],
    actor: UserContext,
) -> None:
    with get_db_session() as session:
        for uid in user_ids_add:
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_watchers (ticket_id, user_id)
                    VALUES (:ticket_id, :uid)
                    ON CONFLICT DO NOTHING
                """),
                {"ticket_id": ticket_id, "uid": uid},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "ADD_WATCHER",
                        after_value={"user_id": uid})
            _create_notification(session, uid, "WATCHER_UPDATE",
                                 f"You are now watching ticket #{ticket_id}",
                                 ticket_id=ticket_id, queue_id=queue_id)
        for uid in user_ids_remove:
            session.execute(
                text("DELETE FROM kirana_kart.crm_watchers WHERE ticket_id = :ticket_id AND user_id = :uid"),
                {"ticket_id": ticket_id, "uid": uid},
            )
            _log_action(session, ticket_id, queue_id, actor.id, "REMOVE_WATCHER",
                        before_value={"user_id": uid})


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------


def merge_tickets(
    source_queue_id: int,
    target_queue_id: int,
    reason: str | None,
    actor: UserContext,
) -> None:
    with get_db_session() as session:
        src = session.execute(
            text("SELECT ticket_id FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": source_queue_id},
        ).mappings().first()
        tgt = session.execute(
            text("SELECT ticket_id FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": target_queue_id},
        ).mappings().first()
        if not src or not tgt:
            raise ValueError("Source or target queue item not found")

        src_tid, tgt_tid = src["ticket_id"], tgt["ticket_id"]

        # Mark source as closed + merged
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET merged_into = :target_id, status = 'CLOSED', updated_at = NOW()
                WHERE id = :qid
            """),
            {"target_id": target_queue_id, "qid": source_queue_id},
        )

        # Insert merge log
        session.execute(
            text("""
                INSERT INTO kirana_kart.crm_merge_log (source_ticket, target_ticket, merged_by, reason)
                VALUES (:src, :tgt, :actor, :reason)
            """),
            {"src": src_tid, "tgt": tgt_tid, "actor": actor.id, "reason": reason},
        )

        # System notes on both
        for tid, qid in [(src_tid, source_queue_id), (tgt_tid, target_queue_id)]:
            session.execute(
                text("""
                    INSERT INTO kirana_kart.crm_notes (ticket_id, queue_id, author_id, note_type, body)
                    VALUES (:tid, :qid, :aid, 'SYSTEM',
                            :body)
                """),
                {"tid": tid, "qid": qid, "aid": actor.id,
                 "body": f"Ticket #{src_tid} merged into #{tgt_tid}. Reason: {reason or 'No reason provided'}"},
            )

        _log_action(session, src_tid, source_queue_id, actor.id, "MERGE",
                    after_value={"merged_into": tgt_tid}, reason=reason)


# ---------------------------------------------------------------------------
# Bulk operations
# ---------------------------------------------------------------------------


def bulk_assign(queue_ids: list[int], assignee_id: int, actor: UserContext) -> dict:
    updated = 0
    with get_db_session() as session:
        for qid in queue_ids:
            hq = session.execute(
                text("SELECT ticket_id, status FROM kirana_kart.hitl_queue WHERE id = :qid"),
                {"qid": qid},
            ).mappings().first()
            if not hq:
                continue
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET assigned_to = :aid, assigned_at = NOW(),
                        status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": qid, "aid": assignee_id},
            )
            _log_action(session, hq["ticket_id"], qid, actor.id, "BULK_ASSIGN",
                        after_value={"assigned_to": assignee_id})
            _create_notification(session, assignee_id, "BULK_ACTION",
                                 f"Ticket #{hq['ticket_id']} assigned to you (bulk)",
                                 ticket_id=hq["ticket_id"], queue_id=qid)
            updated += 1
    return {"updated": updated, "skipped": len(queue_ids) - updated}


def bulk_escalate(queue_ids: list[int], reason: str, actor: UserContext) -> dict:
    updated = 0
    now = _now()
    with get_db_session() as session:
        for qid in queue_ids:
            hq = session.execute(
                text("SELECT ticket_id, status FROM kirana_kart.hitl_queue WHERE id = :qid"),
                {"qid": qid},
            ).mappings().first()
            if not hq or hq["status"] in ("RESOLVED", "CLOSED"):
                continue
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET queue_type = 'ESCALATION_QUEUE', status = 'ESCALATED',
                        escalation_reason = :reason,
                        sla_due_at = :sla, first_response_due_at = :fr,
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": qid, "reason": reason,
                 "sla": _sla_due("ESCALATION_QUEUE", now),
                 "fr": _first_response_due("ESCALATION_QUEUE", now)},
            )
            _log_action(session, hq["ticket_id"], qid, actor.id, "BULK_ESCALATE", reason=reason)
            updated += 1
    return {"updated": updated, "skipped": len(queue_ids) - updated}


def bulk_close(queue_ids: list[int], reason: str, actor: UserContext) -> dict:
    updated = 0
    with get_db_session() as session:
        for qid in queue_ids:
            hq = session.execute(
                text("SELECT ticket_id, status FROM kirana_kart.hitl_queue WHERE id = :qid"),
                {"qid": qid},
            ).mappings().first()
            if not hq or hq["status"] == "CLOSED":
                continue
            session.execute(
                text("UPDATE kirana_kart.hitl_queue SET status = 'CLOSED', updated_at = NOW() WHERE id = :qid"),
                {"qid": qid},
            )
            _log_action(session, hq["ticket_id"], qid, actor.id, "BULK_CLOSE", reason=reason)
            updated += 1
    return {"updated": updated, "skipped": len(queue_ids) - updated}


def bulk_status_change(queue_ids: list[int], new_status: str, actor: UserContext) -> dict:
    if new_status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {new_status}")
    updated = 0
    with get_db_session() as session:
        for qid in queue_ids:
            hq = session.execute(
                text("SELECT ticket_id FROM kirana_kart.hitl_queue WHERE id = :qid"),
                {"qid": qid},
            ).mappings().first()
            if not hq:
                continue
            session.execute(
                text("UPDATE kirana_kart.hitl_queue SET status = :s, updated_at = NOW() WHERE id = :qid"),
                {"qid": qid, "s": new_status},
            )
            _log_action(session, hq["ticket_id"], qid, actor.id, "BULK_STATUS",
                        after_value={"status": new_status})
            updated += 1
    return {"updated": updated, "skipped": len(queue_ids) - updated}


# ---------------------------------------------------------------------------
# Canned responses
# ---------------------------------------------------------------------------


def get_canned_responses(action_code_id: str | None, issue_l1: str | None) -> list:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT * FROM kirana_kart.response_templates
                WHERE (:action_code IS NULL OR action_code_id = :action_code)
                   OR (:issue_l1 IS NULL OR issue_l1 = :issue_l1)
                LIMIT 50
            """),
            {"action_code": action_code_id, "issue_l1": issue_l1},
        ).mappings().fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


def get_notifications(
    user_id: int,
    unread_only: bool = False,
    page: int = 1,
    limit: int = 25,
) -> dict:
    limit = min(limit, 100)
    offset = (page - 1) * limit
    where = "WHERE recipient_id = :uid"
    if unread_only:
        where += " AND is_read = FALSE"

    with get_db_session() as session:
        rows = session.execute(
            text(f"""
                SELECT * FROM kirana_kart.crm_notifications
                {where}
                ORDER BY created_at DESC
                LIMIT :limit OFFSET :offset
            """),
            {"uid": user_id, "limit": limit, "offset": offset},
        ).mappings().fetchall()
        total = session.execute(
            text(f"SELECT COUNT(*) FROM kirana_kart.crm_notifications {where}"),
            {"uid": user_id},
        ).scalar()
        unread_count = session.execute(
            text("SELECT COUNT(*) FROM kirana_kart.crm_notifications WHERE recipient_id = :uid AND is_read = FALSE"),
            {"uid": user_id},
        ).scalar()
    return {
        "items": [dict(r) for r in rows],
        "total": total,
        "unread_count": unread_count,
        "page": page,
        "limit": limit,
    }


def mark_notifications_read(user_id: int, notification_ids: list[int]) -> None:
    if not notification_ids:
        return
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.crm_notifications
                SET is_read = TRUE, read_at = NOW()
                WHERE recipient_id = :uid AND id = ANY(:ids)
            """),
            {"uid": user_id, "ids": notification_ids},
        )


def mark_all_notifications_read(user_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.crm_notifications
                SET is_read = TRUE, read_at = NOW()
                WHERE recipient_id = :uid AND is_read = FALSE
            """),
            {"uid": user_id},
        )


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


def get_agents() -> list:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT
                    u.id, u.full_name, u.email, u.avatar_url,
                    COALESCE(u.crm_availability, 'ONLINE') AS crm_availability,
                    COUNT(hq.id) AS open_tickets
                FROM kirana_kart.users u
                JOIN kirana_kart.user_permissions up
                    ON up.user_id = u.id AND up.module = 'crm' AND up.can_edit = TRUE
                LEFT JOIN kirana_kart.hitl_queue hq
                    ON hq.assigned_to = u.id AND hq.status NOT IN ('RESOLVED','CLOSED')
                GROUP BY u.id, u.full_name, u.email, u.avatar_url, u.crm_availability
                ORDER BY u.full_name
            """)
        ).mappings().fetchall()
    return [dict(r) for r in rows]


def update_availability(user_id: int, availability: str) -> None:
    if availability not in VALID_AVAILABILITY:
        raise ValueError(f"Invalid availability: {availability}")
    with get_db_session() as session:
        session.execute(
            text("UPDATE kirana_kart.users SET crm_availability = :avail WHERE id = :uid"),
            {"uid": user_id, "avail": availability},
        )


# ---------------------------------------------------------------------------
# Saved views
# ---------------------------------------------------------------------------


def get_saved_views(user_id: int) -> list:
    with get_db_session() as session:
        rows = session.execute(
            text("SELECT * FROM kirana_kart.crm_saved_views WHERE owner_id = :uid ORDER BY is_default DESC, name"),
            {"uid": user_id},
        ).mappings().fetchall()
    return [dict(r) for r in rows]


def save_view(
    user_id: int,
    name: str,
    filters: dict,
    sort_by: str = "sla_due_at",
    sort_dir: str = "asc",
    is_default: bool = False,
) -> dict:
    import json
    with get_db_session() as session:
        if is_default:
            session.execute(
                text("UPDATE kirana_kart.crm_saved_views SET is_default = FALSE WHERE owner_id = :uid"),
                {"uid": user_id},
            )
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_saved_views (owner_id, name, filters, sort_by, sort_dir, is_default)
                VALUES (:uid, :name, CAST(:filters AS jsonb), :sort_by, :sort_dir, :is_default)
                RETURNING *
            """),
            {
                "uid": user_id, "name": name,
                "filters": json.dumps(filters),
                "sort_by": sort_by, "sort_dir": sort_dir, "is_default": is_default,
            },
        ).mappings().first()
    return dict(row)


def delete_saved_view(view_id: int, user_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("DELETE FROM kirana_kart.crm_saved_views WHERE id = :vid AND owner_id = :uid"),
            {"vid": view_id, "uid": user_id},
        )


# ---------------------------------------------------------------------------
# Agent dashboard
# ---------------------------------------------------------------------------


def get_agent_dashboard(agent_id: int, date_from: str, date_to: str) -> dict:
    with get_db_session() as session:
        # Queue counts by status
        my_queue = session.execute(
            text("""
                SELECT status, COUNT(*) AS cnt
                FROM kirana_kart.hitl_queue
                WHERE assigned_to = :aid
                GROUP BY status
            """),
            {"aid": agent_id},
        ).mappings().fetchall()

        # Tickets handled in date range
        handled = session.execute(
            text("""
                SELECT
                    COUNT(*) AS tickets_handled,
                    AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) AS avg_resolution_minutes,
                    AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60) AS avg_first_response_minutes
                FROM kirana_kart.hitl_queue
                WHERE resolved_by = :aid
                  AND resolved_at BETWEEN :from_dt AND :to_dt
            """),
            {"aid": agent_id, "from_dt": date_from, "to_dt": date_to},
        ).mappings().first()

        # CSAT for resolved tickets
        csat = session.execute(
            text("""
                SELECT AVG(cr.csat_score) AS avg_csat
                FROM kirana_kart.csat_responses cr
                JOIN kirana_kart.hitl_queue hq ON hq.ticket_id = cr.ticket_id
                WHERE hq.resolved_by = :aid
                  AND hq.resolved_at BETWEEN :from_dt AND :to_dt
            """),
            {"aid": agent_id, "from_dt": date_from, "to_dt": date_to},
        ).mappings().first()

        # Approval rate
        approval = session.execute(
            text("""
                SELECT
                    COUNT(*) FILTER (WHERE action_type = 'APPROVE_AI_REC') AS approved,
                    COUNT(*) FILTER (WHERE action_type IN ('APPROVE_AI_REC','REJECT_AI_REC')) AS total
                FROM kirana_kart.crm_agent_actions
                WHERE actor_id = :aid AND created_at BETWEEN :from_dt AND :to_dt
            """),
            {"aid": agent_id, "from_dt": date_from, "to_dt": date_to},
        ).mappings().first()

        # Recent actions
        recent = session.execute(
            text("""
                SELECT a.*, u.full_name AS actor_name
                FROM kirana_kart.crm_agent_actions a
                JOIN kirana_kart.users u ON u.id = a.actor_id
                WHERE a.actor_id = :aid
                ORDER BY a.created_at DESC
                LIMIT 20
            """),
            {"aid": agent_id},
        ).mappings().fetchall()

    queue_by_status = {r["status"]: int(r["cnt"]) for r in my_queue}
    h = dict(handled) if handled else {}
    appr = dict(approval) if approval else {}
    approval_rate = (
        (float(appr.get("approved", 0)) / float(appr["total"]))
        if appr.get("total") else None
    )

    return {
        "my_queue": queue_by_status,
        "tickets_handled": int(h.get("tickets_handled") or 0),
        "avg_resolution_time_minutes": float(h.get("avg_resolution_minutes") or 0),
        "avg_first_response_time_minutes": float(h.get("avg_first_response_minutes") or 0),
        "csat_average": float(csat["avg_csat"]) if csat and csat["avg_csat"] else None,
        "approval_rate": approval_rate,
        "recent_actions": [dict(r) for r in recent],
    }


# ---------------------------------------------------------------------------
# Admin dashboard
# ---------------------------------------------------------------------------


def get_admin_dashboard(date_from: str, date_to: str) -> dict:
    with get_db_session() as session:
        # Queue health grid
        queue_health = session.execute(
            text("""
                SELECT queue_type, status, COUNT(*) AS count
                FROM kirana_kart.hitl_queue
                GROUP BY queue_type, status
                ORDER BY queue_type, status
            """)
        ).mappings().fetchall()

        # SLA compliance per queue
        sla_compliance = session.execute(
            text("""
                SELECT
                    queue_type,
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE NOT sla_breached) AS compliant
                FROM kirana_kart.hitl_queue
                WHERE created_at BETWEEN :from_dt AND :to_dt
                GROUP BY queue_type
            """),
            {"from_dt": date_from, "to_dt": date_to},
        ).mappings().fetchall()

        # First response compliance
        fr_compliance = session.execute(
            text("""
                SELECT
                    queue_type,
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE NOT first_response_breached) AS compliant
                FROM kirana_kart.hitl_queue
                WHERE created_at BETWEEN :from_dt AND :to_dt
                GROUP BY queue_type
            """),
            {"from_dt": date_from, "to_dt": date_to},
        ).mappings().fetchall()

        # Volume trend
        volume_trend = session.execute(
            text("""
                SELECT DATE(created_at) AS date, COUNT(*) AS count
                FROM kirana_kart.hitl_queue
                WHERE created_at BETWEEN :from_dt AND :to_dt
                GROUP BY DATE(created_at)
                ORDER BY date
            """),
            {"from_dt": date_from, "to_dt": date_to},
        ).mappings().fetchall()

        # Agent performance
        agent_perf = session.execute(
            text("""
                SELECT
                    u.id AS agent_id, u.full_name AS agent_name,
                    COUNT(hq.id) FILTER (WHERE hq.resolved_by = u.id
                        AND hq.resolved_at BETWEEN :from_dt AND :to_dt) AS tickets_handled,
                    AVG(EXTRACT(EPOCH FROM (hq.resolved_at - hq.created_at)) / 60)
                        FILTER (WHERE hq.resolved_by = u.id
                            AND hq.resolved_at BETWEEN :from_dt AND :to_dt) AS avg_resolution_time_minutes,
                    AVG(EXTRACT(EPOCH FROM (hq.first_response_at - hq.created_at)) / 60)
                        FILTER (WHERE hq.resolved_by = u.id
                            AND hq.resolved_at BETWEEN :from_dt AND :to_dt) AS avg_first_response_time_minutes,
                    COUNT(hq.id) FILTER (WHERE hq.assigned_to = u.id
                        AND hq.status NOT IN ('RESOLVED','CLOSED')) AS open_count
                FROM kirana_kart.users u
                JOIN kirana_kart.user_permissions up
                    ON up.user_id = u.id AND up.module = 'crm' AND up.can_edit = TRUE
                LEFT JOIN kirana_kart.hitl_queue hq ON hq.assigned_to = u.id
                GROUP BY u.id, u.full_name
                ORDER BY tickets_handled DESC NULLS LAST
            """),
            {"from_dt": date_from, "to_dt": date_to},
        ).mappings().fetchall()

        # Aging buckets
        aging = session.execute(
            text("""
                SELECT
                    CASE
                        WHEN NOW() - created_at < INTERVAL '4 hours' THEN '0-4h'
                        WHEN NOW() - created_at < INTERVAL '8 hours' THEN '4-8h'
                        WHEN NOW() - created_at < INTERVAL '24 hours' THEN '8-24h'
                        ELSE '24h+'
                    END AS bucket,
                    COUNT(*) AS count
                FROM kirana_kart.hitl_queue
                WHERE status NOT IN ('RESOLVED','CLOSED')
                GROUP BY bucket
                ORDER BY bucket
            """)
        ).mappings().fetchall()

        # Auto vs HITL ratio
        pathway_counts = session.execute(
            text("""
                SELECT automation_pathway, COUNT(*) AS count
                FROM kirana_kart.hitl_queue
                WHERE created_at BETWEEN :from_dt AND :to_dt
                GROUP BY automation_pathway
            """),
            {"from_dt": date_from, "to_dt": date_to},
        ).mappings().fetchall()

    def _compliance_pct(row):
        if not row["total"]:
            return 0.0
        return round(100.0 * int(row["compliant"]) / int(row["total"]), 1)

    pathway_map = {r["automation_pathway"]: int(r["count"]) for r in pathway_counts}

    return {
        "queue_health": [
            {"queue_type": r["queue_type"], "status": r["status"], "count": int(r["count"])}
            for r in queue_health
        ],
        "sla_compliance": [
            {"queue_type": r["queue_type"], "compliance_pct": _compliance_pct(r), "total": int(r["total"])}
            for r in sla_compliance
        ],
        "first_response_compliance": [
            {"queue_type": r["queue_type"], "compliance_pct": _compliance_pct(r)}
            for r in fr_compliance
        ],
        "volume_trend": [
            {"date": str(r["date"]), "count": int(r["count"])}
            for r in volume_trend
        ],
        "agent_performance": [dict(r) for r in agent_perf],
        "aging_buckets": [
            {"bucket": r["bucket"], "count": int(r["count"])}
            for r in aging
        ],
        "auto_vs_hitl": {
            "hitl": pathway_map.get("HITL", 0),
            "manual": pathway_map.get("MANUAL_REVIEW", 0),
        },
    }


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def get_report(
    report_type: str,
    date_from: str,
    date_to: str,
    queue_type: str | None = None,
    agent_id: int | None = None,
) -> list:
    params: dict[str, Any] = {"from_dt": date_from, "to_dt": date_to}
    extra_filter = ""
    if queue_type:
        extra_filter += " AND hq.queue_type = :queue_type"
        params["queue_type"] = queue_type
    if agent_id:
        extra_filter += " AND hq.assigned_to = :agent_id"
        params["agent_id"] = agent_id

    if report_type == "queue_aging":
        query = f"""
            SELECT
                hq.id, hq.ticket_id, hq.queue_type, hq.status, hq.priority,
                hq.assigned_to, u.full_name AS agent_name,
                hq.sla_due_at, hq.sla_breached,
                EXTRACT(EPOCH FROM (NOW() - hq.created_at)) / 3600 AS age_hours,
                hq.created_at
            FROM kirana_kart.hitl_queue hq
            LEFT JOIN kirana_kart.users u ON u.id = hq.assigned_to
            WHERE hq.created_at BETWEEN :from_dt AND :to_dt
              AND hq.status NOT IN ('RESOLVED','CLOSED')
              {extra_filter}
            ORDER BY hq.created_at ASC
        """
    elif report_type == "agent_performance":
        query = f"""
            SELECT
                u.id AS agent_id, u.full_name AS agent_name,
                COUNT(hq.id) AS tickets_handled,
                AVG(EXTRACT(EPOCH FROM (hq.resolved_at - hq.created_at)) / 60) AS avg_resolution_minutes,
                AVG(EXTRACT(EPOCH FROM (hq.first_response_at - hq.created_at)) / 60) AS avg_first_response_minutes,
                COUNT(hq.id) FILTER (WHERE hq.sla_breached) AS sla_breaches,
                COUNT(hq.id) FILTER (WHERE hq.status NOT IN ('RESOLVED','CLOSED')) AS open_count
            FROM kirana_kart.users u
            JOIN kirana_kart.user_permissions up ON up.user_id = u.id AND up.module = 'crm' AND up.can_edit = TRUE
            LEFT JOIN kirana_kart.hitl_queue hq
                ON hq.assigned_to = u.id AND hq.created_at BETWEEN :from_dt AND :to_dt {extra_filter}
            GROUP BY u.id, u.full_name
            ORDER BY tickets_handled DESC NULLS LAST
        """
    elif report_type == "sla_report":
        query = f"""
            SELECT
                hq.queue_type,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE NOT hq.sla_breached) AS sla_met,
                COUNT(*) FILTER (WHERE hq.sla_breached) AS sla_breached_count,
                ROUND(100.0 * COUNT(*) FILTER (WHERE NOT hq.sla_breached) / NULLIF(COUNT(*),0), 1) AS compliance_pct,
                AVG(EXTRACT(EPOCH FROM (hq.resolved_at - hq.created_at)) / 60) AS avg_resolution_minutes
            FROM kirana_kart.hitl_queue hq
            WHERE hq.created_at BETWEEN :from_dt AND :to_dt {extra_filter}
            GROUP BY hq.queue_type
            ORDER BY hq.queue_type
        """
    elif report_type == "resolution_summary":
        query = f"""
            SELECT
                hq.id, hq.ticket_id, hq.queue_type, hq.status,
                hq.ai_action_code, hq.final_action_code,
                hq.ai_refund_amount, hq.final_refund_amount,
                u.full_name AS resolved_by_name,
                hq.resolved_at, hq.created_at,
                EXTRACT(EPOCH FROM (hq.resolved_at - hq.created_at)) / 60 AS resolution_minutes
            FROM kirana_kart.hitl_queue hq
            LEFT JOIN kirana_kart.users u ON u.id = hq.resolved_by
            WHERE hq.status IN ('RESOLVED','CLOSED')
              AND hq.resolved_at BETWEEN :from_dt AND :to_dt {extra_filter}
            ORDER BY hq.resolved_at DESC
        """
    else:
        raise ValueError(f"Unknown report_type: {report_type}")

    with get_db_session() as session:
        rows = session.execute(text(query), params).mappings().fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Auto-escalation (Celery Beat task)
# ---------------------------------------------------------------------------


def auto_escalate_overdue() -> int:
    """Find OPEN/IN_PROGRESS tickets past sla_due_at → move to ESCALATION_QUEUE."""
    now = _now()
    new_sla = _sla_due("ESCALATION_QUEUE", now)
    new_fr = _first_response_due("ESCALATION_QUEUE", now)

    with get_db_session() as session:
        overdue = session.execute(
            text("""
                SELECT id, ticket_id, assigned_to FROM kirana_kart.hitl_queue
                WHERE sla_due_at < NOW()
                  AND status IN ('OPEN','IN_PROGRESS')
                  AND sla_breach_notified = FALSE
            """)
        ).mappings().fetchall()

        count = 0
        for row in overdue:
            session.execute(
                text("""
                    UPDATE kirana_kart.hitl_queue
                    SET queue_type = 'ESCALATION_QUEUE',
                        status = 'ESCALATED',
                        sla_breached = TRUE,
                        sla_breach_notified = TRUE,
                        sla_due_at = :new_sla,
                        first_response_due_at = :new_fr,
                        escalation_reason = 'Auto-escalated: SLA breach',
                        updated_at = NOW()
                    WHERE id = :qid
                """),
                {"qid": row["id"], "new_sla": new_sla, "new_fr": new_fr},
            )
            # Notify assignee if present
            if row["assigned_to"]:
                _create_notification(
                    session, row["assigned_to"], "SLA_BREACHED",
                    f"SLA breached — ticket #{row['ticket_id']} auto-escalated",
                    ticket_id=row["ticket_id"], queue_id=row["id"],
                )
            count += 1

    logger.info("Auto-escalated %d overdue CRM tickets", count)
    return count


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


def list_groups(include_inactive: bool = False) -> list[dict]:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT g.id, g.name, g.description, g.group_type, g.routing_strategy,
                       g.is_active, g.created_at,
                       COUNT(m.user_id) AS member_count
                FROM kirana_kart.crm_groups g
                LEFT JOIN kirana_kart.crm_group_members m ON m.group_id = g.id
                WHERE (:inc_inactive OR g.is_active = TRUE)
                GROUP BY g.id
                ORDER BY g.name ASC
            """),
            {"inc_inactive": include_inactive},
        ).mappings().fetchall()
        return [dict(r) for r in rows]


def get_group(group_id: int) -> dict | None:
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT g.id, g.name, g.description, g.group_type, g.routing_strategy,
                       g.is_active, g.created_at,
                       COUNT(m.user_id) AS member_count
                FROM kirana_kart.crm_groups g
                LEFT JOIN kirana_kart.crm_group_members m ON m.group_id = g.id
                WHERE g.id = :gid
                GROUP BY g.id
            """),
            {"gid": group_id},
        ).mappings().first()
        if not row:
            return None
        result = dict(row)
        # Fetch members
        members = session.execute(
            text("""
                SELECT m.user_id, m.role, m.added_at,
                       u.email, u.full_name, u.crm_availability
                FROM kirana_kart.crm_group_members m
                JOIN kirana_kart.users u ON u.id = m.user_id
                WHERE m.group_id = :gid
                ORDER BY u.full_name ASC
            """),
            {"gid": group_id},
        ).mappings().fetchall()
        result["members"] = [dict(m) for m in members]
        return result


def create_group(
    name: str,
    description: str | None,
    group_type: str,
    routing_strategy: str,
    creator: UserContext,
) -> dict:
    valid_types = {"SUPPORT", "FRAUD_REVIEW", "ESCALATION", "SENIOR_REVIEW", "CUSTOM"}
    valid_strategies = {"ROUND_ROBIN", "LEAST_BUSY", "MANUAL"}
    if group_type not in valid_types:
        raise ValueError(f"Invalid group_type: {group_type}")
    if routing_strategy not in valid_strategies:
        raise ValueError(f"Invalid routing_strategy: {routing_strategy}")
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_groups
                    (name, description, group_type, routing_strategy, created_by)
                VALUES (:name, :desc, :gtype, :strategy, :creator)
                RETURNING id, name, description, group_type, routing_strategy, is_active, created_at
            """),
            {
                "name": name, "desc": description,
                "gtype": group_type, "strategy": routing_strategy,
                "creator": creator.id,
            },
        ).mappings().first()
        result = dict(row)
        result["member_count"] = 0
        result["members"] = []
        return result


def update_group(
    group_id: int,
    name: str | None,
    description: str | None,
    group_type: str | None,
    routing_strategy: str | None,
    is_active: bool | None,
) -> dict | None:
    updates = []
    params: dict[str, Any] = {"gid": group_id}
    if name is not None:
        updates.append("name = :name"); params["name"] = name
    if description is not None:
        updates.append("description = :desc"); params["desc"] = description
    if group_type is not None:
        updates.append("group_type = :gtype"); params["gtype"] = group_type
    if routing_strategy is not None:
        updates.append("routing_strategy = :strategy"); params["strategy"] = routing_strategy
    if is_active is not None:
        updates.append("is_active = :active"); params["active"] = is_active
    if not updates:
        return get_group(group_id)
    with get_db_session() as session:
        session.execute(
            text(f"UPDATE kirana_kart.crm_groups SET {', '.join(updates)} WHERE id = :gid"),
            params,
        )
    return get_group(group_id)


def add_group_member(group_id: int, user_id: int, role: str = "AGENT") -> None:
    valid_roles = {"AGENT", "LEAD", "MANAGER"}
    if role not in valid_roles:
        role = "AGENT"
    with get_db_session() as session:
        session.execute(
            text("""
                INSERT INTO kirana_kart.crm_group_members (group_id, user_id, role)
                VALUES (:gid, :uid, :role)
                ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role
            """),
            {"gid": group_id, "uid": user_id, "role": role},
        )


def remove_group_member(group_id: int, user_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("DELETE FROM kirana_kart.crm_group_members WHERE group_id = :gid AND user_id = :uid"),
            {"gid": group_id, "uid": user_id},
        )


def assign_ticket_to_group(queue_id: int, group_id: int, actor: UserContext) -> dict:
    """Assign ticket to a group and auto-dispatch based on routing strategy."""
    from app.admin.services.crm_automation_engine import _auto_dispatch_to_group
    with get_db_session() as session:
        hq = session.execute(
            text("SELECT id, ticket_id FROM kirana_kart.hitl_queue WHERE id = :qid"),
            {"qid": queue_id},
        ).fetchone()
        if not hq:
            raise ValueError(f"Queue item {queue_id} not found")

        grp = session.execute(
            text("SELECT id, name, routing_strategy FROM kirana_kart.crm_groups WHERE id = :gid AND is_active = TRUE"),
            {"gid": group_id},
        ).fetchone()
        if not grp:
            raise ValueError(f"Group {group_id} not found or inactive")

        session.execute(
            text("UPDATE kirana_kart.hitl_queue SET group_id = :gid, updated_at = NOW() WHERE id = :qid"),
            {"gid": group_id, "qid": queue_id},
        )

        dispatched = False
        if grp.routing_strategy in ("ROUND_ROBIN", "LEAST_BUSY"):
            _auto_dispatch_to_group(group_id, queue_id, hq.ticket_id, grp.routing_strategy, session)
            dispatched = True

        _log_action(session, hq.ticket_id, queue_id, actor.id, "REASSIGN",
                    after_value={"group_id": group_id, "group_name": grp.name})

    return {"queue_id": queue_id, "group_id": group_id, "auto_dispatched": dispatched}


# ---------------------------------------------------------------------------
# SLA Policies
# ---------------------------------------------------------------------------


def list_sla_policies() -> list[dict]:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT p.id, p.queue_type, p.resolution_minutes, p.first_response_minutes,
                       p.is_active, p.updated_at,
                       u.full_name AS updated_by_name
                FROM kirana_kart.crm_sla_policies p
                LEFT JOIN kirana_kart.users u ON u.id = p.updated_by
                ORDER BY p.resolution_minutes ASC
            """)
        ).mappings().fetchall()
        return [dict(r) for r in rows]


def update_sla_policy(
    queue_type: str,
    resolution_minutes: int | None,
    first_response_minutes: int | None,
    actor: UserContext,
) -> dict | None:
    if queue_type not in VALID_QUEUE_TYPES:
        raise ValueError(f"Invalid queue_type: {queue_type}")
    updates = ["updated_at = NOW()", "updated_by = :actor"]
    params: dict[str, Any] = {"qt": queue_type, "actor": actor.id}
    if resolution_minutes is not None:
        if resolution_minutes < 1:
            raise ValueError("resolution_minutes must be >= 1")
        updates.append("resolution_minutes = :res")
        params["res"] = resolution_minutes
    if first_response_minutes is not None:
        if first_response_minutes < 1:
            raise ValueError("first_response_minutes must be >= 1")
        updates.append("first_response_minutes = :fr")
        params["fr"] = first_response_minutes
    with get_db_session() as session:
        session.execute(
            text(f"""
                UPDATE kirana_kart.crm_sla_policies
                SET {', '.join(updates)}
                WHERE queue_type = :qt
            """),
            params,
        )
    rows = list_sla_policies()
    return next((r for r in rows if r["queue_type"] == queue_type), None)


# ---------------------------------------------------------------------------
# Automation Rules CRUD
# ---------------------------------------------------------------------------


def list_automation_rules() -> list[dict]:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT r.id, r.name, r.description, r.trigger_event,
                       r.condition_logic, r.conditions, r.actions,
                       r.is_active, r.priority, r.run_count, r.last_run_at,
                       r.is_seeded, r.created_at, r.updated_at,
                       u.full_name AS created_by_name
                FROM kirana_kart.crm_automation_rules r
                LEFT JOIN kirana_kart.users u ON u.id = r.created_by
                ORDER BY r.priority ASC, r.id ASC
            """)
        ).mappings().fetchall()
        result = []
        for r in rows:
            row = dict(r)
            # Ensure conditions/actions are lists
            if isinstance(row.get("conditions"), str):
                import json
                row["conditions"] = json.loads(row["conditions"] or "[]")
            if isinstance(row.get("actions"), str):
                import json
                row["actions"] = json.loads(row["actions"] or "[]")
            result.append(row)
        return result


def create_automation_rule(
    name: str,
    trigger_event: str,
    conditions: list[dict],
    actions: list[dict],
    description: str | None = None,
    condition_logic: str = "AND",
    priority: int = 100,
    actor: UserContext | None = None,
) -> dict:
    import json
    valid_triggers = {"TICKET_CREATED", "TICKET_UPDATED", "SLA_WARNING", "SLA_BREACHED"}
    if trigger_event not in valid_triggers:
        raise ValueError(f"Invalid trigger_event: {trigger_event}")
    if condition_logic not in ("AND", "OR"):
        condition_logic = "AND"
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_automation_rules
                    (name, description, trigger_event, condition_logic,
                     conditions, actions, priority, created_by)
                VALUES
                    (:name, :desc, :trigger, :logic,
                     CAST(:conds AS jsonb), CAST(:acts AS jsonb), :priority, :creator)
                RETURNING id
            """),
            {
                "name": name, "desc": description,
                "trigger": trigger_event, "logic": condition_logic,
                "conds": json.dumps(conditions), "acts": json.dumps(actions),
                "priority": priority,
                "creator": actor.id if actor else None,
            },
        ).fetchone()
        return {"id": row.id, "name": name, "trigger_event": trigger_event,
                "is_active": True, "is_seeded": False}


def update_automation_rule(
    rule_id: int,
    name: str | None = None,
    description: str | None = None,
    trigger_event: str | None = None,
    conditions: list | None = None,
    actions: list | None = None,
    condition_logic: str | None = None,
    priority: int | None = None,
    is_active: bool | None = None,
) -> None:
    import json
    updates = ["updated_at = NOW()"]
    params: dict[str, Any] = {"rid": rule_id}
    if name is not None:          updates.append("name = :name");           params["name"] = name
    if description is not None:   updates.append("description = :desc");    params["desc"] = description
    if trigger_event is not None: updates.append("trigger_event = :trigger"); params["trigger"] = trigger_event
    if conditions is not None:    updates.append("conditions = CAST(:conds AS jsonb)"); params["conds"] = json.dumps(conditions)
    if actions is not None:       updates.append("actions = CAST(:acts AS jsonb)");  params["acts"] = json.dumps(actions)
    if condition_logic is not None: updates.append("condition_logic = :logic"); params["logic"] = condition_logic
    if priority is not None:      updates.append("priority = :priority");   params["priority"] = priority
    if is_active is not None:     updates.append("is_active = :active");    params["active"] = is_active
    with get_db_session() as session:
        session.execute(
            text(f"UPDATE kirana_kart.crm_automation_rules SET {', '.join(updates)} WHERE id = :rid"),
            params,
        )


def delete_automation_rule(rule_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("DELETE FROM kirana_kart.crm_automation_rules WHERE id = :rid"),
            {"rid": rule_id},
        )


def toggle_automation_rule(rule_id: int) -> bool:
    """Toggle is_active. Returns new state."""
    with get_db_session() as session:
        row = session.execute(
            text("""
                UPDATE kirana_kart.crm_automation_rules
                SET is_active = NOT is_active, updated_at = NOW()
                WHERE id = :rid
                RETURNING is_active
            """),
            {"rid": rule_id},
        ).fetchone()
        return row.is_active if row else False


# ---------------------------------------------------------------------------
# Group Integrations
# ---------------------------------------------------------------------------

import secrets as _secrets
import hashlib as _hashlib

def _hash_group_key(raw: str) -> str:
    return "sha256:" + _hashlib.sha256(raw.encode()).hexdigest()



def list_group_integrations(group_id: int) -> list[dict]:
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, group_id, type, name, config, is_active,
                       CASE WHEN api_key IS NOT NULL
                            THEN 'kk_grp_••••••••'
                            ELSE NULL END AS api_key_masked,
                       api_key,
                       created_at, updated_at
                FROM kirana_kart.crm_group_integrations
                WHERE group_id = :gid
                ORDER BY created_at ASC
            """),
            {"gid": group_id},
        ).mappings().fetchall()
        result = []
        for r in rows:
            d = dict(r)
            # Mask full api key; only return masked version
            d.pop("api_key", None)
            result.append(d)
        return result


def create_group_integration(
    group_id: int,
    integration_type: str,
    name: str,
    config: dict,
    creator_id: int,
) -> dict:
    valid_types = {"SMTP_INBOUND", "API_KEY", "WEBHOOK", "CARDINAL_RULE"}
    if integration_type not in valid_types:
        raise ValueError(f"Invalid type: {integration_type}")
    api_key = None
    if integration_type == "API_KEY":
        api_key = f"kk_grp_{_secrets.token_urlsafe(24)}"
    with get_db_session() as session:
        import json as _json
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.crm_group_integrations
                    (group_id, type, name, config, api_key, created_by)
                VALUES (:gid, :type, :name, CAST(:config AS jsonb), :key, :creator)
                RETURNING id, group_id, type, name, config, is_active, api_key, created_at
            """),
            {
                "gid": group_id, "type": integration_type, "name": name,
                "config": _json.dumps(config), "key": _hash_group_key(api_key) if api_key else None, "creator": creator_id,
            },
        ).mappings().first()
        result = dict(row)
        if integration_type == "API_KEY" and api_key:
            result["api_key_full"] = api_key  # Return full key only on creation
            result["api_key_masked"] = api_key[:8] + "••••••••"
        result.pop("api_key", None)
        return result


def update_group_integration(
    integration_id: int,
    config: dict | None = None,
    is_active: bool | None = None,
    name: str | None = None,
) -> dict | None:
    import json as _json
    updates = ["updated_at = NOW()"]
    params: dict[str, Any] = {"iid": integration_id}
    if config is not None:
        updates.append("config = CAST(:config AS jsonb)")
        params["config"] = _json.dumps(config)
    if is_active is not None:
        updates.append("is_active = :active")
        params["active"] = is_active
    if name is not None:
        updates.append("name = :name")
        params["name"] = name
    with get_db_session() as session:
        session.execute(
            text(f"UPDATE kirana_kart.crm_group_integrations SET {', '.join(updates)} WHERE id = :iid"),
            params,
        )
    return {"id": integration_id, "updated": True}


def delete_group_integration(integration_id: int) -> None:
    with get_db_session() as session:
        session.execute(
            text("DELETE FROM kirana_kart.crm_group_integrations WHERE id = :iid"),
            {"iid": integration_id},
        )


def regenerate_api_key(integration_id: int) -> dict:
    new_key = f"kk_grp_{_secrets.token_urlsafe(24)}"
    with get_db_session() as session:
        row = session.execute(
            text("""
                UPDATE kirana_kart.crm_group_integrations
                SET api_key = :key, updated_at = NOW()
                WHERE id = :iid AND type = 'API_KEY'
                RETURNING id
            """),
            {"key": _hash_group_key(new_key), "iid": integration_id},
        ).fetchone()
        if not row:
            raise ValueError("API_KEY integration not found")
    return {
        "integration_id": integration_id,
        "api_key_full": new_key,
        "api_key_masked": new_key[:8] + "••••••••",
    }


# ---------------------------------------------------------------------------
# Test Ticket Seeding
# ---------------------------------------------------------------------------

TEST_SCENARIOS = [
    {
        "subject": "Order #ORD-2841 never arrived — GPS shows driver left area",
        "description": "I placed an order at 7:30 PM. The driver marked it delivered but I never received it. GPS shows the driver was 2km away from my address. Please refund.",
        "cx_email": "priya.sharma@gmail.com",
        "module": "delivery",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "REFUND_FULL",
        "ai_refund_amount": 450.00,
        "ai_confidence": 0.88,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "GPS data confirms driver did not reach customer address (distance: 2.1km). Delivery failure verified. Full refund eligible per R-001.",
        "customer_segment": "standard",
        "priority": 3,
        "label": "Undelivered - GPS Unconfirmed",
    },
    {
        "subject": "Found a cockroach in my biryani — food safety issue",
        "description": "Received my order and found a cockroach inside the food container. This is a severe food safety violation. Attaching photo evidence. Demand full refund plus compensation.",
        "cx_email": "rahul.verma@outlook.com",
        "module": "quality",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "REFUND_FULL",
        "ai_refund_amount": 320.00,
        "ai_confidence": 0.94,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "Food safety violation confirmed. Foreign object (cockroach) reported with photo evidence within 2-hour complaint window. Full refund + ₹100 compensation per R-007 food safety matrix.",
        "customer_segment": "gold",
        "priority": 2,
        "label": "Food Safety - Foreign Object",
    },
    {
        "subject": "Refund request for missing items in order",
        "description": "5 items in my order were missing. This is the 4th time this month I am raising a complaint. Please process my refund immediately.",
        "cx_email": "frequent.complainer@yahoo.com",
        "module": "missing_items",
        "automation_pathway": "MANUAL_REVIEW",
        "queue_type": "MANUAL_REVIEW",
        "ai_action_code": "MANUAL_REVIEW_REPEAT",
        "ai_refund_amount": None,
        "ai_confidence": 0.95,
        "ai_fraud_segment": "MEDIUM",
        "ai_reasoning": "Customer has 4 refund requests in the last 30 days, exceeding the 3-request threshold. Flagged for manual review per R-004.",
        "customer_segment": "standard",
        "priority": 2,
        "label": "Repeat Refunder - Manual Review Required",
    },
    {
        "subject": "Premium order for corporate event completely spoiled",
        "description": "Ordered catering worth ₹2,800 for our office event. All food arrived cold and spoiled. This is unacceptable for a premium order. Need full refund immediately.",
        "cx_email": "corporate.client@techcorp.com",
        "module": "quality",
        "automation_pathway": "HITL",
        "queue_type": "SENIOR_REVIEW",
        "ai_action_code": "ESCALATE_MANAGER",
        "ai_refund_amount": 2800.00,
        "ai_confidence": 0.86,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "Refund amount ₹2,800 exceeds ₹2,000 threshold. Manager approval required per R-006 escalation matrix. Quality issue (QUALITY_SPOILED) confirmed.",
        "customer_segment": "platinum",
        "priority": 1,
        "label": "High-Value Escalation - Manager Approval",
    },
    {
        "subject": "Delivery boy denied access — GPS data not available",
        "description": "The delivery person claims he tried to deliver but I was home all evening. There is no GPS record for my order delivery in the app. Please investigate and refund.",
        "cx_email": "ananya.krishnan@gmail.com",
        "module": "delivery",
        "automation_pathway": "MANUAL_REVIEW",
        "queue_type": "MANUAL_REVIEW",
        "ai_action_code": "MANUAL_REVIEW_GPS_MISSING",
        "ai_refund_amount": None,
        "ai_confidence": 0.70,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "No GPS delivery event found in delivery_events table for this order_id. Cannot verify delivery status. Human verification required per GPS-001.",
        "customer_segment": "standard",
        "priority": 3,
        "label": "GPS Data Missing - Manual Verification",
    },
    {
        "subject": "I did not receive my order but it shows delivered",
        "description": "App shows delivered but I never got my food. This has happened multiple times. I have filed GPS disputes before. My refund rate might be high but this is genuine.",
        "cx_email": "suspicious.user@gmail.com",
        "module": "delivery",
        "automation_pathway": "MANUAL_REVIEW",
        "queue_type": "ESCALATION_QUEUE",
        "ai_action_code": "REJECT_FRAUD",
        "ai_refund_amount": 0.00,
        "ai_confidence": 0.95,
        "ai_fraud_segment": "VERY_HIGH",
        "ai_reasoning": "Multiple fraud signals triggered: refund_rate_30d=0.73 (>0.5), complaints_30d=8 (>5), marked_delivered_90d=5 (>3). Greedy classification: FRAUD. Rejecting refund and flagging for investigation.",
        "customer_segment": "standard",
        "priority": 1,
        "label": "Fraud Detected - VERY_HIGH Risk",
    },
    {
        "subject": "Missing 3 items from my order, want partial refund",
        "description": "Ordered biryani, raita and dessert. Only biryani arrived. Missing raita (₹150) and gulab jamun (₹120). Please refund for missing items.",
        "cx_email": "normal.customer@gmail.com",
        "module": "missing_items",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "ESCALATE_GRADE3",
        "ai_refund_amount": 750.00,
        "ai_confidence": 0.85,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "Missing items confirmed (MISSING_ITEMS_PARTIAL). Refund amount ₹750 is in ₹501-₹999 range requiring Grade 3 agent sign-off per R-006.",
        "customer_segment": "standard",
        "priority": 2,
        "label": "Grade 3 Escalation - ₹750 Refund",
    },
    {
        "subject": "Food arrived but not sure if quality issue or normal",
        "description": "My food arrived and it looks slightly different from the photo. Temperature seems off. Not sure if this is a genuine complaint or expected variation. Need guidance.",
        "cx_email": "unsure.customer@gmail.com",
        "module": "quality",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "REFUND_PARTIAL",
        "ai_refund_amount": 180.00,
        "ai_confidence": 0.38,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "Ambiguous quality complaint. Low confidence in classification. Evidence unclear — temperature complaint may qualify for partial refund (QUALITY_TEMPERATURE_COLD: 40%) but uncertain. Requires human review.",
        "customer_segment": "standard",
        "priority": 2,
        "label": "Low Confidence - Human Review Needed",
    },
    {
        "subject": "Order delivered but food was completely spoiled",
        "description": "Received my order but everything was rotten and had a strong smell. This cannot be eaten. I deserve a full refund for this health hazard.",
        "cx_email": "high.value.customer@gmail.com",
        "module": "quality",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "REFUND_FULL",
        "ai_refund_amount": 600.00,
        "ai_confidence": 0.82,
        "ai_fraud_segment": "HIGH",
        "ai_reasoning": "QUALITY_SPOILED confirmed. Full refund eligible per R-007. Note: fraud_segment=HIGH due to refund_rate_30d=0.52. Flagged for senior review before processing.",
        "customer_segment": "gold",
        "priority": 2,
        "label": "Suspicious High-Refund - Fraud HIGH + ₹600",
    },
    {
        "subject": "Food was cold and portion sizes were very small",
        "description": "Ordered dal makhani and paneer butter masala. Both arrived cold (below room temperature) and portions were half of what I normally get. Requesting partial refund.",
        "cx_email": "regular.customer@gmail.com",
        "module": "quality",
        "automation_pathway": "HITL",
        "queue_type": "STANDARD_REVIEW",
        "ai_action_code": "REFUND_PARTIAL",
        "ai_refund_amount": 350.00,
        "ai_confidence": 0.90,
        "ai_fraud_segment": "LOW",
        "ai_reasoning": "QUALITY_TEMPERATURE_COLD (40%) + QUALITY_PORTION_SMALL (30%) = combined partial refund at 35% of ₹980 = ₹343 (rounded to ₹350). Evidence submitted within 2-hour window.",
        "customer_segment": "standard",
        "priority": 3,
        "label": "Quality Issue - Cold + Small Portions",
    },
]


def seed_test_tickets() -> dict:
    """Create 10 test tickets directly in the queue to demonstrate the full CRM flow."""
    import json as _json

    created = []
    skipped = 0

    with get_db_session() as session:
        # Check if test tickets already exist (by checking for specific test emails)
        test_emails = [s["cx_email"] for s in TEST_SCENARIOS]
        existing = session.execute(
            text("""
                SELECT DISTINCT cx_email FROM kirana_kart.hitl_queue
                WHERE cx_email = ANY(:emails)
            """),
            {"emails": test_emails},
        ).fetchall()
        existing_emails = {r[0] for r in existing}

    for scenario in TEST_SCENARIOS:
        if scenario["cx_email"] in existing_emails:
            skipped += 1
            continue

        try:
            with get_db_session() as session:
                # 1. Generate a unique ticket_id (fdraw.ticket_id has no default)
                max_row = session.execute(
                    text("SELECT COALESCE(MAX(ticket_id), 990000) + 1 FROM kirana_kart.fdraw")
                ).fetchone()
                ticket_id = max_row[0] + len(created)

                # Insert into fdraw (raw ticket) - requires ticket_id and group_id
                session.execute(
                    text("""
                        INSERT INTO kirana_kart.fdraw
                            (ticket_id, group_id, subject, description, cx_email, module, created_at)
                        VALUES (:tid, '1', :subject, :desc, :email, :module, NOW())
                    """),
                    {
                        "tid": ticket_id,
                        "subject": scenario["subject"],
                        "desc": scenario["description"],
                        "email": scenario["cx_email"],
                        "module": scenario["module"],
                    },
                )

                # 2. Compute SLA timestamps
                queue_type = scenario["queue_type"]
                sla_minutes = _get_sla_resolution_minutes(queue_type)
                fr_minutes = _get_sla_first_response_minutes(queue_type)
                now = _now()
                sla_due = now + timedelta(minutes=sla_minutes)
                fr_due = now + timedelta(minutes=fr_minutes)

                # 3. Insert into hitl_queue
                hq_row = session.execute(
                    text("""
                        INSERT INTO kirana_kart.hitl_queue (
                            ticket_id, automation_pathway, queue_type, status, priority,
                            sla_due_at, first_response_due_at,
                            ai_action_code, ai_refund_amount, ai_confidence,
                            ai_fraud_segment, ai_reasoning,
                            cx_email, customer_segment, subject,
                            created_at, updated_at
                        ) VALUES (
                            :tid, :pathway, :qtype, 'OPEN', :priority,
                            :sla_due, :fr_due,
                            :ai_code, :ai_refund, :ai_conf,
                            :ai_fraud, :ai_reason,
                            :email, :segment, :subject,
                            NOW(), NOW()
                        )
                        RETURNING id
                    """),
                    {
                        "tid": ticket_id,
                        "pathway": scenario["automation_pathway"],
                        "qtype": queue_type,
                        "priority": scenario["priority"],
                        "sla_due": sla_due,
                        "fr_due": fr_due,
                        "ai_code": scenario["ai_action_code"],
                        "ai_refund": scenario.get("ai_refund_amount"),
                        "ai_conf": scenario["ai_confidence"],
                        "ai_fraud": scenario["ai_fraud_segment"],
                        "ai_reason": scenario.get("ai_reasoning"),
                        "email": scenario["cx_email"],
                        "segment": scenario["customer_segment"],
                        "subject": scenario["subject"],
                    },
                ).fetchone()
                queue_id = hq_row[0]

            # 4. Run automation rules (non-fatal, outside session)
            try:
                from app.admin.services.crm_automation_engine import run_for_ticket
                rules_applied = run_for_ticket("TICKET_CREATED", queue_id)
            except Exception as ae:
                logger.warning("Automation for test ticket %d failed: %s", queue_id, ae)
                rules_applied = 0

            created.append({
                "ticket_id": ticket_id,
                "queue_id": queue_id,
                "label": scenario["label"],
                "queue_type": queue_type,
                "ai_action_code": scenario["ai_action_code"],
                "rules_applied": rules_applied,
            })

        except Exception as e:
            logger.error("Failed to seed test ticket '%s': %s", scenario["label"], e)

    return {
        "created": len(created),
        "skipped": skipped,
        "tickets": created,
    }


def _get_sla_resolution_minutes(queue_type: str) -> int:
    """Get resolution SLA minutes from DB with fallback."""
    try:
        with get_db_session() as session:
            row = session.execute(
                text("SELECT resolution_minutes FROM kirana_kart.crm_sla_policies WHERE queue_type = :qt"),
                {"qt": queue_type},
            ).fetchone()
            if row:
                return row[0]
    except Exception:
        pass
    return SLA_RESOLUTION_MINUTES.get(queue_type, 480)


def _get_sla_first_response_minutes(queue_type: str) -> int:
    """Get first response SLA minutes from DB with fallback."""
    try:
        with get_db_session() as session:
            row = session.execute(
                text("SELECT first_response_minutes FROM kirana_kart.crm_sla_policies WHERE queue_type = :qt"),
                {"qt": queue_type},
            ).fetchone()
            if row:
                return row[0]
    except Exception:
        pass
    return SLA_FIRST_RESPONSE_MINUTES.get(queue_type, 60)
