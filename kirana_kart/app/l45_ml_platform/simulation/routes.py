"""
Simulation Routes
=================

FastAPI endpoints for policy simulation.

Endpoints:
  POST /simulation/run              — batch simulation (two versions vs sample tickets)
  POST /simulation/run-ticket       — simulate a single real ticket vs two versions
  GET  /simulation/tickets          — search real tickets for simulation picker
  GET  /simulation/ticket/{id}      — full detail for one ticket
  GET  /simulation/health           — liveness probe
"""

import os
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import create_engine
from dotenv import load_dotenv

from app.admin.routes.auth import UserContext, require_permission
from .policy_simulation_service import PolicySimulationService


# ============================================================
# CONFIG
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST     = os.getenv("DB_HOST")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME")
DB_USER     = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

DATABASE_URL = (
    f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

engine = create_engine(DATABASE_URL)


# ============================================================
# ROUTER
# ============================================================

router = APIRouter(prefix="/simulation", tags=["Policy Simulation"])

logger = logging.getLogger("simulation_routes")
logger.setLevel(logging.INFO)

_edit  = require_permission("policy", "edit")
_admin = require_permission("policy", "admin")


# ============================================================
# REQUEST MODELS
# ============================================================

class SimulationRequest(BaseModel):
    baseline_version: str
    candidate_version: str


class TicketSimulationRequest(BaseModel):
    ticket_id: int
    baseline_version: str
    candidate_version: str


class CardinalSimulationRequest(BaseModel):
    ticket_id: int
    baseline_version: str
    candidate_version: str


# ============================================================
# TICKET SEARCH (for simulation picker)
# ============================================================

@router.get("/tickets")
def list_simulation_tickets(
    search: str | None = Query(None, description="Search by subject or ticket_id"),
    limit: int = Query(20, le=100),
    _u: UserContext = Depends(_edit),
):
    """List real tickets available for per-ticket simulation."""
    try:
        service = PolicySimulationService(engine)
        return service.get_tickets(search=search, limit=limit)
    except Exception as e:
        logger.error("list_simulation_tickets failed: %s", e)
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# SINGLE TICKET DETAIL
# ============================================================

@router.get("/ticket/{ticket_id}")
def get_simulation_ticket(
    ticket_id: int,
    _u: UserContext = Depends(_edit),
):
    """Get full ticket detail for display in simulation panel."""
    try:
        service = PolicySimulationService(engine)
        return service.get_ticket_detail(ticket_id)
    except Exception as e:
        logger.error("get_simulation_ticket failed ticket_id=%s: %s", ticket_id, e)
        raise HTTPException(status_code=404 if "not found" in str(e).lower() else 500, detail=str(e))


# ============================================================
# PER-TICKET SIMULATION
# ============================================================

@router.post("/run-ticket")
def run_ticket_simulation(
    request: TicketSimulationRequest,
    _u: UserContext = Depends(_edit),
):
    """
    Run a single real ticket through two policy versions.
    Returns full evaluation trace + side-by-side comparison.
    """
    try:
        service = PolicySimulationService(engine)
        result = service.simulate_ticket(
            ticket_id=request.ticket_id,
            baseline_version=request.baseline_version,
            candidate_version=request.candidate_version,
        )
        return result
    except Exception as e:
        logger.error("run_ticket_simulation failed: %s", e)
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# FULL CARDINAL SIMULATION (4-stage LLM pipeline)
# ============================================================

@router.post("/run-ticket-cardinal")
def run_ticket_cardinal_simulation(
    request: CardinalSimulationRequest,
    _u: UserContext = Depends(_edit),
):
    """
    Run a single real ticket through the full 4-stage Cardinal pipeline
    for two policy versions and return a side-by-side comparison.

    Stage 0 (classification) runs once.
    Stages 1 (LLM + Weaviate), 2 (deterministic), 3 (response draft if HITL)
    run for each version.
    """
    try:
        service = PolicySimulationService(engine)
        result = service.simulate_ticket_cardinal(
            ticket_id=request.ticket_id,
            baseline_version=request.baseline_version,
            candidate_version=request.candidate_version,
        )
        return result
    except Exception as e:
        logger.error("run_ticket_cardinal_simulation failed: %s", e)
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# BATCH SIMULATION (original)
# ============================================================

@router.post("/run")
def run_simulation(
    request: SimulationRequest,
    _u: UserContext = Depends(_admin),
):
    """Run simulation comparing two policy versions over sample tickets."""
    try:
        service = PolicySimulationService(engine)
        result = service.run_simulation(
            candidate_version=request.candidate_version,
            baseline_version=request.baseline_version,
        )
        return {
            "status": "success",
            "baseline_version": request.baseline_version,
            "candidate_version": request.candidate_version,
            "result": result,
        }
    except Exception as e:
        logger.error("run_simulation failed: %s", e)
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


# ============================================================
# HEALTH
# ============================================================

@router.get("/health")
def simulation_health():
    return {"status": "ok", "module": "policy_simulation"}
