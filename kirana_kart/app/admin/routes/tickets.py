from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import text

import json

from app.admin.db import get_db_session
from app.admin.redis_client import get_redis
from app.admin.routes.auth import UserContext, require_permission
from app.l1_ingestion.schemas import CanonicalPayload
from app.l2_cardinal.phase3_handler import Phase3Result
from app.l2_cardinal import phase4_enricher

router = APIRouter(prefix="/tickets", tags=["tickets"])

STREAM_P3 = "cardinal:dispatch:P3_STANDARD"

_view = require_permission("tickets", "view")
_edit = require_permission("tickets", "edit")


class DispatchRequest(BaseModel):
    ticket_ids: list[int] | None = Field(default=None, max_length=100)
    mode: Literal["latest"] | None = None
    limit: int = Field(default=25, ge=1, le=100)


@router.get("/")
def list_tickets(
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=200),
    search: str | None = None,
    module: str | None = None,
    pipeline_stage: str | None = None,
    _u: UserContext = Depends(_view),
):
    filters: list[str] = []
    params: dict[str, object] = {}

    if search:
        filters.append(
            "(cx_email ILIKE :search OR subject ILIKE :search OR CAST(ticket_id AS TEXT) ILIKE :search)"
        )
        params["search"] = f"%{search}%"

    if module:
        filters.append("module = :module")
        params["module"] = module

    if pipeline_stage:
        filters.append("pipeline_stage = :stage")
        params["stage"] = pipeline_stage

    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    offset = (page - 1) * limit

    with get_db_session() as session:
        total = session.execute(
            text(f"SELECT COUNT(*) FROM kirana_kart.fdraw {where}"),
            params,
        ).scalar() or 0

        rows = session.execute(
            text(f"""
                SELECT
                    f.sl, f.ticket_id, f.group_id, f.group_name, f.cx_email,
                    f.status, f.subject, f.description, f.created_at, f.updated_at,
                    f.tags, f.code, f.img_flg, f.attachment, f.processed, f.ts,
                    f.pipeline_stage, f.source, f.module, f.canonical_payload,
                    f.detected_language, f.preprocessed_text,
                    ps.current_stage, ps.stage_0_status, ps.stage_1_status,
                    ps.stage_2_status, ps.stage_3_status
                FROM kirana_kart.fdraw f
                LEFT JOIN LATERAL (
                    SELECT current_stage, stage_0_status, stage_1_status,
                           stage_2_status, stage_3_status
                    FROM kirana_kart.ticket_processing_state
                    WHERE ticket_id = f.ticket_id
                    ORDER BY created_at DESC NULLS LAST
                    LIMIT 1
                ) ps ON true
                {where}
                ORDER BY f.created_at DESC NULLS LAST, f.ticket_id DESC
                LIMIT :limit OFFSET :offset
            """),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    return {
        "items": jsonable_encoder([dict(r) for r in rows]),
        "total": total,
        "page": page,
        "page_size": limit,
        "total_pages": max(1, (total + limit - 1) // limit),
    }


@router.get("/{ticket_id}")
def get_ticket(ticket_id: int, _u: UserContext = Depends(_view)):
    with get_db_session() as session:
        ticket = session.execute(
            text("""
                SELECT
                    sl, ticket_id, group_id, group_name, cx_email,
                    status, subject, description, created_at, updated_at,
                    tags, code, img_flg, attachment, processed, ts,
                    pipeline_stage, source, module, canonical_payload,
                    detected_language, preprocessed_text
                FROM kirana_kart.fdraw
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

        if not ticket:
            raise HTTPException(status_code=404, detail="Ticket not found")

        processing_state = session.execute(
            text("""
                SELECT
                    id, ticket_id, execution_id, current_stage,
                    stage_0_status, stage_1_status, stage_2_status, stage_3_status,
                    stage_0_completed_at, stage_1_completed_at, stage_2_completed_at, stage_3_completed_at,
                    claimed_by, processing_started_at, processing_completed_at,
                    error_message, retry_count, created_at, module
                FROM kirana_kart.ticket_processing_state
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

        llm_output_1 = session.execute(
            text("""
                SELECT
                    id, ticket_id, order_id, issue_type_l1, issue_type_l2,
                    confidence_entailment, confidence_db_match, image_required, image_fetched,
                    db_issue_type, db_issue_match, vector_top_match_l1, vector_top_match_l2,
                    vector_similarity_score, reasoning, status, created_at,
                    execution_id, execution_type, is_complete, pipeline_status, module
                FROM kirana_kart.llm_output_1
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

        llm_output_2 = session.execute(
            text("""
                SELECT
                    id, ticket_id, order_id, llm_output_1_id,
                    issue_type_l1_original, issue_type_l2_original,
                    issue_type_l1_verified, issue_type_l2_verified,
                    issue_changed, fraud_segment, value_segment, standard_logic_passed,
                    aon_bod_eligible, super_subscriber, hrx_applicable, hrx_passed,
                    greedy_classification, sla_breach, delivery_delay_minutes, multiplier,
                    order_value, calculated_gratification, capped_gratification, cap_applied,
                    action_code, action_code_id, action_description, overall_confidence,
                    decision_reasoning, status, created_at, execution_id,
                    is_complete, pipeline_status, module
                FROM kirana_kart.llm_output_2
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

        llm_output_3 = session.execute(
            text("""
                SELECT
                    id, ticket_id, order_id, llm_output_2_id,
                    final_action_code, final_action_name, final_refund_amount,
                    logic_validation_status, automation_pathway, cap_applied_flag,
                    history_check_flag, discrepancy_detected, discrepancy_count,
                    discrepancy_details, discrepancy_severity, override_applied,
                    override_reason, detailed_reasoning, freshdesk_status,
                    freshdesk_code, is_synced, created_at, execution_id,
                    is_complete, pipeline_status, policy_version,
                    policy_artifact_hash, decision_trace, module
                FROM kirana_kart.llm_output_3
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

        metrics = session.execute(
            text("""
                SELECT
                    id, execution_id, ticket_id, start_at, end_at,
                    duration_ms, llm_1_tokens, llm_2_tokens, llm_3_tokens,
                    total_tokens, overall_status, created_at
                FROM kirana_kart.execution_metrics
                WHERE ticket_id = :ticket_id
                ORDER BY created_at DESC NULLS LAST
                LIMIT 1
            """),
            {"ticket_id": ticket_id},
        ).mappings().first()

    response = dict(ticket)
    if processing_state:
        response["processing_state"] = dict(processing_state)
    if llm_output_1:
        response["llm_output_1"] = dict(llm_output_1)
    if llm_output_2:
        response["llm_output_2"] = dict(llm_output_2)
    if llm_output_3:
        response["llm_output_3"] = dict(llm_output_3)
    if metrics:
        response["execution_metrics"] = dict(metrics)

    return jsonable_encoder(response)


@router.post("/dispatch")
def dispatch_tickets(
    payload: DispatchRequest,
    _u: UserContext = Depends(_edit),
):
    with get_db_session() as session:
        if payload.ticket_ids:
            ticket_ids = list(dict.fromkeys(payload.ticket_ids))[:100]
        elif payload.mode == "latest":
            ticket_ids = [
                row["ticket_id"]
                for row in session.execute(
                    text("""
                        SELECT ticket_id
                        FROM kirana_kart.fdraw
                        ORDER BY created_at DESC NULLS LAST, ticket_id DESC
                        LIMIT :limit
                    """),
                    {"limit": payload.limit},
                ).mappings().all()
            ]
        else:
            raise HTTPException(status_code=400, detail="Provide ticket_ids or mode=latest.")

        if not ticket_ids:
            return {"dispatched": 0, "ticket_ids": []}

        active_version = session.execute(
            text("SELECT active_version FROM kirana_kart.kb_runtime_config LIMIT 1")
        ).scalar()

        rows = session.execute(
            text("""
                SELECT ticket_id, module, canonical_payload
                FROM kirana_kart.fdraw
                WHERE ticket_id = ANY(:ids)
            """),
            {"ids": ticket_ids},
        ).mappings().all()

        dispatched = []
        now = datetime.now(timezone.utc).isoformat()
        r = get_redis()

        for row in rows:
            canonical = row["canonical_payload"] or {}
            if isinstance(canonical, str):
                canonical = {}

            if "customer_context" not in canonical:
                try:
                    canonical_payload = CanonicalPayload.model_validate(canonical)
                except Exception:
                    canonical_payload = CanonicalPayload(
                        ticket_id=row["ticket_id"],
                        group_id=canonical.get("group_id", "manual_dispatch"),
                        group_name=canonical.get("group_name", "manual_dispatch"),
                        cx_email=canonical.get("cx_email"),
                        subject=canonical.get("subject", ""),
                        description=canonical.get("description", ""),
                        channel=canonical.get("channel", "email"),
                        source=canonical.get("source", "api"),
                        module=row["module"] or canonical.get("module", "delivery"),
                        order_id=canonical.get("order_id"),
                        customer_id=canonical.get("customer_id"),
                        business_line=canonical.get("business_line", "ecommerce"),
                        org=canonical.get("org", "KiranaKart"),
                        is_sandbox=bool(canonical.get("is_sandbox", False)),
                    )
                phase3 = Phase3Result(
                    canonical=canonical_payload,
                    connector_id=0,
                    is_thread_reply=False,
                    source_verified=True,
                    verification_method="manual_dispatch",
                )
                try:
                    phase4_result = phase4_enricher.run(phase3)
                    canonical = {
                        **canonical,
                        "customer_context": phase4_result.context.to_dict(),
                    }
                except Exception:
                    pass

            org = canonical.get("org") or "KiranaKart"
            business_line = canonical.get("business_line") or "ecommerce"
            customer_id = canonical.get("customer_id") or ""
            is_sandbox = str(canonical.get("is_sandbox", False)).lower()
            module = row["module"] or canonical.get("module", "delivery")

            risk_ctx = (canonical.get("customer_context") or {}).get("risk") or {}
            execution_id = f"manual_{org[:20]}_{int(datetime.now(timezone.utc).timestamp())}_{uuid4().hex[:8]}"

            message = {
                "execution_id": execution_id,
                "ticket_id": str(row["ticket_id"]),
                "org": org,
                "module": module,
                "business_line": business_line,
                "active_policy": active_version or "",
                "customer_id": str(customer_id),
                "priority": "P3_STANDARD",
                "escalation_group": "STANDARD",
                "is_sandbox": is_sandbox,
                "reprocess": "true",
                "prior_complaints_30d": str(risk_ctx.get("complaints_last_30_days", 0)),
                "fraud_risk_classification": risk_ctx.get("fraud_risk_classification", "NORMAL"),
                "auto_approval_limit": str(risk_ctx.get("auto_approval_limit", 500.0)),
                "recommended_queue": risk_ctx.get("recommended_queue", "STANDARD_REVIEW"),
                "enriched_at": canonical.get("enriched_at") or now,
            }

            r.xadd(name=STREAM_P3, fields=message, maxlen=10_000, approximate=True)

            session.execute(
                text("""
                    INSERT INTO kirana_kart.cardinal_execution_plans
                        (execution_id, execution_mode, org, module, total_tickets, status,
                         metadata, created_at)
                    VALUES
                        (:execution_id, 'single', :org, :module, 1, 'queued',
                         :metadata, NOW())
                """),
                {
                    "execution_id": execution_id,
                    "org": org,
                    "module": module,
                    "metadata": json.dumps({"source": "manual_dispatch"}),
                },
            )
            session.execute(
                text("""
                    INSERT INTO kirana_kart.ticket_processing_state
                        (ticket_id, execution_id, current_stage,
                         stage_0_status, stage_1_status, stage_2_status, stage_3_status,
                         module, created_at)
                    VALUES
                        (:ticket_id, :execution_id, 0,
                         'pending', 'pending', 'pending', 'pending',
                         :module, NOW())
                    ON CONFLICT (ticket_id) DO UPDATE SET
                        execution_id   = EXCLUDED.execution_id,
                        current_stage  = 0,
                        stage_0_status = 'pending',
                        stage_1_status = 'pending',
                        stage_2_status = 'pending',
                        stage_3_status = 'pending',
                        processing_completed_at = NULL,
                        error_message  = NULL,
                        created_at     = NOW()
                """),
                {
                    "ticket_id": row["ticket_id"],
                    "execution_id": execution_id,
                    "module": module,
                },
            )
            session.execute(
                text("""
                    UPDATE kirana_kart.fdraw
                    SET pipeline_stage = 'DISPATCHED'
                    WHERE ticket_id = :ticket_id
                """),
                {"ticket_id": row["ticket_id"]},
            )
            dispatched.append(row["ticket_id"])

        session.commit()

    return {"dispatched": len(dispatched), "ticket_ids": dispatched, "stream": STREAM_P3}
