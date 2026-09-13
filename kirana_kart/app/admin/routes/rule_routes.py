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
"""

from __future__ import annotations

import logging
import uuid
from typing import Optional, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.admin.db import engine
from app.admin.routes.auth import UserContext, require_permission

logger = logging.getLogger("kirana_kart.rule_routes")

router = APIRouter(prefix="/rules", tags=["Rule Editor"])

_kb_view  = require_permission("knowledgeBase", "view")
_kb_edit  = require_permission("knowledgeBase", "edit")


# ============================================================
# REQUEST MODELS
# ============================================================

class RuleCreate(BaseModel):
    policy_version: str
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


# ============================================================
# HELPERS
# ============================================================

def _seed_training_sample(conn, kb_id: str, correction_type: str, input_data: dict, corrected: dict) -> None:
    """Record every rule edit as a training sample for Model A."""
    try:
        conn.execute(text("""
            INSERT INTO kirana_kart.ml_training_samples
                (model_name, kb_id, input_data, corrected_output, correction_type)
            VALUES ('rule_extractor', :kb_id, :input::jsonb, :corrected::jsonb, :ctype)
        """), {
            "kb_id": kb_id,
            "input": __import__("json").dumps(input_data),
            "corrected": __import__("json").dumps(corrected),
            "ctype": correction_type,
        })
    except Exception:
        logger.warning("Failed to seed ml_training_samples — skipping", exc_info=True)


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
    try:
        rule_id = body.rule_id or f"R-{uuid.uuid4().hex[:8].upper()}"
        with engine.begin() as conn:
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
                    :sla_breach_required, :evidence_required, :conditions::jsonb,
                    :action_id, :action_payload::jsonb, :deterministic, :overrideable
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

        return {"id": row["id"], "rule_id": row["rule_id"]}
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
    try:
        updates = body.model_dump(exclude_none=True)
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")

        # Build SET clause
        set_parts = []
        params: dict[str, Any] = {"id": rule_db_id, "kb_id": kb_id}
        for key, val in updates.items():
            if key in ("conditions", "action_payload"):
                set_parts.append(f"{key} = :{key}::jsonb")
                params[key] = json.dumps(val)
            else:
                set_parts.append(f"{key} = :{key}")
                params[key] = val

        set_clause = ", ".join(set_parts)

        with engine.begin() as conn:
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

        return {"id": row["id"], "rule_id": row["rule_id"]}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("update_rule failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.delete("/{kb_id}/{rule_db_id}", status_code=204)
def delete_rule(
    kb_id: str,
    rule_db_id: int,
    u: UserContext = Depends(_kb_edit),
):
    """Delete a rule. Seeds a deletion training sample."""
    try:
        with engine.begin() as conn:
            result = conn.execute(text("""
                DELETE FROM kirana_kart.rule_registry
                WHERE id = :id AND kb_id = :kb_id
                RETURNING rule_id
            """), {"id": rule_db_id, "kb_id": kb_id})
            row = result.mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Rule not found")
            _seed_training_sample(conn, kb_id, "delete", {"rule_db_id": rule_db_id}, {})
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("delete_rule failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.get("/{kb_id}/action-codes")
def list_action_codes(kb_id: str, _u: UserContext = Depends(_kb_view)):
    """Return all master action codes for dropdowns."""
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, action_code_id, action_name, action_category,
                       requires_approval, is_reversible, severity_level
                FROM kirana_kart.master_action_codes
                ORDER BY action_category, action_name
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

    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")

    raw = await file.read()
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load action codes: {e}")

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
                        conn, kb_id, "csv_import",
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
        return {"warnings": [], "conflicts": [], "duplicates": [], "model_status": "error", "error": str(e)}
