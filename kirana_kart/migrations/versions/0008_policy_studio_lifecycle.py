"""Reproduce the Policy Studio lifecycle contract on a migrated database.

The BPM engine was written against the retired startup DDL. On a database built
by these migrations it could not run at all:

* BPMService.transition() sets bpm_process_instances.updated_at, which the
  baseline never created, so every stage change raised UndefinedColumn.
* Instances reference bpm_process_definitions by name, which nothing seeds, so
  the Policy Studio upload failed its foreign key before a proposal existed.
* request_approval() supersedes earlier requests with status 'superseded', which
  the status CHECK rejected.
"""
from alembic import op
revision = '0008_policy_studio_lifecycle'
down_revision = '0007_group_key_hashes'
branch_labels = None
depends_on = None

KB_STAGES = ('["DRAFT","AI_COMPILE_QUEUED","AI_COMPILE_FAILED","RULE_EDIT","SIMULATION_GATE",'
             '"SIMULATION_FAILED","SHADOW_GATE","SHADOW_DIVERGENCE_HIGH","PENDING_APPROVAL",'
             '"REJECTED","ACTIVE","ROLLBACK_PENDING","RETIRED"]')
TAXONOMY_STAGES = '["DRAFT","DIFF_REVIEW","PENDING_APPROVAL","REJECTED","ACTIVE","ROLLBACK_PENDING","RETIRED"]'


def upgrade():
    op.execute('ALTER TABLE kirana_kart.bpm_process_instances '
               'ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    op.execute(f"""INSERT INTO kirana_kart.bpm_process_definitions
            (process_name, kb_id, stages, gate_config, ml_thresholds)
        VALUES
            ('kb_policy_lifecycle', 'default', '{KB_STAGES}'::jsonb,
             '{{"SIMULATION_GATE": {{"max_change_rate": 0.20}}}}'::jsonb,
             '{{"rule_extractor": 0.75, "gate_predictor": 0.80}}'::jsonb),
            ('taxonomy_lifecycle', 'default', '{TAXONOMY_STAGES}'::jsonb, '{{}}'::jsonb, '{{}}'::jsonb)
        ON CONFLICT (process_name) DO NOTHING""")
    op.execute('ALTER TABLE kirana_kart.bpm_approvals DROP CONSTRAINT bpm_approvals_status_check')
    op.execute("""ALTER TABLE kirana_kart.bpm_approvals ADD CONSTRAINT bpm_approvals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'))""")
    # Keep only the newest open request per stage before enforcing uniqueness.
    op.execute("""UPDATE kirana_kart.bpm_approvals a SET status = 'superseded'
        WHERE a.status = 'pending' AND EXISTS (
            SELECT 1 FROM kirana_kart.bpm_approvals b
            WHERE b.instance_id = a.instance_id AND b.stage = a.stage
              AND b.status = 'pending' AND b.id > a.id)""")
    op.execute("""CREATE UNIQUE INDEX ux_bpm_approvals_one_pending
        ON kirana_kart.bpm_approvals (instance_id, stage) WHERE status = 'pending'""")


def downgrade():
    op.execute('DROP INDEX kirana_kart.ux_bpm_approvals_one_pending')
    # 'superseded' requests were never decided; the narrower CHECK can only
    # hold them as rejected. The note keeps the audit meaning.
    op.execute("""UPDATE kirana_kart.bpm_approvals
        SET status = 'rejected',
            review_notes = COALESCE(review_notes || ' ', '') || '[superseded by a later request]'
        WHERE status = 'superseded'""")
    op.execute('ALTER TABLE kirana_kart.bpm_approvals DROP CONSTRAINT bpm_approvals_status_check')
    op.execute("""ALTER TABLE kirana_kart.bpm_approvals ADD CONSTRAINT bpm_approvals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected'))""")
    op.execute('ALTER TABLE kirana_kart.bpm_process_instances DROP COLUMN updated_at')
    # Process definitions are referenced by existing instances and may predate
    # Alembic on an adopted database; they are preserved on rollback.
