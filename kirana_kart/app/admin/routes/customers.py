from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

from app.utils.customer_pii import email_index, reveal_customer
from app.admin.db import get_db_session
from app.admin.routes.auth import UserContext, require_permission
from app.middleware.pii_audit_middleware import log_pii_access

# Columns these endpoints return that are personal data under the DPDP Act.
_PII_FIELDS = ["email", "phone", "date_of_birth"]

router = APIRouter(prefix="/customers", tags=["customers"])

_view = require_permission("customers", "view")


@router.get("/")
def list_customers(
    request: Request,
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=200),
    search: str | None = None,
    segment: str | None = None,
    user: UserContext = Depends(_view),
):
    filters: list[str] = []
    params: dict[str, object] = {}

    if search:
        filters.append("(customer_id ILIKE :search OR email_blind_index = :email_index OR (email_blind_index IS NULL AND lower(trim(email)) = :email_plain))")
        params["search"] = f"%{search}%"
        params["email_index"] = email_index(search)
        params["email_plain"] = search.strip().lower()

    if segment:
        filters.append("segment = :segment")
        params["segment"] = segment

    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    offset = (page - 1) * limit

    with get_db_session() as session:
        total = session.execute(
            text(f"SELECT COUNT(*) FROM kirana_kart.customers {where}"),
            params,
        ).scalar() or 0

        rows = session.execute(
            text(f"""
                SELECT
                    customer_id, email, phone, date_of_birth, signup_date,
                    is_active, lifetime_order_count, lifetime_igcc_rate, segment,
                    customer_churn_probability, churn_model_version, churn_last_updated
                FROM kirana_kart.customers
                {where}
                ORDER BY signup_date DESC NULLS LAST
                LIMIT :limit OFFSET :offset
            """),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    log_pii_access(
        accessed_by=user.id,
        entity_type="customer",
        entity_id=f"list:{len(rows)}",
        fields=_PII_FIELDS,
        endpoint=str(request.url.path),
        ip_address=request.client.host if request.client else None,
    )

    return {
        "items": jsonable_encoder([reveal_customer(r) for r in rows]),
        "total": total,
        "page": page,
        "page_size": limit,
        "total_pages": max(1, (total + limit - 1) // limit),
    }


@router.get("/{customer_id}")
def get_customer(
    customer_id: str,
    request: Request,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT
                    customer_id, email, phone, date_of_birth, signup_date,
                    is_active, lifetime_order_count, lifetime_igcc_rate, segment,
                    customer_churn_probability, churn_model_version, churn_last_updated
                FROM kirana_kart.customers
                WHERE customer_id = :customer_id
            """),
            {"customer_id": customer_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Customer not found")

    log_pii_access(
        accessed_by=user.id,
        entity_type="customer",
        entity_id=customer_id,
        fields=_PII_FIELDS,
        endpoint=str(request.url.path),
        ip_address=request.client.host if request.client else None,
    )

    return jsonable_encoder(reveal_customer(row))


@router.get("/{customer_id}/orders")
def get_orders(customer_id: str, _u: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT
                    order_id, customer_id, order_value,
                    delivery_estimated, delivery_actual, sla_breach,
                    created_at, updated_at
                FROM kirana_kart.orders
                WHERE customer_id = :customer_id
                ORDER BY created_at DESC NULLS LAST
            """),
            {"customer_id": customer_id},
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


@router.get("/{customer_id}/tickets")
def get_customer_tickets(customer_id: str, _u: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT f.*
                FROM kirana_kart.fdraw f
                JOIN kirana_kart.ticket_execution_summary s
                  ON f.ticket_id = s.ticket_id
                WHERE s.customer_id = :customer_id
                ORDER BY f.created_at DESC NULLS LAST
            """),
            {"customer_id": customer_id},
        ).mappings().all()

        if not rows:
            rows = session.execute(
                text("""
                    SELECT *
                    FROM kirana_kart.fdraw
                    WHERE canonical_payload->>'customer_id' = :customer_id
                    ORDER BY created_at DESC NULLS LAST
                """),
                {"customer_id": customer_id},
            ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


@router.get("/{customer_id}/csat")
def get_customer_csat(customer_id: str, _u: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT r.id, r.ticket_id, r.rating, r.feedback, r.created_at
                FROM kirana_kart.csat_responses r
                JOIN kirana_kart.ticket_execution_summary s
                  ON r.ticket_id = s.ticket_id
                WHERE s.customer_id = :customer_id
                ORDER BY r.created_at DESC NULLS LAST
            """),
            {"customer_id": customer_id},
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])
