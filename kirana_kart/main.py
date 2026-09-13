"""
main.py — Cardinal Ingest Plane
=================================
FastAPI application for the Cardinal ingestion pipeline.

This is a SEPARATE service from the governance/admin plane
(app/admin/main.py). They run as independent processes:

    Governance plane:  uvicorn app.admin.main:app --port 8001
    Cardinal plane:    uvicorn main:app --port 8000

Why separate:
    The governance plane manages KB compilation, vectorisation,
    policy publishing, and shadow testing — long-running admin
    operations that should not share a process with the
    high-throughput ingest path.

    The Cardinal ingest plane handles real-time ticket ingestion.
    It must stay lean, fast, and isolated from admin operations.

Routes registered:
    POST /cardinal/ingest   — main ingest endpoint (phase1→5 pipeline)
    GET  /health            — liveness probe
    GET  /system-status     — DB + Redis connectivity check
"""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.config import settings

from app.middleware.logging_middleware import configure_logging, CorrelationIdMiddleware
from app.metrics import configure_otel, metrics_endpoint

logger = logging.getLogger("kirana_kart.ingest")

# ----------------------------------------------------------------
# LIFESPAN — startup / shutdown hooks
# ----------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.schema import verify_schema
    verify_schema()
    logger.info("Cardinal ingest plane starting")
    yield
    logger.info("Cardinal ingest plane shutting down")


# ----------------------------------------------------------------
# OBSERVABILITY — before app creation so FastAPIInstrumentor wraps
# the ASGI stack before the middleware stack is frozen.
# ----------------------------------------------------------------

configure_logging()

# ----------------------------------------------------------------
# APP
# ----------------------------------------------------------------

app = FastAPI(
    title="OrgIntelligence — Cardinal Ingest Plane",
    version="1.0.0",
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
    lifespan=lifespan,
)

# CORS for local UI access
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(CorrelationIdMiddleware)

# OTel — after app + middleware are registered, before first request
configure_otel(app, service_name="kirana-kart-ingest")

# ----------------------------------------------------------------
# ROUTE REGISTRATION
# ----------------------------------------------------------------

from app.l2_cardinal.routes import router as cardinal_router

app.include_router(cardinal_router)
app.add_route("/metrics", metrics_endpoint)

# ----------------------------------------------------------------
# HEALTH
# ----------------------------------------------------------------

@app.get("/health", tags=["Ops"])
def health():
    return {"status": "ok", "service": "cardinal-ingest"}




from app.readiness import readiness
app.add_api_route("/ready", readiness, methods=["GET"], tags=["ops"])
