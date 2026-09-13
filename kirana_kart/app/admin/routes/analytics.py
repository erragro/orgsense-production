from __future__ import annotations

from datetime import datetime
from fastapi import APIRouter, Depends, Query
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.routes.auth import UserContext, require_permission

router = APIRouter(prefix="/analytics", tags=["analytics"])

_view = require_permission("analytics", "view")


def _parse_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return value
    except ValueError:
        return None


def _parse_bool(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    lowered = value.lower()
    if lowered in ("true", "1", "yes"):
        return True
    if lowered in ("false", "0", "no"):
        return False
    return None


@router.get("/summary")
def analytics_summary(
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    _u: UserContext = Depends(_view),
):
    date_from = _parse_date(date_from)
    date_to = _parse_date(date_to)

    ticket_filter = []
    metric_filter = []
    refund_filter = []
    csat_filter = []
    summary_filter = []
    params: dict[str, object] = {}

    if date_from:
        ticket_filter.append("processed_at >= :date_from")
        metric_filter.append("created_at >= :date_from")
        refund_filter.append("processed_at >= :date_from")
        csat_filter.append("created_at >= :date_from")
        summary_filter.append("processed_at >= :date_from")
        params["date_from"] = date_from
    if date_to:
        ticket_filter.append("processed_at < CAST(:date_to AS date) + interval '1 day'")
        metric_filter.append("created_at < CAST(:date_to AS date) + interval '1 day'")
        refund_filter.append("processed_at < CAST(:date_to AS date) + interval '1 day'")
        csat_filter.append("created_at < CAST(:date_to AS date) + interval '1 day'")
        summary_filter.append("processed_at < CAST(:date_to AS date) + interval '1 day'")
        params["date_to"] = date_to

    ticket_where = f"WHERE {' AND '.join(ticket_filter)}" if ticket_filter else ""
    metric_where = f"WHERE {' AND '.join(metric_filter)}" if metric_filter else ""
    refund_where = f"WHERE {' AND '.join(refund_filter)}" if refund_filter else ""
    csat_where = f"WHERE {' AND '.join(csat_filter)}" if csat_filter else ""
    summary_where = f"WHERE {' AND '.join(summary_filter)}" if summary_filter else ""

    with get_db_session() as session:
        total_tickets = session.execute(
            text(f"SELECT COUNT(*) FROM kirana_kart.ticket_execution_summary {ticket_where}"),
            params,
        ).scalar() or 0

        metrics = session.execute(
            text(f"""
                SELECT
                    AVG(duration_ms) AS avg_duration,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration
                FROM kirana_kart.execution_metrics
                {metric_where}
            """),
            params,
        ).mappings().first() or {}

        avg_duration_ms = int(metrics.get("avg_duration") or 0)
        p95_duration_ms = int(metrics.get("p95_duration") or 0)

        summary = session.execute(
            text(f"""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN applied_action_code IS NOT NULL THEN 1 ELSE 0 END) AS auto_count,
                    AVG(CASE WHEN sla_breach THEN 1 ELSE 0 END) AS sla_rate
                FROM kirana_kart.ticket_execution_summary
                {summary_where}
            """),
            params,
        ).mappings().first() or {}

        summary_total = summary.get("total") or 0
        auto_resolution_rate = (
            float(summary.get("auto_count") or 0) / summary_total
            if summary_total else 0
        )
        sla_breach_rate = float(summary.get("sla_rate") or 0)

        avg_csat = session.execute(
            text(f"""
                SELECT AVG(rating) AS avg_rating
                FROM kirana_kart.csat_responses
                {csat_where}
            """),
            params,
        ).scalar() or 0

        total_refund_amount = session.execute(
            text(f"""
                SELECT SUM(refund_amount) AS total_refund
                FROM kirana_kart.refunds
                {refund_where}
            """),
            params,
        ).scalar() or 0

        tickets_by_module_rows = session.execute(
            text(f"""
                SELECT COALESCE(issue_l1, 'UNKNOWN') AS module, COUNT(*) AS count
                FROM kirana_kart.ticket_execution_summary
                {ticket_where}
                GROUP BY issue_l1
            """),
            params,
        ).mappings().all()

        tickets_by_module = {
            (r["module"] or "unknown"): int(r["count"] or 0)
            for r in tickets_by_module_rows
        }

        daily_ticket_counts = session.execute(
            text(f"""
                SELECT DATE(processed_at) AS date, COUNT(*) AS count
                FROM kirana_kart.ticket_execution_summary
                {ticket_where}
                GROUP BY DATE(processed_at)
                ORDER BY DATE(processed_at)
            """),
            params,
        ).mappings().all()

        csat_trend = session.execute(
            text(f"""
                SELECT DATE(created_at) AS date, AVG(rating) AS value
                FROM kirana_kart.csat_responses
                {csat_where}
                GROUP BY DATE(created_at)
                ORDER BY DATE(created_at)
            """),
            params,
        ).mappings().all()

        refund_by_day = session.execute(
            text(f"""
                SELECT DATE(processed_at) AS date, SUM(refund_amount) AS value
                FROM kirana_kart.refunds
                {refund_where}
                GROUP BY DATE(processed_at)
                ORDER BY DATE(processed_at)
            """),
            params,
        ).mappings().all()

        action_where = summary_where
        if action_where:
            action_where = f"{action_where} AND applied_action_code IS NOT NULL"
        else:
            action_where = "WHERE applied_action_code IS NOT NULL"

        action_code_distribution_rows = session.execute(
            text(f"""
                SELECT applied_action_code AS action_code, COUNT(*) AS count
                FROM kirana_kart.ticket_execution_summary
                {action_where}
                GROUP BY applied_action_code
                ORDER BY count DESC
            """),
            params,
        ).mappings().all()

        action_code_distribution = {
            r["action_code"]: int(r["count"] or 0)
            for r in action_code_distribution_rows
        }

    return jsonable_encoder({
        "total_tickets": int(total_tickets),
        "avg_duration_ms": avg_duration_ms,
        "p95_duration_ms": p95_duration_ms,
        "auto_resolution_rate": round(auto_resolution_rate, 4),
        "avg_csat": float(avg_csat),
        "sla_breach_rate": round(sla_breach_rate, 4),
        "total_refund_amount": float(total_refund_amount),
        "tickets_by_module": tickets_by_module,
        "daily_ticket_counts": [dict(r) for r in daily_ticket_counts],
        "csat_trend": [dict(r) for r in csat_trend],
        "refund_by_day": [dict(r) for r in refund_by_day],
        "action_code_distribution": action_code_distribution,
    })


@router.get("/refunds")
def refund_list(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    _u: UserContext = Depends(_view),
):
    date_from = _parse_date(date_from)
    date_to = _parse_date(date_to)

    filters = []
    params: dict[str, object] = {}

    if date_from:
        filters.append("processed_at >= :date_from")
        params["date_from"] = date_from
    if date_to:
        filters.append("processed_at < CAST(:date_to AS date) + interval '1 day'")
        params["date_to"] = date_to

    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    offset = (page - 1) * limit

    with get_db_session() as session:
        rows = session.execute(
            text(f"""
                SELECT
                    refund_id, ticket_id, order_id, refund_amount,
                    applied_action_code, refund_reason, refund_source, processed_at
                FROM kirana_kart.refunds
                {where}
                ORDER BY processed_at DESC
                LIMIT :limit OFFSET :offset
            """),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


@router.get("/evaluation-filters")
def evaluation_filters(_u: UserContext = Depends(_view)):
    with get_db_session() as session:
        def _distinct(query: str) -> list[str]:
            return [row[0] for row in session.execute(text(query)).all() if row[0]]

        return jsonable_encoder({
            "modules": _distinct("SELECT DISTINCT module FROM kirana_kart.fdraw ORDER BY module"),
            "issue_l1": _distinct("SELECT DISTINCT issue_type_l1_verified FROM kirana_kart.llm_output_2 ORDER BY issue_type_l1_verified"),
            "issue_l2": _distinct("SELECT DISTINCT issue_type_l2_verified FROM kirana_kart.llm_output_2 ORDER BY issue_type_l2_verified"),
            "fraud_segments": _distinct("SELECT DISTINCT fraud_segment FROM kirana_kart.llm_output_2 ORDER BY fraud_segment"),
            "value_segments": _distinct("SELECT DISTINCT value_segment FROM kirana_kart.llm_output_2 ORDER BY value_segment"),
            "action_codes": _distinct("SELECT DISTINCT action_code FROM kirana_kart.llm_output_2 ORDER BY action_code"),
            "automation_pathways": _distinct("SELECT DISTINCT automation_pathway FROM kirana_kart.llm_output_3 ORDER BY automation_pathway"),
            "greedy_classifications": _distinct("SELECT DISTINCT greedy_classification FROM kirana_kart.llm_output_2 ORDER BY greedy_classification"),
            "pipeline_stages": _distinct("SELECT DISTINCT pipeline_stage FROM kirana_kart.fdraw ORDER BY pipeline_stage"),
        })


@router.get("/evaluations")
def evaluation_rows(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    module: str | None = Query(None),
    issue_l1: str | None = Query(None),
    issue_l2: str | None = Query(None),
    fraud_segment: str | None = Query(None),
    value_segment: str | None = Query(None),
    action_code: str | None = Query(None),
    automation_pathway: str | None = Query(None),
    standard_logic_passed: str | None = Query(None),
    greedy_classification: str | None = Query(None),
    override_applied: str | None = Query(None),
    pipeline_stage: str | None = Query(None),
    _u: UserContext = Depends(_view),
):
    date_from = _parse_date(date_from)
    date_to = _parse_date(date_to)
    standard_logic_passed_bool = _parse_bool(standard_logic_passed)
    override_applied_bool = _parse_bool(override_applied)

    filters = []
    params: dict[str, object] = {}

    if date_from:
        filters.append("fd.created_at >= :date_from")
        params["date_from"] = date_from
    if date_to:
        filters.append("fd.created_at < CAST(:date_to AS date) + interval '1 day'")
        params["date_to"] = date_to
    if module:
        filters.append("fd.module = :module")
        params["module"] = module
    if pipeline_stage:
        filters.append("fd.pipeline_stage = :pipeline_stage")
        params["pipeline_stage"] = pipeline_stage
    if issue_l1:
        filters.append("l2.issue_type_l1_verified = :issue_l1")
        params["issue_l1"] = issue_l1
    if issue_l2:
        filters.append("l2.issue_type_l2_verified = :issue_l2")
        params["issue_l2"] = issue_l2
    if fraud_segment:
        filters.append("l2.fraud_segment = :fraud_segment")
        params["fraud_segment"] = fraud_segment
    if value_segment:
        filters.append("l2.value_segment = :value_segment")
        params["value_segment"] = value_segment
    if action_code:
        filters.append("l2.action_code = :action_code")
        params["action_code"] = action_code
    if automation_pathway:
        filters.append("l3.automation_pathway = :automation_pathway")
        params["automation_pathway"] = automation_pathway
    if standard_logic_passed_bool is not None:
        filters.append("l2.standard_logic_passed = :standard_logic_passed")
        params["standard_logic_passed"] = standard_logic_passed_bool
    if greedy_classification:
        filters.append("l2.greedy_classification = :greedy_classification")
        params["greedy_classification"] = greedy_classification
    if override_applied_bool is not None:
        filters.append("l3.override_applied = :override_applied")
        params["override_applied"] = override_applied_bool

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""

    offset = (page - 1) * limit
    params["limit"] = limit
    params["offset"] = offset

    base_query = f"""
        FROM kirana_kart.fdraw fd
        LEFT JOIN kirana_kart.llm_output_1 l1 ON l1.ticket_id = fd.ticket_id
        LEFT JOIN kirana_kart.llm_output_2 l2 ON l2.ticket_id = fd.ticket_id
        LEFT JOIN kirana_kart.llm_output_3 l3 ON l3.ticket_id = fd.ticket_id
        {where_clause}
    """

    with get_db_session() as session:
        total = session.execute(
            text(f"SELECT COUNT(*) {base_query}"),
            params,
        ).scalar() or 0

        rows = session.execute(
            text(f"""
                SELECT
                    fd.ticket_id,
                    fd.created_at,
                    fd.module,
                    fd.pipeline_stage,
                    COALESCE(l2.order_id, l3.order_id, l1.order_id) AS order_id,
                    fd.canonical_payload->>'customer_id' AS customer_id,
                    l1.issue_type_l1 AS source_issue_l1,
                    l1.issue_type_l2 AS source_issue_l2,
                    l2.fraud_segment AS source_fraud_segment,
                    l2.value_segment AS source_value_segment,
                    l2.order_value AS source_order_value,
                    l2.calculated_gratification AS source_complaint_amount,
                    l2.issue_type_l1_verified AS eval_issue_l1,
                    l2.issue_type_l2_verified AS eval_issue_l2,
                    l2.standard_logic_passed AS eval_standard_logic_passed,
                    l2.lifetime_igcc_check AS eval_lifetime_igcc_check,
                    l2.exceptions_60d_check AS eval_exceptions_60d_check,
                    l2.igcc_history_check AS eval_igcc_history_check,
                    l2.same_issue_check AS eval_same_issue_check,
                    l2.aon_bod_eligible AS eval_aon_bod_eligible,
                    l2.greedy_signals_count AS eval_greedy_signals_count,
                    l2.greedy_classification AS eval_greedy_classification,
                    l2.hrx_applicable AS eval_hrx_applicable,
                    l2.hrx_passed AS eval_hrx_passed,
                    l2.multiplier AS eval_multiplier,
                    l2.order_value AS eval_order_value,
                    l2.calculated_gratification AS eval_calculated_gratification,
                    l2.capped_gratification AS eval_capped_gratification,
                    l2.cap_applied AS eval_cap_applied,
                    l2.action_code AS eval_action_code,
                    l2.action_code_id AS eval_action_code_id,
                    l2.overall_confidence AS eval_overall_confidence,
                    l2.evaluation_confidence AS eval_evaluation_confidence,
                    l2.action_confidence AS eval_action_confidence,
                    l2.model_used AS eval_model_used,
                    l3.validation_standard_logic AS val_standard_logic,
                    l3.validation_greedy_check AS val_greedy_check,
                    l3.validation_multiplier AS val_multiplier_check,
                    l3.validation_cap AS val_cap_check,
                    l3.validated_multiplier AS val_multiplier,
                    l3.validated_capped_gratification AS val_capped_gratification,
                    l3.validated_greedy_classification AS val_greedy_classification,
                    l3.llm_overall_accuracy AS val_llm_accuracy,
                    l3.discrepancy_detected AS val_discrepancy_detected,
                    l3.discrepancy_severity AS val_discrepancy_severity,
                    l3.override_applied AS val_override_applied,
                    l3.override_type AS val_override_type,
                    l3.automation_pathway AS val_automation_pathway,
                    l3.final_action_code AS val_final_action_code,
                    l3.final_refund_amount AS val_final_refund_amount
                {base_query}
                ORDER BY fd.created_at DESC
                LIMIT :limit OFFSET :offset
            """),
            params,
        ).mappings().all()

    total_pages = (total + limit - 1) // limit if total else 1

    return jsonable_encoder({
        "items": [dict(r) for r in rows],
        "page": page,
        "limit": limit,
        "total": total,
        "total_pages": total_pages,
    })


# ─────────────────────────────────────────────────────────────────────────────
# FCR — True First Contact Resolution
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/fcr")
def fcr_summary(
    date_from: str | None = Query(None),
    date_to:   str | None = Query(None),
    _u: UserContext = Depends(_view),
):
    """
    Returns true FCR rate (async 48h check) vs resolution count.
    Breaks down FCR by issue_type_l2 so intent-level gaps are visible.
    Addresses Problem 4: True FCR overstated by 20 points.
    """
    date_from = _parse_date(date_from)
    date_to   = _parse_date(date_to)

    filters: list[str] = []
    params: dict[str, object] = {}
    if date_from:
        filters.append("processed_at >= :date_from")
        params["date_from"] = date_from
    if date_to:
        filters.append("processed_at < CAST(:date_to AS date) + interval '1 day'")
        params["date_to"] = date_to

    where = f"WHERE {' AND '.join(filters)}" if filters else ""

    with get_db_session() as session:
        # Overall FCR stats (only rows where fcr has been computed)
        overall = session.execute(
            text(f"""
                SELECT
                    COUNT(*)                                       AS total_checked,
                    SUM(CASE WHEN fcr = TRUE  THEN 1 ELSE 0 END)  AS fcr_true,
                    SUM(CASE WHEN fcr = FALSE THEN 1 ELSE 0 END)  AS fcr_false,
                    SUM(CASE WHEN fcr IS NULL THEN 1 ELSE 0 END)  AS fcr_pending
                FROM kirana_kart.ticket_execution_summary
                {where}
            """),
            params,
        ).mappings().first() or {}

        # FCR by issue_type_l2 (join with llm_output_1 for issue label)
        by_intent = session.execute(
            text(f"""
                SELECT
                    COALESCE(lo1.issue_type_l2, 'unknown')           AS intent,
                    COUNT(tes.ticket_id)                             AS total,
                    SUM(CASE WHEN tes.fcr = TRUE  THEN 1 ELSE 0 END) AS fcr_true,
                    SUM(CASE WHEN tes.fcr = FALSE THEN 1 ELSE 0 END) AS fcr_false
                FROM kirana_kart.ticket_execution_summary tes
                LEFT JOIN LATERAL (
                    SELECT issue_type_l2 FROM kirana_kart.llm_output_1
                    WHERE ticket_id = tes.ticket_id
                    ORDER BY id DESC LIMIT 1
                ) lo1 ON TRUE
                {where.replace('processed_at', 'tes.processed_at')}
                GROUP BY lo1.issue_type_l2
                HAVING COUNT(tes.ticket_id) > 0
                ORDER BY total DESC
                LIMIT 20
            """),
            params,
        ).mappings().all()

        # Daily true FCR trend
        trend = session.execute(
            text(f"""
                SELECT
                    DATE(processed_at)                               AS date,
                    COUNT(*) FILTER (WHERE fcr IS NOT NULL)          AS checked,
                    COUNT(*) FILTER (WHERE fcr = TRUE)               AS fcr_true
                FROM kirana_kart.ticket_execution_summary
                {where}
                GROUP BY DATE(processed_at)
                ORDER BY DATE(processed_at)
                LIMIT 60
            """),
            params,
        ).mappings().all()

    total_checked = int(overall.get("total_checked") or 0)
    fcr_true      = int(overall.get("fcr_true") or 0)
    true_fcr_rate = round(fcr_true / total_checked, 4) if total_checked else None

    by_intent_out = []
    for r in by_intent:
        t = int(r["total"] or 0)
        ft = int(r["fcr_true"] or 0)
        by_intent_out.append({
            "intent":      r["intent"],
            "total":       t,
            "fcr_true":    ft,
            "fcr_false":   int(r["fcr_false"] or 0),
            "true_fcr_rate": round(ft / t, 4) if t else None,
        })

    return jsonable_encoder({
        "total_checked":   total_checked,
        "fcr_true":        fcr_true,
        "fcr_false":       int(overall.get("fcr_false") or 0),
        "fcr_pending":     int(overall.get("fcr_pending") or 0),
        "true_fcr_rate":   true_fcr_rate,
        "by_intent":       by_intent_out,
        "trend":           [dict(r) for r in trend],
    })


# ─────────────────────────────────────────────────────────────────────────────
# SPIKE REPORTS — Ticket Volume Anomalies
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/spikes")
def spike_reports(
    limit: int = Query(20, ge=1, le=100),
    _u: UserContext = Depends(_view),
):
    """
    Returns recent spike reports from the spike_reports table.
    Each report contains cluster breakdown with root-cause percentages.
    Addresses Problem 3: volume spike root cause unknown (3-day lag).
    """
    with get_db_session() as session:
        # Check if table exists first
        exists = session.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'kirana_kart'
                    AND table_name = 'spike_reports'
                )
            """)
        ).scalar()

        if not exists:
            return jsonable_encoder({"items": [], "total": 0, "message": "No spikes detected yet."})

        rows = session.execute(
            text("""
                SELECT
                    spike_id, window_start, window_end,
                    current_volume, baseline_mean, baseline_std,
                    sigma_above, cluster_method, clusters_json, produced_at
                FROM kirana_kart.spike_reports
                ORDER BY produced_at DESC
                LIMIT :limit
            """),
            {"limit": limit},
        ).mappings().all()

    return jsonable_encoder({
        "items": [dict(r) for r in rows],
        "total": len(rows),
    })


# ─────────────────────────────────────────────────────────────────────────────
# AGENT QUALITY — Bad-Actor Flags + Conversation QA Scores
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/agent-quality")
def agent_quality(
    page:      int = Query(1, ge=1),
    limit:     int = Query(50, ge=1, le=200),
    resolved:  str | None = Query(None),   # "true" | "false"
    _u: UserContext = Depends(_view),
):
    """
    Returns:
    - agent_quality_flags: agents flagged for excessive refund approval
    - conversation_qa_summary: aggregate QA scores per agent
    Addresses Problem 2: agent quality invisible (0.2% QA coverage).
    """
    resolved_bool = _parse_bool(resolved)

    with get_db_session() as session:
        # Check agent_quality_flags table
        flags_exist = session.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'kirana_kart'
                    AND table_name = 'agent_quality_flags'
                )
            """)
        ).scalar()

        qa_exist = session.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'kirana_kart'
                    AND table_name = 'conversation_qa_scores'
                )
            """)
        ).scalar()

        # Agent quality flags
        flags: list[dict] = []
        total_flags = 0
        if flags_exist:
            flag_filters = []
            flag_params: dict[str, object] = {}
            if resolved_bool is not None:
                flag_filters.append("resolved = :resolved")
                flag_params["resolved"] = resolved_bool
            flag_where = f"WHERE {' AND '.join(flag_filters)}" if flag_filters else ""

            total_flags = session.execute(
                text(f"SELECT COUNT(*) FROM kirana_kart.agent_quality_flags {flag_where}"),
                flag_params,
            ).scalar() or 0

            offset = (page - 1) * limit
            flag_rows = session.execute(
                text(f"""
                    SELECT
                        agent_id, flagged_at, window_days,
                        total_tickets, refund_approvals, refund_rate,
                        manual_review_count, flag_reason, resolved
                    FROM kirana_kart.agent_quality_flags
                    {flag_where}
                    ORDER BY flagged_at DESC
                    LIMIT :limit OFFSET :offset
                """),
                {**flag_params, "limit": limit, "offset": offset},
            ).mappings().all()
            flags = [dict(r) for r in flag_rows]

        # Conversation QA summary per agent
        qa_summary: list[dict] = []
        if qa_exist:
            qa_rows = session.execute(
                text("""
                    SELECT
                        agent_id,
                        COUNT(*)                              AS total_scored,
                        ROUND(AVG(overall_qa_score)::numeric, 3)    AS avg_qa_score,
                        ROUND(AVG(canned_ratio)::numeric, 3)        AS avg_canned_ratio,
                        ROUND(AVG(grammar_errors_per_100w)::numeric, 2) AS avg_grammar_errors,
                        SUM(CASE WHEN coaching_flags != '[]'::jsonb AND coaching_flags IS NOT NULL THEN 1 ELSE 0 END) AS flagged_count,
                        MAX(scored_at) AS last_scored_at
                    FROM kirana_kart.conversation_qa_scores
                    WHERE agent_id IS NOT NULL
                    GROUP BY agent_id
                    ORDER BY avg_qa_score ASC
                    LIMIT 100
                """),
            ).mappings().all()
            qa_summary = [dict(r) for r in qa_rows]

        # Overall QA coverage
        total_conversations = 0
        total_scored = 0
        if qa_exist:
            total_scored = session.execute(
                text("SELECT COUNT(*) FROM kirana_kart.conversation_qa_scores")
            ).scalar() or 0
            total_conversations = session.execute(
                text("SELECT COUNT(*) FROM kirana_kart.conversations WHERE status IN ('resolved','closed')")
            ).scalar() or 0

    coverage = round(total_scored / total_conversations, 4) if total_conversations else 0.0

    return jsonable_encoder({
        "flags": flags,
        "total_flags": int(total_flags),
        "total_pages": max(1, (int(total_flags) + limit - 1) // limit),
        "qa_summary": qa_summary,
        "coverage": coverage,
        "total_conversations": int(total_conversations),
        "total_scored": int(total_scored),
    })
