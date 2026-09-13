"""
Compiler Routes
===============

FastAPI endpoints for the KB compiler.

Responsibilities:
- Trigger compilation
- Compile specific version
- Inspect compilation status

No business logic here.
Delegates to CompilerService.
"""

import logging
from fastapi import APIRouter, Depends, HTTPException
from typing import Dict
from pydantic import BaseModel

from app.admin.routes.auth import UserContext, require_permission
from .compiler_service import CompilerService


# ============================================================
# ROUTER CONFIG
# ============================================================

router = APIRouter(
    prefix="/compiler",
    tags=["KB Compiler"]
)

logger = logging.getLogger("compiler_routes")
logger.setLevel(logging.INFO)

compiler_service = CompilerService()

_view  = require_permission("knowledgeBase", "view")
_admin = require_permission("knowledgeBase", "admin")


class ExtractActionsRequest(BaseModel):
    version_label: str


# ============================================================
# COMPILE LATEST DRAFT
# ============================================================

@router.post("/compile-latest")
def compile_latest(_u: UserContext = Depends(_admin)) -> Dict:
    """
    Compiles the most recently uploaded KB draft.
    """
    try:
        result = compiler_service.compile_latest_draft()
        return {
            "status": "success",
            "message": "Draft compiled successfully",
            "result": result
        }
    except Exception as e:
        logger.error(f"Compile latest failed: {str(e)}")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# COMPILE SPECIFIC VERSION
# ============================================================

@router.post("/compile-version/{version_label}")
def compile_version(version_label: str, _u: UserContext = Depends(_admin)) -> Dict:
    """
    Compiles a specific KB version.
    """
    try:
        result = compiler_service.compile_version(version_label)
        return {
            "status": "success",
            "version_label": version_label,
            "result": result
        }
    except Exception as e:
        logger.error(f"Compile version failed: {str(e)}")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# COMPILATION STATUS
# ============================================================

@router.get("/status/{version_label}")
def compilation_status(version_label: str, _u: UserContext = Depends(_admin)):
    """
    Returns compilation status for a policy version.
    """
    conn = None
    try:
        conn = compiler_service._get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT policy_version,
                       artifact_hash,
                       is_active
                FROM kirana_kart.policy_versions
                WHERE policy_version = %s
            """, (version_label,))
            policy_row = cur.fetchone()

            if not policy_row:
                raise HTTPException(status_code=404, detail="Policy version not found")

            cur.execute("""
                SELECT registry_status
                FROM kirana_kart.knowledge_base_raw_uploads
                WHERE version_label = %s
                ORDER BY uploaded_at DESC
                LIMIT 1
            """, (version_label,))
            raw_row = cur.fetchone()

        return {
            "version_label": policy_row[0],
            "artifact_hash": policy_row[1],
            "is_active": policy_row[2],
            "raw_status": raw_row[0] if raw_row else None
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Status fetch failed: {str(e)}")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")
    finally:
        if conn:
            conn.close()


# ============================================================
# LIST ACTION CODES
# ============================================================

@router.get("/action-codes")
def list_action_codes(_u: UserContext = Depends(_view)):
    """
    Returns all master_action_codes rows.
    """
    conn = None
    try:
        conn = compiler_service._get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, action_key, action_code_id, action_name, action_description,
                       requires_refund, requires_escalation, automation_eligible
                FROM kirana_kart.master_action_codes
                ORDER BY id
            """)
            rows = cur.fetchall()
        return [
            {
                "id": r[0],
                "action_key": r[1],
                "action_code_id": r[2],
                "action_name": r[3],
                "action_description": r[4],
                "requires_refund": r[5],
                "requires_escalation": r[6],
                "automation_eligible": r[7],
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Action codes list failed: {e}")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")
    finally:
        if conn:
            conn.close()


# ============================================================
# EXTRACT ACTION CODES FROM DOCUMENT
# ============================================================

@router.post("/extract-actions")
def extract_action_codes(body: ExtractActionsRequest, _u: UserContext = Depends(_admin)):
    """
    LLM pass over the KB document to extract all possible policy decisions.
    Upserts discovered action codes into master_action_codes.
    """
    try:
        result = compiler_service.extract_action_codes(body.version_label)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Extract actions failed: {e}")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")
