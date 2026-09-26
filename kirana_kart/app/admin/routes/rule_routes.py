"""
app/admin/routes/rule_routes.py
================================
REST API for per-KB rule editing (RULE_EDIT BPM stage).

All writes seed ml_training_samples for progressive ML improvement.

Endpoints:
  GET    /rules/{kb_id}                      → list rules for a version
  POST   /rules/{kb_id}                      → add a new rule
  PUT    /rules/{kb_id}/{rule_id}            → update a rule
  DELETE /rules/{kb_id}/{rule_id}            → delete a rule
  GET    /rules/{kb_id}/action-codes         → available action codes (dropdown)
  GET    /rules/{kb_id}/validate             → run duplicate/conflict check (stub)

Writes are governed by the Policy Studio lifecycle: a version awaiting
approval or live cannot be edited, and editing a tested proposal returns it
to RULE_EDIT (policy_lifecycle.open_for_editing). Direct edits to a live
version previously changed customer decisions with no review at all.
"""

from __future__ import annotations

import logging
import uuid
from typing import Optional, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.admin.db import engine
from app.admin.routes.auth import UserContext, require_permission
from app.admin.services import policy_knowledge_service as knowledge
from app.admin.services import policy_lifecycle as lifecycle
from app.admin.services.bpm_service import BPMService
from app.admin.services.policy_lifecycle import LifecycleError

logger = logging.getLogger("kirana_kart.rule_routes")

router = APIRouter(prefix="/rules", tags=["Rule Editor"])

_kb_view  = require_permission("knowledgeBase", "view")
_kb_edit  = require_permission("knowledgeBase", "edit")

_bpm_service = BPMService(engine)


# ============================================================
# REQUEST MODELS
# ============================================================

class RuleCreate(BaseModel):
    policy_version: str = Field(min_length=1, max_length=50)
    rule_id: Optional[str] = None          # auto-generated if omitted
    module_name: str = "default"
    rule_type: str = "action"
    priority: int = 500
    rule_scope: str = "global"
    issue_type_l1: str
    issue_type_l2: Optional[str] = None
    business_line: Optional[str] = None
    customer_segment: Optional[str] = None
    fraud_segment: Optional[str] = None
    min_order_value: Optional[float] = None
    max_order_value: Optional[float] = None
    min_repeat_count: Optional[int] = None
    max_repeat_count: Optional[int] = None
    sla_breach_required: bool = False
    evidence_required: bool = False
    conditions: dict = {}
    action_id: int
    action_payload: dict = {}
    deterministic: bool = True
    overrideable: bool = False

    @field_validator("action_payload")
    @classmethod
    def _amounts(cls, v: dict) -> dict:
        # Amounts the runtime applies when this rule decides a ticket.
        from app.l4_agents.rule_engine import validate_payload
        return validate_payload(v)


class RuleUpdate(BaseModel):
    module_name: Optional[str] = None
    rule_type: Optional[str] = None
    priority: Optional[int] = None
    rule_scope: Optional[str] = None
    issue_type_l1: Optional[str] = None
    issue_type_l2: Optional[str] = None
    business_line: Optional[str] = None
    customer_segment: Optional[str] = None
    fraud_segment: Optional[str] = None
    min_order_value: Optional[float] = None
    max_order_value: Optional[float] = None
    min_repeat_count: Optional[int] = None
    max_repeat_count: Optional[int] = None
    sla_breach_required: Optional[bool] = None
    evidence_required: Optional[bool] = None
    conditions: Optional[dict] = None
    action_id: Optional[int] = None
    action_payload: Optional[dict] = None
    deterministic: Optional[bool] = None
    overrideable: Optional[bool] = None
    # Why the reviewer changed the rule; kept with the AI-vs-human diff.
    edit_reason: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("action_payload")
    @classmethod
    def _amounts(cls, v: Optional[dict]) -> Optional[dict]:
        from app.l4_agents.rule_engine import validate_payload
        return None if v is None else validate_payload(v)


# ============================================================
# HELPERS
# ============================================================

def _seed_training_sample(conn, kb_id: str, correction_type: str, input_data: dict, corrected: dict) -> None:
    """
    Record every rule edit as a training sample for Model A. Best effort, in
    a savepoint: a failed insert must not abort the caller's transaction, or
    COMMIT silently rolls back the rule change the user was told succeeded.
    """
    try:
        with conn.begin_nested():
            conn.execute(text("""
            INSERT INTO kirana_kart.ml_training_samples
                (model_name, kb_id, input_data, corrected_output, correction_type)
            VALUES ('rule_extractor', :kb_id, CAST(:input AS jsonb), CAST(:corrected AS jsonb), :ctype)
            """), {
                "kb_id": kb_id,
                "input": __import__("json").dumps(input_data, default=str),
                "corrected": __import__("json").dumps(corrected, default=str),
                "ctype": correction_type,
            })
    except Exception:
        logger.warning("Failed to seed ml_training_samples — skipping", exc_info=True)


_RULE_FIELDS = (
    "module_name", "rule_type", "priority", "rule_scope", "issue_type_l1", "issue_type_l2",
    "business_line", "customer_segment", "fraud_segment", "min_order_value", "max_order_value",
    "min_repeat_count", "max_repeat_count", "sla_breach_required", "evidence_required",
    "conditions", "action_id", "action_payload", "deterministic", "overrideable",
)


def _log_rule_change(conn, kb_id: str, version: str, before: dict, after: dict,
                     edit_type: str, reason: Optional[str], user: UserContext) -> None:
    """
    Record a rule change against what the generator wrote for it, when it
    did, so a correction reads 'AI said X, reviewer set Y' even after
    several edits. Rules written by hand diff against their previous value.
    """
    generated = conn.execute(text("""
        SELECT llm_output FROM kirana_kart.rule_edit_log
        WHERE kb_id = :kb AND entity_id = :v AND stage = 'rule'
          AND item_ref = :ref AND edit_type = 'proposed'
        ORDER BY id DESC LIMIT 1
    """), {"kb": kb_id, "v": version, "ref": before.get("rule_id")}).scalar() or {}
    if isinstance(generated, str):
        generated = __import__("json").loads(generated)
    baseline = {**before, **{k: v for k, v in generated.items() if k in _RULE_FIELDS}}
    changes = knowledge.field_changes(baseline, after, _RULE_FIELDS) if after else None
    if edit_type == "edited" and not changes:
        return
    knowledge.log_edit(
        conn, kb_id=kb_id, entity_id=version, stage="rule", item_ref=before.get("rule_id"),
        edit_type=edit_type, business_line=before.get("business_line"),
        llm_output=generated or None, user_output=after or None,
        reason=(reason or "").strip() or None, actor_id=user.id, changes=changes,
    )


def _require_kb_access(user: UserContext, kb_id: str, required_role: str) -> None:
    if user.is_super_admin:
        return
    if not _bpm_service.check_kb_access(kb_id=kb_id, user_id=user.id, required_role=required_role):
        raise HTTPException(status_code=403, detail=f"You do not have {required_role} access to KB '{kb_id}'")


def _guard_version_write(conn, kb_id: str, version: str, user: UserContext, change: str) -> None:
    """Refuse edits to versions under approval or live; invalidate stale test evidence."""
    try:
        instance = lifecycle.load_proposal(conn, kb_id, version, lock=True)
    except LifecycleError as exc:
        if exc.status_code != 404:
            raise
        instance = None
    if instance:
        lifecycle.open_for_editing(conn, instance, user, change)
        return
    # A version outside Policy Studio: never edit what is or was live.
    active, shadow = lifecycle.runtime_versions(conn)
    published = conn.execute(text("""
        SELECT 1 FROM kirana_kart.knowledge_base_versions WHERE version_label = :v
        UNION ALL
        SELECT 1 FROM kirana_kart.policy_versions WHERE policy_version = :v AND is_active
    """), {"v": version}).first()
    if published or version in (active, shadow):
        raise LifecycleError(409, (
            f"Version '{version}' is published or in live use and cannot be edited. "
            "Create a new policy change instead."
        ))


def _rule_version(conn, kb_id: str, rule_db_id: int) -> str:
    version = conn.execute(text("""
        SELECT policy_version FROM kirana_kart.rule_registry WHERE id = :id AND kb_id = :kb_id
    """), {"id": rule_db_id, "kb_id": kb_id}).scalar()
    if version is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return version


# ============================================================
# ROUTES
# ============================================================

@router.get("/{kb_id}")
def list_rules(
    kb_id: str,
    version: str = Query(..., description="Policy version label"),
    _u: UserContext = Depends(_kb_view),
):
    """Return all rules for a specific KB + policy version."""
    _require_kb_access(_u, kb_id, "view")
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    r.id, r.rule_id, r.policy_version, r.module_name, r.rule_type,
                    r.priority, r.rule_scope, r.issue_type_l1, r.issue_type_l2,
                    r.business_line, r.customer_segment, r.fraud_segment,
                    r.min_order_value, r.max_order_value,
                    r.min_repeat_count, r.max_repeat_count,
                    r.sla_breach_required, r.evidence_required,
                    r.conditions, r.action_id, r.action_payload,
                    r.deterministic, r.overrideable,
                    mac.action_code_id, mac.action_name
                FROM kirana_kart.rule_registry r
                JOIN kirana_kart.master_action_codes mac ON mac.id = r.action_id
                WHERE r.kb_id = :kb_id AND r.policy_version = :version
                ORDER BY r.priority, r.rule_id
            """), {"kb_id": kb_id, "version": version}).mappings().all()
        return jsonable_encoder([dict(r) for r in rows])
    except Exception as e:
        logger.exception("list_rules failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.post("/{kb_id}", status_code=201)
def create_rule(kb_id: str, body: RuleCreate, u: UserContext = Depends(_kb_edit)):
    """Add a new rule to a policy version. Seeds training sample."""
    import json
    _require_kb_access(u, kb_id, "edit")
    try:
        rule_id = body.rule_id or f"R-{uuid.uuid4().hex[:8].upper()}"
        with engine.begin() as conn:
            _guard_version_write(conn, kb_id, body.policy_version, u, f"Rule {rule_id} added")
            if not conn.execute(text("""
                SELECT 1 FROM kirana_kart.master_action_codes WHERE id = :id
            """), {"id": body.action_id}).scalar():
                raise HTTPException(status_code=400, detail="Unknown action")
            row = conn.execute(text("""
                INSERT INTO kirana_kart.rule_registry (
                    kb_id, rule_id, policy_version, module_name, rule_type, priority,
                    rule_scope, issue_type_l1, issue_type_l2, business_line,
                    customer_segment, fraud_segment, min_order_value, max_order_value,
                    min_repeat_count, max_repeat_count, sla_breach_required,
                    evidence_required, conditions, action_id, action_payload,
                    deterministic, overrideable
                ) VALUES (
                    :kb_id, :rule_id, :policy_version, :module_name, :rule_type,
                    :priority, :rule_scope, :issue_type_l1, :issue_type_l2,
                    :business_line, :customer_segment, :fraud_segment,
                    :min_order_value, :max_order_value, :min_repeat_count, :max_repeat_count,
                    :sla_breach_required, :evidence_required, CAST(:conditions AS jsonb),
                    :action_id, CAST(:action_payload AS jsonb), :deterministic, :overrideable
                )
                RETURNING id, rule_id
            """), {
                "kb_id": kb_id,
                "rule_id": rule_id,
                "policy_version": body.policy_version,
                "module_name": body.module_name,
                "rule_type": body.rule_type,
                "priority": body.priority,
                "rule_scope": body.rule_scope,
                "issue_type_l1": body.issue_type_l1,
                "issue_type_l2": body.issue_type_l2,
                "business_line": body.business_line,
                "customer_segment": body.customer_segment,
                "fraud_segment": body.fraud_segment,
                "min_order_value": body.min_order_value,
                "max_order_value": body.max_order_value,
                "min_repeat_count": body.min_repeat_count,
                "max_repeat_count": body.max_repeat_count,
                "sla_breach_required": body.sla_breach_required,
                "evidence_required": body.evidence_required,
                "conditions": json.dumps(body.conditions),
                "action_id": body.action_id,
                "action_payload": json.dumps(body.action_payload),
                "deterministic": body.deterministic,
                "overrideable": body.overrideable,
            }).mappings().first()

            # Seed training sample
            _seed_training_sample(
                conn, kb_id, "manual_add",
                {"policy_version": body.policy_version},
                body.model_dump(),
            )
            knowledge.log_edit(
                conn, kb_id=kb_id, entity_id=body.policy_version, stage="rule", item_ref=rule_id,
                edit_type="manual_add", business_line=body.business_line,
                user_output=body.model_dump(), actor_id=u.id,
            )

        return {"id": row["id"], "rule_id": row["rule_id"]}
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("create_rule failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.put("/{kb_id}/{rule_db_id}")
def update_rule(
    kb_id: str,
    rule_db_id: int,
    body: RuleUpdate,
    u: UserContext = Depends(_kb_edit),
):
    """Partial update of a rule. Only supplied fields are changed. Seeds training sample."""
    import json
    _require_kb_access(u, kb_id, "edit")
    try:
        # Fields sent as null are cleared (e.g. removing an order-value bound);
        # exclude_none used to drop them, so a cleared bound silently stayed.
        # Columns that cannot be null are only ever changed, never cleared.
        updates = body.model_dump(exclude_unset=True)
        reason = updates.pop("edit_reason", None)
        for required in ("module_name", "rule_type", "action_id", "priority", "rule_scope",
                         "issue_type_l1", "conditions", "action_payload", "deterministic",
                         "overrideable", "sla_breach_required", "evidence_required"):
            if required in updates and updates[required] is None:
                updates.pop(required)
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")

        # Build SET clause
        set_parts = []
        params: dict[str, Any] = {"id": rule_db_id, "kb_id": kb_id}
        for key, val in updates.items():
            if key in ("conditions", "action_payload"):
                # CAST, not "::jsonb": SQLAlchemy does not bind ":x::jsonb".
                set_parts.append(f"{key} = CAST(:{key} AS jsonb)")
                params[key] = json.dumps(val)
            else:
                set_parts.append(f"{key} = :{key}")
                params[key] = val

        set_clause = ", ".join(set_parts)

        with engine.begin() as conn:
            version = _rule_version(conn, kb_id, rule_db_id)
            _guard_version_write(conn, kb_id, version, u, f"Rule {rule_db_id} edited")
            if "action_id" in updates and not conn.execute(text("""
                SELECT 1 FROM kirana_kart.master_action_codes WHERE id = :id
            """), {"id": updates["action_id"]}).scalar():
                raise HTTPException(status_code=400, detail="Unknown action")
            before = conn.execute(text("""
                SELECT * FROM kirana_kart.rule_registry WHERE id = :id AND kb_id = :kb_id
            """), {"id": rule_db_id, "kb_id": kb_id}).mappings().first()
            result = conn.execute(text(f"""
                UPDATE kirana_kart.rule_registry
                SET {set_clause}
                WHERE id = :id AND kb_id = :kb_id
                RETURNING id, rule_id
            """), params)
            row = result.mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Rule not found")

            _seed_training_sample(conn, kb_id, "edit", {"rule_db_id": rule_db_id}, updates)
            _log_rule_change(conn, kb_id, version, dict(before), updates, "edited", reason, u)

        return {"id": row["id"], "rule_id": row["rule_id"]}
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("update_rule failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.delete("/{kb_id}/{rule_db_id}", status_code=204)
def delete_rule(
    kb_id: str,
    rule_db_id: int,
    reason: Optional[str] = Query(default=None, max_length=2000),
    u: UserContext = Depends(_kb_edit),
):
    """Delete a rule. Seeds a deletion training sample."""
    _require_kb_access(u, kb_id, "edit")
    try:
        with engine.begin() as conn:
            version = _rule_version(conn, kb_id, rule_db_id)
            _guard_version_write(conn, kb_id, version, u, f"Rule {rule_db_id} removed")
            result = conn.execute(text("""
                DELETE FROM kirana_kart.rule_registry
                WHERE id = :id AND kb_id = :kb_id
                RETURNING *
            """), {"id": rule_db_id, "kb_id": kb_id})
            row = result.mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Rule not found")
            _seed_training_sample(conn, kb_id, "delete", {"rule_db_id": rule_db_id}, {})
            _log_rule_change(conn, kb_id, version, dict(row), {}, "rejected", reason, u)
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("delete_rule failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.get("/{kb_id}/action-codes")
def list_action_codes(kb_id: str, _u: UserContext = Depends(_kb_view)):
    """Return all master action codes for dropdowns."""
    # The previous query selected action_category, requires_approval,
    # is_reversible and severity_level — columns master_action_codes does not
    # have — so every rule editor's action dropdown failed with a 500.
    _require_kb_access(_u, kb_id, "view")
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, action_code_id, action_name, action_description,
                       requires_refund, requires_escalation, automation_eligible
                FROM kirana_kart.master_action_codes
                ORDER BY action_name, action_code_id
            """)).mappings().all()
        return jsonable_encoder([dict(r) for r in rows])
    except Exception as e:
        logger.exception("list_action_codes failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.post("/{kb_id}/import-csv", status_code=201)
async def import_rules_csv(
    kb_id: str,
    file: UploadFile = File(...),
    version_label: str = Form(...),
    u: UserContext = Depends(_kb_edit),
):
    """
    Bulk-import rules from a CSV file directly into rule_registry — no LLM.

    Required CSV columns: issue_type_l1, action_code_id
    Optional columns: issue_type_l2, priority, business_line, customer_segment,
        fraud_segment, min_order_value, max_order_value, min_repeat_count,
        max_repeat_count, sla_breach_required, evidence_required,
        deterministic, overrideable, rule_id

    Returns: { "imported": N, "skipped": M, "errors": [{row, error}, ...] }
    """
    import csv
    import io
    import json

    _require_kb_access(u, kb_id, "edit")
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")

    raw = await file.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="CSV is larger than 5 MB")
    try:
        text_content = raw.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        text_content = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_content))
    if reader.fieldnames is None:
        raise HTTPException(status_code=400, detail="CSV file is empty or has no header row")

    # Load action codes for validation (code → id map)
    try:
        with engine.connect() as conn:
            ac_rows = conn.execute(text("""
                SELECT id, action_code_id FROM kirana_kart.master_action_codes
            """)).mappings().all()
        action_code_map = {r["action_code_id"].upper(): r["id"] for r in ac_rows}
    except Exception:
        logger.exception("import_rules_csv: loading action codes failed")
        raise HTTPException(status_code=500, detail="Failed to load action codes")

    imported = 0
    errors: list[dict] = []

    BOOL_TRUE = {"true", "1", "yes", "y"}

    def to_bool(val: str | None, default: bool = False) -> bool:
        if val is None:
            return default
        return val.strip().lower() in BOOL_TRUE

    def to_float(val: str | None) -> float | None:
        if val is None or val.strip() == "":
            return None
        try:
            return float(val.strip())
        except ValueError:
            return None

    def to_int(val: str | None) -> int | None:
        if val is None or val.strip() == "":
            return None
        try:
            return int(val.strip())
        except ValueError:
            return None

    rows = list(reader)
    if not rows:
        raise HTTPException(status_code=400, detail="CSV has headers but no data rows")

    try:
        with engine.begin() as conn:
            _guard_version_write(conn, kb_id, version_label, u, "Rules imported from CSV")
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    with engine.begin() as conn:
        for row_num, row in enumerate(rows, start=2):  # row 1 = header
            issue_type_l1 = (row.get("issue_type_l1") or "").strip()
            raw_code = (row.get("action_code_id") or "").strip().upper()

            if not issue_type_l1:
                errors.append({"row": row_num, "error": "Missing issue_type_l1"})
                continue
            if not raw_code:
                errors.append({"row": row_num, "error": "Missing action_code_id"})
                continue
            if raw_code not in action_code_map:
                errors.append({"row": row_num, "error": f"Unknown action_code_id '{raw_code}'"})
                continue

            action_id = action_code_map[raw_code]
            rule_id = (row.get("rule_id") or "").strip() or f"R-{uuid.uuid4().hex[:8].upper()}"
            priority = to_int(row.get("priority")) or 500

            try:
                result = conn.execute(text("""
                    INSERT INTO kirana_kart.rule_registry (
                        kb_id, rule_id, policy_version, module_name, rule_type,
                        priority, rule_scope, issue_type_l1, issue_type_l2,
                        business_line, customer_segment, fraud_segment,
                        min_order_value, max_order_value,
                        min_repeat_count, max_repeat_count,
                        sla_breach_required, evidence_required,
                        conditions, action_id, action_payload,
                        deterministic, overrideable
                    ) VALUES (
                        :kb_id, :rule_id, :version, 'default', 'action',
                        :priority, 'global', :issue_l1, :issue_l2,
                        :biz_line, :customer_seg, :fraud_seg,
                        :min_ov, :max_ov, :min_rc, :max_rc,
                        :sla_breach, :evidence,
                        '{}', :action_id, '{}',
                        :deterministic, :overrideable
                    )
                    ON CONFLICT DO NOTHING
                    RETURNING id
                """), {
                    "kb_id": kb_id,
                    "rule_id": rule_id,
                    "version": version_label,
                    "priority": priority,
                    "issue_l1": issue_type_l1,
                    "issue_l2": (row.get("issue_type_l2") or "").strip() or None,
                    "biz_line": (row.get("business_line") or "").strip() or None,
                    "customer_seg": (row.get("customer_segment") or "").strip() or None,
                    "fraud_seg": (row.get("fraud_segment") or "").strip() or None,
                    "min_ov": to_float(row.get("min_order_value")),
                    "max_ov": to_float(row.get("max_order_value")),
                    "min_rc": to_int(row.get("min_repeat_count")),
                    "max_rc": to_int(row.get("max_repeat_count")),
                    "sla_breach": to_bool(row.get("sla_breach_required")),
                    "evidence": to_bool(row.get("evidence_required")),
                    "deterministic": to_bool(row.get("deterministic"), default=True),
                    "overrideable": to_bool(row.get("overrideable")),
                    "action_id": action_id,
                })
                if result.rowcount:
                    imported += 1
                    _seed_training_sample(
                        conn, kb_id, "manual_add",  # correction_type CHECK has no csv_import
                        {"policy_version": version_label, "row": row_num},
                        {"rule_id": rule_id, "action_code_id": raw_code, "issue_type_l1": issue_type_l1},
                    )
            except Exception as exc:
                errors.append({"row": row_num, "error": str(exc)})

    skipped = len(rows) - imported - len(errors)
    return {
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "version_label": version_label,
    }


@router.get("/{kb_id}/validate")
def validate_rules(
    kb_id: str,
    version: str = Query(...),
    _u: UserContext = Depends(_kb_view),
):
    """
    Model B (semantic matcher) duplicate/conflict detection.
    Runs all rules for the version through batch_check().
    Returns immediately — no training needed (uses pre-trained MiniLM).
    """
    _require_kb_access(_u, kb_id, "view")
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT r.rule_id, r.issue_type_l1, r.issue_type_l2,
                       r.conditions, mac.action_name, mac.action_code_id
                FROM kirana_kart.rule_registry r
                JOIN kirana_kart.master_action_codes mac ON mac.id = r.action_id
                WHERE r.kb_id = :kb_id AND r.policy_version = :version
                ORDER BY r.priority
            """), {"kb_id": kb_id, "version": version}).mappings().all()

        rules = [dict(r) for r in rows]
        if not rules:
            return {"warnings": [], "conflicts": [], "duplicates": [], "model_status": "ready"}

        from app.l45_ml_platform.models.rule_matcher import get_matcher
        matcher = get_matcher()
        findings = matcher.batch_check(rules)

        warnings = [f for f in findings if f.get("issue") == "conflict"]
        duplicates = [
            {"rule_ids": [f["rule_id"], f["other_rule_id"]], "score": f["score"], "message": f["message"]}
            for f in findings if f.get("issue") == "duplicate"
        ]
        conflicts = [
            {"rule_ids": [f["rule_id"], f["other_rule_id"]], "message": f["message"]}
            for f in findings if f.get("issue") == "conflict"
        ]

        model_status = "ready" if matcher._ready else "not_available"
        return {
            "warnings": warnings,
            "conflicts": conflicts,
            "duplicates": duplicates,
            "model_status": model_status,
        }

    except Exception as e:
        logger.exception("validate_rules failed")
        return {"warnings": [], "conflicts": [], "duplicates": [], "model_status": "error"}
