"""
app/admin/routes/bpm_routes.py
================================
REST API for the BPM Policy Lifecycle system.

Endpoints:
  KB Management (super-admin):
    GET    /bpm/kbs                             → list all KBs
    POST   /bpm/kbs                             → create KB
    GET    /bpm/kbs/{kb_id}/members             → list members
    POST   /bpm/kbs/{kb_id}/members             → add/update member role
    DELETE /bpm/kbs/{kb_id}/members/{user_id}   → remove member

  Process Instances:
    GET    /bpm/{kb_id}/instances               → list instances (filter by stage)
    POST   /bpm/{kb_id}/instances               → create instance
    GET    /bpm/{kb_id}/instances/{id}          → get instance detail
    POST   /bpm/{kb_id}/instances/{id}/transition → reopen / manual stage change
    GET    /bpm/{kb_id}/instances/{id}/trail    → audit trail
    GET    /bpm/{kb_id}/instances/{id}/gates    → gate results
    GET    /bpm/{kb_id}/instances/{id}/approvals → pending approvals

  Approvals:
    POST   /bpm/approvals/{approval_id}/approve → approve (activates a policy version)
    POST   /bpm/approvals/{approval_id}/reject  → reject
    POST   /bpm/{kb_id}/instances/{id}/request-approval → create approval request

  Policy Studio (kb_version proposals; see services/policy_lifecycle.py):
    POST   /bpm/kb/{kb_id}/upload               → SOP upload → DRAFT proposal
    POST   /bpm/kb/{kb_id}/extract-taxonomy     → stage 1 analysis
    POST   /bpm/kb/{kb_id}/extract-actions      → stage 2 analysis
    POST   /bpm/kb/{kb_id}/generate-rules       → stage 3 → RULE_EDIT
    POST   /bpm/kb/{kb_id}/simulate             → sample replay gate
    POST   /bpm/kb/{kb_id}/submit               → request approval
    GET    /bpm/kb/{kb_id}/proposals/{entity_id}/readiness
    POST   /bpm/kb/{kb_id}/publish              → approve + activate

Every instance lookup is scoped to the kb_id in the URL: access is checked
against that KB, so an instance from another KB must not be reachable through
it.
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field, field_validator

from app.admin.db import engine
from app.admin.routes.auth import UserContext, require_permission
from app.admin.services import policy_lifecycle as lifecycle
from app.admin.services.bpm_service import BPMService
from app.admin.services.policy_lifecycle import LifecycleError, SIMULATION_GATE_THRESHOLD  # noqa: F401

logger = logging.getLogger("kirana_kart.bpm_routes")

router = APIRouter(prefix="/bpm", tags=["BPM"])

_kb_view  = require_permission("knowledgeBase", "view")
_kb_edit  = require_permission("knowledgeBase", "edit")
_kb_admin = require_permission("knowledgeBase", "admin")
_policy_admin = require_permission("policy", "admin")
_sys_admin = require_permission("system", "admin")

_bpm_service = BPMService(engine)

# The wizard advertises this limit; it is enforced here, before conversion.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
# entity_id becomes kb_runtime_config.active_version / kb_vector_jobs.version_label,
# both VARCHAR(50). "<kb_id>-<10 hex>" must fit.
MAX_KB_ID_LENGTH = 32
MAX_ENTITY_ID_LENGTH = 50


# ============================================================
# REQUEST MODELS
# ============================================================

class CreateKBRequest(BaseModel):
    kb_id: str
    kb_name: str
    description: Optional[str] = None

    @field_validator("kb_id")
    @classmethod
    def validate_kb_id(cls, v: str) -> str:
        v = v.strip().lower()
        if not v or not v.replace("_", "").replace("-", "").isalnum():
            raise ValueError("kb_id must be alphanumeric (underscores/hyphens allowed)")
        if len(v) > MAX_KB_ID_LENGTH:
            raise ValueError(f"kb_id must be at most {MAX_KB_ID_LENGTH} characters")
        return v


class SetMemberRoleRequest(BaseModel):
    user_id: int
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("view", "edit", "admin"):
            raise ValueError("role must be view | edit | admin")
        return v


class CreateInstanceRequest(BaseModel):
    entity_id: str
    entity_type: str
    process_name: str
    metadata: Optional[dict] = None

    @field_validator("entity_type")
    @classmethod
    def validate_entity_type(cls, v: str) -> str:
        if v not in ("kb_version", "taxonomy_version"):
            raise ValueError("entity_type must be kb_version | taxonomy_version")
        return v


class TransitionRequest(BaseModel):
    to_stage: str
    notes: Optional[str] = None
    transition_data: Optional[dict] = None


class RequestApprovalRequest(BaseModel):
    stage: str = "PENDING_APPROVAL"
    justification: Optional[str] = Field(default=None, max_length=2000)


class ReviewApprovalRequest(BaseModel):
    notes: Optional[str] = Field(default=None, max_length=2000)


class EntityRequest(BaseModel):
    entity_id: str = Field(min_length=1, max_length=MAX_ENTITY_ID_LENGTH)


class SubmitRequest(EntityRequest):
    justification: Optional[str] = Field(default=None, max_length=2000)


class PublishRequest(EntityRequest):
    notes: Optional[str] = Field(default=None, max_length=2000)


# ============================================================
# HELPERS
# ============================================================

def _require_kb_access(
    user: UserContext,
    kb_id: str,
    required_role: str = "view",
) -> None:
    """Raise 403 if user lacks the required role on this KB."""
    if user.is_super_admin:
        return
    if not _bpm_service.check_kb_access(
        kb_id=kb_id,
        user_id=user.id,
        required_role=required_role,
        is_super_admin=user.is_super_admin,
    ):
        raise HTTPException(
            status_code=403,
            detail=f"You do not have {required_role} access to KB '{kb_id}'",
        )


def _has_policy_admin(user: UserContext) -> bool:
    return bool(user.is_super_admin or (user.permissions or {}).get("policy", {}).get("admin"))


def _entity_id(body: dict | EntityRequest) -> str:
    entity_id = body.entity_id if isinstance(body, EntityRequest) else (body or {}).get("entity_id", "")
    if not entity_id:
        raise HTTPException(status_code=400, detail="entity_id required")
    return entity_id


@contextmanager
def _lifecycle_txn():
    """One transaction per lifecycle operation; refusals become HTTP errors and roll back."""
    try:
        with engine.begin() as conn:
            yield conn
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


def _scoped_instance(kb_id: str, instance_id: int) -> dict:
    with _lifecycle_txn() as conn:
        return lifecycle.load_instance(conn, kb_id, instance_id)


# ============================================================
# KB MANAGEMENT
# ============================================================

@router.get("/kbs")
def list_kbs(u: UserContext = Depends(_kb_view)):
    """List KBs accessible to the current user."""
    try:
        kbs = _bpm_service.list_kbs(
            user_id=u.id,
            is_super_admin=u.is_super_admin,
        )
        return jsonable_encoder(kbs)
    except Exception:
        logger.exception("list_kbs failed")
        raise HTTPException(status_code=500, detail="Failed to list knowledge bases")


@router.post("/kbs", status_code=201)
def create_kb(request: CreateKBRequest, u: UserContext = Depends(_sys_admin)):
    """Create a new Knowledge Base (super admin only)."""
    try:
        kb = _bpm_service.create_kb(
            kb_id=request.kb_id,
            kb_name=request.kb_name,
            description=request.description,
            created_by_id=u.id,
        )
        return jsonable_encoder(kb)
    except Exception:
        logger.exception("create_kb failed")
        raise HTTPException(status_code=400, detail="Could not create the knowledge base. The ID may already exist.")


@router.get("/kbs/{kb_id}/members")
def get_kb_members(kb_id: str, u: UserContext = Depends(_kb_admin)):
    """List members of a KB (kb admin or super admin)."""
    _require_kb_access(u, kb_id, "admin")
    try:
        return jsonable_encoder(_bpm_service.get_kb_members(kb_id))
    except Exception:
        logger.exception("get_kb_members failed")
        raise HTTPException(status_code=500, detail="Failed to get KB members")


@router.post("/kbs/{kb_id}/members")
def set_kb_member(
    kb_id: str,
    request: SetMemberRoleRequest,
    u: UserContext = Depends(_kb_admin),
):
    """Add or update a member's role on a KB."""
    _require_kb_access(u, kb_id, "admin")
    try:
        _bpm_service.set_kb_member_role(
            kb_id=kb_id,
            user_id=request.user_id,
            role=request.role,
            granted_by_id=u.id,
        )
        return {"status": "ok", "kb_id": kb_id, "user_id": request.user_id, "role": request.role}
    except Exception:
        logger.exception("set_kb_member failed")
        raise HTTPException(status_code=400, detail="Could not update the member role")


@router.delete("/kbs/{kb_id}/members/{user_id}")
def remove_kb_member(kb_id: str, user_id: int, u: UserContext = Depends(_kb_admin)):
    """Remove a member from a KB."""
    _require_kb_access(u, kb_id, "admin")
    try:
        _bpm_service.remove_kb_member(kb_id=kb_id, user_id=user_id)
        return {"status": "removed", "kb_id": kb_id, "user_id": user_id}
    except Exception:
        logger.exception("remove_kb_member failed")
        raise HTTPException(status_code=400, detail="Could not remove the member")


# ============================================================
# PROCESS INSTANCES
# ============================================================

@router.get("/{kb_id}/instances")
def list_instances(
    kb_id: str,
    stage: Optional[str] = Query(None, description="Filter by stage"),
    limit: int = Query(50, ge=1, le=200),
    entity_id: Optional[str] = Query(None, description="Exact proposal version"),
    u: UserContext = Depends(_kb_view),
):
    """List BPM instances for a KB, optionally filtered by stage."""
    _require_kb_access(u, kb_id, "view")
    try:
        instances = _bpm_service.list_instances(
            kb_id=kb_id,
            stage_filter=stage,
            limit=limit,
            entity_id=entity_id,
        )
        return jsonable_encoder(instances)
    except Exception:
        logger.exception("list_instances failed")
        raise HTTPException(status_code=500, detail="Failed to list instances")


@router.post("/{kb_id}/instances", status_code=201)
def create_instance(
    kb_id: str,
    request: CreateInstanceRequest,
    u: UserContext = Depends(_kb_edit),
):
    """Create a new BPM process instance (starts at DRAFT)."""
    _require_kb_access(u, kb_id, "edit")
    try:
        instance = _bpm_service.create_instance(
            kb_id=kb_id,
            entity_id=request.entity_id,
            entity_type=request.entity_type,
            process_name=request.process_name,
            created_by_id=u.id,
            created_by_name=u.email,
            metadata=request.metadata,
        )
        return jsonable_encoder(instance)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("create_instance failed")
        raise HTTPException(status_code=500, detail="Failed to create BPM instance")


@router.get("/{kb_id}/instances/{instance_id}")
def get_instance(kb_id: str, instance_id: int, u: UserContext = Depends(_kb_view)):
    """Get full detail of a BPM instance."""
    _require_kb_access(u, kb_id, "view")
    return jsonable_encoder(_scoped_instance(kb_id, instance_id))


@router.post("/{kb_id}/instances/{instance_id}/transition")
def transition_instance(
    kb_id: str,
    instance_id: int,
    request: TransitionRequest,
    u: UserContext = Depends(_kb_edit),
):
    """
    Manual stage change.

    Policy proposals advance only through the work each stage describes
    (analysis, sample replay, approval), so for them this endpoint can only
    reopen a proposal for editing. No process may be moved to ACTIVE here:
    that previously showed a version as live that the runtime never served.
    """
    _require_kb_access(u, kb_id, "edit")
    with _lifecycle_txn() as conn:
        instance = lifecycle.load_instance(conn, kb_id, instance_id, lock=True)
        if request.to_stage == "ACTIVE":
            raise LifecycleError(409, "Activation requires an approved request, not a stage change.")
        if instance["entity_type"] == "kb_version":
            if request.to_stage != "RULE_EDIT":
                raise LifecycleError(409, (
                    "Policy proposals advance through analysis, testing and approval. "
                    "Only reopening for editing (RULE_EDIT) is a manual step."
                ))
            lifecycle.open_for_editing(conn, instance, u, request.notes or "Reopened for editing")
        else:
            try:
                BPMService.transition_on(
                    conn, instance_id, request.to_stage,
                    actor_id=u.id, actor_name=u.email,
                    notes=request.notes, transition_data=request.transition_data,
                )
            except ValueError as e:
                raise LifecycleError(400, str(e))
    return jsonable_encoder(_bpm_service.get_instance(instance_id))


@router.get("/{kb_id}/instances/{instance_id}/trail")
def get_audit_trail(kb_id: str, instance_id: int, u: UserContext = Depends(_kb_view)):
    """Get the full stage transition audit trail for an instance."""
    _require_kb_access(u, kb_id, "view")
    _scoped_instance(kb_id, instance_id)
    try:
        return jsonable_encoder(_bpm_service.get_audit_trail(instance_id))
    except Exception:
        logger.exception("get_audit_trail failed")
        raise HTTPException(status_code=500, detail="Failed to get audit trail")


@router.get("/{kb_id}/instances/{instance_id}/gates")
def get_gate_results(kb_id: str, instance_id: int, u: UserContext = Depends(_kb_view)):
    """Get simulation/shadow gate results for an instance."""
    _require_kb_access(u, kb_id, "view")
    _scoped_instance(kb_id, instance_id)
    try:
        return jsonable_encoder(_bpm_service.get_gate_results(instance_id))
    except Exception:
        logger.exception("get_gate_results failed")
        raise HTTPException(status_code=500, detail="Failed to get gate results")


@router.get("/{kb_id}/instances/{instance_id}/approvals")
def get_pending_approvals(kb_id: str, instance_id: int, u: UserContext = Depends(_kb_view)):
    """Get pending approvals for an instance."""
    _require_kb_access(u, kb_id, "view")
    _scoped_instance(kb_id, instance_id)
    try:
        return jsonable_encoder(_bpm_service.get_pending_approvals(instance_id))
    except Exception:
        logger.exception("get_pending_approvals failed")
        raise HTTPException(status_code=500, detail="Failed to get approvals")


@router.post("/{kb_id}/instances/{instance_id}/request-approval")
def request_approval(
    kb_id: str,
    instance_id: int,
    request: RequestApprovalRequest,
    u: UserContext = Depends(_kb_edit),
):
    """Create a pending approval request for an instance stage."""
    _require_kb_access(u, kb_id, "edit")
    with _lifecycle_txn() as conn:
        instance = lifecycle.load_instance(conn, kb_id, instance_id)
        if instance["entity_type"] == "kb_version":
            return jsonable_encoder(lifecycle.submit_for_approval(
                conn, kb_id, instance["entity_id"], u, request.justification,
            ))
    try:
        return jsonable_encoder(_bpm_service.request_approval(
            instance_id=instance_id,
            stage=request.stage,
            requested_by_id=u.id,
            requested_by=u.email,
        ))
    except Exception:
        logger.exception("request_approval failed")
        raise HTTPException(status_code=500, detail="Failed to request approval")


# ============================================================
# APPROVALS
# ============================================================

def _approval_instance(approval_id: int) -> dict:
    from sqlalchemy import text
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT a.id AS approval_id, i.id, i.kb_id, i.entity_type
            FROM kirana_kart.bpm_approvals a
            JOIN kirana_kart.bpm_process_instances i ON i.id = a.instance_id
            WHERE a.id = :id
        """), {"id": approval_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Approval not found")
    return dict(row)


def _authorise_decision(u: UserContext, target: dict) -> None:
    """Deciding needs admin on the approval's own KB; policy versions also need policy.admin."""
    _require_kb_access(u, target["kb_id"], "admin")
    if target["entity_type"] == "kb_version" and not _has_policy_admin(u):
        raise HTTPException(status_code=403, detail="Permission denied: policy.admin required")


@router.post("/approvals/{approval_id}/approve")
def approve_request(
    approval_id: int,
    request: ReviewApprovalRequest,
    u: UserContext = Depends(_kb_admin),
):
    """
    Approve a pending approval. For a policy version this activates it —
    approval that only moved the stage marker left the runtime serving the
    previous policy while the board said ACTIVE.
    """
    from app.config import settings

    target = _approval_instance(approval_id)
    _authorise_decision(u, target)
    if target["entity_type"] == "kb_version":
        with _lifecycle_txn() as conn:
            return jsonable_encoder(lifecycle.approve_and_activate(
                conn, engine, target["kb_id"], target["id"], u,
                notes=request.notes, approval_id=approval_id,
                require_separate_approver=settings.policy_require_separate_approver,
            ))
    try:
        return jsonable_encoder(_bpm_service.approve(
            approval_id=approval_id, reviewer_id=u.id,
            reviewer_name=u.email, notes=request.notes,
        ))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("approve failed")
        raise HTTPException(status_code=500, detail="Approval failed")


@router.post("/approvals/{approval_id}/reject")
def reject_request(
    approval_id: int,
    request: ReviewApprovalRequest,
    u: UserContext = Depends(_kb_admin),
):
    """Reject a pending approval."""
    target = _approval_instance(approval_id)
    _authorise_decision(u, target)
    if target["entity_type"] == "kb_version":
        with _lifecycle_txn() as conn:
            return jsonable_encoder(lifecycle.reject_proposal(
                conn, target["kb_id"], target["id"], u, request.notes, approval_id=approval_id,
            ))
    try:
        return jsonable_encoder(_bpm_service.reject(
            approval_id=approval_id, reviewer_id=u.id,
            reviewer_name=u.email, notes=request.notes,
        ))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("reject failed")
        raise HTTPException(status_code=500, detail="Rejection failed")


# ============================================================
# MULTIPART FILE UPLOAD (for VersionWizard frontend)
# ============================================================

async def _read_limited(file: UploadFile, limit: int) -> bytes:
    chunks, size = [], 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > limit:
            raise HTTPException(status_code=413, detail=f"File is larger than {limit // (1024 * 1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/kb/{kb_id}/upload")
async def upload_document_file(
    kb_id: str,
    file: UploadFile = File(...),
    change_name: str = Form(default="", max_length=160),
    business_outcome: str = Form(default="", max_length=2000),
    affected_scope: str = Form(default="", max_length=1000),
    u: UserContext = Depends(_kb_edit),
):
    """
    Accept a multipart file upload (PDF/DOCX/MD/TXT/CSV).
    Converts to markdown, stores in knowledge_base_raw_uploads and creates
    the DRAFT proposal in the same transaction, returns entity_id.
    """
    import base64
    import uuid
    from sqlalchemy import text

    _require_kb_access(u, kb_id, "edit")

    ALLOWED_FORMATS = {"pdf", "docx", "md", "markdown", "txt", "csv"}

    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "txt"
    if ext not in ALLOWED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_FORMATS))}",
        )

    entity_id = f"{kb_id}-{uuid.uuid4().hex[:10]}"
    if len(entity_id) > MAX_ENTITY_ID_LENGTH:
        raise HTTPException(status_code=400, detail="Knowledge base ID is too long for policy versions")

    raw_bytes = await _read_limited(file, MAX_UPLOAD_BYTES)
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        # For binary formats (PDF, DOCX) encode as base64 for the MarkdownConverter
        if ext in ("pdf", "docx"):
            raw_content = base64.b64encode(raw_bytes).decode("ascii")
        else:
            raw_content = raw_bytes.decode("utf-8", errors="replace")

        from app.l1_ingestion.kb_registry.markdown_converter import MarkdownConverter
        markdown_content = MarkdownConverter().convert(raw_content, ext)
    except Exception:
        logger.exception("upload conversion failed")
        raise HTTPException(status_code=400, detail="The document could not be read. Check the file and try again.")

    if not (markdown_content or "").strip():
        raise HTTPException(status_code=400, detail="No readable text was found in this document")

    try:
        with engine.begin() as conn:
            if not conn.execute(text("""
                SELECT 1 FROM kirana_kart.knowledge_bases WHERE kb_id = :kb_id AND is_active = TRUE
            """), {"kb_id": kb_id}).scalar():
                raise HTTPException(status_code=404, detail="Knowledge base not found")

            conn.execute(text("""
                INSERT INTO kirana_kart.knowledge_base_raw_uploads (
                    document_id, original_filename, original_format,
                    raw_content, markdown_content, uploaded_by,
                    version_label, upload_status, is_active,
                    registry_status, kb_id
                ) VALUES (
                    :doc_id, :filename, :fmt,
                    :raw, :md, :by,
                    :version, 'uploaded', TRUE,
                    'active', :kb_id
                )
            """), {
                "doc_id": entity_id,
                "filename": filename,
                "fmt": ext,
                "raw": raw_content if ext not in ("pdf", "docx") else "[binary]",
                "md": markdown_content,
                "by": u.email,
                "version": entity_id,
                "kb_id": kb_id,
            })

            instance = _bpm_service.create_instance(
                kb_id=kb_id,
                process_name="kb_policy_lifecycle",
                entity_id=entity_id,
                entity_type="kb_version",
                created_by_id=u.id,
                created_by_name=u.email,
                metadata={"business_brief": {
                    "name": change_name.strip() or filename,
                    "outcome": business_outcome.strip(),
                    "scope": affected_scope.strip(),
                }},
                conn=conn,
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("upload_document_file failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")

    return {
        "entity_id": entity_id,
        "filename": filename,
        "upload_id": entity_id,
        "bpm_instance_id": instance["id"],
    }


@router.post("/kb/{kb_id}/simulate")
def simulate_version(
    kb_id: str,
    body: dict,
    u: UserContext = Depends(_kb_edit),
):
    """
    Run the sample replay gate for a candidate policy version.

    Replays the saved sample tickets against the candidate rules and the
    currently active baseline, records the result as the proposal's
    simulation gate and advances it: within threshold (or with no live
    policy to compare against) → SHADOW_GATE, otherwise SIMULATION_FAILED.

    When the replay genuinely cannot run (no rules, no sample tickets,
    unresolved review items) the response says so with status="unavailable",
    carries no metrics and leaves the stage unchanged. It never invents a rate.
    """
    from app.l45_ml_platform.simulation.policy_simulation_service import (
        PolicySimulationService,
    )

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")
    with _lifecycle_txn() as conn:
        result = lifecycle.run_simulation_gate(
            conn, kb_id, entity_id, u, PolicySimulationService(engine),
        )
    return jsonable_encoder(result)


@router.post("/kb/{kb_id}/submit")
def submit_for_approval(
    kb_id: str,
    body: SubmitRequest,
    u: UserContext = Depends(_kb_edit),
):
    """
    Request approval for a tested proposal. Freezes its rules as a compiled
    version and queues the runtime preparation (vectorization) an approver
    waits on. A proposal whose replay exceeded the change threshold needs a
    written justification.
    """
    _require_kb_access(u, kb_id, "edit")
    with _lifecycle_txn() as conn:
        result = lifecycle.submit_for_approval(conn, kb_id, _entity_id(body), u, body.justification)
    return jsonable_encoder(result)


@router.get("/kb/{kb_id}/proposals/{entity_id}/readiness")
def proposal_readiness(kb_id: str, entity_id: str, u: UserContext = Depends(_kb_view)):
    """Review, preparation and approval state an approver needs before activating."""
    _require_kb_access(u, kb_id, "view")
    with _lifecycle_txn() as conn:
        return jsonable_encoder(lifecycle.readiness(conn, kb_id, entity_id))


@router.post("/kb/{kb_id}/publish")
def publish_version_bpm(
    kb_id: str,
    body: PublishRequest,
    u: UserContext = Depends(_policy_admin),
):
    """
    Approve the open request for a policy version and make it live.

    Runs the same activation path as POST /kb/publish
    (KBRegistryService.publish_version, which sets
    kb_runtime_config.active_version *and* policy_versions.is_active),
    together with the registry commit of the approved categories and
    responses, the approval record and the ACTIVE stage, in one transaction:
    a failure at any step leaves all of them unchanged. The previously live
    version's proposal is retired.

    The submitter cannot publish their own request unless
    POLICY_REQUIRE_SEPARATE_APPROVER is disabled.
    """
    from app.config import settings

    _require_kb_access(u, kb_id, "admin")
    with _lifecycle_txn() as conn:
        instance = lifecycle.load_proposal(conn, kb_id, _entity_id(body))
        result = lifecycle.approve_and_activate(
            conn, engine, kb_id, instance["id"], u, notes=body.notes,
            require_separate_approver=settings.policy_require_separate_approver,
        )
    return {"message": "Published", "entity_id": instance["entity_id"], **result}


@router.post("/kb/{kb_id}/compile")
def compile_document(
    kb_id: str,
    body: dict,
    u: UserContext = Depends(_kb_edit),
):
    """
    Legacy: mark an upload for compilation (DRAFT → AI_COMPILE_QUEUED).
    Policy Studio analyses documents through extract-taxonomy instead; this
    only records the queued state.
    """
    from sqlalchemy import text

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")

    with _lifecycle_txn() as conn:
        instance = lifecycle.load_proposal(conn, kb_id, entity_id, lock=True)
        if instance["current_stage"] not in ("DRAFT", "AI_COMPILE_FAILED"):
            raise LifecycleError(400, f"Cannot compile from stage '{instance['current_stage']}'")
        lifecycle.start_analysis(conn, instance, u)
        conn.execute(text("""
            UPDATE kirana_kart.knowledge_base_raw_uploads
            SET upload_status = 'pending_compile', registry_status = 'queued'
            WHERE document_id = :eid AND kb_id = :kb_id
        """), {"eid": entity_id, "kb_id": kb_id})

    return {"message": "Compilation queued", "entity_id": entity_id}


# ============================================================
# ML MODEL HEALTH + FORCE RETRAIN
# ============================================================

@router.get("/ml/health")
def ml_health(
    kb_id: str = Query("default"),
    u: UserContext = Depends(_kb_view),
):
    """Return current status of all 3 ML models for the MLHealthPanel UI."""
    from app.l45_ml_platform.models.model_store import get_model_health
    _require_kb_access(u, kb_id, "view")
    return get_model_health(engine, kb_id)


@router.post("/ml/retrain")
def force_retrain(
    kb_id: str = Query("default"),
    u: UserContext = Depends(_kb_admin),
):
    """Manually trigger model retraining (normally runs nightly)."""
    from app.l45_ml_platform.models.training_jobs import run_nightly_retraining
    _require_kb_access(u, kb_id, "admin")
    result = run_nightly_retraining(engine, kb_id)
    return result


# ============================================================
# SOP EXTRACTION — 3-STAGE PIPELINE
# ============================================================

_TAXONOMY_EDIT_FIELDS = {"label": 255, "description": 2000}
_ACTION_EDIT_FIELDS = {"action_name": 255, "action_description": 2000, "exact_action": 4000}


class ReviewProposalRequest(BaseModel):
    status: str        # 'accepted' | 'rejected' | 'edited'
    edit_reason: Optional[str] = Field(default=None, max_length=2000)
    user_output: Optional[dict] = None   # edited fields


def _validated_edits(body: ReviewProposalRequest, allowed: dict[str, int]) -> Optional[dict]:
    if body.status not in {"accepted", "rejected", "edited"}:
        raise HTTPException(status_code=400, detail="status must be one of accepted, rejected, edited")
    if body.status != "edited":
        return None
    edits = body.user_output or {}
    unknown = set(edits) - set(allowed)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Cannot edit: {', '.join(sorted(unknown))}")
    for key, limit in allowed.items():
        value = edits.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > limit):
            raise HTTPException(status_code=400, detail=f"{key} must be text of at most {limit} characters")
    name_field = "label" if "label" in allowed else "action_name"
    if name_field in edits and not (edits[name_field] or "").strip():
        raise HTTPException(status_code=400, detail=f"{name_field} cannot be empty")
    return edits


def _sop_text(kb_id: str, entity_id: str) -> str:
    from sqlalchemy import text
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT markdown_content FROM kirana_kart.knowledge_base_raw_uploads
            WHERE document_id = :eid AND kb_id = :kb_id
        """), {"eid": entity_id, "kb_id": kb_id}).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Upload not found")
    return row[0] or ""


def _run_analysis(kb_id: str, entity_id: str, u: UserContext, extractor, label: str) -> dict:
    """
    Record the analysis start, run the (slow) LLM call outside any lock, and
    record a failure on the proposal so it does not sit in 'analysing'.
    """
    from app.l45_ml_platform.compiler.sop_extractor import sop_truncated, SOP_CHAR_LIMIT

    sop_text = _sop_text(kb_id, entity_id)
    with _lifecycle_txn() as conn:
        lifecycle.start_analysis(conn, lifecycle.load_proposal(conn, kb_id, entity_id, lock=True), u)
    def still_editable(conn) -> None:
        lifecycle.open_for_editing(
            conn, lifecycle.load_proposal(conn, kb_id, entity_id, lock=True), u,
            f"{label} analysis completed",
        )

    try:
        proposals = extractor(engine, kb_id, entity_id, sop_text, before_write=still_editable)
    except LifecycleError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except Exception:
        logger.exception("%s extraction failed for %s", label, entity_id)
        with _lifecycle_txn() as conn:
            lifecycle.analysis_failed(
                conn, lifecycle.load_proposal(conn, kb_id, entity_id, lock=True), u,
                f"{label} analysis failed",
            )
        raise HTTPException(status_code=500, detail=f"{label} extraction failed")
    return {
        "proposals": proposals,
        "count": len(proposals),
        "truncated": sop_truncated(sop_text),
        "analysed_characters": min(len(sop_text), SOP_CHAR_LIMIT),
        "document_characters": len(sop_text),
    }


@router.post("/kb/{kb_id}/extract-taxonomy")
def extract_taxonomy_stage(
    kb_id: str,
    body: dict,
    u: UserContext = Depends(_kb_edit),
):
    """
    Stage 1: LLM reads the uploaded SOP and proposes an issue taxonomy.
    entity_id links to the knowledge_base_raw_uploads row.

    Declared `def`, not `async def`: extract_taxonomy makes synchronous
    OpenAI and SQLAlchemy calls, and SOP extraction is the slowest operation
    in the app. As an async handler it blocked the event loop — and therefore
    every other request — for its whole duration. FastAPI runs a sync handler
    in the threadpool. The same applies to extract_actions_stage below.

    `truncated` reports when the document is longer than the analysed prefix.
    """
    from app.l45_ml_platform.compiler.sop_extractor import extract_taxonomy

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")
    return jsonable_encoder(_run_analysis(kb_id, entity_id, u, extract_taxonomy, "Taxonomy"))


@router.get("/kb/{kb_id}/taxonomy-proposals")
def list_taxonomy_proposals(
    kb_id: str,
    entity_id: str = Query(...),
    u: UserContext = Depends(_kb_view),
):
    """List all taxonomy proposals for a given entity/upload."""
    from sqlalchemy import text
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, issue_code, label, description, parent_code, level,
                   proposal_type, status, extraction_confidence, edit_reason,
                   llm_output, user_output, edited_at
            FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
            ORDER BY level, issue_code
        """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()
    return jsonable_encoder([dict(r) for r in rows])


def _review_proposal(kb_id: str, proposal_id: int, body: ReviewProposalRequest,
                     u: UserContext, table: str, stage: str, ref_column: str,
                     allowed: dict[str, int]) -> dict:
    from sqlalchemy import text

    edits = _validated_edits(body, allowed)
    with _lifecycle_txn() as conn:
        row = conn.execute(text(f"""
            SELECT * FROM kirana_kart.{table}
            WHERE id = :id AND kb_id = :kb_id
        """), {"id": proposal_id, "kb_id": kb_id}).mappings().first()
        if not row:
            raise LifecycleError(404, "Proposal not found")

        instance = lifecycle.load_proposal(conn, kb_id, row["entity_id"], lock=True)
        lifecycle.open_for_editing(conn, instance, u, f"Review decision changed for {row[ref_column]}")

        conn.execute(text(f"""
            UPDATE kirana_kart.{table}
            SET status = :status,
                edit_reason = :reason,
                user_output = :user_out,
                edited_at = NOW(),
                edited_by = :uid
            WHERE id = :id
        """), {
            "status": body.status,
            "reason": body.edit_reason,
            "user_out": json.dumps(edits) if edits else None,
            "uid": u.id,
            "id": proposal_id,
        })

        # Record to edit log
        conn.execute(text("""
            INSERT INTO kirana_kart.rule_edit_log
                (kb_id, entity_id, stage, item_ref, edit_type, llm_output, user_output, edit_reason, created_by)
            VALUES
                (:kb_id, :eid, :stage, :ref, :etype, :llm, :usr, :reason, :uid)
        """), {
            "kb_id": kb_id,
            "eid": row["entity_id"],
            "stage": stage,
            "ref": row[ref_column],
            "etype": body.status,
            "llm": json.dumps(row["llm_output"]) if row["llm_output"] is not None else None,
            "usr": json.dumps(edits) if edits else None,
            "reason": body.edit_reason,
            "uid": u.id,
        })

    return {"id": proposal_id, "status": body.status}


@router.put("/kb/{kb_id}/taxonomy-proposals/{proposal_id}")
def review_taxonomy_proposal(
    kb_id: str,
    proposal_id: int,
    body: ReviewProposalRequest,
    u: UserContext = Depends(_kb_edit),
):
    """Accept, reject, or edit a taxonomy proposal. Edits recorded for ML."""
    _require_kb_access(u, kb_id, "edit")
    return _review_proposal(kb_id, proposal_id, body, u, "draft_taxonomy_proposals",
                            "taxonomy", "issue_code", _TAXONOMY_EDIT_FIELDS)


@router.post("/kb/{kb_id}/extract-actions")
def extract_actions_stage(
    kb_id: str,
    body: dict,
    u: UserContext = Depends(_kb_edit),
):
    """
    Stage 2: LLM reads the SOP + accepted taxonomy proposals → extracts action codes.
    Must be called after at least some taxonomy proposals are accepted.
    """
    from app.l45_ml_platform.compiler.sop_extractor import extract_actions

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")
    return jsonable_encoder(_run_analysis(kb_id, entity_id, u, extract_actions, "Action"))


@router.get("/kb/{kb_id}/action-proposals")
def list_action_proposals(
    kb_id: str,
    entity_id: str = Query(...),
    u: UserContext = Depends(_kb_view),
):
    """List all action proposals for a given entity/upload."""
    from sqlalchemy import text
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, action_code_id, action_name, action_description, exact_action,
                   parent_issue_codes, requires_refund, requires_escalation,
                   automation_eligible, proposal_type, status,
                   extraction_confidence, edit_reason, llm_output, user_output, edited_at
            FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
            ORDER BY action_code_id
        """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()
    return jsonable_encoder([dict(r) for r in rows])


@router.put("/kb/{kb_id}/action-proposals/{proposal_id}")
def review_action_proposal(
    kb_id: str,
    proposal_id: int,
    body: ReviewProposalRequest,
    u: UserContext = Depends(_kb_edit),
):
    """Accept, reject, or edit an action proposal. Edits recorded for ML."""
    _require_kb_access(u, kb_id, "edit")
    return _review_proposal(kb_id, proposal_id, body, u, "draft_action_proposals",
                            "action", "action_code_id", _ACTION_EDIT_FIELDS)


@router.post("/kb/{kb_id}/generate-rules")
def generate_rules_stage(
    kb_id: str,
    body: dict,
    u: UserContext = Depends(_kb_edit),
):
    """
    Stage 3: Deterministic rule generation from accepted taxonomy × action proposals.
    No LLM call. Replaces the version's rules (including manual edits) and
    moves the proposal to RULE_EDIT. Returns the rules and every accepted
    pairing that could not become one.
    """
    from app.l45_ml_platform.compiler.sop_extractor import generate_rules

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")

    with _lifecycle_txn() as conn:
        instance = lifecycle.load_proposal(conn, kb_id, entity_id, lock=True)
        lifecycle.open_for_editing(conn, instance, u, "Decisions regenerated")
        result = generate_rules(engine, kb_id, entity_id, conn=conn)
        lifecycle.rules_generated(conn, instance, u, len(result["rules"]))
    return jsonable_encoder({**result, "count": len(result["rules"]), "stage": instance["current_stage"]})


@router.get("/standards/{kb_id}")
def get_extraction_standards(
    kb_id: str,
    u: UserContext = Depends(_kb_view),
):
    """Return the current extraction_standards.md for this KB."""
    from sqlalchemy import text
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT standards_md, version, updated_at
            FROM kirana_kart.extraction_standards
            WHERE kb_id = :kb_id
        """), {"kb_id": kb_id}).fetchone()
    if not row:
        return {"standards_md": "", "version": 0, "updated_at": None}
    return {"standards_md": row[0], "version": row[1], "updated_at": str(row[2])}
