"""
app/admin/services/bi_agent_service.py
=======================================
Core BI Agent business logic:
  1. understand_question  — LLM #1: parse intent from natural language
  2. generate_sql         — LLM #2: write a SELECT query from intent + schema
  3. validate_sql         — regex safety guard (read-only enforcement)
  4. execute_sql          — run validated query against PostgreSQL
  5. stream_response      — LLM #3: stream an analyst-style answer as SSE
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Generator

from contextlib import contextmanager

from openai import OpenAI
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.admin.db import get_db_session
from app.admin.constants.bi_formulas import BI_FORMULAS, SQL_RULES
from app.admin.constants.schema_loader import get_table_summary
from app.config import settings

logger = logging.getLogger("kirana_kart.bi_agent")

# ============================================================
# READ-ONLY ENGINE — used exclusively by execute_sql()
# Connects as bi_readonly (SELECT-only role) so that even a
# successful regex bypass cannot write, drop, or modify data.
# ============================================================

# The engine is built lazily: settings.bi_database_url raises when no
# SELECT-only role is configured, and that must surface as a clear 503 on the
# BI endpoints rather than an import error that takes down the whole app.
_bi_engine = None
_BiSession = None


def _get_bi_engine():
    global _bi_engine, _BiSession
    if _bi_engine is None:
        _bi_engine = create_engine(
            settings.bi_database_url,   # raises if BI_DB_USER/PASSWORD unset
            poolclass=QueuePool,
            pool_size=3,
            max_overflow=5,
            pool_timeout=20,
            pool_recycle=1800,
            pool_pre_ping=True,
            echo=False,
        )
        _BiSession = sessionmaker(bind=_bi_engine, autocommit=False, autoflush=False)
    return _bi_engine


@contextmanager
def _get_bi_session():
    """
    Read-only session for BI Agent query execution.

    The transaction is marked READ ONLY at the database level, so a statement
    that slips past validate_sql still cannot write. The session is always
    rolled back — there is nothing here that should ever be committed.
    """
    _get_bi_engine()
    session = _BiSession()
    try:
        session.execute(text("SET TRANSACTION READ ONLY"))
        # Bound how long one generated query may hold a connection.
        session.execute(text("SET LOCAL statement_timeout = '30s'"))
        yield session
    finally:
        session.rollback()
        session.close()


# ============================================================
# SQL SAFETY — regex guards
# ============================================================

_ALLOWED_RE = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
_FORBIDDEN_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|"
    r"GRANT|REVOKE|COPY|VACUUM|CALL|MERGE|REPLACE|LOAD|IMPORT|"
    # Dangerous superuser / file-system functions
    r"pg_read_file|pg_write_file|pg_read_binary_file|pg_ls_dir|"
    r"pg_stat_file|lo_export|lo_import|lo_create|lo_open|lo_write|lo_unlink|"
    # Remote execution / extension abuse
    r"dblink|pg_exec|plpython|plperlu|"
    # Connection/session manipulation
    r"pg_terminate_backend|pg_cancel_backend|pg_reload_conf|"
    r"pg_rotate_logfile|pg_switch_wal)\b",
    re.IGNORECASE,
)
_SEMICOLON_SPLIT_RE = re.compile(r";")


def validate_sql(sql: str) -> str:
    """
    Strip SQL comments and assert the query is a pure SELECT statement.
    Raises ValueError if any write or DDL keyword is detected.
    Returns the cleaned SQL string.
    """
    # Strip single-line comments
    clean = re.sub(r"--[^\n]*", "", sql)
    # Strip block comments
    clean = re.sub(r"/\*.*?\*/", "", clean, flags=re.DOTALL)
    clean = clean.strip()

    # Reject multi-statement (stacked queries via semicolon)
    parts = [p.strip() for p in _SEMICOLON_SPLIT_RE.split(clean) if p.strip()]
    if len(parts) > 1:
        raise ValueError("Multi-statement queries are not permitted.")

    if not _ALLOWED_RE.match(clean):
        raise ValueError(
            "Only SELECT queries are permitted. "
            f"Query started with: {clean[:60]!r}"
        )
    if _FORBIDDEN_RE.search(clean):
        m = _FORBIDDEN_RE.search(clean)
        raise ValueError(
            f"Forbidden keyword detected in query: {m.group()!r}. "
            "Only read-only SELECT statements are allowed."
        )
    return clean


# ============================================================
# LLM CLIENT
# ============================================================

def _get_client() -> OpenAI:
    return OpenAI(
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1"),
    )


_FAST_MODEL = os.getenv("MODEL1", "gpt-4o-mini")   # quick intent parsing
_SQL_MODEL  = os.getenv("MODEL1", "gpt-4o-mini")   # SQL generation
_BI_MODEL   = os.getenv("MODEL4", "gpt-4o")        # streamed analyst answer


# ============================================================
# STEP 1 — Understand question
# ============================================================

def understand_question(
    question: str,
    module: str,
    date_from: str,
    date_to: str,
) -> dict:
    """
    Call LLM to parse the business question into a structured intent.
    Returns a dict with keys: intent_summary, metrics_needed, dimensions, filters.
    """
    system = (
        "You are a business intelligence query planner for Kirana Kart, a quick-commerce platform. "
        "Parse the user's question and return JSON with these fields:\n"
        "  intent_summary : one-sentence description of what the user wants\n"
        "  metrics_needed : list of KPI names (e.g. CSAT Score, Refund Rate)\n"
        "  dimensions     : list of grouping/breakdown fields (e.g. date, channel, issue_code)\n"
        "  filters        : dict of additional filter conditions beyond module and date\n"
        "CRITICAL: Preserve EXACT numeric thresholds verbatim from the user's question. "
        "Never substitute or change a threshold (e.g. if user says 0.3 keep 0.3, not 0.7 or 0.5).\n"
        "Return ONLY valid JSON, no markdown."
    )
    user = (
        f"Question: {question}\n"
        f"Customer segment (delivery platform): {module}\n"
        f"Date range: {date_from} to {date_to}"
    )
    client = _get_client()
    resp = client.chat.completions.create(
        model=_FAST_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0.1,
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Intent parse failed, raw: %s", raw[:200])
        return {"intent_summary": question, "metrics_needed": [], "dimensions": [], "filters": {}}


# ============================================================
# STEP 2 — Generate SQL
# ============================================================

def generate_sql(
    intent: dict,
    module: str,
    date_from: str,
    date_to: str,
) -> str:
    """
    Call LLM to write a SELECT query based on intent + schema.
    Returns a raw SQL string (not yet validated).
    """
    system = (
        "You are a PostgreSQL expert. Generate a single SELECT query based on the "
        "business intent provided. Use ONLY the tables listed in the schema below.\n\n"
        f"{get_table_summary()}\n\n"
        f"{SQL_RULES}\n\n"
        "Return ONLY the SQL query — no explanation, no markdown fences, no semicolons."
    )
    user = (
        f"Intent: {json.dumps(intent, indent=2)}\n"
        f"Customer segment filter: {module}  "
        f"(MUST apply as: JOIN kirana_kart.customers cu ON <table>.customer_id = cu.customer_id WHERE cu.segment = '{module}')\n"
        f"Date from: {date_from}  [apply ONLY to transactional tables — conversations, orders, ticket_execution_summary, etc.]\n"
        f"Date to: {date_to}  [DO NOT apply to kirana_kart.customers under any circumstances]\n\n"
        "⚠ If the query is purely about customer attributes (churn probability, segment counts, etc.), "
        "query kirana_kart.customers directly with ONLY WHERE cu.segment = '<segment>' — no date filter at all.\n\n"
        "Write the SELECT query:"
    )
    client = _get_client()
    resp = client.chat.completions.create(
        model=_SQL_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.0,
    )
    raw_sql = (resp.choices[0].message.content or "").strip()
    # Strip any accidental markdown fences
    raw_sql = re.sub(r"^```(?:sql)?\s*", "", raw_sql, flags=re.IGNORECASE)
    raw_sql = re.sub(r"\s*```$", "", raw_sql)
    return raw_sql.strip()


# ============================================================
# STEP 3 — Execute SQL
# ============================================================

def execute_sql(sql: str) -> list[dict]:
    """
    Run the validated SELECT query and return up to 500 rows as a list of dicts.
    Uses the read-only bi_readonly engine — write operations are rejected at
    the database level even if the regex guard is somehow bypassed.
    """
    with _get_bi_session() as session:
        result = session.execute(text(sql))
        keys = list(result.keys())
        rows = []
        for row in result.fetchmany(500):
            rows.append(dict(zip(keys, row)))
    return rows


# ============================================================
# STEP 4 — Stream analyst response
# ============================================================

def stream_response(
    question: str,
    intent: dict,
    sql: str,
    rows: list[dict],
) -> Generator[str, None, None]:
    """
    Stream a Senior Business Analyst-style response using OpenAI streaming.
    Yields SSE-formatted strings: `data: {...}\\n\\n`
    """
    # Truncate rows representation to avoid hitting token limits
    rows_preview = rows[:50]
    rows_json = json.dumps(rows_preview, default=str, indent=2)
    total_rows = len(rows)
    truncation_note = (
        f"\n[Note: {total_rows} rows returned; showing first 50 for analysis.]"
        if total_rows > 50 else ""
    )

    system = (
        "You are a Senior Business Analyst at Kirana Kart with deep expertise in "
        "quick-commerce operations, customer experience, and data analytics. "
        "Answer the user's business question by:\n"
        "1. Directly answering the question using the SQL results\n"
        "2. Applying the relevant BI formulas to compute/verify metrics\n"
        "3. Providing business context and actionable insights\n"
        "4. Flagging any anomalies or notable trends\n"
        "5. Suggesting follow-up analysis if relevant\n\n"
        "Keep the tone professional but clear. Use bullet points for lists. "
        "Round numbers to 2 decimal places. Always state the time period.\n\n"
        f"FORMULA REFERENCE:\n{BI_FORMULAS}"
    )
    user = (
        f"Question: {question}\n\n"
        f"Intent: {intent.get('intent_summary', '')}\n\n"
        f"SQL used:\n{sql}\n\n"
        f"Results ({total_rows} rows){truncation_note}:\n{rows_json}"
    )

    client = _get_client()
    stream = client.chat.completions.create(
        model=_BI_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        stream=True,
        temperature=0.3,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            payload = json.dumps({"type": "content", "text": delta.content})
            yield f"data: {payload}\n\n"
