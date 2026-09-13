# app/admin/routes/taxonomy.py

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field

from app.admin.services.taxonomy_service import (
    fetch_all_issues,
    add_issue,
    update_issue,
    deactivate_issue,
    reactivate_issue,
    rollback_taxonomy,
    list_versions,
    get_version_snapshot,
    diff_versions,
    validate_taxonomy,
    fetch_audit_logs,
    publish_version_atomic,
    get_active_version,
    get_draft_issues,
    save_draft,
)

from app.admin.routes.auth import UserContext, require_permission

from app.admin.services.vector_service import (
    vectorize_active,
    vectorize_version,
    vector_status,
)

router = APIRouter(prefix="/taxonomy", tags=["taxonomy"])

_view  = require_permission("taxonomy", "view")
_edit  = require_permission("taxonomy", "edit")
_admin = require_permission("taxonomy", "admin")


# ============================================================
# RESPONSE FORMATTERS
# ============================================================

def format_issue(row):
    return {
        "id": row[0],
        "issue_code": row[1],
        "label": row[2],
        "description": row[3],
        "parent_id": row[4],
        "level": row[5],
        "is_active": row[6],
        "created_at": row[7],
        "updated_at": row[8],
    }


def format_draft(row):
    return {
        "id": row[0],
        "issue_code": row[1],
        "label": row[2],
        "description": row[3],
        "parent_id": row[4],
        "level": row[5],
        "is_active": row[6],
        "created_at": row[7],
        "updated_at": row[8],
    }


def format_version(row):
    return dict(row)


def format_audit(row):
    return dict(row)


# ============================================================
# REQUEST MODELS
# ============================================================

class AddIssueRequest(BaseModel):
    issue_code: str = Field(..., min_length=3)
    label: str
    description: Optional[str] = None
    parent_id: Optional[int] = None
    level: int = Field(..., ge=1)


class UpdateIssueRequest(BaseModel):
    issue_code: str
    label: str
    description: Optional[str] = None


class IssueCodeRequest(BaseModel):
    issue_code: str


class VersionRequest(BaseModel):
    version_label: str


# ============================================================
# READ
# ============================================================

@router.get("/")
def get_all(include_inactive: bool = Query(False), _u: UserContext = Depends(_view)):
    rows = fetch_all_issues(include_inactive)
    return [format_issue(r) for r in rows]


@router.get("/drafts")
def drafts(_u: UserContext = Depends(_view)):
    rows = get_draft_issues()
    return [format_draft(r) for r in rows]


@router.get("/versions")
def versions(_u: UserContext = Depends(_view)):
    rows = list_versions()
    return [format_version(r) for r in rows]


@router.get("/version/{version_label}")
def version_snapshot(version_label: str, _u: UserContext = Depends(_view)):
    snapshot = get_version_snapshot(version_label)
    return {
        "version_id": None,
        "version_label": version_label,
        "created_by": None,
        "created_at": None,
        "snapshot_data": snapshot,
        "status": "snapshot",
    }


@router.get("/diff")
def diff(from_version: str, to_version: str, _u: UserContext = Depends(_view)):
    return diff_versions(from_version, to_version)


@router.get("/active-version")
def active_version(_u: UserContext = Depends(_view)):
    return {"active_version": get_active_version()}


@router.get("/validate")
def validate(_u: UserContext = Depends(_edit)):
    errors = validate_taxonomy()
    return {"valid": len(errors) == 0, "errors": errors}


@router.get("/audit")
def audit(limit: int = 100, _u: UserContext = Depends(_view)):
    rows = fetch_audit_logs(limit)
    return [format_audit(r) for r in rows]


# ============================================================
# DRAFT SAVE
# ============================================================

@router.post("/draft/save")
def save_draft_endpoint(payload: AddIssueRequest, _u: UserContext = Depends(_edit)):
    save_draft(
        payload.issue_code,
        payload.label,
        payload.description,
        payload.parent_id,
        payload.level
    )
    return {"status": "draft_saved"}


# ============================================================
# LIVE CRUD
# ============================================================

@router.post("/add")
def add(payload: AddIssueRequest, _u: UserContext = Depends(_edit)):
    snapshot = add_issue(
        payload.issue_code,
        payload.label,
        payload.description,
        payload.parent_id,
        payload.level,
    )
    return {"status": "success", "snapshot_created": snapshot}


@router.put("/update")
def update(payload: UpdateIssueRequest, _u: UserContext = Depends(_edit)):
    snapshot = update_issue(
        payload.issue_code,
        payload.label,
        payload.description,
    )
    return {"status": "success", "snapshot_created": snapshot}


@router.patch("/deactivate")
def deactivate(payload: IssueCodeRequest, _u: UserContext = Depends(_edit)):
    snapshot = deactivate_issue(payload.issue_code)
    return {"status": "success", "snapshot_created": snapshot}


@router.patch("/reactivate")
def reactivate(payload: IssueCodeRequest, _u: UserContext = Depends(_edit)):
    snapshot = reactivate_issue(payload.issue_code)
    return {"status": "success", "snapshot_created": snapshot}


# ============================================================
# ROLLBACK
# ============================================================

@router.post("/rollback")
def rollback(payload: VersionRequest, _u: UserContext = Depends(_admin)):
    rollback_taxonomy(payload.version_label)
    return {"status": "rolled_back", "version": payload.version_label}


# ============================================================
# PUBLISH
# ============================================================

@router.post("/publish")
def publish(payload: VersionRequest, _u: UserContext = Depends(_admin)):
    publish_version_atomic(payload.version_label)
    return {
        "status": "published",
        "version": payload.version_label,
        "vector_job_queued": True
    }


# ============================================================
# VECTOR
# ============================================================

@router.post("/vectorize-active")
def vectorize_current(_u: UserContext = Depends(_admin)):
    result = vectorize_active()
    return result


@router.post("/vectorize-version")
def vectorize_specific(payload: VersionRequest, _u: UserContext = Depends(_admin)):
    result = vectorize_version(payload.version_label)
    return result


@router.get("/vector-status")
def vector_state(_u: UserContext = Depends(_view)):
    return vector_status()
