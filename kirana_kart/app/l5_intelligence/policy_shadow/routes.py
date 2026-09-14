"""
Shadow Policy Routes
====================

FastAPI endpoints for managing shadow policy testing.

Responsibilities:
- Enable shadow policy
- Disable shadow policy
- Inspect shadow results

No runtime evaluation here.
Shadow execution happens in the agent runtime.

Access control: enabling or disabling a shadow policy changes how every
ticket in the system is evaluated, so the mutating endpoints require
policy.admin and the read endpoints require policy.view.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.routes.auth import UserContext, require_permission


router = APIRouter(
    prefix="/shadow",
    tags=["Shadow Policy"]
)

logger = logging.getLogger("shadow_routes")

_view = require_permission("policy", "view")
_admin = require_permission("policy", "admin")


# ============================================================
# REQUEST MODEL
# ============================================================

class ShadowEnableRequest(BaseModel):
    shadow_version: str = Field(min_length=1, max_length=64)


# ============================================================
# ENABLE SHADOW POLICY
# ============================================================

@router.post("/enable")
def enable_shadow(
    request: ShadowEnableRequest,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        # Target the current config row only. An unqualified UPDATE would
        # rewrite shadow_version on every historical row in the table.
        updated = session.execute(
            text("""
                UPDATE kirana_kart.kb_runtime_config
                SET shadow_version = :version
                WHERE id = (SELECT id FROM kirana_kart.kb_runtime_config
                            ORDER BY id DESC LIMIT 1)
            """),
            {"version": request.shadow_version},
        ).rowcount

    if not updated:
        raise HTTPException(
            status_code=404,
            detail="No runtime config row exists to attach a shadow policy to.",
        )

    logger.info(
        "Shadow policy enabled | version=%s actor=%d",
        request.shadow_version,
        user.id,
    )
    return {
        "status": "shadow_enabled",
        "shadow_version": request.shadow_version,
    }


# ============================================================
# DISABLE SHADOW POLICY
# ============================================================

@router.post("/disable")
def disable_shadow(user: UserContext = Depends(_admin)):
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.kb_runtime_config
                SET shadow_version = NULL
                WHERE id = (SELECT id FROM kirana_kart.kb_runtime_config
                            ORDER BY id DESC LIMIT 1)
            """)
        )

    logger.info("Shadow policy disabled | actor=%d", user.id)
    return {"status": "shadow_disabled"}


# ============================================================
# SHADOW STATS
# ============================================================

@router.get("/stats")
def get_shadow_stats(_u: UserContext = Depends(_view)):
    with get_db_session() as session:
        runtime = session.execute(text("""
            SELECT active_version, shadow_version, kb_id
            FROM kirana_kart.kb_runtime_config ORDER BY id DESC LIMIT 1
        """)).mappings().first()
        result = session.execute(text("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN decision_changed THEN 1 ELSE 0 END) AS changed,
                   MAX(created_at) AS last_evaluated_at
            FROM kirana_kart.policy_shadow_results
            WHERE active_policy_version = :active AND candidate_policy_version = :candidate
        """), {"active": runtime["active_version"] if runtime else None,
                 "candidate": runtime["shadow_version"] if runtime else None}).mappings().first()

    total = result["total"] or 0
    changed = result["changed"] or 0
    change_rate = round((changed / total), 4) if total > 0 else 0

    shadow_version = runtime["shadow_version"] if runtime else None

    return {
        "shadow_version": shadow_version,
        "active_version": runtime["active_version"] if runtime else None,
        "total_evaluated": total,
        "kb_id": runtime["kb_id"] if runtime else None,
        "last_evaluated_at": result["last_evaluated_at"],
        "decisions_changed": changed,
        "change_rate": change_rate,
        "is_active": bool(shadow_version),
    }


# ============================================================
# SHADOW RESULTS
# ============================================================

@router.get("/results")
def get_shadow_results(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    _u: UserContext = Depends(_view),
):
    offset = (page - 1) * limit

    with get_db_session() as session:
        rows = session.execute(text("""
            SELECT
                id,
                ticket_id,
                active_policy_version,
                candidate_policy_version,
                active_action_code,
                shadow_action_code,
                decision_changed,
                created_at
            FROM kirana_kart.policy_shadow_results
            ORDER BY created_at DESC
            LIMIT :limit OFFSET :offset
        """), {"limit": limit, "offset": offset}).mappings().all()

    return [dict(r) for r in rows]
