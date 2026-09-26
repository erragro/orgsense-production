"""
app/admin/routes/qa_agent.py
=============================
QA Agent routes — governance plane (port 8001).

Endpoints:
  GET  /qa-agent/sessions                   → list QA sessions for current user
  POST /qa-agent/sessions                   → create new session
  PATCH /qa-agent/sessions/{id}             → rename session
  DELETE /qa-agent/sessions/{id}            → delete session + cascade evaluations
  GET  /qa-agent/sessions/{id}/evaluations  → list evaluations in session (summary)
  GET  /qa-agent/evaluations/{id}           → full evaluation detail with findings
  GET  /qa-agent/tickets/search             → search completed tickets for QA
  POST /qa-agent/evaluate                   → trigger streaming QA audit (SSE)
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from app.admin.rate_limiter import limiter
from fastapi.responses import StreamingResponse
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.admin.db import get_db_session, engine
from app.admin.routes.auth import UserContext, require_permission
from app.admin.services.qa_agent_service import (
    fetch_ticket_context,
    retrieve_kb_evidence,
    run_python_evaluations,
    run_ml_evaluations,
    run_qa_evaluation,
    persist_evaluation,
)

logger = logging.getLogger("kirana_kart.qa_agent")

router = APIRouter(prefix="/qa-agent", tags=["qa-agent"])

_view = require_permission("qaAgent", "view")


# ============================================================
# STARTUP — ensure tables exist
# ============================================================

def ensure_qa_tables() -> None:
    """Create QA audit tables if they don't exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS kirana_kart.qa_sessions (
        id          SERIAL PRIMARY KEY,
        label       VARCHAR(200)  NOT NULL DEFAULT 'New QA Session',
        user_id     INTEGER       NOT NULL,
        created_at  TIMESTAMPTZ   DEFAULT NOW(),
        updated_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kirana_kart.qa_evaluations (
        id                      SERIAL PRIMARY KEY,
        session_id              INTEGER      NOT NULL
                                    REFERENCES kirana_kart.qa_sessions(id) ON DELETE CASCADE,
        ticket_id               INTEGER      NOT NULL,
        execution_id            VARCHAR(100),

        -- 10 parameter scores (0.0000–1.0000)
        classification_score    NUMERIC(5,4),
        policy_compliance_score NUMERIC(5,4),
        confidence_score        NUMERIC(5,4),
        gratification_score     NUMERIC(5,4),
        sla_score               NUMERIC(5,4),
        discrepancy_score       NUMERIC(5,4),
        response_quality_score  NUMERIC(5,4),
        kb_alignment_score      NUMERIC(5,4),
        override_score          NUMERIC(5,4),
        fraud_score             NUMERIC(5,4),

        overall_score           NUMERIC(5,4),
        grade                   VARCHAR(2),

        -- JSONB payloads
        findings                JSONB,
        kb_evidence             JSONB,

        -- Denormalised ticket snapshot for quick display
        ticket_subject          TEXT,
        ticket_module           VARCHAR(100),
        issue_type_l1           VARCHAR(100),
        issue_type_l2           VARCHAR(100),
        action_code             VARCHAR(100),
        overall_confidence      NUMERIC(5,4),

        -- Lifecycle
        status                  VARCHAR(20)  DEFAULT 'pending',
        error_message           TEXT,
        created_at              TIMESTAMPTZ  DEFAULT NOW(),
        completed_at            TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_qa_evaluations_session
        ON kirana_kart.qa_evaluations(session_id);
    CREATE INDEX IF NOT EXISTS idx_qa_evaluations_ticket
        ON kirana_kart.qa_evaluations(ticket_id);
    """
    # Keep each statement separate — psycopg2 does not support multi-statement execute()
    ddl_statements = [s.strip() for s in ddl.split(";") if s.strip()]
    migrations = [
        "ALTER TABLE kirana_kart.qa_evaluations ADD COLUMN IF NOT EXISTS python_qa_score NUMERIC(5,4)",
        "ALTER TABLE kirana_kart.qa_evaluations ADD COLUMN IF NOT EXISTS python_findings JSONB",
        """CREATE TABLE IF NOT EXISTS kirana_kart.qa_flag_overrides (
            id              SERIAL PRIMARY KEY,
            qa_evaluation_id INTEGER NOT NULL REFERENCES kirana_kart.qa_evaluations(id) ON DELETE CASCADE,
            parameter_name  TEXT NOT NULL,
            original_score  NUMERIC(5,4),
            override_by     INTEGER REFERENCES kirana_kart.users(id),
            override_reason TEXT,
            overridden_at   TIMESTAMP DEFAULT NOW()
        )""",
    ]
    try:
        with engine.connect() as conn:
            for stmt in ddl_statements:
                conn.execute(text(stmt))
            for stmt in migrations:
                conn.execute(text(stmt))
            conn.commit()
        logger.info("QA tables ensured (including python_qa_score / python_findings columns).")
    except Exception as exc:
        logger.error("Failed to create QA tables: %s", exc)


# ============================================================
# REQUEST / RESPONSE MODELS
# ============================================================

class CreateSessionRequest(BaseModel):
    label: str = Field(default="New QA Session", max_length=200)


class RenameSessionRequest(BaseModel):
    label: str = Field(..., max_length=200)


class EvaluateRequest(BaseModel):
    session_id: int
    ticket_id: int = Field(..., ge=1)


# ============================================================
# GET /qa-agent/sessions
# ============================================================

@router.get("/sessions")
def list_sessions(user: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, label, created_at, updated_at
                FROM kirana_kart.qa_sessions
                WHERE user_id = :uid
                ORDER BY updated_at DESC
            """),
            {"uid": user.id},
        ).mappings().all()
    return [dict(r) for r in rows]


# ============================================================
# POST /qa-agent/sessions
# ============================================================

@router.post("/sessions", status_code=201)
def create_session(
    body: CreateSessionRequest,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.qa_sessions (label, user_id)
                VALUES (:label, :uid)
                RETURNING id, label, created_at, updated_at
            """),
            {"label": body.label, "uid": user.id},
        ).mappings().first()
    return dict(row)


# ============================================================
# PATCH /qa-agent/sessions/{session_id}
# ============================================================

@router.patch("/sessions/{session_id}")
def rename_session(
    session_id: int,
    body: RenameSessionRequest,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                UPDATE kirana_kart.qa_sessions
                SET label = :label, updated_at = NOW()
                WHERE id = :sid AND user_id = :uid
                RETURNING id, label, updated_at
            """),
            {"label": body.label, "sid": session_id, "uid": user.id},
        ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return dict(row)


# ============================================================
# DELETE /qa-agent/sessions/{session_id}
# ============================================================

@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(
    session_id: int,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        result = session.execute(
            text("""
                DELETE FROM kirana_kart.qa_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": session_id, "uid": user.id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Session not found")


# ============================================================
# GET /qa-agent/sessions/{session_id}/evaluations
# ============================================================

@router.get("/sessions/{session_id}/evaluations")
def list_evaluations(
    session_id: int,
    user: UserContext = Depends(_view),
):
    # Verify session ownership
    with get_db_session() as session:
        owner = session.execute(
            text("""
                SELECT id FROM kirana_kart.qa_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": session_id, "uid": user.id},
        ).first()
        if not owner:
            raise HTTPException(status_code=404, detail="Session not found")

        rows = session.execute(
            text("""
                SELECT id, ticket_id, ticket_subject, ticket_module,
                       issue_type_l1, issue_type_l2, action_code,
                       overall_score, grade, status,
                       created_at, completed_at
                FROM kirana_kart.qa_evaluations
                WHERE session_id = :sid
                ORDER BY created_at DESC
            """),
            {"sid": session_id},
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


# ============================================================
# GET /qa-agent/evaluations/{evaluation_id}
# ============================================================

@router.get("/evaluations/{evaluation_id}")
def get_evaluation(
    evaluation_id: int,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        # Verify ownership via session join
        row = session.execute(
            text("""
                SELECT e.*
                FROM kirana_kart.qa_evaluations e
                JOIN kirana_kart.qa_sessions s ON s.id = e.session_id
                WHERE e.id = :eid AND s.user_id = :uid
            """),
            {"eid": evaluation_id, "uid": user.id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Evaluation not found")

    result = dict(row)
    # Parse JSONB fields
    for field in ("findings", "kb_evidence", "python_findings"):
        if isinstance(result.get(field), str):
            try:
                result[field] = json.loads(result[field])
            except Exception:
                pass

    return jsonable_encoder(result)


# ============================================================
# GET /qa-agent/tickets/search
# ============================================================

@router.get("/tickets/search")
def search_tickets(
    ticket_id: int | None = Query(default=None),
    module: str | None = Query(default=None),
    date_from: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    limit: int = Query(default=25, ge=1, le=100),
    _user: UserContext = Depends(_view),
):
    """
    Search for fully-processed tickets available for QA audit.
    Only returns tickets where ticket_processing_state.processing_completed_at IS NOT NULL.
    """
    filters = ["ps.processing_completed_at IS NOT NULL"]
    params: dict = {"limit": limit}

    if ticket_id is not None:
        filters.append("f.ticket_id = :ticket_id")
        params["ticket_id"] = ticket_id

    if module:
        filters.append("f.module = :module")
        params["module"] = module

    if date_from:
        filters.append("f.created_at >= CAST(:date_from AS date)")
        params["date_from"] = date_from

    if date_to:
        filters.append("f.created_at < (CAST(:date_to AS date) + interval '1 day')")
        params["date_to"] = date_to

    where = "WHERE " + " AND ".join(filters)

    with get_db_session() as session:
        rows = session.execute(
            text(f"""
                SELECT
                    f.ticket_id,
                    f.subject,
                    f.module,
                    f.cx_email,
                    f.created_at                  AS ticket_created_at,
                    lo2.issue_type_l1_verified    AS issue_type_l1,
                    lo2.issue_type_l2_verified    AS issue_type_l2,
                    lo3.final_action_code         AS action_code,
                    lo2.overall_confidence,
                    ps.processing_completed_at
                FROM kirana_kart.fdraw f
                INNER JOIN LATERAL (
                    SELECT processing_completed_at,
                           stage_0_status, stage_1_status,
                           stage_2_status, stage_3_status
                    FROM kirana_kart.ticket_processing_state
                    WHERE ticket_id = f.ticket_id
                    ORDER BY created_at DESC
                    LIMIT 1
                ) ps ON true
                LEFT JOIN LATERAL (
                    SELECT issue_type_l1_verified, issue_type_l2_verified, overall_confidence
                    FROM kirana_kart.llm_output_2
                    WHERE ticket_id = f.ticket_id
                    ORDER BY id DESC LIMIT 1
                ) lo2 ON true
                LEFT JOIN LATERAL (
                    SELECT final_action_code
                    FROM kirana_kart.llm_output_3
                    WHERE ticket_id = f.ticket_id
                    ORDER BY id DESC LIMIT 1
                ) lo3 ON true
                {where}
                ORDER BY ps.processing_completed_at DESC
                LIMIT :limit
            """),
            params,
        ).mappings().all()

    return jsonable_encoder([dict(r) for r in rows])


# ============================================================
# POST /qa-agent/evaluate  (STREAMING SSE)
# ============================================================

@router.post("/evaluate")
@limiter.limit("20/minute")
async def evaluate_stream(
    request: Request,
    body: EvaluateRequest,
    user: UserContext = Depends(_view),
):
    # Verify session ownership upfront
    with get_db_session() as session:
        owner = session.execute(
            text("""
                SELECT id FROM kirana_kart.qa_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": body.session_id, "uid": user.id},
        ).first()
    if not owner:
        raise HTTPException(status_code=404, detail="Session not found")

    def _sse(payload: dict) -> str:
        return f"data: {json.dumps(payload, default=str)}\n\n"

    def _generate():
        evaluation_result: dict = {}
        context: dict = {}
        kb_evidence: dict = {"rules": [], "issues": [], "actions": []}
        python_results: dict | None = None
        ml_check_results: list = []

        try:
            # ── Step 1: fetch context ──────────────────────────────
            yield _sse({"type": "status", "text": "Fetching ticket execution context…"})
            try:
                context = fetch_ticket_context(body.ticket_id)
            except ValueError as e:
                yield _sse({"type": "error", "text": str(e)})
                return

            # ── Step 2: retrieve KB evidence ──────────────────────
            yield _sse({"type": "status", "text": "Embedding ticket context for KB retrieval…"})
            kb_evidence = retrieve_kb_evidence(context)
            yield _sse({"type": "kb_evidence", **kb_evidence})

            # ── Step 3: Python deterministic checks ───────────────
            yield _sse({"type": "status", "text": "Running deterministic Python quality checks…"})
            try:
                python_results = run_python_evaluations(context)
                for check in python_results["checks"]:
                    yield _sse({"type": "python_check", **check})
                yield _sse({
                    "type": "python_summary",
                    "python_score": python_results["python_score"],
                    "python_grade": python_results["python_grade"],
                    "python_pass_count": sum(1 for c in python_results["checks"] if c["pass"]),
                    "python_fail_count": sum(1 for c in python_results["checks"] if not c["pass"]),
                })
            except Exception as py_exc:
                logger.error("Python evaluation error: %s", py_exc, exc_info=True)
                # Non-fatal: continue with LLM evaluation
                python_results = None

            # ── Step 3.5: ML checks (Override Justification + Fraud Segment) ──
            yield _sse({"type": "status", "text": "Running ML quality checks…"})
            try:
                ml_check_results = run_ml_evaluations(context)
                for check in ml_check_results:
                    yield _sse({"type": "ml_check", **check})
            except Exception as ml_exc:
                logger.warning("ML evaluation error (non-fatal): %s", ml_exc)

            # ── Step 4: run LLM semantic evaluation ───────────────
            rule_count = len(kb_evidence.get("rules", []))
            yield _sse({
                "type": "status",
                "text": f"Running Six Sigma AI evaluation across 6 parameters ({rule_count} KB rules loaded)…",
            })

            try:
                evaluation_result = run_qa_evaluation(context, kb_evidence, python_results)
            except Exception as e:
                logger.error("QA evaluation error: %s", e, exc_info=True)
                yield _sse({"type": "error", "text": f"QA evaluation failed: {e}"})
                return

            # ── Stream each parameter result ──────────────────────
            for param in evaluation_result.get("parameters", []):
                yield _sse({"type": "parameter", **param})

            # ── Stream summary ────────────────────────────────────
            summary = evaluation_result.get("summary", {})
            if summary:
                yield _sse({"type": "summary", **summary})

            yield _sse({"type": "status", "text": "Persisting evaluation…"})

        except Exception as exc:
            logger.error("QA Agent stream error: %s", exc, exc_info=True)
            yield _sse({"type": "error", "text": "An unexpected error occurred."})

        finally:
            # ── Persist to DB regardless of whether we errored ────
            if context and evaluation_result.get("parameters"):
                try:
                    eval_id = persist_evaluation(
                        session_id=body.session_id,
                        ticket_id=body.ticket_id,
                        context=context,
                        kb_evidence=kb_evidence,
                        result=evaluation_result,
                        python_results=python_results,
                        ml_results=ml_check_results or None,
                    )
                    yield _sse({"type": "done", "evaluation_id": eval_id})
                except Exception as db_exc:
                    logger.error("Failed to persist QA evaluation: %s", db_exc)
                    yield _sse({"type": "done", "evaluation_id": None})
            else:
                yield _sse({"type": "done", "evaluation_id": None})

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================
# QA FLAG OVERRIDES — dismiss/override LLM Six Sigma flags
# ============================================================

class DismissFlagRequest(BaseModel):
    parameter_name: str
    original_score: float
    dismiss_reason: str      # "Expected behavior" | "Business exception" | "False positive"
    dismiss_note: str = ""

@router.post("/evaluations/{evaluation_id}/dismiss-flag")
def dismiss_qa_flag(
    evaluation_id: int,
    body: DismissFlagRequest,
    u: UserContext = Depends(require_permission("policy", "admin")),
):
    """
    Governance admin dismisses/overrides a Six Sigma QA flag.
    Stored in qa_flag_overrides for audit trail.
    """
    from sqlalchemy import text as _text
    try:
        with engine.begin() as conn:
            # Verify evaluation exists
            ev = conn.execute(_text("""
                SELECT id FROM kirana_kart.qa_evaluations WHERE id = :id
            """), {"id": evaluation_id}).fetchone()
            if not ev:
                raise HTTPException(status_code=404, detail="Evaluation not found")

            # Delete existing override for same param if any, then insert fresh
            conn.execute(_text("""
                DELETE FROM kirana_kart.qa_flag_overrides
                WHERE qa_evaluation_id = :eval_id AND parameter_name = :param
            """), {"eval_id": evaluation_id, "param": body.parameter_name})

            conn.execute(_text("""
                INSERT INTO kirana_kart.qa_flag_overrides
                    (qa_evaluation_id, parameter_name, original_score,
                     override_by, override_reason, overridden_at)
                VALUES
                    (:eval_id, :param, :score, :user_id, :reason, NOW())
            """), {
                "eval_id": evaluation_id,
                "param": body.parameter_name,
                "score": body.original_score,
                "user_id": u.id,
                "reason": f"{body.dismiss_reason}: {body.dismiss_note}".strip(": "),
            })

        return {"status": "dismissed", "parameter_name": body.parameter_name}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("dismiss_qa_flag failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")


@router.get("/evaluations/{evaluation_id}/flags")
def get_qa_flags(
    evaluation_id: int,
    _u: UserContext = Depends(require_permission("policy", "view")),
):
    """Return all dismissed flags for an evaluation (for UI to show dismissed state)."""
    from sqlalchemy import text as _text
    try:
        with engine.connect() as conn:
            rows = conn.execute(_text("""
                SELECT parameter_name, original_score, override_reason, overridden_at
                FROM kirana_kart.qa_flag_overrides
                WHERE qa_evaluation_id = :id
                ORDER BY overridden_at DESC
            """), {"id": evaluation_id}).mappings().all()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.exception("get_qa_flags failed")
        raise HTTPException(status_code=500, detail="An internal error occurred. See server logs for details.")
