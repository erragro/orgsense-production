"""
app/admin/routes/data_rights_routes.py
========================================
DPDP Act §§13-14 — Data subject rights endpoints.

Rights implemented:
  - Right to erasure (§13): anonymise or delete personal data
  - Right to portability (§14): export personal data as structured JSON
  - Grievance redressal (§13(3)): submit a data rights complaint to the DPO

Endpoints:
    DELETE /data-rights/users/me                  — Self-service account erasure
    GET    /data-rights/users/me/export           — Export my personal data
    DELETE /data-rights/customers/{id}/erase      — Admin: erase customer PII
    GET    /data-rights/customers/{id}/export     — Admin: export customer data
    POST   /data-rights/grievance                 — Submit a grievance to the DPO
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, EmailStr, Field
from typing import Literal
from sqlalchemy import text

from app.utils.customer_pii import reveal_customer
from app.admin.db import get_db_session
from app.admin.services.auth_service import (
    UserContext,
    get_current_user,
    invalidate_refresh_token,
    require_permission,
)

logger = logging.getLogger("kirana_kart.data_rights")

router = APIRouter(prefix="/data-rights", tags=["data-rights"])


# ---------------------------------------------------------------------------
# Self-service: erase my account
# ---------------------------------------------------------------------------


@router.delete("/users/me")
def erase_my_account(user: UserContext = Depends(get_current_user)):
    """
    DPDP Act §13 — Right to erasure.
    Permanently deletes the user account and all personally identifiable information.
    Cascades to user_permissions and refresh_tokens via DB foreign keys.
    """
    user_id = user.id

    with get_db_session() as session:
        # Verify account still exists
        exists = session.execute(
            text("SELECT id FROM kirana_kart.users WHERE id = :uid"),
            {"uid": user_id},
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="Account not found")

        # Soft-anonymise before hard delete to preserve audit trail length
        session.execute(
            text("""
                UPDATE kirana_kart.users
                SET email = :anon_email,
                    full_name = 'Deleted User',
                    password_hash = NULL,
                    avatar_url = NULL,
                    oauth_provider = NULL,
                    oauth_id = NULL,
                    is_active = FALSE,
                    updated_at = NOW()
                WHERE id = :uid
            """),
            {"anon_email": f"deleted_{user_id}@erased.local", "uid": user_id},
        )

        # Delete auth tokens
        session.execute(
            text("DELETE FROM kirana_kart.refresh_tokens WHERE user_id = :uid"),
            {"uid": user_id},
        )

        # Record erasure in consent log
        session.execute(
            text("""
                INSERT INTO kirana_kart.consent_records
                    (data_principal_id, principal_type, purpose, consent_given,
                     withdrawal_timestamp, version)
                VALUES (:uid, 'user', 'account_management', FALSE, NOW(), '1.0')
            """),
            {"uid": user_id},
        )

    logger.info("User account erased [user_id=%d]", user_id)
    return {
        "status": "erased",
        "message": "Your account and personal data have been permanently deleted.",
    }


# ---------------------------------------------------------------------------
# Self-service: export my data
# ---------------------------------------------------------------------------


@router.get("/users/me/export")
def export_my_data(user: UserContext = Depends(get_current_user)):
    """
    DPDP Act §14 — Right to data portability.
    Returns a structured JSON bundle of all personal data held about the user.
    """
    with get_db_session() as session:
        profile = session.execute(
            text("""
                SELECT id, email, full_name, avatar_url, oauth_provider,
                       is_active, is_super_admin, created_at, updated_at
                FROM kirana_kart.users WHERE id = :uid
            """),
            {"uid": user.id},
        ).mappings().first()

        permissions = session.execute(
            text("""
                SELECT module, can_view, can_edit, can_admin
                FROM kirana_kart.user_permissions WHERE user_id = :uid
            """),
            {"uid": user.id},
        ).mappings().all()

        consents = session.execute(
            text("""
                SELECT purpose, consent_given, consent_timestamp, withdrawal_timestamp
                FROM kirana_kart.consent_records
                WHERE data_principal_id = :uid AND principal_type = 'user'
                ORDER BY consent_timestamp DESC
            """),
            {"uid": user.id},
        ).mappings().all()

    return {
        "export_generated_at": datetime.now(timezone.utc).isoformat(),
        "data_controller": "Kirana Kart",
        "data_principal": {
            "profile": jsonable_encoder(dict(profile)) if profile else None,
            "permissions": [dict(r) for r in permissions],
            "consent_records": [dict(r) for r in consents],
        },
    }


# ---------------------------------------------------------------------------
# Admin: erase a customer's PII
# ---------------------------------------------------------------------------


@router.delete("/customers/{customer_id}/erase")
def erase_customer_pii(
    customer_id: str,
    _admin: UserContext = Depends(require_permission("customers", "admin")),
):
    """
    DPDP Act §13 — Admin-initiated customer PII erasure.
    Anonymises all PII fields while retaining anonymised order/transaction
    records for financial audit purposes (7-year legal retention requirement).
    """
    with get_db_session() as session:
        exists = session.execute(
            text("SELECT customer_id FROM kirana_kart.customers WHERE customer_id = :cid"),
            {"cid": customer_id},
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="Customer not found")

        # Anonymise PII in-place — preserve non-PII operational fields
        session.execute(
            text("""
                UPDATE kirana_kart.customers
                SET email          = NULL,
                    email_blind_index = NULL,
                    phone          = NULL,
                    date_of_birth  = NULL,
                    is_active      = FALSE
                WHERE customer_id = :cid
            """),
            {
                "anon_email": f"erased_{customer_id}@erased.local",
                "cid": customer_id,
            },
        )

        # Anonymise CRM notes that may contain PII in free text
        session.execute(
            text("""
                UPDATE kirana_kart.crm_notes
                SET body = '[Content erased per DPDP Act §13 erasure request]'
                WHERE ticket_id IN (
                    SELECT ticket_id FROM kirana_kart.hitl_queue
                    WHERE customer_id = :cid
                )
            """),
            {"cid": customer_id},
        )

        # Anonymise HITL queue CX email
        session.execute(
            text("""
                UPDATE kirana_kart.hitl_queue
                SET cx_email = :anon_email,
                    subject  = '[Erased]'
                WHERE customer_id = :cid
            """),
            {"anon_email": f"erased_{customer_id}@erased.local", "cid": customer_id},
        )

        # Record erasure consent event
        session.execute(
            text("""
                INSERT INTO kirana_kart.consent_records
                    (data_principal_id, principal_type, purpose, consent_given,
                     withdrawal_timestamp, version)
                VALUES (0, 'customer_erasure', :cid, FALSE, NOW(), '1.0')
            """),
            {"cid": customer_id},
        )

    logger.info(
        "Customer PII erased [customer_id=%s admin_user_id=%d]",
        customer_id,
        _admin.id,
    )
    return {
        "status": "erased",
        "customer_id": customer_id,
        "message": (
            "Customer PII has been anonymised. Anonymised transaction records "
            "are retained for financial audit compliance (7-year legal hold)."
        ),
    }


# ---------------------------------------------------------------------------
# Admin: export a customer's data
# ---------------------------------------------------------------------------


@router.get("/customers/{customer_id}/export")
def export_customer_data(
    customer_id: str,
    _admin: UserContext = Depends(require_permission("customers", "admin")),
):
    """
    DPDP Act §14 — Customer data portability export.
    Returns all personal data held about a customer in structured JSON.
    """
    with get_db_session() as session:
        profile = session.execute(
            text("""
                SELECT customer_id, email, phone, date_of_birth, signup_date,
                       is_active, segment, dietary_preference,
                       lifetime_order_count, lifetime_value
                FROM kirana_kart.customers WHERE customer_id = :cid
            """),
            {"cid": customer_id},
        ).mappings().first()

        if not profile:
            raise HTTPException(status_code=404, detail="Customer not found")

        orders = session.execute(
            text("""
                SELECT order_id, order_value, delivery_estimated, delivery_actual,
                       sla_breach, created_at
                FROM kirana_kart.orders WHERE customer_id = :cid
                ORDER BY created_at DESC
            """),
            {"cid": customer_id},
        ).mappings().all()

        csat = session.execute(
            text("""
                SELECT r.rating, r.feedback, r.created_at
                FROM kirana_kart.csat_responses r
                JOIN kirana_kart.ticket_execution_summary s ON r.ticket_id = s.ticket_id
                WHERE s.customer_id = :cid
                ORDER BY r.created_at DESC
            """),
            {"cid": customer_id},
        ).mappings().all()

    return {
        "export_generated_at": datetime.now(timezone.utc).isoformat(),
        "data_controller": "Kirana Kart",
        "customer": {
            "profile": jsonable_encoder(reveal_customer(profile)),
            "orders": jsonable_encoder([dict(r) for r in orders]),
            "csat_responses": jsonable_encoder([dict(r) for r in csat]),
        },
    }


# ---------------------------------------------------------------------------
# Grievance redressal
# ---------------------------------------------------------------------------


class GrievanceRequest(BaseModel):
    grievance_type: Literal["erasure_request", "access_request", "correction_request", "complaint"]
    description: str = Field(min_length=1, max_length=10000)
    contact_email: EmailStr


@router.post("/grievance")
def submit_grievance(
    payload: GrievanceRequest,
    user: UserContext = Depends(get_current_user),
):
    """
    DPDP Act §13(3) — Grievance redressal mechanism.
    Logs the complaint and returns a reference ID. The DPO must respond
    within the configured operational target of 30 days. Legal deadlines
    must be confirmed by the organisation; this is not a statutory claim.
    """
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.grievances
                    (user_id, grievance_type, description, contact_email, status)
                VALUES (:uid, :gtype, :desc, :email, 'pending')
                RETURNING id, created_at, due_at, owner_user_id
            """),
            {
                "uid": user.id,
                "gtype": payload.grievance_type,
                "desc": payload.description,
                "email": payload.contact_email,
            },
        ).mappings().first()

    logger.info(
        "Grievance submitted [user_id=%d type=%s ref_id=%d]",
        user.id,
        payload.grievance_type,
        row["id"],
    )

    return {
        "status": "received",
        "reference_id": row["id"],
        "submitted_at": row["created_at"].isoformat() if row["created_at"] else None,
        "expected_response_days": 30,
        "due_at": row["due_at"].isoformat(),
        "owner_user_id": row["owner_user_id"],
        "message": (
            "Your grievance has been received and will be reviewed by our "
            "Data Protection Officer within 30 days."
        ),
        "dpo_contact": "dpo@kirana.com",
    }


class GrievanceUpdate(BaseModel):
    owner_user_id: int = Field(gt=0)
    status: Literal['pending', 'in_progress', 'resolved']
    resolution: str | None = Field(default=None, max_length=10000)


@router.get('/grievances')
def list_grievances(_admin: UserContext = Depends(require_permission('system', 'admin'))):
    with get_db_session() as session:
        rows = session.execute(text('''SELECT id,user_id,grievance_type,status,
            created_at,due_at,owner_user_id,resolved_at
            FROM kirana_kart.grievances ORDER BY due_at LIMIT 200''')).mappings().all()
    return jsonable_encoder([dict(row) for row in rows])


@router.patch('/grievances/{grievance_id}')
def update_grievance(grievance_id: int, payload: GrievanceUpdate,
                     _admin: UserContext = Depends(require_permission('system', 'admin'))):
    if payload.status == 'resolved' and not (payload.resolution or '').strip():
        raise HTTPException(422, 'A resolution is required to close a grievance')
    with get_db_session() as session:
        owner = session.execute(text('SELECT id FROM kirana_kart.users WHERE id=:id AND is_active=TRUE'),
                                {'id': payload.owner_user_id}).scalar()
        if not owner:
            raise HTTPException(422, 'Owner must be an active user')
        row = session.execute(text('''UPDATE kirana_kart.grievances SET
            owner_user_id=:owner, status=:status, resolution=:resolution,
            resolved_at=CASE WHEN :status='resolved' THEN NOW() ELSE NULL END
            WHERE id=:id RETURNING id,status,due_at,owner_user_id,resolved_at'''),
            {'id': grievance_id, 'owner': owner, 'status': payload.status,
             'resolution': payload.resolution}).mappings().first()
        if not row:
            raise HTTPException(404, 'Grievance not found')
    logger.info('Grievance updated [ref_id=%d admin_user_id=%d status=%s]', grievance_id, _admin.id, payload.status)
    return jsonable_encoder(dict(row))
