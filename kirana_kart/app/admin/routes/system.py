from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.routes.auth import UserContext, require_permission

router = APIRouter(prefix="/system", tags=["system"])

_view  = require_permission("system", "view")
_admin = require_permission("system", "admin")


@router.get("/vector-jobs")
def vector_jobs(_u: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT
                    id, version_label, status, created_at,
                    started_at, completed_at, error
                FROM kirana_kart.kb_vector_jobs
                ORDER BY created_at DESC
            """)
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


@router.get("/audit-logs")
def audit_logs(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _u: UserContext = Depends(_view),
):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT
                    id, execution_id, ticket_id, stage_name,
                    event_time, event_type, message, metadata
                FROM kirana_kart.execution_audit_log
                ORDER BY event_time DESC
                LIMIT :limit OFFSET :offset
            """),
            {"limit": limit, "offset": offset},
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


@router.get("/models")
def model_registry(_u: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT model_name, model_version, deployed_at, is_active
                FROM kirana_kart.model_registry
                ORDER BY deployed_at DESC NULLS LAST
            """)
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])
