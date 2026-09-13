"""Reconstructed schema baseline, derived from repository schema and legacy DDL.

An existing deployment must compare schema before stamping this revision.
This revision deliberately contains no application or customer data.
"""
from pathlib import Path
from alembic import op

revision = '0001_baseline'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')
    # exec_driver_sql preserves PostgreSQL function bodies and casts verbatim.
    sql = (Path(__file__).parents[1] / 'sql/0001_baseline.sql').read_text()
    op.get_bind().exec_driver_sql(sql, execution_options={"no_parameters": True})
    op.execute("""INSERT INTO kirana_kart.knowledge_bases (kb_id, kb_name, description)
                  VALUES ('default', 'Default KB', 'Default knowledge base')""")
    op.execute("""INSERT INTO kirana_kart.retention_policies
        (data_category, retention_days, action_on_expiry, description) VALUES
        ('customer_pii',1095,'anonymize','Customer identity retention'),
        ('orders',2555,'anonymize','Order retention; requires approved policy'),
        ('conversations',365,'delete','Conversation retention'),
        ('csat_responses',730,'delete','Feedback retention'),
        ('access_logs',365,'delete','Audit retention'),
        ('refresh_tokens',30,'delete','Expired credentials')""")
    op.execute("""INSERT INTO kirana_kart.crm_sla_policies
        (queue_type,resolution_minutes,first_response_minutes) VALUES
        ('ESCALATION_QUEUE',60,15),('SLA_BREACH_REVIEW',120,20),
        ('SENIOR_REVIEW',240,30),('MANUAL_REVIEW',240,30),('STANDARD_REVIEW',480,60)""")


def downgrade():
    # Explicit operator action on the baseline removes the application's schema.
    op.execute('DROP SCHEMA kirana_kart CASCADE')
