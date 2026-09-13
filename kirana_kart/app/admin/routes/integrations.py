"""
app/admin/routes/integrations.py
==================================
Integration management routes — governance plane (port 8001).

Endpoints:
  GET    /integrations                   → list all integrations (config redacted)
  POST   /integrations                   → create integration
  GET    /integrations/{id}              → get single integration (config redacted)
  GET    /integrations/{id}/config       → full config (system.admin only)
  PATCH  /integrations/{id}             → update name / config / org / module
  DELETE /integrations/{id}             → delete + remove api_key from admin_users
  POST   /integrations/{id}/toggle      → activate / deactivate
  POST   /integrations/{id}/test        → test connectivity
  POST   /integrations/{id}/sync        → manual poll (email types only)
  POST   /integrations/generate-key     → generate a new kk_live_ API key
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.routes.auth import UserContext, require_permission
from app.admin.services.integration_service import (
    generate_api_key,
    register_api_key_in_admin_users,
    remove_api_key_from_admin_users,
    run_one_integration,
    test_gmail,
    test_imap,
    test_outlook,
)

logger = logging.getLogger("kirana_kart.integrations")

router = APIRouter(prefix="/integrations", tags=["integrations"])

_view = require_permission("system", "view")
_admin = require_permission("system", "admin")

# Sensitive config keys to strip from list / get responses
_REDACTED_KEYS = {"access_token", "refresh_token", "password", "client_secret", "api_key"}


# ============================================================
# HELPERS
# ============================================================


def _redact(config: dict) -> dict:
    """Remove sensitive fields from a config dict."""
    return {k: ("***" if k in _REDACTED_KEYS else v) for k, v in config.items()}


def _row_to_dict(row: Any, redact: bool = True) -> dict:
    d = dict(row)
    cfg = d.get("config") or {}
    d["config"] = _redact(cfg) if redact else cfg
    return d


# ============================================================
# REQUEST / RESPONSE MODELS
# ============================================================


class CreateIntegrationRequest(BaseModel):
    name: str = Field(..., max_length=200)
    type: str = Field(..., pattern=r"^(gmail|outlook|smtp|api)$")
    org: str = Field(default="default", max_length=100)
    business_line: str = Field(default="ecommerce", max_length=50)
    module: str = Field(default="delivery", max_length=50)
    config: Dict[str, Any] = Field(default_factory=dict)


class UpdateIntegrationRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    org: Optional[str] = Field(default=None, max_length=100)
    business_line: Optional[str] = Field(default=None, max_length=50)
    module: Optional[str] = Field(default=None, max_length=50)
    config: Optional[Dict[str, Any]] = None


# ============================================================
# GET /integrations
# ============================================================


@router.get("")
def list_integrations(user: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, name, type, org, business_line, module,
                       is_active, config, last_synced_at, sync_status,
                       sync_error, created_by, created_at, updated_at
                FROM kirana_kart.integrations
                ORDER BY created_at DESC
            """)
        ).mappings().all()

    return [_row_to_dict(r, redact=True) for r in rows]


# ============================================================
# POST /integrations
# ============================================================


@router.post("", status_code=201)
def create_integration(
    body: CreateIntegrationRequest,
    user: UserContext = Depends(_admin),
):
    config = dict(body.config)

    # For API type: generate key, store in config, register in admin_users
    if body.type == "api" and not config.get("api_key"):
        api_key = generate_api_key()
        config["api_key"] = api_key
        config.setdefault(
            "ingest_url",
            "http://your-server:8000/cardinal/ingest",
        )
        register_api_key_in_admin_users(api_key)
        logger.info("API integration created; registered api_key in admin_users")

    import json

    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.integrations
                    (name, type, org, business_line, module, config, created_by)
                VALUES (:name, :type, :org, :bl, :module, CAST(:config AS JSONB), :uid)
                RETURNING id, name, type, org, business_line, module,
                          is_active, config, last_synced_at, sync_status,
                          sync_error, created_by, created_at, updated_at
            """),
            {
                "name": body.name,
                "type": body.type,
                "org": body.org,
                "bl": body.business_line,
                "module": body.module,
                "config": json.dumps(config),
                "uid": user.id,
            },
        ).mappings().first()

    result = _row_to_dict(row, redact=True)
    # For API type: expose the api_key once in the creation response
    if body.type == "api" and "api_key" in config:
        result["config"]["api_key"] = config["api_key"]
    return result


# ============================================================
# GET /integrations/{id}
# ============================================================


@router.get("/{integration_id}")
def get_integration(
    integration_id: int,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT id, name, type, org, business_line, module,
                       is_active, config, last_synced_at, sync_status,
                       sync_error, created_by, created_at, updated_at
                FROM kirana_kart.integrations
                WHERE id = :id
            """),
            {"id": integration_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Integration not found")
    return _row_to_dict(row, redact=True)


# ============================================================
# GET /integrations/{id}/config  (admin only — full config)
# ============================================================


@router.get("/{integration_id}/config")
def get_integration_config(
    integration_id: int,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT id, name, type, config
                FROM kirana_kart.integrations
                WHERE id = :id
            """),
            {"id": integration_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Integration not found")
    return _row_to_dict(row, redact=False)


# ============================================================
# PATCH /integrations/{id}
# ============================================================


@router.patch("/{integration_id}")
def update_integration(
    integration_id: int,
    body: UpdateIntegrationRequest,
    user: UserContext = Depends(_admin),
):
    import json

    with get_db_session() as session:
        existing = session.execute(
            text("SELECT config FROM kirana_kart.integrations WHERE id = :id"),
            {"id": integration_id},
        ).mappings().first()
        if not existing:
            raise HTTPException(status_code=404, detail="Integration not found")

        # Merge config: existing config + incoming patch
        current_config = existing["config"] or {}
        new_config = {**current_config, **(body.config or {})}

        row = session.execute(
            text("""
                UPDATE kirana_kart.integrations
                SET name          = COALESCE(:name, name),
                    org           = COALESCE(:org, org),
                    business_line = COALESCE(:bl, business_line),
                    module        = COALESCE(:module, module),
                    config        = CAST(:config AS JSONB),
                    updated_at    = NOW()
                WHERE id = :id
                RETURNING id, name, type, org, business_line, module,
                          is_active, config, last_synced_at, sync_status,
                          sync_error, created_by, created_at, updated_at
            """),
            {
                "name": body.name,
                "org": body.org,
                "bl": body.business_line,
                "module": body.module,
                "config": json.dumps(new_config),
                "id": integration_id,
            },
        ).mappings().first()

    return _row_to_dict(row, redact=True)


# ============================================================
# DELETE /integrations/{id}
# ============================================================


@router.delete("/{integration_id}", status_code=204)
def delete_integration(
    integration_id: int,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        row = session.execute(
            text("SELECT type, config FROM kirana_kart.integrations WHERE id = :id"),
            {"id": integration_id},
        ).mappings().first()

        if not row:
            raise HTTPException(status_code=404, detail="Integration not found")

        # Remove API key from admin_users if applicable
        if row["type"] == "api":
            api_key = (row["config"] or {}).get("api_key")
            if api_key:
                remove_api_key_from_admin_users(api_key)
                logger.info("Removed api_key from admin_users for deleted integration %s", integration_id)

        session.execute(
            text("DELETE FROM kirana_kart.integrations WHERE id = :id"),
            {"id": integration_id},
        )


# ============================================================
# POST /integrations/{id}/toggle
# ============================================================


@router.post("/{integration_id}/toggle")
def toggle_integration(
    integration_id: int,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                UPDATE kirana_kart.integrations
                SET is_active  = NOT is_active,
                    updated_at = NOW()
                WHERE id = :id
                RETURNING id, name, type, org, business_line, module,
                          is_active, config, last_synced_at, sync_status,
                          sync_error, created_by, created_at, updated_at
            """),
            {"id": integration_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Integration not found")
    return _row_to_dict(row, redact=True)


# ============================================================
# POST /integrations/{id}/test
# ============================================================


@router.post("/{integration_id}/test")
def test_integration(
    integration_id: int,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        row = session.execute(
            text("SELECT type, config FROM kirana_kart.integrations WHERE id = :id"),
            {"id": integration_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Integration not found")

    itype = row["type"]
    config = row["config"] or {}

    if itype == "gmail":
        success, message = test_gmail(config)
    elif itype == "outlook":
        success, message = test_outlook(config)
    elif itype == "smtp":
        success, message = test_imap(config)
    elif itype == "api":
        api_key = config.get("api_key", "")
        success = bool(api_key and api_key.startswith("kk_live_"))
        message = "API key is configured" if success else "No valid API key found"
    else:
        success, message = False, f"Unknown integration type: {itype}"

    return {"success": success, "message": message}


# ============================================================
# POST /integrations/{id}/sync  (background)
# ============================================================


@router.post("/{integration_id}/sync")
def sync_integration(
    integration_id: int,
    background_tasks: BackgroundTasks,
    user: UserContext = Depends(_admin),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT id, name, type, org, business_line, module,
                       config, is_active, sync_status
                FROM kirana_kart.integrations
                WHERE id = :id
            """),
            {"id": integration_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Integration not found")

    if row["type"] == "api":
        raise HTTPException(
            status_code=400, detail="API integrations do not have a sync/poll cycle"
        )

    if row["sync_status"] == "running":
        raise HTTPException(status_code=409, detail="Integration is already syncing")

    integration = dict(row)
    background_tasks.add_task(run_one_integration, integration)
    logger.info("Manual sync triggered for integration %s by user %s", integration_id, user.id)
    return {"status": "sync_started", "integration_id": integration_id}


# ============================================================
# POST /integrations/generate-key
# ============================================================


@router.post("/generate-key")
def generate_key(user: UserContext = Depends(_admin)):
    """Generate a new API key. The caller is responsible for storing it."""
    key = generate_api_key()
    return {"api_key": key}
