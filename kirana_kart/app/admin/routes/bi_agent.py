"""
app/admin/routes/bi_agent.py
=============================
BI Agent routes — governance plane (port 8001).

Endpoints:
  GET  /bi-agent/modules               → taxonomy issue types for filter dropdown
  GET  /bi-agent/sessions              → list chat sessions for current user
  POST /bi-agent/sessions              → create new chat session
  PATCH /bi-agent/sessions/{id}        → rename session
  DELETE /bi-agent/sessions/{id}       → delete session + messages
  GET  /bi-agent/sessions/{id}/messages → message history
  POST /bi-agent/query                 → STREAMING analyst query (text/event-stream)
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from app.admin.rate_limiter import limiter
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.admin.db import get_db_session, engine
from app.admin.routes.auth import UserContext, require_permission
from app.config import settings
from app.admin.services.bi_agent_service import (
    understand_question,
    generate_sql,
    validate_sql,
    execute_sql,
    stream_response,
)

logger = logging.getLogger("kirana_kart.bi_agent")

router = APIRouter(prefix="/bi-agent", tags=["bi-agent"])

_view = require_permission("biAgent", "view")


# ============================================================
# STARTUP — ensure tables exist
# ============================================================

def ensure_bi_tables() -> None:
    """Create BI chat tables if they don't exist, and run column migrations."""
    ddl = """
    CREATE TABLE IF NOT EXISTS kirana_kart.bi_chat_sessions (
        id          SERIAL PRIMARY KEY,
        label       VARCHAR(200) NOT NULL DEFAULT 'New Chat',
        user_id     INTEGER      NOT NULL,
        created_at  TIMESTAMPTZ  DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kirana_kart.bi_chat_messages (
        id          SERIAL PRIMARY KEY,
        session_id  INT          NOT NULL
                        REFERENCES kirana_kart.bi_chat_sessions(id) ON DELETE CASCADE,
        role        VARCHAR(20)  NOT NULL,
        content     TEXT         NOT NULL,
        sql_query   TEXT,
        created_at  TIMESTAMPTZ  DEFAULT NOW()
    );
    """
    # Migration: old schema used token_hash VARCHAR(64) instead of user_id INTEGER.
    # Run each statement separately — multi-statement strings are unreliable with psycopg2.
    migrations = [
        "ALTER TABLE kirana_kart.bi_chat_sessions ADD COLUMN IF NOT EXISTS user_id INTEGER",
        "ALTER TABLE kirana_kart.bi_chat_sessions DROP COLUMN IF EXISTS token_hash",
    ]
    # Keep each statement separate — psycopg2 does not support multi-statement execute()
    ddl_statements = [s.strip() for s in ddl.split(";") if s.strip()]
    try:
        with engine.connect() as conn:
            for stmt in ddl_statements:
                conn.execute(text(stmt))
            for stmt in migrations:
                conn.execute(text(stmt))
            conn.commit()
        logger.info("BI chat tables ensured.")
    except Exception as exc:
        logger.error("Failed to create BI chat tables: %s", exc)


# ============================================================
# REQUEST / RESPONSE MODELS
# ============================================================

class CreateSessionRequest(BaseModel):
    label: str = Field(default="New Chat", max_length=200)


class RenameSessionRequest(BaseModel):
    label: str = Field(..., max_length=200)


class QueryRequest(BaseModel):
    session_id: int
    question: str = Field(..., min_length=3, max_length=2000)
    module: str = Field(..., min_length=1)
    date_from: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    date_to: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")


# ============================================================
# GET /bi-agent/modules
# ============================================================

@router.get("/modules")
def get_modules(user: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT segment                  AS issue_code,
                       INITCAP(segment)         AS label,
                       COUNT(*)::int            AS customer_count
                FROM kirana_kart.customers
                WHERE segment IS NOT NULL
                GROUP BY segment
                ORDER BY COUNT(*) DESC
            """)
        ).mappings().all()

    return [dict(r) for r in rows]


# ============================================================
# GET /bi-agent/sessions
# ============================================================

@router.get("/sessions")
def list_sessions(user: UserContext = Depends(_view)):
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT id, label, created_at, updated_at
                FROM kirana_kart.bi_chat_sessions
                WHERE user_id = :uid
                ORDER BY updated_at DESC
            """),
            {"uid": user.id},
        ).mappings().all()

    return [dict(r) for r in rows]


# ============================================================
# POST /bi-agent/sessions
# ============================================================

@router.post("/sessions", status_code=201)
def create_session(
    body: CreateSessionRequest,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.bi_chat_sessions (label, user_id)
                VALUES (:label, :uid)
                RETURNING id, label, created_at, updated_at
            """),
            {"label": body.label, "uid": user.id},
        ).mappings().first()

    return dict(row)


# ============================================================
# PATCH /bi-agent/sessions/{session_id}
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
                UPDATE kirana_kart.bi_chat_sessions
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
# DELETE /bi-agent/sessions/{session_id}
# ============================================================

@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(
    session_id: int,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        result = session.execute(
            text("""
                DELETE FROM kirana_kart.bi_chat_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": session_id, "uid": user.id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Session not found")


# ============================================================
# GET /bi-agent/sessions/{session_id}/messages
# ============================================================

@router.get("/sessions/{session_id}/messages")
def get_messages(
    session_id: int,
    user: UserContext = Depends(_view),
):
    with get_db_session() as session:
        owner = session.execute(
            text("""
                SELECT id FROM kirana_kart.bi_chat_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": session_id, "uid": user.id},
        ).first()
        if not owner:
            raise HTTPException(status_code=404, detail="Session not found")

        rows = session.execute(
            text("""
                SELECT id, role, content, sql_query, created_at
                FROM kirana_kart.bi_chat_messages
                WHERE session_id = :sid
                ORDER BY created_at ASC
            """),
            {"sid": session_id},
        ).mappings().all()

    return [dict(r) for r in rows]


# ============================================================
# POST /bi-agent/query  (STREAMING)
# ============================================================

@router.post("/query")
@limiter.limit("30/minute")
def query_stream(
    request: Request,
    body: QueryRequest,
    user: UserContext = Depends(_view),
):
    """
    Declared `def`, not `async def`, on purpose: everything below is blocking
    (SQLAlchemy and the LLM client are both synchronous). As an async handler
    it stalled the event loop — and every other in-flight request — for the
    several seconds each BI query takes. FastAPI runs a sync handler in the
    threadpool instead.
    """
    if not settings.bi_agent_enabled:
        raise HTTPException(
            status_code=503,
            detail=(
                "The BI Agent is not configured. It requires BI_DB_USER and "
                "BI_DB_PASSWORD to be set to a SELECT-only database role."
            ),
        )

    # Verify session ownership
    with get_db_session() as session:
        owner = session.execute(
            text("""
                SELECT id FROM kirana_kart.bi_chat_sessions
                WHERE id = :sid AND user_id = :uid
            """),
            {"sid": body.session_id, "uid": user.id},
        ).first()
    if not owner:
        raise HTTPException(status_code=404, detail="Session not found")

    def _sse_event(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    def _generate():
        assistant_content = ""
        final_sql = ""

        try:
            yield _sse_event({"type": "status", "text": "Understanding your question…"})

            intent = understand_question(
                body.question, body.module, body.date_from, body.date_to
            )

            yield _sse_event({"type": "status", "text": "Generating SQL query…"})

            raw_sql = generate_sql(intent, body.module, body.date_from, body.date_to)

            try:
                clean_sql = validate_sql(raw_sql)
            except ValueError as e:
                yield _sse_event({"type": "error", "text": f"SQL validation failed: {e}"})
                return

            final_sql = clean_sql
            yield _sse_event({"type": "sql", "query": clean_sql})

            yield _sse_event({"type": "status", "text": "Querying the database…"})

            try:
                rows = execute_sql(clean_sql)
            except Exception as e:
                logger.error("SQL execution error: %s", e)
                yield _sse_event({"type": "error", "text": f"Query execution failed: {e}"})
                return

            row_count = len(rows)
            yield _sse_event({"type": "status", "text": f"Analysing {row_count} rows…"})

            for chunk in stream_response(body.question, intent, clean_sql, rows):
                try:
                    inner = json.loads(chunk.removeprefix("data: ").strip())
                    assistant_content += inner.get("text", "")
                except Exception:
                    pass
                yield chunk

            yield _sse_event({"type": "done"})

        except Exception as exc:
            logger.error("BI Agent stream error: %s", exc, exc_info=True)
            yield _sse_event({"type": "error", "text": "An unexpected error occurred. Please try again."})
        finally:
            try:
                with get_db_session() as session:
                    session.execute(
                        text("""
                            INSERT INTO kirana_kart.bi_chat_messages
                                (session_id, role, content, sql_query)
                            VALUES (:sid, 'user', :content, NULL)
                        """),
                        {"sid": body.session_id, "content": body.question},
                    )
                    if assistant_content:
                        session.execute(
                            text("""
                                INSERT INTO kirana_kart.bi_chat_messages
                                    (session_id, role, content, sql_query)
                                VALUES (:sid, 'assistant', :content, :sql)
                            """),
                            {
                                "sid": body.session_id,
                                "content": assistant_content,
                                "sql": final_sql or None,
                            },
                        )
                    session.execute(
                        text("""
                            UPDATE kirana_kart.bi_chat_sessions
                            SET updated_at = NOW()
                            WHERE id = :sid
                        """),
                        {"sid": body.session_id},
                    )
            except Exception as db_exc:
                logger.error("Failed to persist BI messages: %s", db_exc)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
