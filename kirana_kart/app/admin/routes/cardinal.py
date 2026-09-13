"""
app/admin/routes/cardinal.py
============================
Cardinal Intelligence pipeline observability routes — governance plane (port 8001).

Surfaces read-only visibility into the Cardinal 5-phase ingest pipeline and
4-stage Celery LLM worker chain. All data comes from existing DB tables
(fdraw, execution_metrics, ticket_execution_summary, execution_audit_log,
llm_output_1/2/3, cardinal_execution_plans) with zero writes to ingest tables
except for the reprocess action.

Endpoints:
  GET    /cardinal/overview              → pipeline summary stats + volume trend
  GET    /cardinal/phase-stats           → per-phase pass/fail/latency
  GET    /cardinal/executions            → paginated ticket execution list
  GET    /cardinal/executions/{id}       → full execution trace for one ticket
  GET    /cardinal/audit                 → paginated execution_audit_log
  POST   /cardinal/reprocess/{id}        → re-submit ticket to ingest pipeline (admin)

Access: cardinal.view for all GETs, cardinal.admin for POST reprocess.
RBAC: new users receive can_view=False by default (ADMIN_ONLY_MODULES in auth_service).
"""

from __future__ import annotations

import logging
import math
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from app.admin.db import get_db_session, engine
from app.admin.routes.auth import UserContext, require_permission
from app.config import settings

logger = logging.getLogger("kirana_kart.cardinal")

router = APIRouter(prefix="/cardinal", tags=["cardinal"])

_view  = require_permission("cardinal", "view")
_admin = require_permission("cardinal", "admin")

_INGEST_URL = "http://ingest:8000/cardinal/ingest"


# ============================================================
# HELPERS
# ============================================================


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val) if val is not None else default
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any, default: int = 0) -> int:
    try:
        return int(val) if val is not None else default
    except (TypeError, ValueError):
        return default


def _serialize_row(row: Any) -> dict:
    """Convert a SQLAlchemy mapping row to a JSON-serializable dict."""
    if row is None:
        return {}
    import json as _json
    result = {}
    for k, v in dict(row).items():
        if hasattr(v, "isoformat"):
            result[k] = v.isoformat()
        elif v is None:
            result[k] = None
        else:
            try:
                _json.dumps(v)
                result[k] = v
            except (TypeError, ValueError):
                result[k] = str(v)
    return result


# ============================================================
# GET /cardinal/overview
# ============================================================


@router.get("/overview")
def cardinal_overview(user: UserContext = Depends(_view)):
    """
    Pipeline summary stats for the Overview tab.
    Uses: fdraw, ticket_execution_summary, execution_metrics, execution_audit_log.
    """
    with get_db_session() as session:
        # Ticket counts
        counts = session.execute(
            text("""
                SELECT
                    COUNT(*)                                            AS all_time,
                    COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)  AS today,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last_7d
                FROM kirana_kart.fdraw
            """)
        ).mappings().first() or {}

        total_all_time = _safe_int(counts.get("all_time"))
        total_today    = _safe_int(counts.get("today"))
        total_7d       = _safe_int(counts.get("last_7d"))

        # Auto-resolution rate
        summary_stats = session.execute(
            text("""
                SELECT
                    COUNT(*)                                                        AS total,
                    COUNT(*) FILTER (WHERE applied_action_code IS NOT NULL)         AS auto_count
                FROM kirana_kart.ticket_execution_summary
            """)
        ).mappings().first() or {}

        summary_total       = _safe_int(summary_stats.get("total"))
        auto_count          = _safe_int(summary_stats.get("auto_count"))
        auto_resolution_pct = (auto_count / summary_total * 100) if summary_total else 0.0

        # Phase failure rate from execution_audit_log
        phase_stats_row = session.execute(
            text("""
                SELECT
                    COUNT(*) FILTER (WHERE event_type IN ('error', 'fail', 'failed')) AS fail_count,
                    COUNT(DISTINCT ticket_id)                                          AS total_tickets
                FROM kirana_kart.execution_audit_log
                WHERE ticket_id IS NOT NULL
            """)
        ).mappings().first() or {}

        fail_count                = _safe_int(phase_stats_row.get("fail_count"))
        total_tickets_with_events = _safe_int(phase_stats_row.get("total_tickets"))
        phase_failure_pct         = (fail_count / total_tickets_with_events * 100) if total_tickets_with_events else 0.0

        # Average processing time
        avg_ms = session.execute(
            text("SELECT AVG(duration_ms) FROM kirana_kart.execution_metrics")
        ).scalar() or 0.0

        # 14-day volume trend
        trend_rows = session.execute(
            text("""
                SELECT DATE(created_at) AS date, COUNT(*) AS count
                FROM kirana_kart.fdraw
                WHERE created_at >= CURRENT_DATE - INTERVAL '14 days'
                GROUP BY DATE(created_at)
                ORDER BY DATE(created_at)
            """)
        ).mappings().all()
        volume_trend = [{"date": str(r["date"]), "count": _safe_int(r["count"])} for r in trend_rows]

        # Source distribution
        source_rows = session.execute(
            text("""
                SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
                FROM kirana_kart.fdraw
                GROUP BY source
                ORDER BY count DESC
            """)
        ).mappings().all()
        source_distribution = [{"source": r["source"], "count": _safe_int(r["count"])} for r in source_rows]

        # Channel distribution (derived from source)
        channel_map: dict[str, int] = {}
        for row in source_rows:
            src = row["source"] or "unknown"
            ch  = ("email" if src in ("gmail", "outlook", "smtp")
                   else "api" if src in ("api", "webhook")
                   else "other")
            channel_map[ch] = channel_map.get(ch, 0) + _safe_int(row["count"])
        channel_distribution = [{"channel": ch, "count": cnt} for ch, cnt in channel_map.items()]

    return {
        "totals": {"all_time": total_all_time, "today": total_today, "last_7d": total_7d},
        "rates": {
            "auto_resolution_pct": round(auto_resolution_pct, 2),
            "dedup_pct":           0.0,
            "phase_failure_pct":   round(phase_failure_pct, 2),
        },
        "avg_processing_ms":    round(_safe_float(avg_ms), 1),
        "volume_trend":         volume_trend,
        "source_distribution":  source_distribution,
        "channel_distribution": channel_distribution,
    }


# ============================================================
# GET /cardinal/phase-stats
# ============================================================


@router.get("/phase-stats")
def cardinal_phase_stats(user: UserContext = Depends(_view)):
    """
    Per-phase breakdown from execution_audit_log (Cardinal phases)
    and llm_output_1/2/3 + ticket_execution_summary (LLM stages).
    """
    result = []
    display_names = {
        "phase_1": "Validator", "phase_1_validator": "Validator",
        "phase_2": "Deduplicator", "phase_2_deduplicator": "Deduplicator",
        "phase_3": "Source Handler", "phase_3_source_handler": "Source Handler",
        "phase_4": "Enricher", "phase_4_enricher": "Enricher",
        "phase_5": "Dispatcher", "phase_5_dispatcher": "Dispatcher",
    }

    with get_db_session() as session:
        # Cardinal phases from execution_audit_log
        phase_agg = session.execute(
            text("""
                SELECT
                    stage_name,
                    COUNT(*)                                                            AS processed,
                    COUNT(*) FILTER (WHERE event_type IN ('pass','success','ok'))       AS passed,
                    COUNT(*) FILTER (WHERE event_type IN ('error','fail','failed'))     AS failed
                FROM kirana_kart.execution_audit_log
                WHERE stage_name IS NOT NULL
                GROUP BY stage_name
                ORDER BY MIN(event_time)
            """)
        ).mappings().all()

        top_errors_rows = session.execute(
            text("""
                SELECT stage_name, message, COUNT(*) AS cnt
                FROM kirana_kart.execution_audit_log
                WHERE event_type IN ('error','fail','failed')
                  AND stage_name IS NOT NULL AND message IS NOT NULL
                GROUP BY stage_name, message
                ORDER BY stage_name, cnt DESC
            """)
        ).mappings().all()

        top_errors_map: dict[str, list] = {}
        for r in top_errors_rows:
            sn = r["stage_name"]
            if sn not in top_errors_map:
                top_errors_map[sn] = []
            if len(top_errors_map[sn]) < 5:
                top_errors_map[sn].append({"message": r["message"], "count": _safe_int(r["cnt"])})

        for idx, row in enumerate(phase_agg):
            sn          = row["stage_name"]
            processed   = _safe_int(row["processed"])
            passed      = _safe_int(row["passed"])
            failed      = _safe_int(row["failed"])
            error_rate  = (failed / processed * 100) if processed else 0.0
            result.append({
                "stage":          sn,
                "phase":          idx + 1,
                "name":           display_names.get(sn, sn.replace("_", " ").title()),
                "processed":      processed,
                "passed":         passed,
                "failed":         failed,
                "error_rate_pct": round(error_rate, 2),
                "avg_latency_ms": 0.0,
                "top_errors":     top_errors_map.get(sn, []),
                "type":           "cardinal_phase",
            })

        # LLM stages from llm_output tables
        llm_stages = [
            {"stage": "llm_0", "name": "Classification", "table": "llm_output_1"},
            {"stage": "llm_1", "name": "Evaluation",     "table": "llm_output_2"},
            {"stage": "llm_2", "name": "Validation",     "table": "llm_output_3"},
        ]
        base_phase = len(phase_agg)
        for i, stage in enumerate(llm_stages):
            tbl = stage["table"]
            row = session.execute(
                text(f"""
                    SELECT
                        COUNT(*) AS processed,
                        COUNT(*) FILTER (WHERE is_complete = TRUE)  AS passed,
                        COUNT(*) FILTER (WHERE is_complete = FALSE)  AS failed,
                        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)
                            FILTER (WHERE updated_at IS NOT NULL AND created_at IS NOT NULL) AS avg_latency_ms
                    FROM kirana_kart.{tbl}
                """)
            ).mappings().first() or {}

            processed  = _safe_int(row.get("processed"))
            passed     = _safe_int(row.get("passed"))
            failed     = _safe_int(row.get("failed"))
            latency_ms = _safe_float(row.get("avg_latency_ms"))
            error_rate = (failed / processed * 100) if processed else 0.0
            result.append({
                "stage":          stage["stage"],
                "phase":          base_phase + i + 1,
                "name":           stage["name"],
                "processed":      processed,
                "passed":         passed,
                "failed":         failed,
                "error_rate_pct": round(error_rate, 2),
                "avg_latency_ms": round(latency_ms, 1),
                "top_errors":     [],
                "type":           "llm_stage",
            })

        # Dispatch stage from ticket_execution_summary
        d_row = session.execute(
            text("""
                SELECT COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE applied_action_code IS NOT NULL) AS passed,
                       COUNT(*) FILTER (WHERE applied_action_code IS NULL)     AS failed
                FROM kirana_kart.ticket_execution_summary
            """)
        ).mappings().first() or {}
        d_processed  = _safe_int(d_row.get("total"))
        d_passed     = _safe_int(d_row.get("passed"))
        d_failed     = _safe_int(d_row.get("failed"))
        d_error_rate = (d_failed / d_processed * 100) if d_processed else 0.0
        result.append({
            "stage": "llm_3", "phase": base_phase + len(llm_stages) + 1, "name": "Dispatch",
            "processed": d_processed, "passed": d_passed, "failed": d_failed,
            "error_rate_pct": round(d_error_rate, 2), "avg_latency_ms": 0.0,
            "top_errors": [], "type": "llm_stage",
        })

    return result


# ============================================================
# GET /cardinal/executions
# ============================================================


@router.get("/executions")
def cardinal_executions(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    source: Optional[str] = None,
    status: Optional[str] = None,
    module: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    search: Optional[str] = None,
    user: UserContext = Depends(_view),
):
    """Paginated ticket execution list (fdraw + execution_metrics + ticket_execution_summary)."""
    conditions = []
    params: dict[str, Any] = {"limit": size, "offset": (page - 1) * size}

    if source:
        conditions.append("f.source = :source")
        params["source"] = source
    if module:
        conditions.append("f.module = :module")
        params["module"] = module
    if date_from:
        conditions.append("f.created_at >= :date_from::date")
        params["date_from"] = date_from
    if date_to:
        conditions.append("f.created_at < :date_to::date + INTERVAL '1 day'")
        params["date_to"] = date_to
    if search:
        try:
            params["ticket_id_search"] = int(search)
            params["search"] = f"%{search}%"
            conditions.append("(f.ticket_id = :ticket_id_search OR f.cx_email ILIKE :search)")
        except ValueError:
            params["search"] = f"%{search}%"
            conditions.append("f.cx_email ILIKE :search")
    if status:
        conditions.append("COALESCE(em.overall_status, 'pending') = :status")
        params["status"] = status

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    with get_db_session() as session:
        total = session.execute(
            text(f"""
                SELECT COUNT(*)
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.execution_metrics em  ON em.ticket_id = f.ticket_id
                LEFT JOIN kirana_kart.ticket_execution_summary tes ON tes.ticket_id = f.ticket_id
                {where}
            """),
            params,
        ).scalar() or 0

        rows = session.execute(
            text(f"""
                SELECT
                    f.ticket_id,
                    COALESCE(f.cx_email, '')  AS cx_email,
                    COALESCE(f.subject, '')   AS subject,
                    COALESCE(f.source, '')    AS source,
                    COALESCE(f.module, '')    AS module,
                    f.created_at,
                    COALESCE(em.overall_status, 'pending') AS status,
                    em.duration_ms                          AS processing_ms,
                    tes.applied_action_code                 AS action_code,
                    tes.issue_l1,
                    tes.issue_l2
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.execution_metrics em  ON em.ticket_id = f.ticket_id
                LEFT JOIN kirana_kart.ticket_execution_summary tes ON tes.ticket_id = f.ticket_id
                {where}
                ORDER BY f.created_at DESC
                LIMIT :limit OFFSET :offset
            """),
            params,
        ).mappings().all()

    return {
        "items": [
            {
                "ticket_id":    str(r["ticket_id"]),
                "cx_email":     r["cx_email"],
                "subject":      r["subject"],
                "source":       r["source"],
                "module":       r["module"],
                "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
                "status":       r["status"],
                "processing_ms": r["processing_ms"],
                "action_code":  r["action_code"],
                "issue_l1":     r["issue_l1"],
                "issue_l2":     r["issue_l2"],
            }
            for r in rows
        ],
        "total": _safe_int(total),
        "page":  page,
        "pages": max(1, math.ceil(_safe_int(total) / size)),
    }


# ============================================================
# GET /cardinal/executions/{ticket_id}
# ============================================================


@router.get("/executions/{ticket_id}")
def cardinal_execution_detail(
    ticket_id: int,
    user: UserContext = Depends(_view),
):
    """Full execution trace for a single ticket (integer ticket_id)."""
    with get_db_session() as session:
        raw_ticket = session.execute(
            text("""
                SELECT sl, ticket_id, group_id, group_name, cx_email, status, subject,
                       description, created_at, updated_at, tags, code, img_flg, processed,
                       pipeline_stage, source, connector_id, thread_id, message_count,
                       module, detected_language
                FROM kirana_kart.fdraw
                WHERE ticket_id = :tid
            """),
            {"tid": ticket_id},
        ).mappings().first()

        if not raw_ticket:
            raise HTTPException(status_code=404, detail="Ticket not found")

        execution_plan = session.execute(
            text("""
                SELECT cep.*
                FROM kirana_kart.cardinal_execution_plans cep
                JOIN kirana_kart.execution_metrics em ON em.execution_id = cep.execution_id
                WHERE em.ticket_id = :tid
                LIMIT 1
            """),
            {"tid": ticket_id},
        ).mappings().first()

        lo1 = session.execute(
            text("SELECT * FROM kirana_kart.llm_output_1 WHERE ticket_id = :tid ORDER BY created_at DESC LIMIT 1"),
            {"tid": ticket_id},
        ).mappings().first()

        lo2 = session.execute(
            text("SELECT * FROM kirana_kart.llm_output_2 WHERE ticket_id = :tid ORDER BY created_at DESC LIMIT 1"),
            {"tid": ticket_id},
        ).mappings().first()

        lo3 = session.execute(
            text("SELECT * FROM kirana_kart.llm_output_3 WHERE ticket_id = :tid ORDER BY created_at DESC LIMIT 1"),
            {"tid": ticket_id},
        ).mappings().first()

        summary = session.execute(
            text("SELECT * FROM kirana_kart.ticket_execution_summary WHERE ticket_id = :tid"),
            {"tid": ticket_id},
        ).mappings().first()

        metrics = session.execute(
            text("SELECT * FROM kirana_kart.execution_metrics WHERE ticket_id = :tid ORDER BY created_at DESC LIMIT 1"),
            {"tid": ticket_id},
        ).mappings().first()

        audit_events_rows = session.execute(
            text("""
                SELECT id, execution_id, ticket_id, stage_name, event_time, event_type, message, metadata
                FROM kirana_kart.execution_audit_log
                WHERE ticket_id = :tid
                ORDER BY event_time
            """),
            {"tid": ticket_id},
        ).mappings().all()

    return {
        "raw_ticket":     _serialize_row(raw_ticket),
        "execution_plan": _serialize_row(execution_plan) if execution_plan else None,
        "phase_states":   [],
        "llm_output_1":   _serialize_row(lo1) if lo1 else None,
        "llm_output_2":   _serialize_row(lo2) if lo2 else None,
        "llm_output_3":   _serialize_row(lo3) if lo3 else None,
        "summary":        _serialize_row(summary) if summary else None,
        "metrics":        _serialize_row(metrics) if metrics else None,
        "audit_events":   [_serialize_row(r) for r in audit_events_rows],
    }


# ============================================================
# GET /cardinal/audit
# ============================================================


@router.get("/audit")
def cardinal_audit(
    page:       int = Query(1, ge=1),
    size:       int = Query(50, ge=1, le=200),
    ticket_id:  Optional[int] = None,
    event_type: Optional[str] = None,
    stage_name: Optional[str] = None,
    date_from:  Optional[str] = None,
    date_to:    Optional[str] = None,
    user: UserContext = Depends(_view),
):
    """Paginated execution audit log."""
    conditions = []
    params: dict[str, Any] = {"limit": size, "offset": (page - 1) * size}

    if ticket_id is not None:
        conditions.append("ticket_id = :ticket_id")
        params["ticket_id"] = ticket_id
    if event_type:
        conditions.append("event_type = :event_type")
        params["event_type"] = event_type
    if stage_name:
        conditions.append("stage_name = :stage_name")
        params["stage_name"] = stage_name
    if date_from:
        conditions.append("event_time >= :date_from::date")
        params["date_from"] = date_from
    if date_to:
        conditions.append("event_time < :date_to::date + INTERVAL '1 day'")
        params["date_to"] = date_to

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    with get_db_session() as session:
        total = session.execute(
            text(f"SELECT COUNT(*) FROM kirana_kart.execution_audit_log {where}"),
            params,
        ).scalar() or 0

        rows = session.execute(
            text(f"""
                SELECT id, execution_id, ticket_id, stage_name, event_time, event_type, message, metadata
                FROM kirana_kart.execution_audit_log
                {where}
                ORDER BY event_time DESC
                LIMIT :limit OFFSET :offset
            """),
            params,
        ).mappings().all()

    return {
        "items": [
            {
                "id":           r["id"],
                "execution_id": r["execution_id"],
                "ticket_id":    r["ticket_id"],
                "stage_name":   r["stage_name"],
                "event_time":   r["event_time"].isoformat() if r["event_time"] else None,
                "event_type":   r["event_type"],
                "message":      r["message"],
                "metadata":     r["metadata"],
            }
            for r in rows
        ],
        "total": _safe_int(total),
        "page":  page,
        "pages": max(1, math.ceil(_safe_int(total) / size)),
    }


# ============================================================
# POST /cardinal/reprocess/{ticket_id}
# ============================================================


@router.post("/reprocess/{ticket_id}")
def cardinal_reprocess(
    ticket_id: int,
    user: UserContext = Depends(_admin),
):
    """Re-submit a ticket through the full Cardinal pipeline (admin only)."""
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT ticket_id, cx_email, subject, description, source, module,
                       thread_id, connector_id
                FROM kirana_kart.fdraw
                WHERE ticket_id = :tid
            """),
            {"tid": ticket_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Ticket not found")

    source  = row["source"] or "api"
    channel = "email" if source in ("gmail", "outlook", "smtp") else "api"

    ingest_payload = {
        "channel": channel,
        "source":  source,
        "org":     "default",
        "business_line": "ecommerce",
        "module":  row["module"] or "delivery",
        "payload": {
            "cx_email":    row["cx_email"],
            "subject":     row["subject"],
            "description": row["description"],
            "thread_id":   row["thread_id"],
        },
        "metadata": {
            "called_by":          "admin_reprocess",
            "original_ticket_id": str(row["ticket_id"]),
            "reprocessed_by":     str(user.id),
        },
    }

    try:
        resp = httpx.post(_INGEST_URL, json=ingest_payload, timeout=15.0)
        resp.raise_for_status()
        data = resp.json()
        logger.info("Reprocess submitted for ticket %s by user %s → execution_id=%s",
                    ticket_id, user.id, data.get("execution_id"))
        return {
            "status":       "submitted",
            "execution_id": data.get("execution_id"),
            "message":      f"Ticket {ticket_id} re-queued successfully.",
        }
    except httpx.HTTPStatusError as exc:
        logger.error("Reprocess failed for ticket %s: %s", ticket_id, exc.response.text)
        raise HTTPException(status_code=502,
                            detail=f"Ingest API returned {exc.response.status_code}: {exc.response.text[:200]}")
    except Exception as exc:
        logger.error("Reprocess error for ticket %s: %s", ticket_id, exc)
        raise HTTPException(status_code=502, detail=f"Failed to reach ingest API: {exc}")


# ============================================================
# BEAT SCHEDULE TABLE SETUP
# ============================================================

_SCHEDULE_DEFAULTS = [
    {
        "task_key":        "poll-streams-every-5s",
        "task_name":       "app.l4_agents.tasks.beat_poll_streams",
        "display_name":    "Stream Poll",
        "description":     "Read from all 4 priority Redis streams and dispatch Celery tasks. Runs every 5 seconds.",
        "schedule_type":   "interval",
        "interval_seconds": 5,
        "cron_expression": None,
    },
    {
        "task_key":        "reclaim-idle-every-60s",
        "task_name":       "app.l4_agents.tasks.beat_reclaim_idle_messages",
        "display_name":    "Idle Message Reclaim",
        "description":     "Reclaim Redis stream messages that were delivered to crashed workers. Runs every 60 seconds.",
        "schedule_type":   "interval",
        "interval_seconds": 60,
        "cron_expression": None,
    },
    {
        "task_key":        "refresh-risk-profiles-hourly",
        "task_name":       "app.l4_agents.tasks.beat_refresh_risk_profiles",
        "display_name":    "Risk Profile Refresh",
        "description":     "Recompute stale customer risk profiles from orders and complaints data. Runs hourly.",
        "schedule_type":   "crontab",
        "interval_seconds": None,
        "cron_expression": "0 * * * *",
    },
    {
        "task_key":        "timeout-stuck-executions-every-10m",
        "task_name":       "app.l4_agents.tasks.beat_execution_plan_timeout",
        "display_name":    "Execution Timeout Check",
        "description":     "Mark cardinal_execution_plans stuck in 'processing' beyond the timeout threshold as 'failed'. Runs every 10 minutes.",
        "schedule_type":   "interval",
        "interval_seconds": 600,
        "cron_expression": None,
    },
    {
        "task_key":        "purge-stale-dedup-keys-daily",
        "task_name":       "app.l4_agents.tasks.beat_purge_stale_dedup_keys",
        "display_name":    "Dedup Key Purge",
        "description":     "Delete deduplication_log rows older than 30 days to keep the table lean. Runs daily at 02:00 UTC.",
        "schedule_type":   "crontab",
        "interval_seconds": None,
        "cron_expression": "0 2 * * *",
    },
]


def ensure_schedule_table() -> None:
    """Create and seed the cardinal_beat_schedule table if it doesn't exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS kirana_kart.cardinal_beat_schedule (
        id                SERIAL PRIMARY KEY,
        task_key          VARCHAR(100) UNIQUE NOT NULL,
        task_name         VARCHAR(200) NOT NULL,
        display_name      VARCHAR(200) NOT NULL,
        description       TEXT,
        schedule_type     VARCHAR(20) NOT NULL DEFAULT 'interval',
        interval_seconds  INTEGER,
        cron_expression   VARCHAR(100),
        enabled           BOOLEAN NOT NULL DEFAULT true,
        last_triggered_at TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_by        VARCHAR(200)
    );
    """
    try:
        with engine.connect() as conn:
            conn.execute(text(ddl))
            for row in _SCHEDULE_DEFAULTS:
                conn.execute(
                    text("""
                        INSERT INTO kirana_kart.cardinal_beat_schedule
                            (task_key, task_name, display_name, description,
                             schedule_type, interval_seconds, cron_expression, enabled)
                        VALUES
                            (:task_key, :task_name, :display_name, :description,
                             :schedule_type, :interval_seconds, :cron_expression, true)
                        ON CONFLICT (task_key) DO NOTHING
                    """),
                    row,
                )
            conn.commit()
        logger.info("cardinal_beat_schedule table ensured with %d default rows.", len(_SCHEDULE_DEFAULTS))
    except Exception as exc:
        logger.error("Failed to ensure cardinal_beat_schedule: %s", exc)


def ensure_master_action_codes_constraints() -> None:
    """Idempotently add UNIQUE constraint on master_action_codes.action_code_id."""
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.table_constraints
                        WHERE constraint_schema = 'kirana_kart'
                          AND constraint_name = 'uq_master_action_codes_action_code_id'
                    ) THEN
                        ALTER TABLE kirana_kart.master_action_codes
                            ADD CONSTRAINT uq_master_action_codes_action_code_id UNIQUE (action_code_id);
                    END IF;
                END $$;
            """))
            conn.commit()
        logger.info("master_action_codes constraints ensured.")
    except Exception as exc:
        logger.warning("ensure_master_action_codes_constraints: %s", exc)


# ============================================================
# SCHEDULER REQUEST MODELS
# ============================================================

class ScheduleUpdateRequest(BaseModel):
    enabled: Optional[bool] = None
    interval_seconds: Optional[int] = None
    cron_expression: Optional[str] = None


# Celery trigger app (governance sends tasks to the shared Redis broker)
_TASK_MAP = {
    "poll-streams-every-5s":              "app.l4_agents.tasks.beat_poll_streams",
    "reclaim-idle-every-60s":             "app.l4_agents.tasks.beat_reclaim_idle_messages",
    "refresh-risk-profiles-hourly":       "app.l4_agents.tasks.beat_refresh_risk_profiles",
    "timeout-stuck-executions-every-10m": "app.l4_agents.tasks.beat_execution_plan_timeout",
    "purge-stale-dedup-keys-daily":       "app.l4_agents.tasks.beat_purge_stale_dedup_keys",
}

_DEFAULT_INTERVALS = {
    "poll-streams-every-5s":              {"interval_seconds": 5,   "cron_expression": None},
    "reclaim-idle-every-60s":             {"interval_seconds": 60,  "cron_expression": None},
    "refresh-risk-profiles-hourly":       {"interval_seconds": None, "cron_expression": "0 * * * *"},
    "timeout-stuck-executions-every-10m": {"interval_seconds": 600, "cron_expression": None},
    "purge-stale-dedup-keys-daily":       {"interval_seconds": None, "cron_expression": "0 2 * * *"},
}


# ============================================================
# GET /cardinal/schedules
# ============================================================

@router.get("/schedules")
def list_schedules(user: UserContext = Depends(_view)):
    """List all beat schedule configs."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, task_key, task_name, display_name, description,
                       schedule_type, interval_seconds, cron_expression,
                       enabled, last_triggered_at, updated_at, updated_by
                FROM kirana_kart.cardinal_beat_schedule
                ORDER BY id
            """)
        ).mappings().all()
    return [_serialize_row(r) for r in rows]


# ============================================================
# PATCH /cardinal/schedules/{task_key}
# ============================================================

@router.patch("/schedules/{task_key}")
def update_schedule(
    task_key: str,
    body: ScheduleUpdateRequest,
    user: UserContext = Depends(_admin),
):
    """Update a beat schedule's enabled flag or interval. Interval changes apply on next scheduler restart."""
    if task_key not in _TASK_MAP:
        raise HTTPException(status_code=404, detail=f"Unknown task_key: {task_key}")

    updates: dict[str, Any] = {"updated_at": "NOW()", "updated_by": str(user.email or user.id)}
    set_parts = ["updated_at = NOW()", "updated_by = :updated_by"]
    params: dict[str, Any] = {"task_key": task_key, "updated_by": str(user.email or user.id)}

    if body.enabled is not None:
        set_parts.append("enabled = :enabled")
        params["enabled"] = body.enabled
    if body.interval_seconds is not None:
        set_parts.append("interval_seconds = :interval_seconds")
        params["interval_seconds"] = body.interval_seconds
    if body.cron_expression is not None:
        set_parts.append("cron_expression = :cron_expression")
        params["cron_expression"] = body.cron_expression

    with get_db_session() as session:
        row = session.execute(
            text(f"""
                UPDATE kirana_kart.cardinal_beat_schedule
                SET {", ".join(set_parts)}
                WHERE task_key = :task_key
                RETURNING id, task_key, task_name, display_name, description,
                          schedule_type, interval_seconds, cron_expression,
                          enabled, last_triggered_at, updated_at, updated_by
            """),
            params,
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail=f"Schedule row not found for: {task_key}")
    return _serialize_row(row)


# ============================================================
# POST /cardinal/schedules/{task_key}/trigger
# ============================================================

@router.post("/schedules/{task_key}/trigger")
def trigger_schedule(
    task_key: str,
    user: UserContext = Depends(_admin),
):
    """Manually fire a beat task immediately via Celery send_task."""
    if task_key not in _TASK_MAP:
        raise HTTPException(status_code=404, detail=f"Unknown task_key: {task_key}")

    task_name = _TASK_MAP[task_key]
    try:
        from celery import Celery as _Celery
        _trigger_app = _Celery(broker=settings.celery_broker_url)
        _trigger_app.send_task(task_name)
        logger.info("Manual trigger: %s by user %s", task_key, user.id)
    except Exception as exc:
        logger.error("Failed to trigger task %s: %s", task_key, exc)
        raise HTTPException(status_code=502, detail=f"Failed to dispatch task: {exc}")

    # Update last_triggered_at
    with get_db_session() as session:
        session.execute(
            text("""
                UPDATE kirana_kart.cardinal_beat_schedule
                SET last_triggered_at = NOW()
                WHERE task_key = :task_key
            """),
            {"task_key": task_key},
        )

    return {
        "status":   "triggered",
        "task_key": task_key,
        "message":  f"Task '{task_key}' dispatched to Celery workers.",
    }


# ============================================================
# POST /cardinal/schedules/{task_key}/reset
# ============================================================

@router.post("/schedules/{task_key}/reset")
def reset_schedule(
    task_key: str,
    user: UserContext = Depends(_admin),
):
    """Reset a schedule to its default interval and re-enable it."""
    if task_key not in _TASK_MAP:
        raise HTTPException(status_code=404, detail=f"Unknown task_key: {task_key}")

    defaults = _DEFAULT_INTERVALS[task_key]
    with get_db_session() as session:
        row = session.execute(
            text("""
                UPDATE kirana_kart.cardinal_beat_schedule
                SET enabled = true,
                    interval_seconds = :interval_seconds,
                    cron_expression  = :cron_expression,
                    updated_at       = NOW(),
                    updated_by       = :updated_by
                WHERE task_key = :task_key
                RETURNING id, task_key, task_name, display_name, description,
                          schedule_type, interval_seconds, cron_expression,
                          enabled, last_triggered_at, updated_at, updated_by
            """),
            {
                "task_key":        task_key,
                "interval_seconds": defaults["interval_seconds"],
                "cron_expression":  defaults["cron_expression"],
                "updated_by":       str(user.email or user.id),
            },
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail=f"Schedule row not found for: {task_key}")
    return _serialize_row(row)


# ============================================================
# ACTION REGISTRY REQUEST MODELS
# ============================================================

class ActionCodeCreateRequest(BaseModel):
    action_key: str
    action_code_id: str
    action_name: str
    action_description: Optional[str] = None
    freshdesk_status: Optional[int] = None
    freshdesk_status_name: Optional[str] = None
    requires_refund: bool = False
    requires_escalation: bool = False
    automation_eligible: bool = True


class ActionCodeUpdateRequest(BaseModel):
    action_key: Optional[str] = None
    action_name: Optional[str] = None
    action_description: Optional[str] = None
    freshdesk_status: Optional[int] = None
    freshdesk_status_name: Optional[str] = None
    requires_refund: Optional[bool] = None
    requires_escalation: Optional[bool] = None
    automation_eligible: Optional[bool] = None


# ============================================================
# GET /cardinal/action-registry
# ============================================================

@router.get("/action-registry")
def list_action_registry(user: UserContext = Depends(_view)):
    """List all master_action_codes rows."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, action_key, action_code_id, action_name, action_description,
                       freshdesk_status, freshdesk_status_name,
                       requires_refund, requires_escalation, automation_eligible,
                       created_at
                FROM kirana_kart.master_action_codes
                ORDER BY id
            """)
        ).mappings().all()
    return [_serialize_row(r) for r in rows]


# ============================================================
# POST /cardinal/action-registry
# ============================================================

@router.post("/action-registry", status_code=201)
def create_action_code(body: ActionCodeCreateRequest, user: UserContext = Depends(_admin)):
    """Insert a new action code into master_action_codes."""
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.master_action_codes
                    (action_key, action_code_id, action_name, action_description,
                     freshdesk_status, freshdesk_status_name,
                     requires_refund, requires_escalation, automation_eligible)
                VALUES
                    (:action_key, :action_code_id, :action_name, :action_description,
                     :freshdesk_status, :freshdesk_status_name,
                     :requires_refund, :requires_escalation, :automation_eligible)
                RETURNING id, action_key, action_code_id, action_name, action_description,
                          freshdesk_status, freshdesk_status_name,
                          requires_refund, requires_escalation, automation_eligible, created_at
            """),
            {
                "action_key":            body.action_key,
                "action_code_id":        body.action_code_id,
                "action_name":           body.action_name,
                "action_description":    body.action_description,
                "freshdesk_status":      body.freshdesk_status,
                "freshdesk_status_name": body.freshdesk_status_name,
                "requires_refund":       body.requires_refund,
                "requires_escalation":   body.requires_escalation,
                "automation_eligible":   body.automation_eligible,
            },
        ).mappings().first()
    if not row:
        raise HTTPException(status_code=500, detail="Insert failed")
    return _serialize_row(row)


# ============================================================
# PUT /cardinal/action-registry/{id}
# ============================================================

@router.put("/action-registry/{code_id}")
def update_action_code(code_id: int, body: ActionCodeUpdateRequest, user: UserContext = Depends(_admin)):
    """Update an action code by id."""
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_parts = [f"{k} = :{k}" for k in fields]
    params = dict(fields)
    params["code_id"] = code_id

    with get_db_session() as session:
        row = session.execute(
            text(f"""
                UPDATE kirana_kart.master_action_codes
                SET {", ".join(set_parts)}
                WHERE id = :code_id
                RETURNING id, action_key, action_code_id, action_name, action_description,
                          freshdesk_status, freshdesk_status_name,
                          requires_refund, requires_escalation, automation_eligible, created_at
            """),
            params,
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail=f"Action code {code_id} not found")
    return _serialize_row(row)


# ============================================================
# DELETE /cardinal/action-registry/{id}
# ============================================================

@router.delete("/action-registry/{code_id}", status_code=204)
def delete_action_code(code_id: int, user: UserContext = Depends(_admin)):
    """Delete an action code by id."""
    with get_db_session() as session:
        result = session.execute(
            text("DELETE FROM kirana_kart.master_action_codes WHERE id = :code_id"),
            {"code_id": code_id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Action code {code_id} not found")


# ============================================================
# TEMPLATE REQUEST MODELS
# ============================================================

class TemplateCreateRequest(BaseModel):
    template_ref: str
    action_code_id: Optional[str] = None
    issue_l1: Optional[str] = None
    issue_l2: Optional[str] = None
    template_v1: Optional[str] = None
    template_v2: Optional[str] = None
    template_v3: Optional[str] = None
    template_v4: Optional[str] = None
    template_v5: Optional[str] = None


class TemplateUpdateRequest(BaseModel):
    template_ref: Optional[str] = None
    action_code_id: Optional[str] = None
    issue_l1: Optional[str] = None
    issue_l2: Optional[str] = None
    template_v1: Optional[str] = None
    template_v2: Optional[str] = None
    template_v3: Optional[str] = None
    template_v4: Optional[str] = None
    template_v5: Optional[str] = None


# ============================================================
# GET /cardinal/templates
# ============================================================

@router.get("/templates")
def list_templates(user: UserContext = Depends(_view)):
    """List all response_templates rows."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, template_ref, action_code_id, issue_l1, issue_l2,
                       template_v1, template_v2, template_v3, template_v4, template_v5,
                       created_at, updated_at
                FROM kirana_kart.response_templates
                ORDER BY id
            """)
        ).mappings().all()
    return [_serialize_row(r) for r in rows]


# ============================================================
# POST /cardinal/templates
# ============================================================

@router.post("/templates", status_code=201)
def create_template(body: TemplateCreateRequest, user: UserContext = Depends(_admin)):
    """Insert a new response template."""
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.response_templates
                    (template_ref, action_code_id, issue_l1, issue_l2,
                     template_v1, template_v2, template_v3, template_v4, template_v5)
                VALUES
                    (:template_ref, :action_code_id, :issue_l1, :issue_l2,
                     :template_v1, :template_v2, :template_v3, :template_v4, :template_v5)
                RETURNING id, template_ref, action_code_id, issue_l1, issue_l2,
                          template_v1, template_v2, template_v3, template_v4, template_v5,
                          created_at, updated_at
            """),
            body.model_dump(),
        ).mappings().first()
    if not row:
        raise HTTPException(status_code=500, detail="Insert failed")
    return _serialize_row(row)


# ============================================================
# PUT /cardinal/templates/{id}
# ============================================================

@router.put("/templates/{template_id}")
def update_template(template_id: int, body: TemplateUpdateRequest, user: UserContext = Depends(_admin)):
    """Update a response template by id."""
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_parts = [f"{k} = :{k}" for k in fields]
    set_parts.append("updated_at = NOW()")
    params = dict(fields)
    params["template_id"] = template_id

    with get_db_session() as session:
        row = session.execute(
            text(f"""
                UPDATE kirana_kart.response_templates
                SET {", ".join(set_parts)}
                WHERE id = :template_id
                RETURNING id, template_ref, action_code_id, issue_l1, issue_l2,
                          template_v1, template_v2, template_v3, template_v4, template_v5,
                          created_at, updated_at
            """),
            params,
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail=f"Template {template_id} not found")
    return _serialize_row(row)


# ============================================================
# DELETE /cardinal/templates/{id}
# ============================================================

@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: int, user: UserContext = Depends(_admin)):
    """Delete a response template by id."""
    with get_db_session() as session:
        result = session.execute(
            text("DELETE FROM kirana_kart.response_templates WHERE id = :template_id"),
            {"template_id": template_id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Template {template_id} not found")
