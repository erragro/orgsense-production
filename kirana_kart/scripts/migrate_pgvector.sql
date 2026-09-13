-- =============================================================
-- pgvector migration — run once on Cloud SQL
-- =============================================================
-- Replaces Weaviate with PostgreSQL vector tables.
-- Safe to run multiple times (all statements are idempotent).
--
-- Note: IVFFlat/HNSW indexes are capped at 2000 dims in pgvector
-- <= 0.8.x for float32. text-embedding-3-large = 3072 dims, so we
-- use sequential / exact cosine search (fine for thousands of rows).
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- KB Rule Vectors (replaces Weaviate KBRule class)
CREATE TABLE IF NOT EXISTS kirana_kart.kb_rule_vectors (
    rule_id         TEXT    NOT NULL,
    policy_version  TEXT    NOT NULL,
    embedding       vector(3072) NOT NULL,
    semantic_text   TEXT    NOT NULL DEFAULT '',
    module_name     TEXT,
    rule_type       TEXT,
    action_code_id  TEXT,
    action_name     TEXT,
    PRIMARY KEY (rule_id, policy_version)
);

-- Issue Type Vectors (replaces Weaviate IssueType class)
CREATE TABLE IF NOT EXISTS kirana_kart.issue_type_vectors (
    issue_code      TEXT    NOT NULL,
    corpus_version  TEXT    NOT NULL,
    embedding       vector(3072) NOT NULL,
    semantic_text   TEXT    NOT NULL DEFAULT '',
    label           TEXT,
    description     TEXT,
    level           INT,
    is_active       BOOLEAN,
    PRIMARY KEY (issue_code, corpus_version)
);

-- Action Registry Vectors (replaces Weaviate ActionRegistry class)
CREATE TABLE IF NOT EXISTS kirana_kart.action_registry_vectors (
    action_code_id      TEXT    NOT NULL,
    corpus_version      TEXT    NOT NULL,
    embedding           vector(3072) NOT NULL,
    semantic_text       TEXT    NOT NULL DEFAULT '',
    action_key          TEXT,
    action_name         TEXT,
    action_description  TEXT,
    requires_refund         BOOLEAN,
    requires_escalation     BOOLEAN,
    automation_eligible     BOOLEAN,
    PRIMARY KEY (action_code_id, corpus_version)
);

-- Verify row counts
SELECT 'kb_rule_vectors'        AS table_name, COUNT(*) FROM kirana_kart.kb_rule_vectors
UNION ALL
SELECT 'issue_type_vectors',      COUNT(*) FROM kirana_kart.issue_type_vectors
UNION ALL
SELECT 'action_registry_vectors', COUNT(*) FROM kirana_kart.action_registry_vectors;
