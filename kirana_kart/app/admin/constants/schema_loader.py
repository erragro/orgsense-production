"""
app/admin/constants/schema_loader.py
=====================================
Dynamically builds TABLE_SUMMARY by introspecting the live PostgreSQL schema.

Runs once at first use and caches the result in-process.  Falls back to the
static TABLE_SUMMARY in bi_formulas.py if DB introspection fails.

The generated string is injected into the SQL-generation LLM prompt so the
model always works from the actual, up-to-date column definitions.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from contextlib import contextmanager
from typing import Optional

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import settings

logger = logging.getLogger("kirana_kart.schema_loader")

# ── Read-only engine for schema introspection (bi_readonly credentials) ────────
# Uses the same restricted role as BI query execution so the schema
# summary only describes tables/columns the BI agent can actually query.
# Built lazily: settings.bi_database_url raises when no SELECT-only role is
# configured, and importing this module must not take the process down over a
# feature that may simply be disabled. Callers already fall back to the static
# TABLE_SUMMARY when introspection fails.
_schema_engine = None
_SchemaSession = None


def _get_schema_engine():
    global _schema_engine, _SchemaSession
    if _schema_engine is None:
        _schema_engine = create_engine(
            settings.bi_database_url,   # raises if BI_DB_USER/PASSWORD unset
            pool_size=2,
            max_overflow=2,
            pool_pre_ping=True,
        )
        _SchemaSession = sessionmaker(
            bind=_schema_engine, autocommit=False, autoflush=False
        )
    return _schema_engine


@contextmanager
def _schema_session():
    """Read-only introspection session — nothing here should ever commit."""
    _get_schema_engine()
    session = _SchemaSession()
    try:
        session.execute(text("SET TRANSACTION READ ONLY"))
        yield session
    finally:
        session.rollback()
        session.close()

# Only include these 11 operational tables in the schema (everything else is
# internal governance / AI / policy content and must not appear in the schema)
_ALLOWED_TABLES = {
    "conversations",
    "conversation_turns",
    "customers",
    "csat_responses",
    "orders",
    "refunds",
    "delivery_events",
    "issue_taxonomy",
    "ticket_execution_summary",
    "execution_metrics",
    "master_action_codes",
}

# Display order
_ORDER = [
    "conversations",
    "conversation_turns",
    "customers",
    "csat_responses",
    "orders",
    "refunds",
    "delivery_events",
    "issue_taxonomy",
    "ticket_execution_summary",
    "execution_metrics",
    "master_action_codes",
]

# Max distinct values to show for low-cardinality columns
_MAX_DISTINCT = 15
# Skip sample values if any value is longer than this (prevents injecting huge policy text)
_MAX_VALUE_LEN = 40
# Columns to never sample (free-text / PII / identifiers)
_SKIP_SAMPLE_COLS = {
    "email", "phone", "message_text", "feedback", "description",
    "content", "details", "raw_text", "notes", "address", "name",
    "policy_artifact_hash", "policy_version", "execution_id",
    "customer_id", "order_id", "ticket_id", "agent_id",
}

_CACHE: Optional[str] = None


def get_table_summary() -> str:
    """Return cached TABLE_SUMMARY string, generating from DB if needed."""
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = _build()
            logger.info("Schema introspected (%d chars, %d tables)", len(_CACHE), _CACHE.count("\n."))
        except Exception as exc:
            logger.error("Schema introspection failed, using static fallback: %s", exc, exc_info=True)
            from app.admin.constants.bi_formulas import TABLE_SUMMARY  # noqa: PLC0415
            _CACHE = TABLE_SUMMARY
    return _CACHE


def invalidate_cache() -> None:
    """Force regeneration on next call (e.g. after schema migrations)."""
    global _CACHE
    _CACHE = None


# ── Internal builder ──────────────────────────────────────────────────────────

def _build() -> str:
    with _schema_session() as session:

        # 1. All columns (excluding internal tables)
        col_rows = session.execute(text("""
            SELECT table_name, column_name, data_type, udt_name,
                   is_nullable, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = 'kirana_kart'
            ORDER BY table_name, ordinal_position
        """)).mappings().all()

        # 2. Primary keys
        pk_rows = session.execute(text("""
            SELECT kcu.table_name, kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema    = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema    = 'kirana_kart'
        """)).mappings().all()

        # 3. Foreign keys
        fk_rows = session.execute(text("""
            SELECT kcu.table_name, kcu.column_name,
                   ccu.table_name  AS ref_table,
                   ccu.column_name AS ref_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema    = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
               AND ccu.table_schema    = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema    = 'kirana_kart'
        """)).mappings().all()

        # 4. Approximate row counts — pg_stat_user_tables requires pg_monitor;
        #    gracefully degrade to 0 if bi_readonly lacks that privilege.
        try:
            cnt_rows = session.execute(text("""
                SELECT relname AS table_name,
                       n_live_tup::bigint AS row_count
                FROM pg_stat_user_tables
                WHERE schemaname = 'kirana_kart'
            """)).mappings().all()
        except Exception:
            logger.debug("pg_stat_user_tables not accessible — row counts skipped")
            cnt_rows = []

        # 5. Column comments from pg_description (available once COMMENT ON COLUMN is set)
        try:
            comment_rows = session.execute(text("""
                SELECT c.table_name,
                       c.column_name,
                       pgd.description
                FROM information_schema.columns c
                JOIN pg_class cls
                  ON cls.relname = c.table_name
                JOIN pg_namespace ns
                  ON ns.nspname = c.table_schema
                 AND ns.oid = cls.relnamespace
                LEFT JOIN pg_attribute attr
                  ON attr.attrelid = cls.oid
                 AND attr.attname  = c.column_name
                LEFT JOIN pg_description pgd
                  ON pgd.objoid    = cls.oid
                 AND pgd.objsubid  = attr.attnum
                WHERE c.table_schema = 'kirana_kart'
                  AND pgd.description IS NOT NULL
                ORDER BY c.table_name, c.ordinal_position
            """)).mappings().all()
        except Exception:
            logger.debug("pg_description not accessible — column comments skipped")
            comment_rows = []

    # ── Organise ──────────────────────────────────────────────────────────────
    table_cols: dict[str, list[dict]] = defaultdict(list)
    for r in col_rows:
        if r["table_name"] in _ALLOWED_TABLES and r["column_name"] not in {"email", "phone", "date_of_birth", "email_blind_index"}:
            table_cols[r["table_name"]].append(dict(r))

    pk_map: dict[str, set] = defaultdict(set)
    for r in pk_rows:
        pk_map[r["table_name"]].add(r["column_name"])

    fk_map: dict[str, dict] = defaultdict(dict)
    for r in fk_rows:
        fk_map[r["table_name"]][r["column_name"]] = f"{r['ref_table']}.{r['ref_column']}"

    row_counts: dict[str, int] = {r["table_name"]: r["row_count"] for r in cnt_rows}

    # Column comments map: table → column → description
    col_comments: dict[str, dict[str, str]] = defaultdict(dict)
    for r in comment_rows:
        if r["description"]:
            col_comments[r["table_name"]][r["column_name"]] = r["description"]

    # Ordered tables
    ordered = [t for t in _ORDER if t in table_cols]
    ordered += sorted(t for t in table_cols if t not in _ORDER)

    # ── Fetch sample values for low-cardinality varchar/text columns ──────────
    sample_vals: dict[str, dict[str, list]] = {t: {} for t in ordered}

    with _schema_session() as session:
        for tname in ordered:
            varchar_cols = [
                c["column_name"]
                for c in table_cols[tname]
                if c["data_type"] in ("character varying", "text", "USER-DEFINED")
                and c["column_name"] not in _SKIP_SAMPLE_COLS
            ]
            if not varchar_cols:
                continue

            # One UNION ALL query to count distinct per column
            union = " UNION ALL ".join(
                f"SELECT '{col}' AS col_name, COUNT(DISTINCT \"{col}\") AS cnt "
                f"FROM kirana_kart.{tname}"
                for col in varchar_cols
            )
            try:
                card = session.execute(text(union)).mappings().all()
                low_card = [r["col_name"] for r in card if r["cnt"] is not None and 0 < r["cnt"] <= _MAX_DISTINCT]
                for col in low_card:
                    vals = session.execute(text(
                        f"SELECT DISTINCT \"{col}\" FROM kirana_kart.{tname} "
                        f"WHERE \"{col}\" IS NOT NULL ORDER BY \"{col}\" LIMIT {_MAX_DISTINCT}"
                    )).scalars().all()
                    # Drop values that are too long (policy text, large blobs, etc.)
                    clean = [v for v in vals if v is not None and len(str(v)) <= _MAX_VALUE_LEN]
                    if clean:
                        sample_vals[tname][col] = clean
            except Exception as exc:
                logger.debug("Sample-value query failed for %s: %s", tname, exc)

    # ── Build string ──────────────────────────────────────────────────────────
    lines: list[str] = [
        "KIRANA KART — DATABASE SCHEMA REFERENCE (Schema: kirana_kart)",
        "=" * 65,
        "Use ONLY these tables and columns. Always prefix: kirana_kart.<table>.",
        "All date/time columns are TIMESTAMPTZ unless noted otherwise.",
        "",
    ]

    for idx, tname in enumerate(ordered, 1):
        cols = table_cols[tname]
        rcount = row_counts.get(tname, 0)
        lines.append(f"{idx}. {tname}   (~{rcount:,} rows)")

        for col in cols:
            cname  = col["column_name"]
            dtype  = col["data_type"]
            nullable = col["is_nullable"] == "YES"
            is_pk  = cname in pk_map[tname]

            # Friendlier type label
            udt = col.get("udt_name", "")
            if dtype == "character varying":
                type_label = "VARCHAR"
            elif dtype == "timestamp with time zone":
                type_label = "TIMESTAMPTZ"
            elif dtype == "USER-DEFINED" and udt:
                type_label = udt.upper()
            else:
                type_label = dtype.upper().replace("INTEGER", "INT")

            flags: list[str] = []
            if is_pk:
                flags.append("PK")
            elif not nullable:
                flags.append("NOT NULL")
            if cname in fk_map[tname]:
                flags.append(f"→ {fk_map[tname][cname]}")

            # Sample values annotation
            sv = sample_vals[tname].get(cname)
            sv_note = f"  ({' | '.join(str(v) for v in sv)})" if sv else ""

            flag_note = f"  [{', '.join(flags)}]" if flags else ""
            comment = col_comments[tname].get(cname)
            comment_note = f"  -- {comment}" if comment else ""
            lines.append(f"   {cname:<38}{type_label:<18}{flag_note}{sv_note}{comment_note}")

        lines.append("")

    # ── Warn LLM about empty tables so it never INNER JOINs them ────────────
    empty_tables = [t for t in ordered if row_counts.get(t, 0) == 0]
    if empty_tables:
        lines += [
            "⚠  EMPTY TABLES (0 rows) — NEVER USE THESE IN INNER JOINs — DOING SO RETURNS ZERO RESULTS:",
            *[f"   • kirana_kart.{t}" for t in empty_tables],
            "   If you must reference them, use LEFT JOIN only and handle NULLs.",
            "   → For issue / topic classification use ticket_execution_summary.issue_l1 and issue_l2 directly.",
            "   → Do NOT join issue_taxonomy — it is empty.",
            "   → Do NOT join conversation_turns — it is empty.",
            "",
        ]

    lines += [
        "⚠  CRITICAL RULES FOR SEGMENT / PLATFORM FILTER:",
        "   • customers.segment holds the delivery platform: swiggy | blinkit | zomato | zepto | instamart | dunzo",
        "   • ticket_execution_summary and orders have NO segment / module / platform column.",
        "   • To filter by segment you MUST join customers:",
        "       JOIN kirana_kart.customers cu ON <main_table>.customer_id = cu.customer_id",
        "       WHERE cu.segment = '<segment_value>'",
        "   • NEVER write tes.segment, tes.module, o.segment — those columns do not exist.",
        "",
        "⚠  OTHER NOTES:",
        "   • csat_responses.rating is 1–5; CSAT score = AVG(rating) * 20 → 0–100 scale",
        "   • execution_metrics.duration_ms is milliseconds; divide by 1000 for seconds",
        "   • ticket_execution_summary.customer_id links to customers.customer_id",
        "   • conversations.ticket_id = ticket_execution_summary.ticket_id (1-to-1)",
        "   • Churn column exact name: customers.customer_churn_probability (NOT churn_probability, NOT churn_score)",
        "   • ⚠ NEVER filter kirana_kart.customers by any date (signup_date, churn_last_updated, etc.).",
        "     Customer queries: WHERE cu.segment = '<seg>' ONLY — absolutely NO date condition.",
        "     WRONG: WHERE cu.signup_date >= '2026-01-01' AND cu.segment = 'zomato'",
        "     RIGHT: WHERE cu.segment = 'zomato'",
        "   • For issue / topic breakdowns use ticket_execution_summary.issue_l1 and issue_l2 directly.",
        "     WRONG: JOIN kirana_kart.issue_taxonomy it ON tes.issue_l1 = it.code",
        "     RIGHT:  SELECT tes.issue_l1, COUNT(*) FROM kirana_kart.ticket_execution_summary tes ...",
    ]

    return "\n".join(lines)
