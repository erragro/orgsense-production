"""
app/metrics.py
==============
Prometheus metrics registry + OpenTelemetry tracer setup.

Prometheus:
    Counters and histograms are registered once here and imported by
    routers/services that need to record observations. The /metrics
    endpoint (added to admin main.py) exposes them in the Prometheus
    text format for scraping.

OpenTelemetry:
    Configures a TracerProvider with:
    - BatchSpanProcessor for low-latency recording
    - OTLPSpanExporter if OTLP_ENDPOINT is set
    - ConsoleSpanExporter as a debug fallback when no endpoint is set
    FastAPIInstrumentor auto-instruments all routes after setup.

Usage:
    from app.metrics import (
        ingest_requests_total,
        pipeline_duration_seconds,
        record_pipeline_result,
    )

    with pipeline_duration_seconds.labels(module="ecom").time():
        result = pipeline.run(request)

    record_pipeline_result(
        module=request.module,
        status="accepted",
        priority="P2_HIGH",
    )
"""

from __future__ import annotations

import logging

from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    Info,
    generate_latest,
    CONTENT_TYPE_LATEST,
    REGISTRY,
)
from fastapi import Response

from app.config import settings

logger = logging.getLogger(__name__)


# ============================================================
# PROMETHEUS METRICS
# ============================================================

# --- Ingest pipeline ---

ingest_requests_total = Counter(
    "kirana_kart_ingest_requests_total",
    "Total Cardinal ingest requests received",
    labelnames=["org", "module", "source", "status"],
)

pipeline_duration_seconds = Histogram(
    "kirana_kart_pipeline_duration_seconds",
    "End-to-end Cardinal pipeline latency",
    labelnames=["module", "priority"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

pipeline_phase_errors_total = Counter(
    "kirana_kart_pipeline_phase_errors_total",
    "Cardinal pipeline errors by phase",
    labelnames=["phase", "error_code"],
)

# --- Worker ---

worker_tasks_total = Counter(
    "kirana_kart_worker_tasks_total",
    "Celery worker tasks processed",
    labelnames=["stream", "status"],
)

worker_task_duration_seconds = Histogram(
    "kirana_kart_worker_task_duration_seconds",
    "LLM pipeline task processing latency",
    labelnames=["stream"],
    buckets=[1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
)

worker_llm_calls_total = Counter(
    "kirana_kart_worker_llm_calls_total",
    "LLM API calls made by the worker pipeline",
    labelnames=["stage", "model", "status"],
)

# --- Vector worker ---

vector_jobs_total = Counter(
    "kirana_kart_vector_jobs_total",
    "Vectorization jobs processed",
    labelnames=["status"],
)

vector_worker_running = Gauge(
    "kirana_kart_vector_worker_running",
    "1 if the background vector worker thread is alive, 0 otherwise",
)

vector_worker_last_heartbeat = Gauge(
    "kirana_kart_vector_worker_last_heartbeat_timestamp",
    "Unix timestamp of the last vector worker heartbeat",
)

# --- DB / Redis ---

db_pool_checkedout = Gauge(
    "kirana_kart_db_pool_checked_out",
    "SQLAlchemy connections currently checked out from the pool",
)

redis_operation_errors_total = Counter(
    "kirana_kart_redis_operation_errors_total",
    "Redis operation errors (connection refused, timeout, etc.)",
    labelnames=["operation"],
)

# --- Service info ---

service_info = Info(
    "kirana_kart_service",
    "Static service metadata",
)
service_info.info({
    "name":    settings.service_name,
    "version": settings.service_version,
})


# ============================================================
# CONVENIENCE HELPERS
# ============================================================

def record_pipeline_result(
    org: str,
    module: str,
    source: str,
    status: str,   # accepted | duplicate | validation_error | system_error
    priority: str = "",
    duration_s: float | None = None,
) -> None:
    """Record a completed pipeline execution into Prometheus counters."""
    ingest_requests_total.labels(
        org=org, module=module, source=source, status=status
    ).inc()

    if duration_s is not None and priority:
        pipeline_duration_seconds.labels(
            module=module, priority=priority
        ).observe(duration_s)


def update_pool_metrics() -> None:
    """
    Refresh the db_pool_checkedout gauge.
    Call periodically (e.g. from the vector worker heartbeat).
    """
    from app.admin.db import engine
    try:
        checked_out = engine.pool.checkedout()
        db_pool_checkedout.set(checked_out)
    except Exception:
        pass


# ============================================================
# PROMETHEUS ENDPOINT HANDLER
# ============================================================

def metrics_endpoint(request=None) -> Response:
    """
    FastAPI route handler that returns Prometheus metrics.

    Register in main.py:
        from app.metrics import metrics_endpoint
        app.add_route("/metrics", metrics_endpoint)
    """
    if not settings.prometheus_enabled:
        return Response(
            content="Prometheus metrics disabled (PROMETHEUS_ENABLED=false)",
            status_code=404,
        )
    return Response(
        content=generate_latest(REGISTRY),
        media_type=CONTENT_TYPE_LATEST,
    )


# ============================================================
# OPENTELEMETRY SETUP
# ============================================================

def configure_otel(app=None, *, service_name: str | None = None) -> None:
    """
    Production-grade OpenTelemetry setup.

    Configures:
    - TracerProvider with TraceIdRatioBased sampler (OTEL_SAMPLE_RATE)
    - OTLP gRPC exporter → collector (or NoOp when no endpoint is set)
    - BatchSpanProcessor for low-overhead async export
    - Resource attributes: service.name, service.version,
      deployment.environment, host.name, service.instance.id
    - Auto-instrumentation: FastAPI, SQLAlchemy, Redis, httpx
    - Logging instrumentation: injects trace_id/span_id into every
      log record so log lines can be correlated to a trace in Jaeger

    For the Celery worker (no FastAPI app):
        configure_otel()                  # no app arg
        CeleryInstrumentor().instrument() # call separately after

    Call exactly once during startup (idempotent guard inside).
    """
    try:
        import socket as _socket

        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION
        from opentelemetry.sdk.trace.sampling import TraceIdRatioBased, ALWAYS_ON

        _svc_name = service_name or settings.service_name

        resource = Resource.create({
            SERVICE_NAME:                  _svc_name,
            SERVICE_VERSION:               settings.service_version,
            "deployment.environment":      settings.deployment_env,
            "host.name":                   _socket.gethostname(),
            "service.instance.id":         f"{_svc_name}-{_socket.gethostname()}",
        })

        # Sampler — 100% in dev, configurable fraction in prod
        sample_rate = max(0.0, min(1.0, settings.otel_sample_rate))
        sampler = ALWAYS_ON if sample_rate >= 1.0 else TraceIdRatioBased(sample_rate)

        provider = TracerProvider(resource=resource, sampler=sampler)

        if settings.otlp_endpoint:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            exporter = OTLPSpanExporter(endpoint=settings.otlp_endpoint, insecure=True)
            provider.add_span_processor(BatchSpanProcessor(
                exporter,
                max_export_batch_size=512,
                export_timeout_millis=5_000,
            ))
            logger.info(
                "OTel OTLP exporter configured | endpoint=%s | sample_rate=%s",
                settings.otlp_endpoint, sample_rate,
            )
        else:
            # No collector — spans are created and context propagates, but nothing is exported.
            # Silent: no ConsoleSpanExporter noise in logs.
            logger.info("OTel active (no OTLP_ENDPOINT — spans not exported)")
        trace.set_tracer_provider(provider)

        # ── Auto-instrumentation ──────────────────────────────────
        if app is not None:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            FastAPIInstrumentor.instrument_app(app)
            logger.info("OTel FastAPI auto-instrumentation enabled")

        # SQLAlchemy — instruments all queries automatically
        try:
            from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
            SQLAlchemyInstrumentor().instrument()
            logger.info("OTel SQLAlchemy auto-instrumentation enabled")
        except Exception as exc:
            logger.warning("OTel SQLAlchemy instrumentation skipped: %s", exc)

        # Redis — instruments all redis-py commands
        try:
            from opentelemetry.instrumentation.redis import RedisInstrumentor
            RedisInstrumentor().instrument()
            logger.info("OTel Redis auto-instrumentation enabled")
        except Exception as exc:
            logger.warning("OTel Redis instrumentation skipped: %s", exc)

        # httpx — instruments outbound HTTP calls (LLM API calls, webhooks)
        try:
            from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
            HTTPXClientInstrumentor().instrument()
            logger.info("OTel httpx auto-instrumentation enabled")
        except Exception as exc:
            logger.warning("OTel httpx instrumentation skipped: %s", exc)

        # Logging — injects trace_id + span_id into every log record
        try:
            from opentelemetry.instrumentation.logging import LoggingInstrumentor
            LoggingInstrumentor().instrument(set_logging_format=False)
            logger.info("OTel logging instrumentation enabled (trace_id/span_id injection)")
        except Exception as exc:
            logger.warning("OTel logging instrumentation skipped: %s", exc)

        logger.info(
            "OTel setup complete | service=%s | env=%s | sample_rate=%s",
            _svc_name, settings.deployment_env, sample_rate,
        )

    except ImportError as exc:
        logger.warning(
            "OpenTelemetry packages missing — tracing disabled. "
            "Run: pip install opentelemetry-sdk opentelemetry-instrumentation-fastapi "
            "opentelemetry-instrumentation-sqlalchemy opentelemetry-instrumentation-redis "
            "opentelemetry-instrumentation-httpx opentelemetry-instrumentation-logging. "
            "Error: %s", exc,
        )
