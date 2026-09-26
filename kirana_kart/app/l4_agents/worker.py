"""
app/l4_agents/worker.py
=========================
Celery Worker — Cardinal Stream Consumer

This worker:
    1. Polls four prioritised Redis Streams for dispatch messages
    2. Claims each message atomically (prevents double-processing)
    3. Fetches full ticket context from fdraw
    4. Fetches applicable rules from rule_registry
    5. Runs the 4-stage LLM pipeline:
           Stage 0 — Classification   (MODEL1: gpt-4o-mini)
           Stage 1 — Evaluation       (MODEL2: gpt-4.1)
           Stage 2 — Validation       (MODEL3: o3-mini)
           Stage 3 — Response Gen     (MODEL4: gpt-4o)
    6. Writes results to llm_output_1/2/3 and complaints
    7. Updates ticket_processing_state and cardinal_execution_plans
    8. Acknowledges the Redis Stream message on success

Stream consumption model:
    Consumer group:  cardinal_workers
    Consumer name:   worker_{hostname}_{pid}
    Streams polled (in priority order, single XREADGROUP call):
        cardinal:dispatch:P1_CRITICAL
        cardinal:dispatch:P2_HIGH
        cardinal:dispatch:P3_STANDARD
        cardinal:dispatch:P4_LOW

    Workers configured with WORKER_PRIORITY env var poll only their
    tier and below. Default: all four streams.

Celery is used for:
    - Distributed worker pool (scale horizontally)
    - Retry logic with exponential backoff
    - Task routing by priority queue
    - Dead-letter handling on max retries exceeded

Celery broker: Redis (same instance, different DB index)
    Broker URL:  redis://localhost:6379/1  (DB 1, streams on DB 0)

The Celery task wraps the stream consumer loop so that:
    - Each message becomes one Celery task execution
    - Retries are handled by Celery (not manual loop logic)
    - Failures are visible in Flower dashboard

Stage model assignments (from .env):
    Stage 0 — MODEL1 (gpt-4o-mini)   Fast classification, low cost
    Stage 1 — MODEL2 (gpt-4.1)       Evaluation with full context
    Stage 2 — MODEL3 (o3-mini)       Validation + logic checking
    Stage 3 — MODEL4 (gpt-4o)        Response generation (HITL cases)
"""

from __future__ import annotations

import logging
import os
import platform
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from celery import Celery
from dotenv import load_dotenv

from app.admin.redis_client import get_redis
from contextlib import contextmanager

@contextmanager
def _nullcontext():
    """Fallback no-op context manager used when _tracer is None."""
    yield None

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
SCHEMA      = "kirana_kart"

# Model assignments per stage
MODEL_STAGE_0 = os.getenv("MODEL1", "gpt-4o-mini")   # Classification
MODEL_STAGE_1 = os.getenv("MODEL2", "gpt-4.1")        # Evaluation
MODEL_STAGE_2 = os.getenv("MODEL3", "o3-mini")         # Validation
MODEL_STAGE_3 = os.getenv("MODEL4", "gpt-4o")          # Response generation

REDIS_URL        = os.getenv("REDIS_URL", "redis://localhost:6379/0")
CELERY_BROKER    = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
CELERY_BACKEND   = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")

# Stream names — must match phase5_dispatcher.py exactly
STREAMS = [
    "cardinal:dispatch:P1_CRITICAL",
    "cardinal:dispatch:P2_HIGH",
    "cardinal:dispatch:P3_STANDARD",
    "cardinal:dispatch:P4_LOW",
]

CONSUMER_GROUP = "cardinal_workers"
CONSUMER_NAME  = f"worker_{socket.gethostname()}_{os.getpid()}"

# How many stream messages to fetch per poll cycle
STREAM_BATCH_SIZE = 1   # One message at a time — each becomes one Celery task

# Claim idle messages older than this (ms) — reclaim from crashed workers
CLAIM_IDLE_MS = 60_000  # 60 seconds

MAX_RETRIES = 3

logger = logging.getLogger("cardinal.worker")


# ============================================================
# OPENTELEMETRY — worker bootstrap
# ============================================================

def _setup_worker_otel() -> None:
    """
    Initialise OTel for the Celery worker process.

    Called once when this module is first imported (which happens when
    Celery loads the task module). configure_otel() is idempotent, so
    repeated imports are safe.
    """
    try:
        from app.middleware.logging_middleware import configure_logging
        from app.metrics import configure_otel
        configure_logging()
        configure_otel(service_name=os.getenv("SERVICE_NAME", "kirana-kart-worker-celery"))
        from opentelemetry.instrumentation.celery import CeleryInstrumentor
        CeleryInstrumentor().instrument()
        logger.info("OTel Celery auto-instrumentation enabled")
    except Exception as exc:
        logger.warning("OTel worker setup skipped: %s", exc)


_setup_worker_otel()

# Tracer used for manual spans in the pipeline stages
try:
    from opentelemetry import trace as _otel_trace
    _tracer = _otel_trace.get_tracer("cardinal.worker", schema_url="https://opentelemetry.io/schemas/1.26.0")
except Exception:
    _tracer = None  # type: ignore[assignment]


# ============================================================
# CELERY APP
# ============================================================

celery_app = Celery(
    "cardinal_worker",
    broker=CELERY_BROKER,
    backend=CELERY_BACKEND,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,          # Ack only after task completes — prevents loss on crash
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1, # One task at a time per worker thread — prevents starvation
    task_routes={
        "app.l4_agents.worker.process_ticket": {"queue": "cardinal"},
    },
)


# ============================================================
# DB CONNECTION
# ============================================================

def _get_connection() -> psycopg2.extensions.connection:
    return pooled_connection()


# ============================================================
# STREAM CONSUMER SETUP
# ============================================================

def ensure_consumer_groups() -> None:
    """
    Create consumer groups on all four streams if they don't exist.
    Safe to call on every worker startup — XGROUP CREATE MKSTREAM
    creates the stream if it doesn't exist yet.
    Called once at worker startup before the poll loop begins.
    """
    r = get_redis()
    for stream in STREAMS:
        try:
            r.xgroup_create(
                name=stream,
                groupname=CONSUMER_GROUP,
                id="0",          # Start from beginning of stream
                mkstream=True,   # Create stream if it doesn't exist
            )
            logger.info("Consumer group created: stream=%s group=%s", stream, CONSUMER_GROUP)
        except Exception as exc:
            if "BUSYGROUP" in str(exc):
                pass  # Group already exists — normal on restart
            else:
                logger.warning("xgroup_create error for %s: %s", stream, exc)


# ============================================================
# STREAM POLL LOOP
# ============================================================

def poll_streams_once() -> int:
    """
    Read one batch of messages from all streams (priority order preserved
    because STREAMS list is ordered P1→P4).

    For each message received:
        - Dispatch as a Celery task (process_ticket.delay)
        - The Celery task handles ACK after successful processing

    Returns number of messages dispatched.
    """
    r = get_redis()
    dispatched = 0

    # Build stream dict for XREADGROUP — ">" means only undelivered messages
    stream_ids = {stream: ">" for stream in STREAMS}

    try:
        results = r.xreadgroup(
            groupname=CONSUMER_GROUP,
            consumername=CONSUMER_NAME,
            streams=stream_ids,
            count=STREAM_BATCH_SIZE,
            block=2000,   # Block up to 2 seconds if no messages — prevents tight loop
        )
    except Exception as exc:
        logger.error("xreadgroup failed: %s", exc)
        return 0

    if not results:
        return 0

    for stream_name, messages in results:
        for msg_id, fields in messages:
            # Decode bytes if needed (redis-py may return bytes)
            if isinstance(stream_name, bytes):
                stream_name = stream_name.decode()
            if isinstance(msg_id, bytes):
                msg_id = msg_id.decode()
            fields = {
                (k.decode() if isinstance(k, bytes) else k):
                (v.decode() if isinstance(v, bytes) else v)
                for k, v in fields.items()
            }

            logger.info(
                "Stream message received | stream=%s | msg_id=%s | "
                "execution_id=%s | ticket_id=%s",
                stream_name,
                msg_id,
                fields.get("execution_id", "?"),
                fields.get("ticket_id", "?"),
            )

            # Dispatch to Celery — non-blocking
            process_ticket.delay(
                stream_name=stream_name,
                msg_id=msg_id,
                fields=fields,
            )
            dispatched += 1

    return dispatched


def reclaim_idle_messages() -> int:
    """
    Reclaim messages that were delivered to a worker but never acknowledged.
    This handles crashed workers — their pending messages are re-queued.

    Called periodically (every ~60 seconds) by the poll loop.
    Returns number of messages reclaimed.
    """
    r = get_redis()
    reclaimed = 0

    for stream in STREAMS:
        try:
            # XAUTOCLAIM: reclaim messages idle > CLAIM_IDLE_MS
            # Returns (next_cursor, messages, deleted_ids)
            result = r.xautoclaim(
                name=stream,
                groupname=CONSUMER_GROUP,
                consumername=CONSUMER_NAME,
                min_idle_time=CLAIM_IDLE_MS,
                start_id="0-0",
                count=10,
            )
            messages = result[1] if result else []
            for msg_id, fields in messages:
                if isinstance(msg_id, bytes):
                    msg_id = msg_id.decode()
                fields = {
                    (k.decode() if isinstance(k, bytes) else k):
                    (v.decode() if isinstance(v, bytes) else v)
                    for k, v in fields.items()
                }
                logger.warning(
                    "Reclaiming idle message | stream=%s | msg_id=%s | "
                    "execution_id=%s",
                    stream, msg_id, fields.get("execution_id", "?"),
                )
                process_ticket.delay(
                    stream_name=stream,
                    msg_id=msg_id,
                    fields=fields,
                )
                reclaimed += 1
        except Exception as exc:
            logger.warning("xautoclaim failed for %s: %s", stream, exc)

    return reclaimed


# ============================================================
# CELERY TASK — MAIN ENTRY POINT
# ============================================================

@celery_app.task(
    name="app.l4_agents.worker.process_ticket",
    bind=True,
    max_retries=MAX_RETRIES,
    default_retry_delay=30,   # 30s base, Celery applies exponential backoff
    acks_late=True,
)
def process_ticket(
    self,
    stream_name: str,
    msg_id:      str,
    fields:      dict[str, str],
) -> dict[str, Any]:
    """
    Main Celery task. Processes one ticket through all four LLM stages.

    Args:
        stream_name: Which stream this message came from
        msg_id:      Redis Stream message ID (for ACK on completion)
        fields:      Stream message fields from Phase 5 dispatcher

    Returns:
        dict with execution_id, ticket_id, final_action_code, status

    On failure: retries up to MAX_RETRIES with exponential backoff.
    On max retries exceeded: writes to dead-letter store, ACKs message
    (to prevent infinite redelivery), marks ticket as FAILED.
    """
    execution_id = fields.get("execution_id", "unknown")
    ticket_id    = int(fields.get("ticket_id", 0))

    logger.info(
        "Task start | execution_id=%s | ticket_id=%s | stream=%s",
        execution_id, ticket_id, stream_name,
    )

    # Root span for the entire pipeline — child spans added per stage
    _span_ctx = (
        _tracer.start_as_current_span(
            "cardinal.process_ticket",
            kind=_otel_trace.SpanKind.CONSUMER,
            attributes={
                "ticket.id":       str(ticket_id),
                "execution.id":    execution_id,
                "stream.name":     stream_name,
                "ticket.module":   fields.get("module", ""),
                "ticket.priority": stream_name.split(":")[-1] if ":" in stream_name else "",
            },
        )
        if _tracer else _nullcontext()
    )

    with _span_ctx as _root_span:
      try:
        # ----------------------------------------------------------
        # Claim ticket in processing state
        # ----------------------------------------------------------
        _claim_ticket(execution_id, ticket_id)
        _set_pipeline_stage(ticket_id, "IN_PROGRESS")

        # ----------------------------------------------------------
        # Fetch full context from fdraw
        # ----------------------------------------------------------
        ticket_context = _fetch_ticket_context(ticket_id)
        if not ticket_context:
            raise WorkerError(f"ticket_id={ticket_id} not found in fdraw")
        canonical_payload = ticket_context.get("canonical_payload") or {}
        customer_context = canonical_payload.get("customer_context") or {}
        fields["order_context"]       = customer_context.get("order") or {}
        fields["risk_context"]        = customer_context.get("risk") or {}
        fields["policy_context"]      = customer_context.get("policy") or {}
        fields["customer_profile"]    = customer_context.get("customer") or {}
        fields["prior_complaints_30d"] = int(
            customer_context.get("prior_complaints_30d")
            or fields.get("prior_complaints_30d")
            or 0
        )

        # ----------------------------------------------------------
        # Fetch rules from rule_registry
        # ----------------------------------------------------------
        rules = _fetch_rules(
            policy_version=fields.get("active_policy", ""),
            module=fields.get("module", ""),
            business_line=fields.get("business_line", ""),
            fraud_segment=fields.get("fraud_risk_classification", "NORMAL"),
        )

        # ----------------------------------------------------------
        # Stage 0: Classification
        # ----------------------------------------------------------
        _update_stage_status(execution_id, ticket_id, stage=0, status="running")
        stage0_result = _run_stage_0(
            ticket_id=ticket_id,
            execution_id=execution_id,
            ticket_context=ticket_context,
            fields=fields,
        )
        _update_stage_status(execution_id, ticket_id, stage=0, status="completed")

        # ----------------------------------------------------------
        # Stage 1: Evaluation
        # ----------------------------------------------------------
        _update_stage_status(execution_id, ticket_id, stage=1, status="running")
        stage1_result = _run_stage_1(
            ticket_id=ticket_id,
            execution_id=execution_id,
            ticket_context=ticket_context,
            stage0_result=stage0_result,
            rules=rules,
            fields=fields,
        )
        _update_stage_status(execution_id, ticket_id, stage=1, status="completed")

        # ----------------------------------------------------------
        # Stage 2: Validation
        # ----------------------------------------------------------
        _update_stage_status(execution_id, ticket_id, stage=2, status="running")
        stage2_result = _run_stage_2(
            ticket_id=ticket_id,
            execution_id=execution_id,
            stage0_result=stage0_result,
            stage1_result=stage1_result,
            rules=rules,
            fields=fields,
        )
        _update_stage_status(execution_id, ticket_id, stage=2, status="completed")

        # ----------------------------------------------------------
        # Stage 3: Response generation
        #
        # HITL only  — generate a draft response for the human agent
        #              who will review and approve the monetary action.
        #
        # AUTO_RESOLVED — no response needed; ticket closes automatically.
        #
        # MANUAL_REVIEW — do NOT generate an automated response; the
        #                  agent must handle it directly (no email sent).
        # ----------------------------------------------------------
        stage3_result = None
        automation_pathway = stage2_result.get("automation_pathway", "AUTO_RESOLVED")

        if automation_pathway == "HITL":
            _update_stage_status(execution_id, ticket_id, stage=3, status="running")
            stage3_result = _run_stage_3(
                ticket_id=ticket_id,
                execution_id=execution_id,
                stage0_result=stage0_result,
                stage1_result=stage1_result,
                stage2_result=stage2_result,
                fields=fields,
            )
            _update_stage_status(execution_id, ticket_id, stage=3, status="completed")
        else:
            # AUTO_RESOLVED or MANUAL_REVIEW — skip response generation
            _update_stage_status(execution_id, ticket_id, stage=3, status="completed")

        # ----------------------------------------------------------
        # Write complaint record
        # ----------------------------------------------------------
        _write_complaint(
            ticket_id=ticket_id,
            execution_id=execution_id,
            fields=fields,
            stage0=stage0_result,
            stage1=stage1_result,
            stage2=stage2_result,
        )

        # ----------------------------------------------------------
        # Mark execution plan complete
        # ----------------------------------------------------------
        _complete_execution_plan(execution_id, status="completed")
        _set_pipeline_stage(ticket_id, "COMPLETED")

        # ----------------------------------------------------------
        # ACK the stream message — processing confirmed complete
        # ----------------------------------------------------------
        _ack_message(stream_name, msg_id)

        # ----------------------------------------------------------
        # CRM enqueue (non-fatal) — HITL / MANUAL_REVIEW tickets
        # ----------------------------------------------------------
        if automation_pathway in ("HITL", "MANUAL_REVIEW"):
            try:
                from app.admin.services.crm_service import enqueue_ticket
                _queue_type_map = {
                    "MANUAL_REVIEW": "MANUAL_REVIEW",
                    "HITL": fields.get("recommended_queue", "STANDARD_REVIEW"),
                }
                _priority_map = {
                    "ESCALATION_QUEUE": 1,
                    "SLA_BREACH_REVIEW": 2,
                    "SENIOR_REVIEW": 2,
                }
                _qt = _queue_type_map.get(automation_pathway, "STANDARD_REVIEW")
                if _qt not in ("STANDARD_REVIEW","SENIOR_REVIEW","SLA_BREACH_REVIEW","ESCALATION_QUEUE","MANUAL_REVIEW"):
                    _qt = "STANDARD_REVIEW"
                _customer_profile = (fields.get("customer_profile") or {})
                enqueue_ticket(
                    ticket_id=ticket_id,
                    automation_pathway=automation_pathway,
                    queue_type=_qt,
                    ai_action_code=stage2_result.get("final_action_code"),
                    ai_refund_amount=stage2_result.get("final_refund_amount"),
                    ai_reasoning=stage2_result.get("detailed_reasoning"),
                    ai_confidence=stage2_result.get("overall_confidence"),
                    ai_discrepancy_details=stage2_result.get("discrepancy_details"),
                    ai_fraud_segment=(fields.get("greedy_classification") or stage2_result.get("greedy_classification")),
                    customer_id=str(fields.get("customer_id", "")),
                    order_id=str(fields.get("order_id", "")),
                    cx_email=fields.get("cx_email"),
                    customer_segment=_customer_profile.get("segment"),
                    subject=fields.get("subject"),
                    priority=_priority_map.get(_qt, 3),
                )
                logger.info(
                    "CRM enqueue success | ticket_id=%s | pathway=%s | queue=%s",
                    ticket_id, automation_pathway, _qt,
                )
            except Exception as _crm_exc:
                logger.error(
                    "CRM enqueue failed (non-fatal) | ticket_id=%s | %s",
                    ticket_id, _crm_exc,
                )

        final_action = stage2_result.get("final_action_code", "UNKNOWN")
        logger.info(
            "Task complete | execution_id=%s | ticket_id=%s | action=%s",
            execution_id, ticket_id, final_action,
        )
        if _root_span:
            _root_span.set_attribute("ticket.final_action", final_action)
            _root_span.set_attribute("ticket.automation_pathway", automation_pathway)
            _root_span.set_attribute("ticket.ai_confidence", str(
                stage2_result.get("overall_confidence", "")))

        return {
            "execution_id":    execution_id,
            "ticket_id":       ticket_id,
            "final_action_code": final_action,
            "status":          "completed",
        }

      except WorkerError as exc:
        logger.error(
            "WorkerError | execution_id=%s | ticket_id=%s | error=%s",
            execution_id, ticket_id, exc,
        )
        if _root_span:
            _root_span.record_exception(exc)
            from opentelemetry.trace import StatusCode
            _root_span.set_status(StatusCode.ERROR, str(exc))
        _handle_failure(execution_id, ticket_id, stream_name, msg_id, str(exc), self.request.retries)
        raise self.retry(exc=exc)

      except Exception as exc:
        logger.exception(
            "Unexpected error | execution_id=%s | ticket_id=%s | error=%s",
            execution_id, ticket_id, exc,
        )
        if _root_span:
            _root_span.record_exception(exc)
            from opentelemetry.trace import StatusCode
            _root_span.set_status(StatusCode.ERROR, str(exc))
        _handle_failure(execution_id, ticket_id, stream_name, msg_id, str(exc), self.request.retries)
        raise self.retry(exc=exc)


# ============================================================
# STAGE RUNNERS — STUBS
# Each stage is implemented in its own module under l4_agents/
# These stubs define the contract: inputs, output shape, DB writes.
# ============================================================

def _run_stage_0(
    ticket_id:      int,
    execution_id:   str,
    ticket_context: dict,
    fields:         dict,
) -> dict:
    """
    Stage 0: Classification
    Model: MODEL1 (gpt-4o-mini)

    Input:  ticket subject + description + order context
    Output: issue_type_l1, issue_type_l2, confidence, image_required
    Writes: llm_output_1 row

    Stub — replace with:
        from app.l4_agents.ecommerce.stage0_classifier import run
        return run(ticket_id, execution_id, ticket_context, fields)
    """
    from app.l4_agents.ecommerce.stage0_classifier import run as stage0_run

    logger.info("Stage 0 | ticket_id=%s | model=%s", ticket_id, MODEL_STAGE_0)
    _s0_ctx = (
        _tracer.start_as_current_span(
            "cardinal.stage0.classification",
            attributes={"ticket.id": str(ticket_id), "stage.model": MODEL_STAGE_0},
        ) if _tracer else _nullcontext()
    )
    with _s0_ctx as _s0_span:
        stage0 = stage0_run(ticket_id, execution_id, ticket_context, fields)
        if _s0_span:
            _s0_span.set_attribute("stage.issue_type_l1", str(stage0.get("issue_type_l1", "")))
            _s0_span.set_attribute("stage.issue_type_l2", str(stage0.get("issue_type_l2", "")))
            _s0_span.set_attribute("stage.confidence",    str(stage0.get("confidence", "")))
            _s0_span.set_attribute("stage.taxonomy_status", str(stage0.get("taxonomy_status", "")))

    result = {
        "llm_output_1_id": None,
        "issue_type_l1":   stage0.get("issue_type_l1"),
        "issue_type_l2":   stage0.get("issue_type_l2"),
        "confidence":      stage0.get("confidence", 0.5),
        "image_required":  stage0.get("image_required", False),
        "reasoning":       stage0.get("reasoning", ""),
        "raw_response":    stage0.get("raw_response", "LLM"),
        # 'mapped' / 'unmapped' against the live taxonomy, or 'unavailable'.
        "taxonomy_status": stage0.get("taxonomy_status", "unavailable"),
        "issue_label":     stage0.get("issue_label"),
        "model_issue":     stage0.get("model_issue"),
    }

    # Write stub row to llm_output_1
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.llm_output_1 (
                        ticket_id, execution_id, order_id,
                        issue_type_l1, issue_type_l2,
                        confidence_entailment, image_required,
                        reasoning, raw_response, status,
                        pipeline_status, execution_type
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 1, 'in_progress', 'single')
                    ON CONFLICT (ticket_id, execution_id) DO UPDATE SET
                        order_id               = EXCLUDED.order_id,
                        issue_type_l1          = EXCLUDED.issue_type_l1,
                        issue_type_l2          = EXCLUDED.issue_type_l2,
                        confidence_entailment  = EXCLUDED.confidence_entailment,
                        image_required         = EXCLUDED.image_required,
                        reasoning              = EXCLUDED.reasoning,
                        raw_response           = EXCLUDED.raw_response,
                        status                 = EXCLUDED.status,
                        pipeline_status        = EXCLUDED.pipeline_status,
                        execution_type         = EXCLUDED.execution_type,
                        updated_at             = CURRENT_TIMESTAMP
                    RETURNING id
                    """,
                    (
                        ticket_id,
                        execution_id,
                        ticket_context.get("order_id"),
                        result["issue_type_l1"],
                        result["issue_type_l2"],
                        result["confidence"],
                        result["image_required"],
                        result["reasoning"],
                        str(result["raw_response"]),
                    ),
                )
                row = cur.fetchone()
                result["llm_output_1_id"] = row[0] if row else None
    finally:
        conn.close()

    return result


def _run_stage_1(
    ticket_id:      int,
    execution_id:   str,
    ticket_context: dict,
    stage0_result:  dict,
    rules:          list,
    fields:         dict,
) -> dict:
    """
    Stage 1: Evaluation
    Model: MODEL2 (gpt-4.1)

    Input:  stage0 classification + customer context + rules
    Output: action_code, calculated_gratification, fraud_segment, greedy_classification
    Writes: llm_output_2 row

    Stub — replace with:
        from app.l4_agents.ecommerce.stage1_evaluator import run
        return run(ticket_id, execution_id, ticket_context, stage0_result, rules, fields)
    """
    from app.l4_agents.ecommerce.stage1_evaluator import run as stage1_run

    logger.info("Stage 1 | ticket_id=%s | model=%s", ticket_id, MODEL_STAGE_1)
    _s1_ctx = (
        _tracer.start_as_current_span(
            "cardinal.stage1.evaluation",
            attributes={"ticket.id": str(ticket_id), "stage.model": MODEL_STAGE_1},
        ) if _tracer else _nullcontext()
    )
    with _s1_ctx as _s1_span:
        stage1 = stage1_run(ticket_id, execution_id, ticket_context, stage0_result, rules, fields)
        if _s1_span:
            _s1_span.set_attribute("stage.action_code",    str(stage1.get("action_code", "")))
            _s1_span.set_attribute("stage.fraud_segment",  str(stage1.get("fraud_segment", "")))
            _s1_span.set_attribute("stage.greedy",         str(stage1.get("greedy_classification", "")))

    result = {
        "llm_output_2_id":        None,
        "action_code":            stage1.get("action_code", "REFUND_PARTIAL"),
        "calculated_gratification": stage1.get("calculated_gratification", 0.0),
        "fraud_segment":          stage1.get("fraud_segment", "NORMAL"),
        "value_segment":          stage1.get("value_segment"),
        "standard_logic_passed":  stage1.get("standard_logic_passed"),
        "lifetime_igcc_check":    stage1.get("lifetime_igcc_check"),
        "exceptions_60d_check":   stage1.get("exceptions_60d_check"),
        "igcc_history_check":     stage1.get("igcc_history_check"),
        "same_issue_check":       stage1.get("same_issue_check"),
        "aon_bod_eligible":       stage1.get("aon_bod_eligible"),
        "super_subscriber":       stage1.get("super_subscriber"),
        "hrx_applicable":         stage1.get("hrx_applicable"),
        "hrx_passed":             stage1.get("hrx_passed"),
        "greedy_check_applicable": stage1.get("greedy_check_applicable"),
        "greedy_signals_count":   stage1.get("greedy_signals_count"),
        "greedy_classification":  stage1.get("greedy_classification", "NORMAL"),
        "sla_check_applicable":   stage1.get("sla_check_applicable"),
        "sla_breach":             stage1.get("sla_breach"),
        "delivery_delay_minutes": stage1.get("delivery_delay_minutes"),
        "multiplier":             stage1.get("multiplier"),
        "order_value":            stage1.get("order_value"),
        "cap_applied":            stage1.get("cap_applied"),
        "overall_confidence":     stage1.get("overall_confidence"),
        "issue_confidence":       stage1.get("issue_confidence"),
        "evaluation_confidence":  stage1.get("evaluation_confidence"),
        "action_confidence":      stage1.get("action_confidence"),
        "reasoning":              stage1.get("reasoning", ""),
    }

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.llm_output_2 (
                        ticket_id, execution_id, order_id,
                        llm_output_1_id,
                        issue_type_l1_original, issue_type_l2_original,
                        fraud_segment, value_segment,
                        standard_logic_passed, lifetime_igcc_check, exceptions_60d_check,
                        igcc_history_check, same_issue_check, aon_bod_eligible,
                        super_subscriber, hrx_applicable, hrx_passed,
                        greedy_check_applicable, greedy_signals_count, greedy_classification,
                        sla_check_applicable, sla_breach, delivery_delay_minutes,
                        multiplier, order_value, calculated_gratification,
                        capped_gratification, cap_applied,
                        action_code, overall_confidence,
                        issue_confidence, evaluation_confidence, action_confidence,
                        decision_reasoning
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (ticket_id, execution_id) DO UPDATE SET
                        order_id                   = EXCLUDED.order_id,
                        llm_output_1_id             = EXCLUDED.llm_output_1_id,
                        issue_type_l1_original      = EXCLUDED.issue_type_l1_original,
                        issue_type_l2_original      = EXCLUDED.issue_type_l2_original,
                        fraud_segment               = EXCLUDED.fraud_segment,
                        value_segment               = EXCLUDED.value_segment,
                        standard_logic_passed       = EXCLUDED.standard_logic_passed,
                        lifetime_igcc_check         = EXCLUDED.lifetime_igcc_check,
                        exceptions_60d_check        = EXCLUDED.exceptions_60d_check,
                        igcc_history_check          = EXCLUDED.igcc_history_check,
                        same_issue_check            = EXCLUDED.same_issue_check,
                        aon_bod_eligible            = EXCLUDED.aon_bod_eligible,
                        super_subscriber            = EXCLUDED.super_subscriber,
                        hrx_applicable              = EXCLUDED.hrx_applicable,
                        hrx_passed                  = EXCLUDED.hrx_passed,
                        greedy_check_applicable     = EXCLUDED.greedy_check_applicable,
                        greedy_signals_count        = EXCLUDED.greedy_signals_count,
                        greedy_classification       = EXCLUDED.greedy_classification,
                        sla_check_applicable        = EXCLUDED.sla_check_applicable,
                        sla_breach                  = EXCLUDED.sla_breach,
                        delivery_delay_minutes      = EXCLUDED.delivery_delay_minutes,
                        multiplier                  = EXCLUDED.multiplier,
                        order_value                 = EXCLUDED.order_value,
                        calculated_gratification    = EXCLUDED.calculated_gratification,
                        capped_gratification        = EXCLUDED.capped_gratification,
                        cap_applied                 = EXCLUDED.cap_applied,
                        action_code                 = EXCLUDED.action_code,
                        overall_confidence          = EXCLUDED.overall_confidence,
                        issue_confidence            = EXCLUDED.issue_confidence,
                        evaluation_confidence       = EXCLUDED.evaluation_confidence,
                        action_confidence           = EXCLUDED.action_confidence,
                        decision_reasoning          = EXCLUDED.decision_reasoning,
                        updated_at                  = CURRENT_TIMESTAMP
                    RETURNING id
                    """,
                    (
                        ticket_id,
                        execution_id,
                        ticket_context.get("order_id"),
                        stage0_result.get("llm_output_1_id"),
                        stage0_result.get("issue_type_l1"),
                        stage0_result.get("issue_type_l2"),
                        result["fraud_segment"],
                        result.get("value_segment"),
                        result.get("standard_logic_passed"),
                        result.get("lifetime_igcc_check"),
                        result.get("exceptions_60d_check"),
                        result.get("igcc_history_check"),
                        result.get("same_issue_check"),
                        result.get("aon_bod_eligible"),
                        result.get("super_subscriber"),
                        result.get("hrx_applicable"),
                        result.get("hrx_passed"),
                        result.get("greedy_check_applicable"),
                        result.get("greedy_signals_count"),
                        result["greedy_classification"],
                        result.get("sla_check_applicable"),
                        result.get("sla_breach"),
                        result.get("delivery_delay_minutes"),
                        result.get("multiplier"),
                        result.get("order_value"),
                        result.get("calculated_gratification"),
                        result.get("calculated_gratification"),
                        result.get("cap_applied"),
                        result["action_code"],
                        result.get("overall_confidence"),
                        result.get("issue_confidence"),
                        result.get("evaluation_confidence"),
                        result.get("action_confidence"),
                        result.get("reasoning"),
                    ),
                )
                row = cur.fetchone()
                result["llm_output_2_id"] = row[0] if row else None
    finally:
        conn.close()

    return result


def _run_stage_2(
    ticket_id:     int,
    execution_id:  str,
    stage0_result: dict,
    stage1_result: dict,
    rules:         list,
    fields:        dict,
) -> dict:
    """
    Stage 2: Validation
    Model: MODEL3 (o3-mini)

    Input:  stage1 evaluation + rules — validates logic, caps, fraud checks
    Output: final_action_code, final_refund_amount, validation_status, requires_human_review
    Writes: llm_output_3 row

    Stub — replace with:
        from app.l4_agents.ecommerce.stage2_validator import run
        return run(ticket_id, execution_id, stage0_result, stage1_result, rules, fields)
    """
    from app.l4_agents.ecommerce.stage2_validator import run as stage2_run

    logger.info("Stage 2 | ticket_id=%s | model=%s", ticket_id, MODEL_STAGE_2)
    _s2_ctx = (
        _tracer.start_as_current_span(
            "cardinal.stage2.validation",
            attributes={"ticket.id": str(ticket_id), "stage.model": MODEL_STAGE_2},
        ) if _tracer else _nullcontext()
    )
    with _s2_ctx as _s2_span:
        stage2 = stage2_run(ticket_id, execution_id, stage0_result, stage1_result, rules, fields)
        if _s2_span:
            _s2_span.set_attribute("stage.final_action",   str(stage2.get("final_action_code", "")))
            _s2_span.set_attribute("stage.pathway",        str(stage2.get("automation_pathway", "")))
            _s2_span.set_attribute("stage.validation",     str(stage2.get("validation_status", "")))
            rule = stage2.get("rule_decision") or {}
            _s2_span.set_attribute("rule.mode",    str(rule.get("mode", "")))
            _s2_span.set_attribute("rule.id",      str(rule.get("rule_id") or ""))
            _s2_span.set_attribute("rule.applied", bool(rule.get("applied")))

    result = {
        "llm_output_3_id":        None,
        "final_action_code":      stage2.get("final_action_code", stage1_result.get("action_code", "REFUND_PARTIAL")),
        "final_refund_amount":    stage2.get("final_refund_amount", stage1_result.get("calculated_gratification", 0.0)),
        "validation_status":      stage2.get("validation_status", "PASSED"),
        "requires_human_review":  stage2.get("requires_human_review", False),
        "discrepancy_detected":   stage2.get("discrepancy_detected", False),
        "reasoning":              stage2.get("reasoning", ""),
        "automation_pathway":     stage2.get("automation_pathway", "AUTO_RESOLVED"),
        "rule_decision":          stage2.get("rule_decision"),
    }

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.llm_output_3 (
                        ticket_id, execution_id, order_id,
                        llm_output_2_id,
                        final_action_code,
                        final_refund_amount,
                        logic_validation_status,
                        validated_calculated_gratification,
                        automation_pathway,
                        validation_standard_logic,
                        validation_lifetime_igcc,
                        validation_exceptions_60d,
                        validation_igcc_history,
                        validation_same_issue,
                        validation_greedy_check,
                        validation_multiplier,
                        validation_cap,
                        validated_greedy_signals,
                        validated_greedy_classification,
                        discrepancy_detected,
                        discrepancy_count,
                        discrepancy_details,
                        override_applied,
                        override_reason,
                        override_type,
                        llm_overall_accuracy,
                        detailed_reasoning,
                        policy_version,
                        rule_decision
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (ticket_id, execution_id) DO UPDATE SET
                        order_id                           = EXCLUDED.order_id,
                        llm_output_2_id                    = EXCLUDED.llm_output_2_id,
                        final_action_code                  = EXCLUDED.final_action_code,
                        final_refund_amount                = EXCLUDED.final_refund_amount,
                        logic_validation_status            = EXCLUDED.logic_validation_status,
                        validated_calculated_gratification = EXCLUDED.validated_calculated_gratification,
                        automation_pathway                 = EXCLUDED.automation_pathway,
                        validation_standard_logic          = EXCLUDED.validation_standard_logic,
                        validation_lifetime_igcc           = EXCLUDED.validation_lifetime_igcc,
                        validation_exceptions_60d          = EXCLUDED.validation_exceptions_60d,
                        validation_igcc_history            = EXCLUDED.validation_igcc_history,
                        validation_same_issue              = EXCLUDED.validation_same_issue,
                        validation_greedy_check            = EXCLUDED.validation_greedy_check,
                        validation_multiplier              = EXCLUDED.validation_multiplier,
                        validation_cap                     = EXCLUDED.validation_cap,
                        validated_greedy_signals           = EXCLUDED.validated_greedy_signals,
                        validated_greedy_classification    = EXCLUDED.validated_greedy_classification,
                        discrepancy_detected               = EXCLUDED.discrepancy_detected,
                        discrepancy_count                  = EXCLUDED.discrepancy_count,
                        discrepancy_details                = EXCLUDED.discrepancy_details,
                        override_applied                   = EXCLUDED.override_applied,
                        override_reason                    = EXCLUDED.override_reason,
                        override_type                      = EXCLUDED.override_type,
                        llm_overall_accuracy               = EXCLUDED.llm_overall_accuracy,
                        detailed_reasoning                 = EXCLUDED.detailed_reasoning,
                        policy_version                     = EXCLUDED.policy_version,
                        rule_decision                      = EXCLUDED.rule_decision,
                        updated_at                         = CURRENT_TIMESTAMP
                    RETURNING id
                    """,
                    (
                        ticket_id,
                        execution_id,
                        None,
                        stage1_result.get("llm_output_2_id"),
                        result["final_action_code"],
                        result["final_refund_amount"],
                        result["validation_status"],
                        result["final_refund_amount"],
                        result["automation_pathway"],
                        stage2.get("validation_standard_logic"),
                        stage2.get("validation_lifetime_igcc"),
                        stage2.get("validation_exceptions_60d"),
                        stage2.get("validation_igcc_history"),
                        stage2.get("validation_same_issue"),
                        stage2.get("validation_greedy_check"),
                        stage2.get("validation_multiplier"),
                        stage2.get("validation_cap"),
                        stage2.get("validated_greedy_signals"),
                        stage2.get("validated_greedy_classification"),
                        stage2.get("discrepancy_detected", False),
                        stage2.get("discrepancy_count", 0),
                        stage2.get("discrepancy_details"),
                        stage2.get("override_applied", False),
                        stage2.get("override_reason"),
                        stage2.get("override_type"),
                        stage2.get("llm_overall_accuracy"),
                        stage2.get("reasoning"),
                        fields.get("active_policy") or "",
                        psycopg2.extras.Json(stage2["rule_decision"]) if stage2.get("rule_decision") else None,
                    ),
                )
                row = cur.fetchone()
                result["llm_output_3_id"] = row[0] if row else None
    finally:
        conn.close()

    return result


def _run_stage_3(
    ticket_id:     int,
    execution_id:  str,
    stage0_result: dict,
    stage1_result: dict,
    stage2_result: dict,
    fields:        dict,
) -> dict:
    """
    Stage 3: Response Generation
    Model: MODEL4 (gpt-4o)

    Only runs when Stage 2 sets requires_human_review=True.
    Generates the customer-facing response draft for the HITL agent.

    Stub — replace with:
        from app.l4_agents.ecommerce.stage3_responder import run
        return run(...)
    """
    from app.l4_agents.ecommerce.stage3_responder import run as stage3_run

    logger.info("Stage 3 | ticket_id=%s | model=%s", ticket_id, MODEL_STAGE_3)
    _s3_ctx = (
        _tracer.start_as_current_span(
            "cardinal.stage3.response_generation",
            attributes={"ticket.id": str(ticket_id), "stage.model": MODEL_STAGE_3},
        ) if _tracer else _nullcontext()
    )
    with _s3_ctx:
        return stage3_run(ticket_id, execution_id, stage0_result, stage1_result, stage2_result, fields)


# ============================================================
# CONTEXT + RULES FETCHERS
# ============================================================

def _fetch_ticket_context(ticket_id: int) -> Optional[dict]:
    """
    Fetch the full fdraw row including canonical_payload (with customer_context).
    Returns None if ticket not found.
    """
    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT
                    ticket_id, cx_email, subject, description,
                    module, source, thread_id,
                    canonical_payload, pipeline_stage
                FROM {SCHEMA}.fdraw
                WHERE ticket_id = %s
                LIMIT 1
                """,
                (ticket_id,),
            )
            row = cur.fetchone()
        if not row:
            return None
        data = dict(row)
        canonical_payload = data.get("canonical_payload") or {}
        data["order_id"] = canonical_payload.get("order_id") or canonical_payload.get("raw_payload", {}).get("order_id")
        return data
    except psycopg2.Error as exc:
        logger.error("Failed to fetch ticket context for ticket_id=%s: %s", ticket_id, exc)
        return None
    finally:
        conn.close()


def _fetch_rules(
    policy_version: str,
    module:         str,
    business_line:  str,
    fraud_segment:  str,
) -> list[dict]:
    """
    Fetch applicable rules from rule_registry for this ticket.
    Filters by policy_version only — rules are cross-cutting business policies
    not tied to the ticket's lowercase module label ("delivery", "quality", etc.).
    The rule_registry module_name is a human-readable category name used inside
    the KB pipeline, not a ticket-module selector.
    Returns rules ordered by priority ASC (lower number = higher priority),
    with every field app.l4_agents.rule_engine evaluates.
    """
    if not policy_version:
        logger.warning("Cannot fetch rules: policy_version missing")
        return []

    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT
                    r.rule_id, r.rule_type, r.priority, r.rule_scope,
                    r.filters, r.numeric_constraints, r.flags,
                    r.conditions, r.action_id, r.action_payload,
                    r.issue_type_l1, r.issue_type_l2,
                    r.customer_segment, r.fraud_segment, r.business_line,
                    r.min_order_value, r.max_order_value,
                    r.min_repeat_count, r.max_repeat_count,
                    r.sla_breach_required, r.evidence_required,
                    r.deterministic, r.overrideable,
                    r.module_name,
                    m.action_code_id
                FROM {SCHEMA}.rule_registry r
                LEFT JOIN {SCHEMA}.master_action_codes m ON m.id = r.action_id
                WHERE r.policy_version = %s
                AND   (LOWER(r.business_line) = LOWER(%s) OR r.business_line IS NULL)
                ORDER BY r.priority ASC, r.rule_id ASC
                """,
                (policy_version, business_line),
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]
    except psycopg2.Error as exc:
        logger.error("Failed to fetch rules: %s", exc)
        return []
    finally:
        conn.close()


# ============================================================
# STATE MANAGEMENT
# ============================================================

def _claim_ticket(execution_id: str, ticket_id: int) -> None:
    """
    Atomically mark this ticket as claimed by this worker.
    Updates ticket_processing_state and cardinal_execution_plans.
    """
    now = datetime.now(timezone.utc)
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.ticket_processing_state
                    SET
                        claimed_by           = %s,
                        claimed_at           = %s,
                        processing_started_at = %s
                    WHERE execution_id = %s
                    AND   ticket_id    = %s
                    """,
                    (CONSUMER_NAME, now, now, execution_id, ticket_id),
                )
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.cardinal_execution_plans
                    SET status     = 'processing',
                        started_at = %s
                    WHERE execution_id = %s
                    """,
                    (now, execution_id),
                )
    except psycopg2.Error as exc:
        logger.warning("Claim update failed for execution_id=%s: %s", execution_id, exc)
    finally:
        conn.close()


def _update_stage_status(
    execution_id: str,
    ticket_id:    int,
    stage:        int,
    status:       str,   # running | completed | failed
) -> None:
    """Update the stage_N_status column and current_stage in ticket_processing_state."""
    now = datetime.now(timezone.utc)
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                completed_col = f"stage_{stage}_completed_at"
                status_col    = f"stage_{stage}_status"

                if status == "completed":
                    cur.execute(
                        f"""
                        UPDATE {SCHEMA}.ticket_processing_state
                        SET {status_col} = %s,
                            {completed_col} = %s,
                            current_stage = %s
                        WHERE execution_id = %s AND ticket_id = %s
                        """,
                        (status, now, stage + 1, execution_id, ticket_id),
                    )
                else:
                    cur.execute(
                        f"""
                        UPDATE {SCHEMA}.ticket_processing_state
                        SET {status_col} = %s
                        WHERE execution_id = %s AND ticket_id = %s
                        """,
                        (status, execution_id, ticket_id),
                    )
    except psycopg2.Error as exc:
        logger.warning(
            "Stage status update failed | stage=%s | execution_id=%s: %s",
            stage, execution_id, exc,
        )
    finally:
        conn.close()


def _complete_execution_plan(execution_id: str, status: str = "completed") -> None:
    """Mark the execution plan as completed/failed with timestamp."""
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.cardinal_execution_plans
                    SET status       = %s,
                        completed_at = %s
                    WHERE execution_id = %s
                    """,
                    (status, datetime.now(timezone.utc), execution_id),
                )
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.ticket_processing_state
                    SET processing_completed_at = %s
                    WHERE execution_id = %s
                    """,
                    (datetime.now(timezone.utc), execution_id),
                )
    except psycopg2.Error as exc:
        logger.warning("Execution plan completion failed for %s: %s", execution_id, exc)
    finally:
        conn.close()


def _set_pipeline_stage(ticket_id: int, stage: str) -> None:
    """Update fdraw.pipeline_stage for live UI status."""
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.fdraw
                    SET pipeline_stage = %s
                    WHERE ticket_id = %s
                    """,
                    (stage, ticket_id),
                )
    except psycopg2.Error as exc:
        logger.warning("Pipeline stage update failed for ticket_id=%s: %s", ticket_id, exc)
    finally:
        conn.close()


def _write_complaint(
    ticket_id:    int,
    execution_id: str,
    fields:       dict,
    stage0:       dict,
    stage1:       dict,
    stage2:       dict,
) -> None:
    """
    Write the complaints table row with the final resolution.
    This is the authoritative record of what was decided for this ticket.
    """
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.complaints (
                        ticket_id, execution_id,
                        customer_id, channel,
                        issue_type_l1, issue_type_l2,
                        escalation_group,
                        action_code, refund_amount,
                        resolution_status,
                        fraud_segment,
                        kb_version_used,
                        raised_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        ticket_id,
                        execution_id,
                        fields.get("customer_id") or None,
                        fields.get("channel", "email"),
                        stage0.get("issue_type_l1"),
                        stage0.get("issue_type_l2"),
                        fields.get("escalation_group", "STANDARD"),
                        stage2.get("final_action_code"),
                        stage2.get("final_refund_amount"),
                        {
                            "AUTO_RESOLVED": "resolved",
                            "HITL":          "pending_review",
                            "MANUAL_REVIEW": "manual_review",
                        }.get(stage2.get("automation_pathway", "AUTO_RESOLVED"), "pending_review"),
                        stage1.get("fraud_segment", "NORMAL"),
                        fields.get("active_policy"),
                        datetime.now(timezone.utc),
                    ),
                )
    except psycopg2.Error as exc:
        logger.error("complaints write failed for ticket_id=%s: %s", ticket_id, exc)
    finally:
        conn.close()


def _handle_failure(
    execution_id: str,
    ticket_id:    int,
    stream_name:  str,
    msg_id:       str,
    error:        str,
    retry_count:  int,
) -> None:
    """
    On task failure: update ticket state with error message.
    On max retries exceeded: ACK the message to prevent infinite loop,
    mark execution as failed, write to dead_letter_store.
    """
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {SCHEMA}.ticket_processing_state
                    SET error_message = %s,
                        retry_count   = %s
                    WHERE execution_id = %s AND ticket_id = %s
                    """,
                    (error[:500], retry_count, execution_id, ticket_id),
                )
    except psycopg2.Error as exc:
        logger.warning("Failed to write error state: %s", exc)
    finally:
        conn.close()

    if retry_count >= MAX_RETRIES:
        logger.error(
            "Max retries exceeded | execution_id=%s | ticket_id=%s — "
            "ACKing and marking failed",
            execution_id, ticket_id,
        )
        _complete_execution_plan(execution_id, status="failed")
        _set_pipeline_stage(ticket_id, "FAILED")
        _ack_message(stream_name, msg_id)   # ACK to stop redelivery


# ============================================================
# STREAM ACK
# ============================================================

def _ack_message(stream_name: str, msg_id: str) -> None:
    """
    Acknowledge a Redis Stream message — removes it from the
    consumer group's pending entries list (PEL).
    Called only after successful processing or on max retries exceeded.
    """
    try:
        r = get_redis()
        r.xack(stream_name, CONSUMER_GROUP, msg_id)
        logger.debug("ACK | stream=%s | msg_id=%s", stream_name, msg_id)
    except Exception as exc:
        logger.error("XACK failed for msg_id=%s: %s", msg_id, exc)


# ============================================================
# EXCEPTION
# ============================================================

class WorkerError(Exception):
    """Raised for recoverable worker-level errors that should trigger retry."""
    pass


# ============================================================
# WORKER ENTRYPOINT
# ============================================================

if __name__ == "__main__":
    """
    Direct poll loop mode — alternative to Celery for single-process
    development and debugging.

    Usage:  python -m app.l4_agents.worker

    For production use Celery:
        celery -A app.l4_agents.worker.celery_app worker \
            --loglevel=info --concurrency=4 --queues=cardinal
    """
    logging.basicConfig(level=logging.INFO)
    logger.info("Starting Cardinal stream consumer | consumer=%s", CONSUMER_NAME)

    ensure_consumer_groups()

    last_reclaim = time.time()

    while True:
        dispatched = poll_streams_once()
        if dispatched:
            logger.info("Dispatched %d task(s) to Celery", dispatched)

        # Reclaim idle messages every 60 seconds
        if time.time() - last_reclaim > 60:
            reclaimed = reclaim_idle_messages()
            if reclaimed:
                logger.info("Reclaimed %d idle message(s)", reclaimed)
            last_reclaim = time.time()
