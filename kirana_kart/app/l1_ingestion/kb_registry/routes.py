"""
KB Registry Routes
==================

API layer for Knowledge Base ingestion lifecycle.

Upload != Publish != Rollback

This layer:
- Validates request
- Delegates to KBRegistryService
- Returns structured response
- Contains NO business logic
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, field_validator
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from pathlib import Path
import os
import logging

from app.admin.routes.auth import UserContext, require_permission
from .kb_registry_service import KBRegistryService


# ============================================================
# CONFIG
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

DATABASE_URL = (
    f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True
)

service = KBRegistryService(engine)

router = APIRouter(prefix="/kb", tags=["KB Registry"])

logger = logging.getLogger("kb_routes")

_kb_view  = require_permission("knowledgeBase", "view")
_kb_edit  = require_permission("knowledgeBase", "edit")
_kb_admin = require_permission("knowledgeBase", "admin")
# Publishing or rolling back changes the policy serving every ticket, so it
# needs the same permission as Policy Studio activation.
_policy_admin = require_permission("policy", "admin")
logging.basicConfig(level=logging.INFO)


# ============================================================
# REQUEST MODELS
# ============================================================

class UploadRequest(BaseModel):
    document_id: str
    original_filename: str
    original_format: str
    raw_content: str
    uploaded_by: str
    version_label: str
    kb_id: str = "default"

    @field_validator("raw_content")
    @classmethod
    def validate_content(cls, v):
        if not v or not v.strip():
            raise ValueError("raw_content cannot be empty")
        return v


class UpdateRequest(BaseModel):
    new_raw_content: str
    original_format: str


class PublishRequest(BaseModel):
    version_label: str
    published_by: str = ""   # ignored: the authenticated user is recorded
    kb_id: str = "default"


# ============================================================
# ROUTES
# ============================================================

# ------------------------------------------------------------
# Upload Raw
# ------------------------------------------------------------

@router.post("/upload")
def upload_kb(request: UploadRequest, _u: UserContext = Depends(_kb_edit)):

    try:

        result = service.upload_document(
            document_id=request.document_id,
            original_filename=request.original_filename,
            original_format=request.original_format,
            raw_content=request.raw_content,
            uploaded_by=request.uploaded_by,
            version_label=request.version_label
        )

        return jsonable_encoder(result)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        logger.exception("Upload failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Update Draft
# ------------------------------------------------------------

@router.put("/update/{raw_id}")
def update_kb(raw_id: int, request: UpdateRequest, _u: UserContext = Depends(_kb_edit)):

    try:

        result = service.raw_service.update_document(
            raw_upload_id=raw_id,
            new_raw_content=request.new_raw_content,
            original_format=request.original_format
        )

        return jsonable_encoder(result)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        logger.exception("Update failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Publish Version
# ------------------------------------------------------------

@router.post("/publish")
def publish_kb(request: PublishRequest, _u: UserContext = Depends(_policy_admin)):

    try:

        # The authenticated user is the publisher of record; the client-supplied
        # published_by was accepted verbatim into the audit snapshot.
        result = service.publish_version(
            version_label=request.version_label,
            published_by=_u.email,
        )

        if not result:
            raise HTTPException(status_code=404, detail="Policy version not found")

        return jsonable_encoder(result)

    except HTTPException:
        raise

    except Exception as e:
        logger.exception("Publish failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Rollback Version
# ------------------------------------------------------------

@router.post("/rollback/{version_label}")
def rollback_kb(version_label: str, _u: UserContext = Depends(_policy_admin)):

    try:

        result = service.rollback(version_label)

        return jsonable_encoder(result)

    except Exception as e:
        logger.exception("Rollback failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Fetch Raw By ID
# ------------------------------------------------------------

@router.get("/raw/{raw_id}")
def get_raw(raw_id: int, _u: UserContext = Depends(_kb_view)):

    try:

        result = service.raw_service.fetch_by_id(raw_id)

        if not result:
            raise HTTPException(status_code=404, detail="Document not found")

        return jsonable_encoder(result)

    except HTTPException:
        raise

    except Exception as e:
        logger.exception("Fetch raw failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Fetch Active Draft
# ------------------------------------------------------------

@router.get("/active/{document_id}")
def get_active(document_id: str, _u: UserContext = Depends(_kb_view)):

    try:

        result = service.raw_service.fetch_active_draft(document_id)

        if not result:
            raise HTTPException(status_code=404, detail="No active draft found")

        return jsonable_encoder(result)

    except HTTPException:
        raise

    except Exception as e:
        logger.exception("Fetch active draft failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# CONSUMER KB ENDPOINTS
# ============================================================

# ------------------------------------------------------------
# Get Active Published Policy Version
# ------------------------------------------------------------

@router.get("/active-version")
def get_active_policy_version(
    kb_id: str = Query("default"),
    _u: UserContext = Depends(_kb_view),
):

    try:

        with engine.connect() as conn:

            row = conn.execute(text("""
                SELECT active_version, activated_at, kb_id
                FROM kirana_kart.kb_runtime_config
                WHERE kb_id = :kb_id
                ORDER BY id DESC
                LIMIT 1
            """), {"kb_id": kb_id}).mappings().first()

        if not row:
            return {"active_version": None, "activated_at": None}

        return {
            "active_version": row["active_version"],
            "activated_at": row["activated_at"],
        }

    except Exception as e:
        logger.exception("Active version lookup failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Get Published Policy Snapshot
# ------------------------------------------------------------

@router.get("/version/{version}")
def get_policy_version(version: str, _u: UserContext = Depends(_kb_view)):

    try:

        with engine.connect() as conn:

            row = conn.execute(text("""
                SELECT id, version_label, status, created_by, created_at, snapshot_data
                FROM kirana_kart.knowledge_base_versions
                WHERE version_label = :v
            """), {"v": version}).mappings().first()

        if not row:
            raise HTTPException(status_code=404, detail="Policy version not found")

        return jsonable_encoder(dict(row))

    except HTTPException:
        raise

    except Exception as e:
        logger.exception("Policy fetch failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# List All Published Versions
# ------------------------------------------------------------

@router.get("/versions")
def list_policy_versions(
    kb_id: str = Query("default"),
    _u: UserContext = Depends(_kb_view),
):

    try:

        with engine.connect() as conn:

            rows = conn.execute(text("""
                SELECT id, version_label, status, created_by, created_at, snapshot_data, kb_id
                FROM kirana_kart.knowledge_base_versions
                WHERE kb_id = :kb_id
                ORDER BY created_at DESC
            """), {"kb_id": kb_id}).mappings().all()

        return jsonable_encoder([dict(r) for r in rows])

    except Exception as e:
        logger.exception("Version list failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# List Raw Uploads
# ------------------------------------------------------------

@router.get("/uploads")
def list_raw_uploads(
    kb_id: str = Query("default"),
    _u: UserContext = Depends(_kb_view),
):

    try:

        with engine.connect() as conn:

            rows = conn.execute(text("""
                SELECT
                    id,
                    document_id,
                    original_filename,
                    original_format,
                    raw_content,
                    upload_status,
                    uploaded_by,
                    uploaded_at,
                    compile_errors,
                    compiled_hash,
                    markdown_content,
                    version_label,
                    is_active,
                    registry_status,
                    updated_at,
                    kb_id
                FROM kirana_kart.knowledge_base_raw_uploads
                WHERE kb_id = :kb_id
                ORDER BY uploaded_at DESC
            """), {"kb_id": kb_id}).mappings().all()

        return jsonable_encoder([dict(r) for r in rows])

    except Exception as e:
        logger.exception("Uploads list failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ------------------------------------------------------------
# Rule Registry — Decision Matrix
# ------------------------------------------------------------

@router.get("/rule-registry/{version_label}")
def get_rule_registry(
    version_label: str,
    kb_id: str = Query("default"),
    _u: UserContext = Depends(_kb_view),
):
    """
    Returns all compiled rules for a policy version joined with action code info.
    Used by the Decision Matrix tab.
    """
    try:

        with engine.connect() as conn:

            rows = conn.execute(text("""
                SELECT
                    r.id,
                    r.rule_id,
                    r.policy_version,
                    r.module_name,
                    r.rule_type,
                    r.priority,
                    r.rule_scope,
                    r.issue_type_l1,
                    r.issue_type_l2,
                    r.business_line,
                    r.customer_segment,
                    r.fraud_segment,
                    r.min_order_value,
                    r.max_order_value,
                    r.min_repeat_count,
                    r.max_repeat_count,
                    r.sla_breach_required,
                    r.evidence_required,
                    r.conditions,
                    r.action_id,
                    r.action_payload,
                    r.deterministic,
                    r.overrideable,
                    mac.action_code_id,
                    mac.action_name
                FROM kirana_kart.rule_registry r
                JOIN kirana_kart.master_action_codes mac ON mac.id = r.action_id
                WHERE r.policy_version = :version
                  AND r.kb_id = :kb_id
                ORDER BY r.module_name, r.priority
            """), {"version": version_label, "kb_id": kb_id}).mappings().all()

        return jsonable_encoder([dict(r) for r in rows])

    except Exception as e:
        logger.exception("Rule registry fetch failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")
