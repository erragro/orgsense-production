"""
app/l4_agents/tasks.py
========================
Celery Periodic & Operational Tasks

These tasks run on schedules or are triggered by external events.
They are separate from the main process_ticket task in worker.py.

worker.py  → process_ticket         — per-ticket LLM pipeline (event-driven)
tasks.py   → everything else        — operational, scheduled, maintenance

Tasks defined here:

    SCHEDULED (Celery Beat):
        beat_poll_streams            — Trigger stream poll every 5 seconds
                                       when running in Beat mode instead of
                                       the direct poll loop in worker.py
        beat_reclaim_idle_messages   — Reclaim stuck messages every 60s
        beat_refresh_risk_profiles   — Recompute stale customer_risk_profile rows
        beat_purge_stale_dedup_keys  — Clean expired dedup log entries from DB
        beat_execution_plan_timeout  — Mark execution plans stuck in 'processing'
                                       as 'failed' after timeout threshold

    ON-DEMAND (called programmatically or via CLI):
        reprocess_ticket             — Manually requeue a specific ticket
        drain_failed_executions      — Inspect and optionally requeue failed plans
        health_check                 — Verify DB + Redis connectivity, return status

Celery Beat schedule is defined at the bottom of this file.
Register with:
    celery -A app.l4_agents.tasks beat --loglevel=info
Or combined worker+beat (single process, dev only):
    celery -A app.l4_agents.tasks worker --beat --loglevel=info
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from celery import Celery
from celery.schedules import crontab
from dotenv import load_dotenv

from app.admin.redis_client import get_redis
from app.l4_agents.worker import (
    celery_app,
    ensure_consumer_groups,
    poll_streams_once,
    reclaim_idle_messages,
    SCHEMA,
    CONSUMER_NAME,
)

# ============================================================
# ENVIRONMENT
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME", "orgintelligence")
DB_USER     = os.getenv("DB_USER", "orguser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

# Execution plan stuck timeout — plans in 'processing' longer than this are failed
EXECUTION_TIMEOUT_MINUTES = int(os.getenv("EXECUTION_TIMEOUT_MINUTES", "30"))

# Risk profile staleness threshold — recompute if last_computed_at older than this
RISK_PROFILE_STALE_HOURS = int(os.getenv("RISK_PROFILE_STALE_HOURS", "2"))

logger = logging.getLogger("cardinal.tasks")


# ============================================================
# DB CONNECTION
# ============================================================

def _get_connection() -> psycopg2.extensions.connection:
    return pooled_connection()


# ============================================================
# SCHEDULER ENABLE/DISABLE HELPER
# ============================================================

def _is_task_enabled(task_key: str) -> bool:
    """
    Check if a beat task is enabled via the cardinal_beat_schedule DB table.
    Defaults to True (fail-open) if the row doesn't exist or DB is unavailable.
    This allows enable/disable to take effect on the next beat tick with no restart.
    """
    try:
        conn = _get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled FROM kirana_kart.cardinal_beat_schedule WHERE task_key = %s",
                    (task_key,),
                )
                row = cur.fetchone()
                return row[0] if row is not None else True
        finally:
            conn.close()
    except Exception:
        return True  # fail-open: never block tasks on DB error


# ============================================================
# SCHEDULED TASKS
# ============================================================

@celery_app.task(name="app.l4_agents.tasks.beat_poll_streams")
def beat_poll_streams() -> dict[str, int]:
    """
    Trigger a single stream poll cycle.
    Used when running in Celery Beat mode instead of the
    direct __main__ poll loop in worker.py.

    Beat schedules this every 5 seconds.
    Each invocation reads up to STREAM_BATCH_SIZE messages
    per stream and dispatches them as process_ticket tasks.
    """
    if not _is_task_enabled("poll-streams-every-5s"):
        logger.debug("beat_poll_streams: disabled, skipping")
        return {"skipped": True}
    ensure_consumer_groups()
    dispatched = poll_streams_once()
    if dispatched:
        logger.info("beat_poll_streams: dispatched %d task(s)", dispatched)
    return {"dispatched": dispatched}


@celery_app.task(name="app.l4_agents.tasks.beat_reclaim_idle_messages")
def beat_reclaim_idle_messages() -> dict[str, int]:
    """
    Reclaim stream messages that were delivered but never acknowledged.
    Handles crashed workers — their pending messages are re-dispatched.

    Beat schedules this every 60 seconds.
    """
    if not _is_task_enabled("reclaim-idle-every-60s"):
        logger.debug("beat_reclaim_idle_messages: disabled, skipping")
        return {"skipped": True}
    reclaimed = reclaim_idle_messages()
    if reclaimed:
        logger.warning("beat_reclaim_idle_messages: reclaimed %d message(s)", reclaimed)
    return {"reclaimed": reclaimed}


@celery_app.task(name="app.l4_agents.tasks.beat_refresh_risk_profiles")
def beat_refresh_risk_profiles() -> dict[str, int]:
    """
    Recompute customer_risk_profile rows that are stale.

    Staleness = last_computed_at older than RISK_PROFILE_STALE_HOURS.

    Process:
        1. Read unprocessed rows from risk_profile_change_log
        2. For each affected customer_id, recompute aggregates
           from orders, refunds, complaints tables
        3. Upsert into customer_risk_profile
        4. Mark change_log rows as processed

    Beat schedules this every hour.

    Note: This is the computation job referenced in migration 004.
    The triggers log changes; this job processes them.
    """
    if not _is_task_enabled("refresh-risk-profiles-hourly"):
        logger.debug("beat_refresh_risk_profiles: disabled, skipping")
        return {"skipped": True}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RISK_PROFILE_STALE_HOURS)
    conn   = _get_connection()
    updated = 0

    try:
        # Step 1: Get customer_ids with unprocessed change log entries
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT id, customer_id
                FROM {SCHEMA}.risk_profile_change_log
                WHERE processed = false
                ORDER BY id
                LIMIT 500
                """
            )
            rows = cur.fetchall()

        customer_ids = list(dict.fromkeys(r[1] for r in rows))
        completed_ids = []
        if not customer_ids:
            return {"updated": 0}

        # Step 2: Recompute each customer's risk profile
        for customer_id in customer_ids:
            try:
                _recompute_risk_profile(conn, customer_id)
                completed_ids.extend(r[0] for r in rows if r[1] == customer_id)
                updated += 1
            except Exception as exc:
                logger.error(
                    "Risk profile recompute failed for customer_id=%s: %s",
                    customer_id, exc,
                )

        # Step 3: Mark processed
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.risk_profile_change_log
                    SET processed    = true,
                        processed_at = %s
                    WHERE id = ANY(%s)
                    AND   processed   = false
                    """,
                    (datetime.now(timezone.utc), completed_ids),
                )

        logger.info("beat_refresh_risk_profiles: updated %d profile(s)", updated)
        return {"updated": updated}

    except psycopg2.Error as exc:
        logger.error("beat_refresh_risk_profiles failed: %s", exc)
        return {"updated": updated, "error": str(exc)}
    finally:
        conn.close()


@celery_app.task(name="app.l4_agents.tasks.beat_purge_stale_dedup_keys")
def beat_purge_stale_dedup_keys() -> dict[str, int]:
    """
    Clean up deduplication_log rows older than 30 days.

    Redis keys expire automatically after 24h via TTL.
    The Postgres deduplication_log is permanent by design — but
    rows older than 30 days have no operational value and can
    be archived or deleted to keep the table lean.

    Beat schedules this daily at 02:00 UTC.
    """
    if not _is_task_enabled("purge-stale-dedup-keys-daily"):
        logger.debug("beat_purge_stale_dedup_keys: disabled, skipping")
        return {"skipped": True}
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    conn   = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    DELETE FROM {SCHEMA}.deduplication_log
                    WHERE duplicate_received_at < %s
                    """,
                    (cutoff,),
                )
                deleted = cur.rowcount
        logger.info("beat_purge_stale_dedup_keys: deleted %d row(s)", deleted)
        return {"deleted": deleted}
    except psycopg2.Error as exc:
        logger.error("beat_purge_stale_dedup_keys failed: %s", exc)
        return {"deleted": 0, "error": str(exc)}
    finally:
        conn.close()


@celery_app.task(name="app.l4_agents.tasks.beat_execution_plan_timeout")
def beat_execution_plan_timeout() -> dict[str, int]:
    """
    Mark execution plans that have been stuck in 'processing'
    longer than EXECUTION_TIMEOUT_MINUTES as 'failed'.

    This catches:
        - Workers that claimed a ticket but died without updating state
        - Tasks that hit an unhandled exception that bypassed _handle_failure
        - DB deadlocks that caused a worker to hang indefinitely

    Beat schedules this every 10 minutes.
    """
    if not _is_task_enabled("timeout-stuck-executions-every-10m"):
        logger.debug("beat_execution_plan_timeout: disabled, skipping")
        return {"skipped": True}
    timeout_cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=EXECUTION_TIMEOUT_MINUTES
    )
    conn  = _get_connection()
    timed_out = 0

    try:
        with conn:
            with conn.cursor() as cur:
                # Find stuck execution plans
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.cardinal_execution_plans
                    SET    status       = 'failed',
                           completed_at = %s,
                           metadata     = COALESCE(metadata, '{{}}'::jsonb)
                                          || '{{"timeout": true}}'::jsonb
                    WHERE  status       = 'processing'
                    AND    started_at   < %s
                    RETURNING execution_id
                    """,
                    (datetime.now(timezone.utc), timeout_cutoff),
                )
                timed_out_ids = [r[0] for r in cur.fetchall()]
                timed_out = len(timed_out_ids)

                # Update corresponding ticket_processing_state rows
                if timed_out_ids:
                    cur.execute(
                        f"""
                        UPDATE {SCHEMA}.ticket_processing_state
                        SET    error_message           = 'Execution timed out',
                               processing_completed_at = %s
                        WHERE  execution_id = ANY(%s)
                        AND    processing_completed_at IS NULL
                        """,
                        (datetime.now(timezone.utc), timed_out_ids),
                    )

        if timed_out:
            logger.warning(
                "beat_execution_plan_timeout: timed out %d execution(s): %s",
                timed_out, timed_out_ids,
            )
        return {"timed_out": timed_out}

    except psycopg2.Error as exc:
        logger.error("beat_execution_plan_timeout failed: %s", exc)
        return {"timed_out": 0, "error": str(exc)}
    finally:
        conn.close()


# ============================================================
# SCHEDULED: AGENT BAD-ACTOR FLAGGING
# ============================================================

# Threshold: agents whose policy-ineligible refund approval rate exceeds this
# value within a rolling 7-day window are flagged as potential bad actors.
_BAD_ACTOR_REFUND_RATE_THRESHOLD = float(
    os.getenv("BAD_ACTOR_REFUND_RATE_THRESHOLD", "0.35")
)
# Minimum ticket volume before the rate is considered meaningful
_BAD_ACTOR_MIN_TICKETS = int(os.getenv("BAD_ACTOR_MIN_TICKETS", "10"))


@celery_app.task(name="app.l4_agents.tasks.beat_flag_bad_actor_agents")
def beat_flag_bad_actor_agents() -> dict:
    """
    Identify agents approving policy-ineligible refunds at an elevated rate.

    Addresses Problem 1 gap: "1,840 agents → bad-actor cluster in 4 hours."

    Logic:
        - Reads ticket_execution_summary for the past 7 days
        - Groups by agent_id, computes refund approval rate and
          policy-ineligible rate (automation_pathway = MANUAL_REVIEW with override)
        - Flags agents exceeding _BAD_ACTOR_REFUND_RATE_THRESHOLD with
          at least _BAD_ACTOR_MIN_TICKETS in the window
        - Upserts into agent_quality_flags table (created here if absent)

    Beat schedules this every 4 hours during business hours.
    BI agent can query agent_quality_flags for same-day visibility.
    """
    if not _is_task_enabled("flag-bad-actor-agents-4h"):
        logger.debug("beat_flag_bad_actor_agents: disabled, skipping")
        return {"skipped": True}

    conn = _get_connection()
    flagged = 0
    try:
        # Ensure agent_quality_flags table exists
        with conn:
            with conn.cursor() as cur:
                pass  # Schema installed by Alembic.

        cutoff = datetime.now(timezone.utc) - timedelta(days=7)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT
                    agent_id,
                    COUNT(*)                                                    AS total_tickets,
                    COUNT(*) FILTER (WHERE applied_action_code LIKE 'REFUND%%') AS refund_approvals,
                    COUNT(*) FILTER (WHERE resolution_status = 'manual_review') AS manual_review_count
                FROM {SCHEMA}.ticket_execution_summary
                WHERE processed_at >= %s
                  AND agent_id IS NOT NULL
                GROUP BY agent_id
                HAVING COUNT(*) >= %s
            """, (cutoff, _BAD_ACTOR_MIN_TICKETS))
            rows = cur.fetchall()

        now = datetime.now(timezone.utc)
        for row in rows:
            total    = row["total_tickets"] or 1
            refunds  = row["refund_approvals"] or 0
            rate     = round(refunds / total, 4)

            if rate < _BAD_ACTOR_REFUND_RATE_THRESHOLD:
                continue

            reason = (
                f"refund_rate={rate:.2%} over last 7d "
                f"({refunds}/{total} tickets); "
                f"manual_review_count={row['manual_review_count']}"
            )

            with conn:
                with conn.cursor() as cur:
                    cur.execute(f"""
                        INSERT INTO {SCHEMA}.agent_quality_flags (
                            agent_id, flagged_at, window_days,
                            total_tickets, refund_approvals, refund_rate,
                            manual_review_count, flag_reason, resolved
                        ) VALUES (%s, %s, 7, %s, %s, %s, %s, %s, FALSE)
                        ON CONFLICT DO NOTHING
                    """, (
                        row["agent_id"], now, total,
                        refunds, rate,
                        row["manual_review_count"], reason,
                    ))
            flagged += 1
            logger.warning(
                "bad_actor_flag | agent_id=%s | %s",
                row["agent_id"], reason,
            )

        logger.info("beat_flag_bad_actor_agents: flagged %d agent(s)", flagged)
        return {"flagged": flagged, "agents_evaluated": len(rows)}

    except psycopg2.Error as exc:
        logger.error("beat_flag_bad_actor_agents failed: %s", exc)
        return {"flagged": 0, "error": str(exc)}
    finally:
        conn.close()


# ============================================================
# SCHEDULED: TRUE FCR CHECKER (48-HOUR ASYNC)
# ============================================================

@celery_app.task(name="app.l4_agents.tasks.beat_fcr_checker")
def beat_fcr_checker() -> dict:
    """
    Compute true First Contact Resolution (FCR) by checking re-contacts 48h
    after a ticket was marked resolved.

    Addresses Problem 4: "True FCR is 54%, reported as 74% — gap is invisible."

    Logic:
        - Finds complaints resolved 48–72 hours ago (the check window)
        - For each resolved complaint, looks for a subsequent complaint from
          the same customer_id with the same issue_type_l2 within 48h of resolution
        - Marks the original ticket as fcr=FALSE in ticket_execution_summary
          if a re-contact is found; fcr=TRUE otherwise
        - FCR rate is then queryable via BI agent on ticket_execution_summary

    Beat schedules this every 6 hours.
    """
    if not _is_task_enabled("fcr-checker-6h"):
        logger.debug("beat_fcr_checker: disabled, skipping")
        return {"skipped": True}

    conn = _get_connection()
    checked = 0
    re_contacts = 0

    try:
        now = datetime.now(timezone.utc)
        # Look at complaints resolved 48–72h ago (gives the 48h re-contact window)
        window_start = now - timedelta(hours=72)
        window_end   = now - timedelta(hours=48)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT
                    c.ticket_id,
                    c.customer_id,
                    c.issue_type_l2,
                    c.raised_at   AS resolved_at
                FROM {SCHEMA}.complaints c
                WHERE c.resolution_status = 'resolved'
                  AND c.raised_at BETWEEN %s AND %s
                  AND c.customer_id IS NOT NULL
            """, (window_start, window_end))
            resolved_tickets = cur.fetchall()

        for t in resolved_tickets:
            checked += 1
            # Check if same customer contacted again on same issue within 48h
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT 1
                    FROM {SCHEMA}.complaints
                    WHERE customer_id   = %s
                      AND issue_type_l2 = %s
                      AND raised_at     > %s
                      AND raised_at     <= %s + INTERVAL '48 hours'
                      AND ticket_id     != %s
                    LIMIT 1
                """, (
                    t["customer_id"],
                    t["issue_type_l2"],
                    t["resolved_at"],
                    t["resolved_at"],
                    t["ticket_id"],
                ))
                re_contact_found = cur.fetchone() is not None

            # Update fcr column in ticket_execution_summary
            with conn:
                with conn.cursor() as cur:
                    cur.execute(f"""
                        UPDATE {SCHEMA}.ticket_execution_summary
                        SET fcr = %s
                        WHERE ticket_id = %s
                    """, (not re_contact_found, t["ticket_id"]))

            if re_contact_found:
                re_contacts += 1

        logger.info(
            "beat_fcr_checker: checked=%d re_contacts=%d true_fcr_rate=%.2f%%",
            checked,
            re_contacts,
            ((checked - re_contacts) / checked * 100) if checked else 0,
        )
        return {
            "checked":      checked,
            "re_contacts":  re_contacts,
            "true_fcr_rate": round((checked - re_contacts) / checked, 4) if checked else None,
        }

    except psycopg2.Error as exc:
        logger.error("beat_fcr_checker failed: %s", exc)
        return {"checked": 0, "error": str(exc)}
    finally:
        conn.close()


# ============================================================
# SCHEDULED: SPIKE DETECTION
# ============================================================

@celery_app.task(name="app.l4_agents.tasks.beat_score_conversations")
def beat_score_conversations() -> dict:
    """
    Score recent closed conversations for human agent quality.
    Runs every 5 minutes to achieve near-real-time QA coverage.

    Addresses Problem 2: 0.2% QA coverage → 100% automated QA.
    Scoring signals: canned response ratio, grammar, sentiment arc, resolution quality.
    Results written to conversation_qa_scores; coaching flags logged.
    """
    if not _is_task_enabled("score-conversations-every-5m"):
        logger.debug("beat_score_conversations: disabled, skipping")
        return {"skipped": True}

    try:
        from app.l4_agents.ecommerce.agent_qa_scorer import score_recent_conversations
    except ImportError as exc:
        logger.error("agent_qa_scorer import failed: %s", exc)
        return {"error": str(exc)}

    result = score_recent_conversations(limit=200)
    if result.get("scored"):
        logger.info(
            "beat_score_conversations: scored=%d flagged=%d skipped=%d",
            result["scored"], result["flagged_for_coaching"], result["skipped"],
        )
    return result


@celery_app.task(name="app.l4_agents.tasks.beat_spike_detector")
def beat_spike_detector() -> dict:
    """
    Run spike detection on the current 15-minute ticket volume window.
    If a spike is detected, immediately triggers root-cause clustering
    and persists the summary to spike_reports for BI agent queries.

    Addresses Problem 3: Volume doubled, investigation took 3 days.
    Target: Spike identified + cluster breakdown within 20 minutes.

    Beat schedules this every 15 minutes.
    """
    if not _is_task_enabled("spike-detection-every-15m"):
        logger.debug("beat_spike_detector: disabled, skipping")
        return {"skipped": True}

    try:
        from app.l3_analytics.clustering_service import SpikeDetector, RootCauseClustering
    except ImportError as exc:
        logger.error("clustering_service import failed: %s", exc)
        return {"error": str(exc)}

    detector = SpikeDetector()
    spike    = detector.check_current_window()

    if not spike:
        return {"spike_detected": False}

    logger.warning(
        "beat_spike_detector: SPIKE | sigma=%.2f | count=%d | baseline=%.1f",
        spike.sigma_above, spike.ticket_count, spike.baseline_mean,
    )

    clustering = RootCauseClustering()
    summary    = clustering.analyse(spike)

    return {
        "spike_detected":  True,
        "spike_id":        summary.spike_id,
        "current_volume":  summary.current_volume,
        "sigma_above":     summary.sigma_above,
        "cluster_method":  summary.cluster_method,
        "top_clusters": [
            {"name": c.name, "count": c.count, "pct": c.percentage}
            for c in summary.clusters[:3]
        ],
    }


# ============================================================
# ON-DEMAND TASKS
# ============================================================

@celery_app.task(name="app.l4_agents.tasks.reprocess_ticket")
def reprocess_ticket(
    ticket_id:    int,
    reason:       str = "manual_reprocess",
    requested_by: str = "ops",
) -> dict[str, Any]:
    """
    Manually requeue a specific ticket for reprocessing.

    Use cases:
        - A ticket failed due to a transient error and max retries were hit
        - A policy version was updated and the ticket needs re-evaluation
        - QA found an incorrect resolution and wants it reconsidered

    Fetches the existing execution_id from fdraw, generates a new
    execution_id for the reprocess run, and pushes to P3_STANDARD stream.

    Args:
        ticket_id:    fdraw ticket_id to reprocess
        reason:       Why it's being reprocessed (for audit trail)
        requested_by: Who triggered it (agent ID, ops username, etc.)

    Returns:
        dict with new execution_id and stream message_id, or error info
    """
    from app.l2_cardinal.phase5_dispatcher import _generate_execution_id
    from app.l1_ingestion.schemas import CanonicalPayload

    logger.info(
        "reprocess_ticket | ticket_id=%s | reason=%s | by=%s",
        ticket_id, reason, requested_by,
    )

    conn = _get_connection()
    try:
        # Fetch existing ticket context from fdraw
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT ticket_id, module, canonical_payload, pipeline_stage
                FROM   {SCHEMA}.fdraw
                WHERE  ticket_id = %s
                LIMIT  1
                """,
                (ticket_id,),
            )
            row = cur.fetchone()

        if not row:
            return {"status": "error", "message": f"ticket_id={ticket_id} not found"}

        canonical_payload = row["canonical_payload"] or {}
        execution_id_old  = canonical_payload.get("execution_id", "unknown")

        # Build a minimal CanonicalPayload to generate a new execution_id
        # We only need org and is_sandbox for the ID format
        org        = canonical_payload.get("org", "unknown")
        is_sandbox = canonical_payload.get("is_sandbox", False)

        # Generate new execution_id for this reprocess run
        import time, uuid
        new_execution_id = (
            f"single_{org[:20]}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
        )

        # Push to P3_STANDARD stream
        r = get_redis()
        stream_fields = {
            "execution_id":              new_execution_id,
            "ticket_id":                 str(ticket_id),
            "org":                       org,
            "module":                    canonical_payload.get("module", ""),
            "business_line":             canonical_payload.get("business_line", ""),
            "active_policy":             canonical_payload.get("active_policy", ""),
            "customer_id":               canonical_payload.get("customer_id", ""),
            "priority":                  "P3_STANDARD",
            "escalation_group":          "STANDARD",
            "is_sandbox":                str(is_sandbox).lower(),
            "reprocess":                 "true",
            "prior_complaints_30d":      "0",
            "fraud_risk_classification": "NORMAL",
            "auto_approval_limit":       "500.0",
            "recommended_queue":         "STANDARD_REVIEW",
            "enriched_at":               datetime.now(timezone.utc).isoformat(),
            "reprocess_reason":          reason,
            "reprocess_requested_by":    requested_by,
            "original_execution_id":     execution_id_old,
        }

        msg_id = r.xadd(
            name="cardinal:dispatch:P3_STANDARD",
            fields=stream_fields,
        )

        # Write new execution plan row
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.cardinal_execution_plans (
                        execution_id, execution_mode, org,
                        module, total_tickets, status,
                        metadata, created_at
                    ) VALUES (%s, 'single', %s, %s, 1, 'queued', %s, %s)
                    """,
                    (
                        new_execution_id,
                        org,
                        canonical_payload.get("module", ""),
                        psycopg2.extras.Json({
                            "reprocess":              True,
                            "reason":                 reason,
                            "requested_by":           requested_by,
                            "original_execution_id":  execution_id_old,
                        }),
                        datetime.now(timezone.utc),
                    ),
                )
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.ticket_processing_state (
                        ticket_id, execution_id, current_stage,
                        stage_0_status, stage_1_status,
                        stage_2_status, stage_3_status,
                        module, created_at
                    ) VALUES (%s, %s, 0,
                        'pending', 'pending', 'pending', 'pending',
                        %s, %s)
                    """,
                    (
                        ticket_id,
                        new_execution_id,
                        canonical_payload.get("module", ""),
                        datetime.now(timezone.utc),
                    ),
                )

        logger.info(
            "reprocess_ticket queued | ticket_id=%s | new_execution_id=%s | msg_id=%s",
            ticket_id, new_execution_id, msg_id,
        )
        return {
            "status":            "queued",
            "ticket_id":         ticket_id,
            "new_execution_id":  new_execution_id,
            "stream_message_id": msg_id,
        }

    except Exception as exc:
        logger.error("reprocess_ticket failed for ticket_id=%s: %s", ticket_id, exc)
        return {"status": "error", "message": str(exc)}
    finally:
        conn.close()


@celery_app.task(name="app.l4_agents.tasks.drain_failed_executions")
def drain_failed_executions(
    requeue:       bool = False,
    limit:         int  = 50,
) -> dict[str, Any]:
    """
    Inspect failed execution plans and optionally requeue them.

    Args:
        requeue:  If True, automatically requeue all failed executions
                  via reprocess_ticket. If False, just return the list.
        limit:    Max number of failed executions to inspect/requeue.

    Returns:
        dict with list of failed execution_ids and requeue results.

    Usage:
        # Inspect only
        drain_failed_executions.delay(requeue=False)

        # Inspect and requeue
        drain_failed_executions.delay(requeue=True, limit=10)
    """
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT
                    cep.execution_id,
                    cep.org,
                    cep.module,
                    cep.created_at,
                    cep.completed_at,
                    tps.ticket_id,
                    tps.error_message,
                    tps.retry_count
                FROM {SCHEMA}.cardinal_execution_plans cep
                LEFT JOIN {SCHEMA}.ticket_processing_state tps
                    ON cep.execution_id = tps.execution_id
                WHERE cep.status = 'failed'
                ORDER BY cep.created_at DESC
                LIMIT %s
                """,
                (limit,),
            )
            rows = [dict(r) for r in cur.fetchall()]

        if not rows:
            return {"failed_count": 0, "executions": []}

        requeue_results = []
        if requeue:
            for row in rows:
                if row.get("ticket_id"):
                    result = reprocess_ticket.delay(
                        ticket_id=row["ticket_id"],
                        reason="drain_failed_executions",
                        requested_by="system",
                    )
                    requeue_results.append({
                        "ticket_id":    row["ticket_id"],
                        "execution_id": row["execution_id"],
                        "task_id":      result.id,
                    })

        return {
            "failed_count":   len(rows),
            "executions":     rows,
            "requeued":       len(requeue_results),
            "requeue_results": requeue_results,
        }

    except psycopg2.Error as exc:
        logger.error("drain_failed_executions failed: %s", exc)
        return {"failed_count": 0, "error": str(exc)}
    finally:
        conn.close()


@celery_app.task(name="app.l4_agents.tasks.health_check")
def health_check() -> dict[str, Any]:
    """
    Verify DB + Redis connectivity from within a worker process.
    Useful for confirming workers are alive and connected.

    Returns status dict — safe to call frequently.
    """
    status: dict[str, Any] = {
        "worker":   CONSUMER_NAME,
        "database": "unknown",
        "redis":    "unknown",
        "streams":  {},
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }

    # DB check
    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.close()
        status["database"] = "connected"
    except Exception as exc:
        status["database"] = f"error: {exc}"

    # Redis check + stream lengths
    try:
        r = get_redis()
        r.ping()
        status["redis"] = "connected"

        for stream in [
            "cardinal:dispatch:P1_CRITICAL",
            "cardinal:dispatch:P2_HIGH",
            "cardinal:dispatch:P3_STANDARD",
            "cardinal:dispatch:P4_LOW",
        ]:
            try:
                length = r.xlen(stream)
                status["streams"][stream] = {"length": length}
            except Exception:
                status["streams"][stream] = {"length": "unknown"}

    except Exception as exc:
        status["redis"] = f"error: {exc}"

    return status


# ============================================================
# RISK PROFILE COMPUTATION HELPER
# ============================================================

def _recompute_risk_profile(
    conn:        psycopg2.extensions.connection,
    customer_id: str,
) -> None:
    """
    Recompute a single customer's risk profile from source tables.
    Called by beat_refresh_risk_profiles for each affected customer.

    Aggregates:
        - orders_last_7/30/90_days   from orders table
        - refunds_last_7/30/90_days  from complaints table (resolved refunds)
        - refund_rate_7/30/90d       computed from above
        - complaints_last_30_days    from complaints table
        - marked_delivered_claims_90d from complaints WHERE issue_type_l2='not_received'

    fraud_score and fraud_risk_classification are computed from
    refund_rate_30d + marked_delivered_claims_90d using simple
    threshold rules. Full ML scoring replaces this in Phase 3 roadmap.
    """
    now = datetime.now(timezone.utc)

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Order counts
        cur.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE created_at >= %s - INTERVAL '7 days')  AS orders_7d,
                COUNT(*) FILTER (WHERE created_at >= %s - INTERVAL '30 days') AS orders_30d,
                COUNT(*) FILTER (WHERE created_at >= %s - INTERVAL '90 days') AS orders_90d
            FROM {SCHEMA}.orders
            WHERE customer_id = %s
            """,
            (now, now, now, customer_id),
        )
        order_row = cur.fetchone()

        # Refund counts (complaints with a refund action)
        cur.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE raised_at >= %s - INTERVAL '7 days' AND action_code LIKE 'REFUND%%') AS refunds_7d,
                COUNT(*) FILTER (WHERE raised_at >= %s - INTERVAL '30 days' AND action_code LIKE 'REFUND%%') AS refunds_30d,
                COUNT(*) FILTER (WHERE raised_at >= %s - INTERVAL '90 days' AND action_code LIKE 'REFUND%%') AS refunds_90d,
                COUNT(*) FILTER (WHERE raised_at >= %s - INTERVAL '30 days') AS complaints_30d,
                COUNT(*) FILTER (
                    WHERE raised_at >= %s - INTERVAL '90 days'
                    AND   issue_type_l2 = 'not_received'
                ) AS marked_delivered_90d
            FROM {SCHEMA}.complaints
            WHERE customer_id = %s
            """,
            (now, now, now, now, now, customer_id),
        )
        refund_row = cur.fetchone()

    orders_7d  = order_row["orders_7d"]  or 0
    orders_30d = order_row["orders_30d"] or 0
    orders_90d = order_row["orders_90d"] or 0
    refunds_7d  = refund_row["refunds_7d"]  or 0
    refunds_30d = refund_row["refunds_30d"] or 0
    refunds_90d = refund_row["refunds_90d"] or 0
    complaints_30d       = refund_row["complaints_30d"]       or 0
    marked_delivered_90d = refund_row["marked_delivered_90d"] or 0

    # Refund rates (avoid divide by zero)
    rr_7d  = round(refunds_7d  / orders_7d,  4) if orders_7d  > 0 else 0.0
    rr_30d = round(refunds_30d / orders_30d, 4) if orders_30d > 0 else 0.0
    rr_90d = round(refunds_90d / orders_90d, 4) if orders_90d > 0 else 0.0

    # Simple fraud score: weighted refund rate + marked_delivered signal
    fraud_score = min(1.0, round(
        (rr_30d * 0.5)
        + (marked_delivered_90d * 0.05)
        + (rr_90d * 0.3),
        3
    ))

    if fraud_score >= 0.7:
        fraud_class = "HIGH_RISK"
        auto_limit  = 0.0
        queue       = "FRAUD_TEAM"
    elif fraud_score >= 0.4:
        fraud_class = "MEDIUM_RISK"
        auto_limit  = 200.0
        queue       = "L2_TEAM_LEAD"
    elif fraud_score >= 0.2:
        fraud_class = "LOW_RISK"
        auto_limit  = 200.0
        queue       = "STANDARD_REVIEW"
    else:
        fraud_class = "NORMAL"
        auto_limit  = 500.0
        queue       = "STANDARD_REVIEW"

    with conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {SCHEMA}.customer_risk_profile (
                    customer_id,
                    fraud_score, fraud_risk_classification,
                    orders_last_7_days, orders_last_30_days, orders_last_90_days,
                    refunds_last_7_days, refunds_last_30_days, refunds_last_90_days,
                    refund_rate_7d, refund_rate_30d, refund_rate_90d,
                    complaints_last_30_days, marked_delivered_claims_90d,
                    auto_approval_eligible, auto_approval_limit,
                    recommended_queue, last_computed_at
                ) VALUES (
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s
                )
                ON CONFLICT (customer_id) DO UPDATE SET
                    fraud_score                  = EXCLUDED.fraud_score,
                    fraud_risk_classification    = EXCLUDED.fraud_risk_classification,
                    orders_last_7_days           = EXCLUDED.orders_last_7_days,
                    orders_last_30_days          = EXCLUDED.orders_last_30_days,
                    orders_last_90_days          = EXCLUDED.orders_last_90_days,
                    refunds_last_7_days          = EXCLUDED.refunds_last_7_days,
                    refunds_last_30_days         = EXCLUDED.refunds_last_30_days,
                    refunds_last_90_days         = EXCLUDED.refunds_last_90_days,
                    refund_rate_7d               = EXCLUDED.refund_rate_7d,
                    refund_rate_30d              = EXCLUDED.refund_rate_30d,
                    refund_rate_90d              = EXCLUDED.refund_rate_90d,
                    complaints_last_30_days      = EXCLUDED.complaints_last_30_days,
                    marked_delivered_claims_90d  = EXCLUDED.marked_delivered_claims_90d,
                    auto_approval_eligible       = EXCLUDED.auto_approval_eligible,
                    auto_approval_limit          = EXCLUDED.auto_approval_limit,
                    recommended_queue            = EXCLUDED.recommended_queue,
                    last_computed_at             = EXCLUDED.last_computed_at
                """,
                (
                    customer_id,
                    fraud_score, fraud_class,
                    orders_7d, orders_30d, orders_90d,
                    refunds_7d, refunds_30d, refunds_90d,
                    rr_7d, rr_30d, rr_90d,
                    complaints_30d, marked_delivered_90d,
                    fraud_score < 0.7, auto_limit,
                    queue, now,
                ),
            )


# ============================================================
# CRM AUTO-ESCALATE TASK
# ============================================================


@celery_app.task(name="app.l4_agents.tasks.beat_crm_auto_escalate")
def beat_crm_auto_escalate():
    """Every 15 minutes: auto-escalate CRM tickets that have breached SLA."""
    try:
        from app.admin.services.crm_service import auto_escalate_overdue
        count = auto_escalate_overdue()
        logger.info("[CRM] Auto-escalated %d overdue tickets", count)
        return {"escalated": count}
    except Exception as exc:
        logger.error("[CRM] auto_escalate_overdue failed: %s", exc)
        return {"error": str(exc)}


@celery_app.task(name="app.l4_agents.tasks.beat_crm_automation_sla")
def beat_crm_automation_sla():
    """
    Every 5 minutes: fire SLA_WARNING and SLA_BREACHED automation rule triggers.

    SLA_WARNING fires for tickets within 15 minutes of their SLA deadline.
    SLA_BREACHED fires for tickets that have passed their SLA deadline and
    have not yet been notified.

    This enables automation rules like:
      "When SLA is breached AND queue != ESCALATION → change queue to SLA_BREACH_REVIEW"
    """
    try:
        from app.admin.services.crm_automation_engine import run_sla_checks
        result = run_sla_checks()
        if result.get("warned") or result.get("breached"):
            logger.info("[CRM Automation] SLA checks: %s", result)
        return result
    except Exception as exc:
        logger.error("[CRM Automation] beat_crm_automation_sla failed: %s", exc)
        return {"error": str(exc)}


@celery_app.task(name="app.l4_agents.tasks.beat_crm_automation_timebased")
def beat_crm_automation_timebased():
    """
    Every 15 minutes: evaluate TIME_BASED automation rules against all open tickets.
    Useful for rules like "escalate if not responded within 4 hours".
    """
    try:
        from app.admin.services.crm_automation_engine import run_time_based_rules
        applied = run_time_based_rules()
        if applied:
            logger.info("[CRM Automation] TIME_BASED: %d rule applications", applied)
        return {"applied": applied}
    except Exception as exc:
        logger.error("[CRM Automation] beat_crm_automation_timebased failed: %s", exc)
        return {"error": str(exc)}


# ============================================================
# DATA RETENTION (DPDP Act §8(7))
# ============================================================

@celery_app.task(name="app.l4_agents.tasks.beat_retention_sweep")
def beat_retention_sweep():
    """
    Enforce data retention policies: anonymise expired customer PII, delete
    expired conversations, CSAT responses, PII access logs and refresh tokens.

    app/tasks/retention_sweep.py documented this schedule in its docstring but
    it was never registered, so retention deletion had never run.
    """
    if not _is_task_enabled("retention-sweep-daily"):
        return {"skipped": True}

    from app.tasks.retention_sweep import run_retention_sweep

    return run_retention_sweep()


# ============================================================
# CELERY BEAT SCHEDULE
# ============================================================

celery_app.conf.beat_schedule = {

    "poll-streams-every-5s": {
        "task":     "app.l4_agents.tasks.beat_poll_streams",
        "schedule": 5.0,   # seconds
    },

    "reclaim-idle-every-60s": {
        "task":     "app.l4_agents.tasks.beat_reclaim_idle_messages",
        "schedule": 60.0,
    },

    "refresh-risk-profiles-hourly": {
        "task":     "app.l4_agents.tasks.beat_refresh_risk_profiles",
        "schedule": crontab(minute=0),   # top of every hour
    },

    "timeout-stuck-executions-every-10m": {
        "task":     "app.l4_agents.tasks.beat_execution_plan_timeout",
        "schedule": 600.0,  # 10 minutes
    },

    "purge-stale-dedup-keys-daily": {
        "task":     "app.l4_agents.tasks.beat_purge_stale_dedup_keys",
        "schedule": crontab(hour=2, minute=0),  # 02:00 UTC daily
    },

    "flag-bad-actor-agents-4h": {
        "task":     "app.l4_agents.tasks.beat_flag_bad_actor_agents",
        "schedule": crontab(minute=0, hour="*/4"),  # every 4 hours
    },

    "fcr-checker-6h": {
        "task":     "app.l4_agents.tasks.beat_fcr_checker",
        "schedule": crontab(minute=30, hour="*/6"),  # every 6 hours at :30
    },

    "score-conversations-every-5m": {
        "task":     "app.l4_agents.tasks.beat_score_conversations",
        "schedule": 300.0,  # 5 minutes — aim for 90s latency from conversation close
    },

    "spike-detection-every-15m": {
        "task":     "app.l4_agents.tasks.beat_spike_detector",
        "schedule": 900.0,  # 15 minutes
    },

    "crm-auto-escalate-overdue-15m": {
        "task":     "app.l4_agents.tasks.beat_crm_auto_escalate",
        "schedule": 900.0,  # 15 minutes
    },

    "crm-automation-sla-every-5m": {
        "task":     "app.l4_agents.tasks.beat_crm_automation_sla",
        "schedule": 300.0,  # 5 minutes — SLA_WARNING + SLA_BREACHED triggers
    },

    "crm-automation-timebased-every-15m": {
        "task":     "app.l4_agents.tasks.beat_crm_automation_timebased",
        "schedule": 900.0,  # 15 minutes — TIME_BASED rules
    },

    "retention-sweep-daily": {
        "task":     "app.l4_agents.tasks.beat_retention_sweep",
        "schedule": crontab(hour=2, minute=30),  # 02:30 UTC daily
    },
}