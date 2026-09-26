"""Policy Studio: closed taxonomy mapping, editable SOP knowledge, retained edits.

* policy_taxonomy_gaps — customer problems an SOP describes that the live
  taxonomy has no code for. Policy Studio no longer creates issue codes; a
  gap waits for a taxonomy admin, then a reviewer maps it to the new code.
* policy_knowledge_chunks — reviewable passages of an SOP, with the source
  quote they came from, versioned with the proposal (entity_id) and used at
  runtime as Stage 1 decision context and Stage 3 reply text.
* policy_variables — tenant values ({{support_hours}}, ...) that chunks embed,
  per knowledge base and optionally per business line.
* rule_edit_log gains the business line and a field-level AI-vs-human diff,
  plus 'proposed' for AI output nobody has reviewed yet (it was logged as
  'accepted'), so the next extraction learns from what reviewers changed.
"""
from alembic import op
revision = '0010_policy_knowledge'
down_revision = '0009_rule_decisions'
branch_labels = None
depends_on = None

_OLD_STAGES = "'taxonomy','action','rule'"
_NEW_STAGES = "'taxonomy','action','rule','chunk','gap','variable'"
_OLD_EDITS = "'accepted','edited','rejected','manual_add'"
_NEW_EDITS = "'accepted','edited','rejected','manual_add','proposed'"


def _checks(stages: str, edits: str) -> None:
    op.execute('ALTER TABLE kirana_kart.rule_edit_log DROP CONSTRAINT rule_edit_log_stage_check')
    op.execute('ALTER TABLE kirana_kart.rule_edit_log DROP CONSTRAINT rule_edit_log_edit_type_check')
    op.execute(f'ALTER TABLE kirana_kart.rule_edit_log ADD CONSTRAINT rule_edit_log_stage_check '
               f'CHECK (stage IN ({stages}))')
    op.execute(f'ALTER TABLE kirana_kart.rule_edit_log ADD CONSTRAINT rule_edit_log_edit_type_check '
               f'CHECK (edit_type IN ({edits}))')


def upgrade():
    op.execute("""
        CREATE TABLE kirana_kart.policy_taxonomy_gaps (
            id                    SERIAL PRIMARY KEY,
            kb_id                 TEXT NOT NULL,
            entity_id             TEXT NOT NULL,
            business_line         TEXT,
            label                 VARCHAR(255) NOT NULL,
            description           TEXT,
            suggested_code        VARCHAR(80),
            suggested_parent_code VARCHAR(80),
            source_excerpt        TEXT,
            extraction_confidence DOUBLE PRECISION,
            status                TEXT NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open', 'mapped', 'dismissed')),
            mapped_issue_code     VARCHAR(80),
            resolution_note       TEXT,
            resolved_by           INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            resolved_at           TIMESTAMPTZ,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (status <> 'mapped' OR mapped_issue_code IS NOT NULL)
        )
    """)
    op.execute('CREATE INDEX ix_policy_taxonomy_gaps_kb_status '
               'ON kirana_kart.policy_taxonomy_gaps (kb_id, status)')
    op.execute('CREATE INDEX ix_policy_taxonomy_gaps_entity '
               'ON kirana_kart.policy_taxonomy_gaps (kb_id, entity_id)')

    op.execute("""
        CREATE TABLE kirana_kart.policy_knowledge_chunks (
            id             SERIAL PRIMARY KEY,
            kb_id          TEXT NOT NULL,
            entity_id      TEXT NOT NULL,
            chunk_key      VARCHAR(40) NOT NULL,
            business_line  TEXT,
            title          VARCHAR(200) NOT NULL,
            body           TEXT NOT NULL,
            issue_codes    TEXT[] NOT NULL DEFAULT '{}',
            purpose        TEXT NOT NULL DEFAULT 'both'
                           CHECK (purpose IN ('decision', 'response', 'both')),
            source_excerpt TEXT,
            source_start   INTEGER,
            source_end     INTEGER,
            origin         TEXT NOT NULL CHECK (origin IN ('ai', 'human')),
            status         TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'edited', 'rejected')),
            llm_output     JSONB,
            edit_reason    TEXT,
            edited_by      INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            edited_at      TIMESTAMPTZ,
            sort_order     INTEGER NOT NULL DEFAULT 0,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kb_id, entity_id, chunk_key)
        )
    """)
    op.execute("""CREATE INDEX ix_policy_knowledge_chunks_live
        ON kirana_kart.policy_knowledge_chunks (entity_id, sort_order)
        WHERE status IN ('accepted', 'edited')""")

    op.execute("""
        CREATE TABLE kirana_kart.policy_variables (
            id            SERIAL PRIMARY KEY,
            kb_id         TEXT NOT NULL,
            business_line TEXT NOT NULL DEFAULT '',
            name          VARCHAR(50) NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,49}$'),
            value         TEXT NOT NULL,
            description   TEXT,
            updated_by    INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kb_id, business_line, name)
        )
    """)

    op.execute('ALTER TABLE kirana_kart.draft_taxonomy_proposals ADD COLUMN source_excerpt TEXT')
    op.execute('ALTER TABLE kirana_kart.draft_action_proposals ADD COLUMN source_excerpt TEXT')

    op.execute('ALTER TABLE kirana_kart.rule_edit_log ADD COLUMN business_line TEXT')
    op.execute('ALTER TABLE kirana_kart.rule_edit_log ADD COLUMN field_changes JSONB')
    _checks(_NEW_STAGES, _NEW_EDITS)
    op.execute("""CREATE INDEX ix_rule_edit_log_lessons
        ON kirana_kart.rule_edit_log (kb_id, created_at DESC)
        WHERE edit_type IN ('edited', 'rejected', 'manual_add')""")


def downgrade():
    # Rows the old constraints cannot hold are removed; they only exist
    # because this revision was applied.
    op.execute('DROP INDEX kirana_kart.ix_rule_edit_log_lessons')
    op.execute(f"DELETE FROM kirana_kart.rule_edit_log WHERE stage NOT IN ({_OLD_STAGES}) "
               f"OR edit_type NOT IN ({_OLD_EDITS})")
    _checks(_OLD_STAGES, _OLD_EDITS)
    op.execute('ALTER TABLE kirana_kart.rule_edit_log DROP COLUMN field_changes')
    op.execute('ALTER TABLE kirana_kart.rule_edit_log DROP COLUMN business_line')
    op.execute('ALTER TABLE kirana_kart.draft_action_proposals DROP COLUMN source_excerpt')
    op.execute('ALTER TABLE kirana_kart.draft_taxonomy_proposals DROP COLUMN source_excerpt')
    op.execute('DROP TABLE kirana_kart.policy_variables')
    op.execute('DROP TABLE kirana_kart.policy_knowledge_chunks')
    op.execute('DROP TABLE kirana_kart.policy_taxonomy_gaps')
