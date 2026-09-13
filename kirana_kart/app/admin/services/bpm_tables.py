"""
app/admin/services/bpm_tables.py
==================================
DDL bootstrap for:
  - Multi-KB architecture (knowledge_bases, kb_user_access)
  - kb_id migration on existing tables (idempotent ALTER TABLE)
  - BPM lifecycle tables (process_definitions, instances, transitions, approvals, gate_results)
  - ML infrastructure (ml_training_samples, ml_model_registry)
  - QA flags (qa_flag_overrides)

All operations are idempotent — safe to call on every startup.
"""

import logging
from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger("kirana_kart.bpm_tables")


# ============================================================
# MULTI-KB FOUNDATION
# ============================================================

_KNOWLEDGE_BASES_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.knowledge_bases (
    id          SERIAL PRIMARY KEY,
    kb_id       TEXT UNIQUE NOT NULL,
    kb_name     TEXT NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the default KB that owns all pre-existing data
INSERT INTO kirana_kart.knowledge_bases (kb_id, kb_name, description)
VALUES ('default', 'Default KB', 'Default knowledge base (migrated from single-KB setup)')
ON CONFLICT (kb_id) DO NOTHING;
"""

_KB_USER_ACCESS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.kb_user_access (
    id          SERIAL PRIMARY KEY,
    kb_id       TEXT NOT NULL REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('view', 'edit', 'admin')),
    granted_by  INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kb_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_user_access_kb   ON kirana_kart.kb_user_access(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_user_access_user ON kirana_kart.kb_user_access(user_id);
"""

# Idempotent ALTER TABLE — adds kb_id to existing tables pointing them to 'default'
_KB_ID_MIGRATIONS = [
    # (table_name, column definition)
    ("knowledge_base_raw_uploads",  "TEXT NOT NULL DEFAULT 'default'"),
    ("knowledge_base_versions",     "TEXT NOT NULL DEFAULT 'default'"),
    ("rule_registry",               "TEXT NOT NULL DEFAULT 'default'"),
    ("policy_versions",             "TEXT NOT NULL DEFAULT 'default'"),
    ("kb_vector_jobs",              "TEXT NOT NULL DEFAULT 'default'"),
    ("issue_taxonomy",              "TEXT NOT NULL DEFAULT 'default'"),
    ("issue_taxonomy_versions",     "TEXT NOT NULL DEFAULT 'default'"),
    ("taxonomy_runtime_config",     "TEXT NOT NULL DEFAULT 'default'"),
]

# kb_runtime_config is special: needs kb_id + FK + unique constraint
_KB_RUNTIME_CONFIG_MIGRATION = """
DO $$
BEGIN
    -- Add kb_id column if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'kirana_kart'
          AND table_name   = 'kb_runtime_config'
          AND column_name  = 'kb_id'
    ) THEN
        ALTER TABLE kirana_kart.kb_runtime_config
            ADD COLUMN kb_id TEXT NOT NULL DEFAULT 'default';

        -- Update the single existing row (if any) to default KB
        UPDATE kirana_kart.kb_runtime_config SET kb_id = 'default';

        -- Unique: one runtime config row per KB
        ALTER TABLE kirana_kart.kb_runtime_config
            ADD CONSTRAINT kb_runtime_config_kb_id_unique UNIQUE (kb_id);
    END IF;
END $$;
"""


# ============================================================
# BPM PROCESS TABLES
# ============================================================

_BPM_PROCESS_DEFINITIONS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.bpm_process_definitions (
    id              SERIAL PRIMARY KEY,
    process_name    TEXT UNIQUE NOT NULL,
    kb_id           TEXT REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    -- ordered list of stages as JSON array of stage names
    stages          JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- gate configuration per stage: {stage: {threshold: N, metric: "..."}}
    gate_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- ml confidence thresholds per model: {model_name: threshold}
    ml_thresholds   JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default KB policy process definition
INSERT INTO kirana_kart.bpm_process_definitions (
    process_name, kb_id, stages, gate_config, ml_thresholds
)
VALUES (
    'kb_policy_lifecycle',
    'default',
    '["DRAFT","AI_COMPILE_QUEUED","AI_COMPILE_FAILED","RULE_EDIT",
      "SIMULATION_GATE","SIMULATION_FAILED","SHADOW_GATE",
      "SHADOW_DIVERGENCE_HIGH","PENDING_APPROVAL","REJECTED","ACTIVE",
      "ROLLBACK_PENDING","RETIRED"]'::jsonb,
    '{
        "SIMULATION_GATE": {"max_change_rate": 0.20},
        "SHADOW_GATE": {"min_tickets": 500, "max_divergence_rate": 0.10}
    }'::jsonb,
    '{"rule_extractor": 0.75, "gate_predictor": 0.80}'::jsonb
)
ON CONFLICT (process_name) DO NOTHING;

-- Taxonomy process definition (lighter — no simulation/shadow)
INSERT INTO kirana_kart.bpm_process_definitions (
    process_name, kb_id, stages, gate_config, ml_thresholds
)
VALUES (
    'taxonomy_lifecycle',
    'default',
    '["DRAFT","DIFF_REVIEW","PENDING_APPROVAL","REJECTED","ACTIVE","ROLLBACK_PENDING","RETIRED"]'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb
)
ON CONFLICT (process_name) DO NOTHING;
"""

_BPM_PROCESS_INSTANCES_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.bpm_process_instances (
    id              SERIAL PRIMARY KEY,
    kb_id           TEXT NOT NULL REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    process_name    TEXT NOT NULL REFERENCES kirana_kart.bpm_process_definitions(process_name),
    -- entity being governed: version label for KB, or snapshot label for taxonomy
    entity_id       TEXT NOT NULL,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('kb_version', 'taxonomy_version')),
    current_stage   TEXT NOT NULL DEFAULT 'DRAFT',
    created_by_id   INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    -- store ML prediction results for the current gate
    ml_predictions  JSONB DEFAULT '{}'::jsonb,
    -- extra metadata (e.g., rule count at each stage)
    metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bpm_instances_kb       ON kirana_kart.bpm_process_instances(kb_id);
CREATE INDEX IF NOT EXISTS idx_bpm_instances_stage    ON kirana_kart.bpm_process_instances(current_stage);
CREATE INDEX IF NOT EXISTS idx_bpm_instances_entity   ON kirana_kart.bpm_process_instances(entity_id, entity_type);
"""

_BPM_STAGE_TRANSITIONS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.bpm_stage_transitions (
    id              SERIAL PRIMARY KEY,
    instance_id     INTEGER NOT NULL REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE,
    from_stage      TEXT NOT NULL,
    to_stage        TEXT NOT NULL,
    actor_id        INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    actor_name      TEXT,
    notes           TEXT,
    transition_data JSONB DEFAULT '{}'::jsonb,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bpm_transitions_instance ON kirana_kart.bpm_stage_transitions(instance_id);
CREATE INDEX IF NOT EXISTS idx_bpm_transitions_at       ON kirana_kart.bpm_stage_transitions(transitioned_at DESC);
"""

_BPM_APPROVALS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.bpm_approvals (
    id              SERIAL PRIMARY KEY,
    instance_id     INTEGER NOT NULL REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE,
    stage           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    requested_by_id INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    requested_by    TEXT,
    reviewer_id     INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    reviewer_name   TEXT,
    review_notes    TEXT,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bpm_approvals_instance ON kirana_kart.bpm_approvals(instance_id);
CREATE INDEX IF NOT EXISTS idx_bpm_approvals_status   ON kirana_kart.bpm_approvals(status);
"""

_BPM_GATE_RESULTS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.bpm_gate_results (
    id              SERIAL PRIMARY KEY,
    instance_id     INTEGER NOT NULL REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE,
    gate_type       TEXT NOT NULL CHECK (gate_type IN ('simulation', 'shadow', 'diff_review')),
    passed          BOOLEAN NOT NULL,
    -- key metrics from the gate run
    metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- simulation: baseline_version, candidate_version, change_rate, tickets_tested
    -- shadow: tickets_tested, divergence_rate, divergence_by_action
    -- diff_review: rules_added, rules_removed, rules_changed
    ml_prediction   JSONB DEFAULT NULL,
    ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bpm_gate_results_instance ON kirana_kart.bpm_gate_results(instance_id);
CREATE INDEX IF NOT EXISTS idx_bpm_gate_results_type     ON kirana_kart.bpm_gate_results(gate_type);
"""


# ============================================================
# ML INFRASTRUCTURE
# ============================================================

_ML_TRAINING_SAMPLES_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.ml_training_samples (
    id                      SERIAL PRIMARY KEY,
    kb_id                   TEXT NOT NULL DEFAULT 'default'
                                REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    model_name              TEXT NOT NULL,
    input_data              JSONB NOT NULL,
    llm_output              JSONB,
    corrected_output        JSONB,
    correction_type         TEXT CHECK (correction_type IN ('accept','edit','delete','manual_add')),
    confidence_at_inference FLOAT,
    model_was_used          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_samples_kb    ON kirana_kart.ml_training_samples(kb_id);
CREATE INDEX IF NOT EXISTS idx_ml_samples_model ON kirana_kart.ml_training_samples(model_name);
CREATE INDEX IF NOT EXISTS idx_ml_samples_type  ON kirana_kart.ml_training_samples(correction_type);
"""

_ML_MODEL_REGISTRY_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.ml_model_registry (
    id                    SERIAL PRIMARY KEY,
    kb_id                 TEXT NOT NULL DEFAULT 'default'
                              REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    model_name            TEXT NOT NULL,
    model_version         TEXT NOT NULL,
    accuracy              FLOAT,
    f1_score              FLOAT,
    training_sample_count INTEGER,
    model_path            TEXT NOT NULL,
    is_active             BOOLEAN NOT NULL DEFAULT FALSE,
    trained_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kb_id, model_name, model_version)
);

CREATE INDEX IF NOT EXISTS idx_ml_registry_kb_model ON kirana_kart.ml_model_registry(kb_id, model_name);
CREATE INDEX IF NOT EXISTS idx_ml_registry_active    ON kirana_kart.ml_model_registry(is_active);
"""


# ============================================================
# QA FLAG OVERRIDES (Six Sigma admin dismiss)
# ============================================================

_QA_FLAG_OVERRIDES_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.qa_flag_overrides (
    id               SERIAL PRIMARY KEY,
    qa_evaluation_id INTEGER NOT NULL REFERENCES kirana_kart.qa_evaluations(id) ON DELETE CASCADE,
    parameter_name   TEXT NOT NULL,
    original_score   NUMERIC(5,4),
    dismiss_reason   TEXT NOT NULL CHECK (
        dismiss_reason IN ('expected_behavior', 'business_exception', 'false_positive')
    ),
    dismiss_notes    TEXT,
    override_by      INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    override_by_name TEXT,
    overridden_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (qa_evaluation_id, parameter_name)
);

CREATE INDEX IF NOT EXISTS idx_qa_flag_overrides_eval ON kirana_kart.qa_flag_overrides(qa_evaluation_id);
"""

# ============================================================
# SOP EXTRACTION — DRAFT PROPOSALS
# ============================================================

_DRAFT_TAXONOMY_PROPOSALS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.draft_taxonomy_proposals (
    id                      SERIAL PRIMARY KEY,
    kb_id                   TEXT NOT NULL
                                REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    entity_id               TEXT NOT NULL,          -- links to the KB version / upload being worked on
    issue_code              VARCHAR(80) NOT NULL,
    label                   VARCHAR(255) NOT NULL,
    description             TEXT,
    parent_code             VARCHAR(80),             -- NULL = L1 root node
    level                   INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    proposal_type           TEXT NOT NULL DEFAULT 'new'
                                CHECK (proposal_type IN ('new', 'update', 'existing')),
    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'rejected', 'edited')),
    llm_output              JSONB,                   -- raw LLM extraction for this node
    user_output             JSONB,                   -- what user changed it to (NULL = accepted as-is)
    edit_reason             TEXT,                    -- required when status = rejected | edited
    extraction_confidence   FLOAT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at               TIMESTAMPTZ,
    edited_by               INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_draft_tax_kb_entity ON kirana_kart.draft_taxonomy_proposals(kb_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_draft_tax_status     ON kirana_kart.draft_taxonomy_proposals(status);
"""

_DRAFT_ACTION_PROPOSALS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.draft_action_proposals (
    id                      SERIAL PRIMARY KEY,
    kb_id                   TEXT NOT NULL
                                REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    entity_id               TEXT NOT NULL,
    action_code_id          VARCHAR(100) NOT NULL,
    action_name             VARCHAR(255) NOT NULL,
    action_description      TEXT,
    exact_action            TEXT,                    -- the precise step-by-step action to execute
    parent_issue_codes      TEXT[] NOT NULL DEFAULT '{}', -- taxonomy codes that trigger this action
    requires_refund         BOOLEAN NOT NULL DEFAULT FALSE,
    requires_escalation     BOOLEAN NOT NULL DEFAULT FALSE,
    automation_eligible     BOOLEAN NOT NULL DEFAULT TRUE,
    proposal_type           TEXT NOT NULL DEFAULT 'new'
                                CHECK (proposal_type IN ('new', 'update', 'existing')),
    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'rejected', 'edited')),
    llm_output              JSONB,
    user_output             JSONB,
    edit_reason             TEXT,
    extraction_confidence   FLOAT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at               TIMESTAMPTZ,
    edited_by               INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_draft_act_kb_entity ON kirana_kart.draft_action_proposals(kb_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_draft_act_status     ON kirana_kart.draft_action_proposals(status);
"""

_EXTRACTION_STANDARDS_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.extraction_standards (
    id              SERIAL PRIMARY KEY,
    kb_id           TEXT NOT NULL UNIQUE
                        REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE,
    standards_md    TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL
);

-- Seed one row per existing KB
INSERT INTO kirana_kart.extraction_standards (kb_id, standards_md)
SELECT kb_id, ''
FROM kirana_kart.knowledge_bases
ON CONFLICT (kb_id) DO NOTHING;
"""

_RULE_EDIT_LOG_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.rule_edit_log (
    id                      SERIAL PRIMARY KEY,
    kb_id                   TEXT NOT NULL DEFAULT 'default',
    entity_id               TEXT,                   -- SOP version this edit belongs to
    stage                   TEXT NOT NULL           -- 'taxonomy' | 'action' | 'rule'
                                CHECK (stage IN ('taxonomy', 'action', 'rule')),
    item_ref                TEXT,                   -- issue_code | action_code_id | rule_id
    edit_type               TEXT NOT NULL           -- 'accepted' | 'edited' | 'rejected' | 'manual_add'
                                CHECK (edit_type IN ('accepted', 'edited', 'rejected', 'manual_add')),
    llm_output              JSONB,
    user_output             JSONB,
    edit_reason             TEXT,
    extraction_confidence   FLOAT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_edit_log_kb       ON kirana_kart.rule_edit_log(kb_id);
CREATE INDEX IF NOT EXISTS idx_rule_edit_log_entity   ON kirana_kart.rule_edit_log(entity_id);
CREATE INDEX IF NOT EXISTS idx_rule_edit_log_stage    ON kirana_kart.rule_edit_log(stage);
"""

# Add exact_action column to master_action_codes if missing
_ACTION_CODES_ENHANCE = """
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='kirana_kart' AND table_name='master_action_codes'
          AND column_name='exact_action'
    ) THEN
        ALTER TABLE kirana_kart.master_action_codes ADD COLUMN exact_action TEXT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='kirana_kart' AND table_name='master_action_codes'
          AND column_name='parent_issue_codes'
    ) THEN
        ALTER TABLE kirana_kart.master_action_codes ADD COLUMN parent_issue_codes TEXT[] DEFAULT '{}';
    END IF;
END $$;
"""

# ============================================================
# AGENT DECISION FEEDBACK (future ML training loop)
# ============================================================

_AGENT_DECISION_FEEDBACK_DDL = """
CREATE TABLE IF NOT EXISTS kirana_kart.agent_decision_feedback (
    id              SERIAL PRIMARY KEY,
    ticket_id       TEXT NOT NULL,
    ai_action_code  TEXT NOT NULL,
    agent_action    TEXT NOT NULL,
    outcome         TEXT CHECK (outcome IN ('accepted','modified','rejected','escalated')),
    agent_notes     TEXT,
    agent_user_id   INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adf_ticket   ON kirana_kart.agent_decision_feedback(ticket_id);
CREATE INDEX IF NOT EXISTS idx_adf_outcome  ON kirana_kart.agent_decision_feedback(outcome);
CREATE INDEX IF NOT EXISTS idx_adf_created  ON kirana_kart.agent_decision_feedback(created_at DESC);
"""


# ============================================================
# MAIN ENTRY POINT
# ============================================================

def ensure_bpm_tables(engine: Engine) -> None:
    """
    Idempotent bootstrap of all BPM, multi-KB, ML, and QA-flag tables.
    Safe to call on every startup.
    """
    with engine.begin() as conn:

        # -- Multi-KB foundation --
        logger.info("BPM tables: creating knowledge_bases...")
        conn.execute(text(_KNOWLEDGE_BASES_DDL))

        logger.info("BPM tables: creating kb_user_access...")
        conn.execute(text(_KB_USER_ACCESS_DDL))

        # -- Add kb_id to existing tables --
        for table, col_def in _KB_ID_MIGRATIONS:
            _add_kb_id_column(conn, table, col_def)

        # kb_runtime_config special migration
        logger.info("BPM tables: migrating kb_runtime_config...")
        conn.execute(text(_KB_RUNTIME_CONFIG_MIGRATION))

        # -- BPM lifecycle tables --
        logger.info("BPM tables: creating bpm_process_definitions...")
        conn.execute(text(_BPM_PROCESS_DEFINITIONS_DDL))

        logger.info("BPM tables: creating bpm_process_instances...")
        conn.execute(text(_BPM_PROCESS_INSTANCES_DDL))

        logger.info("BPM tables: creating bpm_stage_transitions...")
        conn.execute(text(_BPM_STAGE_TRANSITIONS_DDL))

        logger.info("BPM tables: creating bpm_approvals...")
        conn.execute(text(_BPM_APPROVALS_DDL))

        logger.info("BPM tables: creating bpm_gate_results...")
        conn.execute(text(_BPM_GATE_RESULTS_DDL))

        # -- ML infrastructure --
        logger.info("BPM tables: creating ml_training_samples...")
        conn.execute(text(_ML_TRAINING_SAMPLES_DDL))

        logger.info("BPM tables: creating ml_model_registry...")
        conn.execute(text(_ML_MODEL_REGISTRY_DDL))

        # -- QA flags --
        logger.info("BPM tables: creating qa_flag_overrides...")
        conn.execute(text(_QA_FLAG_OVERRIDES_DDL))

        # -- Agent feedback --
        logger.info("BPM tables: creating agent_decision_feedback...")
        conn.execute(text(_AGENT_DECISION_FEEDBACK_DDL))

        # -- SOP extraction draft proposals --
        logger.info("BPM tables: creating draft_taxonomy_proposals...")
        conn.execute(text(_DRAFT_TAXONOMY_PROPOSALS_DDL))

        logger.info("BPM tables: creating draft_action_proposals...")
        conn.execute(text(_DRAFT_ACTION_PROPOSALS_DDL))

        logger.info("BPM tables: creating extraction_standards...")
        conn.execute(text(_EXTRACTION_STANDARDS_DDL))

        logger.info("BPM tables: creating rule_edit_log...")
        conn.execute(text(_RULE_EDIT_LOG_DDL))

        logger.info("BPM tables: enhancing master_action_codes...")
        conn.execute(text(_ACTION_CODES_ENHANCE))

    logger.info("BPM tables bootstrap complete.")


def _add_kb_id_column(conn, table: str, col_def: str) -> None:
    """
    Idempotently add a kb_id column to an existing table.
    Skips silently if the column already exists.
    """
    conn.execute(text(f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'kirana_kart'
                  AND table_name   = '{table}'
                  AND column_name  = 'kb_id'
            ) THEN
                ALTER TABLE kirana_kart.{table}
                    ADD COLUMN kb_id {col_def};

                -- Backfill existing rows to the default KB
                UPDATE kirana_kart.{table} SET kb_id = 'default' WHERE kb_id IS NULL;

                -- Add FK if knowledge_bases exists (it always will — we create it first)
                BEGIN
                    ALTER TABLE kirana_kart.{table}
                        ADD CONSTRAINT fk_{table}_kb_id
                        FOREIGN KEY (kb_id)
                        REFERENCES kirana_kart.knowledge_bases(kb_id)
                        ON DELETE RESTRICT;
                EXCEPTION WHEN duplicate_object THEN
                    NULL;
                END;
            END IF;
        END $$;
    """))
    logger.info("BPM tables: kb_id migration done for %s", table)
