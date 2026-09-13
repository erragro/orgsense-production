"""
Postgres pgvector Client
========================

Drop-in replacement for WeaviateClient using PostgreSQL + pgvector extension.

Responsibilities:
- Ensure vector tables exist (CREATE TABLE IF NOT EXISTS)
- Delete vectors by policy_version / corpus_version
- Upsert rule vectors (kb_rule_vectors)
- Upsert corpus objects (issue_type_vectors, action_registry_vectors)
- Query top-k similar vectors with equality filters

All public methods match the WeaviateClient interface exactly so callers
(vector_service, qa_agent_service, retrieval) need only swap the import.

Tables:
  kirana_kart.kb_rule_vectors
  kirana_kart.issue_type_vectors
  kirana_kart.action_registry_vectors

Extension required: CREATE EXTENSION IF NOT EXISTS vector;
"""

import os
import logging
import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from pathlib import Path
from typing import Any
from dotenv import load_dotenv

# ============================================================
# CONFIG
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST     = os.getenv("DB_HOST",     "localhost")
DB_PORT     = os.getenv("DB_PORT",     "5432")
DB_NAME     = os.getenv("DB_NAME",     "orgintelligence")
DB_USER     = os.getenv("DB_USER",     "orguser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

EMBEDDING_DIM = 3072   # text-embedding-3-large

# Class-name constants kept identical to WeaviateClient for import compat
WEAVIATE_CLASS_NAME   = "KBRule"        # → kb_rule_vectors
ISSUE_CLASS_NAME      = "IssueType"     # → issue_type_vectors
ACTION_CLASS_NAME     = "ActionRegistry"# → action_registry_vectors
GUIDELINE_CLASS_NAME  = "Guideline"     # no-op (not used in queries)
IMAGE_RULE_CLASS_NAME = "ImageRule"     # no-op (not used in queries)

# Map class names → table names
_TABLE = {
    WEAVIATE_CLASS_NAME:   "kirana_kart.kb_rule_vectors",
    ISSUE_CLASS_NAME:      "kirana_kart.issue_type_vectors",
    ACTION_CLASS_NAME:     "kirana_kart.action_registry_vectors",
    GUIDELINE_CLASS_NAME:  None,
    IMAGE_RULE_CLASS_NAME: None,
}

logger = logging.getLogger("pgvector_client")
logger.setLevel(logging.INFO)


# ============================================================
# DDL
# ============================================================

_DDL = f"""
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kirana_kart.kb_rule_vectors (
    rule_id         TEXT        NOT NULL,
    policy_version  TEXT        NOT NULL,
    embedding       vector({EMBEDDING_DIM}) NOT NULL,
    semantic_text   TEXT        NOT NULL DEFAULT '',
    module_name     TEXT,
    rule_type       TEXT,
    action_code_id  TEXT,
    action_name     TEXT,
    PRIMARY KEY (rule_id, policy_version)
);

CREATE TABLE IF NOT EXISTS kirana_kart.issue_type_vectors (
    issue_code      TEXT        NOT NULL,
    corpus_version  TEXT        NOT NULL,
    embedding       vector({EMBEDDING_DIM}) NOT NULL,
    semantic_text   TEXT        NOT NULL DEFAULT '',
    label           TEXT,
    description     TEXT,
    level           INT,
    is_active       BOOLEAN,
    PRIMARY KEY (issue_code, corpus_version)
);

CREATE TABLE IF NOT EXISTS kirana_kart.action_registry_vectors (
    action_code_id          TEXT    NOT NULL,
    corpus_version          TEXT    NOT NULL,
    embedding               vector({EMBEDDING_DIM}) NOT NULL,
    semantic_text           TEXT    NOT NULL DEFAULT '',
    action_key              TEXT,
    action_name             TEXT,
    action_description      TEXT,
    requires_refund         BOOLEAN,
    requires_escalation     BOOLEAN,
    automation_eligible     BOOLEAN,
    PRIMARY KEY (action_code_id, corpus_version)
);
"""
# Note: IVFFlat and HNSW indexes cap at 2000 dims (pgvector <=0.8.x for float32).
# text-embedding-3-large uses 3072 dims, so we use sequential scan (exact cosine search).
# For corpora of a few thousand rows this is sub-millisecond — no index needed.


# ============================================================
# PGVECTOR CLIENT
# ============================================================

class PostgresVectorClient:
    """Postgres + pgvector replacement for WeaviateClient."""

    def __init__(self):
        pass
        # Schema is installed by Alembic before deployment, never on import.

    # --------------------------------------------------------
    # INTERNAL HELPERS
    # --------------------------------------------------------

    def _connect(self):
        return pooled_connection()

    def _ensure_schema(self):
        """Create vector tables if they don't exist."""
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(_DDL)
            conn.commit()
            logger.info("pgvector schema verified/created")
        except Exception as e:
            conn.rollback()
            logger.error("Schema init failed: %s", e)
            raise
        finally:
            conn.close()

    # --------------------------------------------------------
    # DELETE
    # --------------------------------------------------------

    def delete_by_policy_version(self, policy_version: str):
        """Delete all kb_rule_vectors for a policy version."""
        logger.info("Deleting kb_rule_vectors for policy_version=%s", policy_version)
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM kirana_kart.kb_rule_vectors WHERE policy_version = %s",
                    (policy_version,)
                )
            conn.commit()
        finally:
            conn.close()

    # --------------------------------------------------------
    # UPSERT RULES (KBRule)
    # --------------------------------------------------------

    def upsert_rules(self, policy_version: str, rules: list[dict[str, Any]]):
        """Batch upsert rule vectors into kb_rule_vectors."""
        if not rules:
            return
        logger.info("Upserting %d rule vectors for version=%s", len(rules), policy_version)

        sql = """
            INSERT INTO kirana_kart.kb_rule_vectors
                (rule_id, policy_version, embedding, semantic_text,
                 module_name, rule_type, action_code_id, action_name)
            VALUES (%s, %s, %s::vector, %s, %s, %s, %s, %s)
            ON CONFLICT (rule_id, policy_version) DO UPDATE SET
                embedding      = EXCLUDED.embedding,
                semantic_text  = EXCLUDED.semantic_text,
                module_name    = EXCLUDED.module_name,
                rule_type      = EXCLUDED.rule_type,
                action_code_id = EXCLUDED.action_code_id,
                action_name    = EXCLUDED.action_name
        """

        conn = self._connect()
        try:
            with conn.cursor() as cur:
                rows = [
                    (
                        r["rule_id"],
                        policy_version,
                        _vec_str(r["vector"]),
                        r.get("semantic_text", ""),
                        r.get("module_name"),
                        r.get("rule_type"),
                        r.get("action_code_id"),
                        r.get("action_name"),
                    )
                    for r in rules
                ]
                psycopg2.extras.execute_batch(cur, sql, rows, page_size=50)
            conn.commit()
        finally:
            conn.close()

    # --------------------------------------------------------
    # UPSERT CORPUS OBJECTS (IssueType / ActionRegistry)
    # --------------------------------------------------------

    def upsert_corpus_objects(
        self,
        class_name: str,
        objects: list[dict[str, Any]],
        id_key: str,
    ):
        """Upsert corpus vectors. class_name must be ISSUE_CLASS_NAME or ACTION_CLASS_NAME."""
        if not objects:
            return

        if class_name == ISSUE_CLASS_NAME:
            self._upsert_issue_types(objects)
        elif class_name == ACTION_CLASS_NAME:
            self._upsert_action_registry(objects)
        else:
            # Guideline / ImageRule — not used in queries, silently skip
            logger.debug("Skipping upsert for unsupported class %s", class_name)

    def _upsert_issue_types(self, objects: list[dict[str, Any]]):
        sql = """
            INSERT INTO kirana_kart.issue_type_vectors
                (issue_code, corpus_version, embedding, semantic_text,
                 label, description, level, is_active)
            VALUES (%s, %s, %s::vector, %s, %s, %s, %s, %s)
            ON CONFLICT (issue_code, corpus_version) DO UPDATE SET
                embedding     = EXCLUDED.embedding,
                semantic_text = EXCLUDED.semantic_text,
                label         = EXCLUDED.label,
                description   = EXCLUDED.description,
                level         = EXCLUDED.level,
                is_active     = EXCLUDED.is_active
        """
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                rows = [
                    (
                        o["issue_code"],
                        o.get("corpus_version", "v1"),
                        _vec_str(o.pop("vector")),
                        o.get("semantic_text", ""),
                        o.get("label"),
                        o.get("description"),
                        o.get("level"),
                        o.get("is_active"),
                    )
                    for o in objects
                ]
                psycopg2.extras.execute_batch(cur, sql, rows, page_size=50)
            conn.commit()
            logger.info("Upserted %d issue_type_vectors", len(objects))
        finally:
            conn.close()

    def _upsert_action_registry(self, objects: list[dict[str, Any]]):
        sql = """
            INSERT INTO kirana_kart.action_registry_vectors
                (action_code_id, corpus_version, embedding, semantic_text,
                 action_key, action_name, action_description,
                 requires_refund, requires_escalation, automation_eligible)
            VALUES (%s, %s, %s::vector, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (action_code_id, corpus_version) DO UPDATE SET
                embedding           = EXCLUDED.embedding,
                semantic_text       = EXCLUDED.semantic_text,
                action_key          = EXCLUDED.action_key,
                action_name         = EXCLUDED.action_name,
                action_description  = EXCLUDED.action_description,
                requires_refund     = EXCLUDED.requires_refund,
                requires_escalation = EXCLUDED.requires_escalation,
                automation_eligible = EXCLUDED.automation_eligible
        """
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                rows = [
                    (
                        o["action_code_id"],
                        o.get("corpus_version", "v1"),
                        _vec_str(o.pop("vector")),
                        o.get("semantic_text", ""),
                        o.get("action_key"),
                        o.get("action_name"),
                        o.get("action_description"),
                        o.get("requires_refund"),
                        o.get("requires_escalation"),
                        o.get("automation_eligible"),
                    )
                    for o in objects
                ]
                psycopg2.extras.execute_batch(cur, sql, rows, page_size=50)
            conn.commit()
            logger.info("Upserted %d action_registry_vectors", len(objects))
        finally:
            conn.close()

    # --------------------------------------------------------
    # QUERY SIMILAR RULES
    # --------------------------------------------------------

    def query_similar_rules(
        self,
        vector: list[float],
        policy_version: str,
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """Return top-k KBRules similar to vector, filtered by policy_version."""
        sql = """
            SELECT rule_id, module_name, rule_type, action_code_id, action_name, semantic_text
            FROM kirana_kart.kb_rule_vectors
            WHERE policy_version = %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """
        conn = self._connect()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (policy_version, _vec_str(vector), top_k))
                return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    # --------------------------------------------------------
    # GENERIC QUERY SIMILAR (IssueType / ActionRegistry)
    # --------------------------------------------------------

    def query_similar(
        self,
        class_name: str,
        vector: list[float],
        filters: dict[str, Any] | None = None,
        top_k: int = 5,
        fields: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Generic similarity search — supports IssueType and ActionRegistry."""
        if class_name == ISSUE_CLASS_NAME:
            return self._query_issue_types(vector, filters, top_k, fields)
        elif class_name == ACTION_CLASS_NAME:
            return self._query_action_registry(vector, filters, top_k, fields)
        else:
            logger.warning("query_similar called for unsupported class %s", class_name)
            return []

    def _query_issue_types(self, vector, filters, top_k, fields):
        corpus_version = _extract_corpus_version(filters)
        select = _build_select(fields, [
            "issue_code", "label", "description", "level", "is_active", "semantic_text"
        ])
        sql = f"""
            SELECT {select}
            FROM kirana_kart.issue_type_vectors
            WHERE corpus_version = %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """
        conn = self._connect()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (corpus_version, _vec_str(vector), top_k))
                return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    def _query_action_registry(self, vector, filters, top_k, fields):
        corpus_version = _extract_corpus_version(filters)
        select = _build_select(fields, [
            "action_code_id", "action_key", "action_name", "action_description",
            "requires_refund", "requires_escalation", "automation_eligible", "semantic_text"
        ])
        sql = f"""
            SELECT {select}
            FROM kirana_kart.action_registry_vectors
            WHERE corpus_version = %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """
        conn = self._connect()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (corpus_version, _vec_str(vector), top_k))
                return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()


# ============================================================
# BACKWARDS-COMPAT ALIAS
# ============================================================

# All callers do: from ...weaviate_client import WeaviateClient
# After swapping the import in weaviate_client.py they transparently get this.
WeaviateClient = PostgresVectorClient


# ============================================================
# UTILITY
# ============================================================

def _vec_str(v: list[float]) -> str:
    """Convert a float list to the PostgreSQL vector literal '[a,b,c,...]'."""
    return "[" + ",".join(str(x) for x in v) + "]"


def _extract_corpus_version(filters: dict | None) -> str:
    """
    Extract corpus_version from a Weaviate-style filter dict.
    Example: {"path": ["corpus_version"], "operator": "Equal", "valueText": "v1"}
    Falls back to 'v1' if not found.
    """
    if not filters:
        return "v1"
    return filters.get("valueText") or "v1"


def _build_select(requested: list[str] | None, allowed: list[str]) -> str:
    """Return comma-separated column list, filtered to allowed set."""
    if not requested:
        return ", ".join(allowed)
    valid = [f for f in requested if f in allowed]
    return ", ".join(valid) if valid else ", ".join(allowed)
