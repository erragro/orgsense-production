"""Record what Policy Studio rules decided (or would have decided) per ticket.

Stage 2 now evaluates rules deterministically. In observe mode the outcome is
unchanged and this column is the evidence for switching to enforce; in
enforce mode it records which rule set the decision.
"""
from alembic import op
revision = '0009_rule_decisions'
down_revision = '0008_policy_studio_lifecycle'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE kirana_kart.llm_output_3 ADD COLUMN rule_decision JSONB')
    op.execute("""CREATE INDEX ix_llm_output_3_rule_decision_recent
        ON kirana_kart.llm_output_3 (created_at DESC) WHERE rule_decision IS NOT NULL""")


def downgrade():
    op.execute('DROP INDEX kirana_kart.ix_llm_output_3_rule_decision_recent')
    op.execute('ALTER TABLE kirana_kart.llm_output_3 DROP COLUMN rule_decision')
