"""
app/admin/routes/consent_routes.py
=====================================
DPDP Act §6 — Consent management endpoints.

Endpoints:
    POST /consent/withdraw          — Data principal withdraws consent for a purpose
    GET  /consent/status            — Data principal checks their consent status
    GET  /consent/admin/{user_id}   — Admin views consent records for a user (system.admin)
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.services.auth_service import UserContext, get_current_user, require_permission

logger = logging.getLogger("kirana_kart.consent")

router = APIRouter(prefix="/consent", tags=["consent"])


class ConsentWithdrawRequest(BaseModel):
    purpose: str  # e.g. "marketing", "analytics"


# ---------------------------------------------------------------------------
# My consent status
# ---------------------------------------------------------------------------


@router.get("/status")
def my_consent_status(user: UserContext = Depends(get_current_user)):
    """Return all active consent records for the current user."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT purpose, consent_given, consent_timestamp,
                       withdrawal_timestamp, version
                FROM kirana_kart.consent_records
                WHERE data_principal_id = :uid AND principal_type = 'user'
                ORDER BY consent_timestamp DESC
            """),
            {"uid": user.id},
        ).mappings().all()

    return {
        "user_id": user.id,
        "consents": [dict(r) for r in rows],
    }


# ---------------------------------------------------------------------------
# Withdraw consent
# ---------------------------------------------------------------------------


@router.post("/withdraw")
def withdraw_consent(
    payload: ConsentWithdrawRequest,
    user: UserContext = Depends(get_current_user),
):
    """
    Withdraw consent for a specific processing purpose.
    DPDP Act §6(3): Data principal has the right to withdraw consent at any time.
    Note: Withdrawal may limit platform functionality (e.g. withdrawing
    'account_management' will result in account deactivation).
    """
    with get_db_session() as session:
        result = session.execute(
            text("""
                UPDATE kirana_kart.consent_records
                SET consent_given = FALSE,
                    withdrawal_timestamp = NOW()
                WHERE data_principal_id = :uid
                  AND principal_type = 'user'
                  AND purpose = :purpose
                  AND consent_given = TRUE
                  AND withdrawal_timestamp IS NULL
                RETURNING id
            """),
            {"uid": user.id, "purpose": payload.purpose},
        ).mappings().first()

    if not result:
        raise HTTPException(
            status_code=404,
            detail=f"No active consent found for purpose '{payload.purpose}'",
        )

    logger.info(
        "Consent withdrawn [user_id=%d purpose=%s]",
        user.id,
        payload.purpose,
    )
    return {
        "status": "withdrawn",
        "purpose": payload.purpose,
        "message": (
            "Your consent has been withdrawn. Data processing for this purpose "
            "will stop. Some features may no longer be available."
        ),
    }


# ---------------------------------------------------------------------------
# Admin: view consent records for a user
# ---------------------------------------------------------------------------


@router.get("/admin/{user_id}")
def admin_consent_status(
    user_id: int,
    _admin: UserContext = Depends(require_permission("system", "admin")),
):
    """Admin: view all consent records for any user."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT purpose, consent_given, consent_timestamp,
                       withdrawal_timestamp, ip_address, version
                FROM kirana_kart.consent_records
                WHERE data_principal_id = :uid AND principal_type = 'user'
                ORDER BY consent_timestamp DESC
            """),
            {"uid": user_id},
        ).mappings().all()

    return {
        "user_id": user_id,
        "consents": [dict(r) for r in rows],
    }
