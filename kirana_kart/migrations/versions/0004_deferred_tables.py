"""Move lazily created and omitted operational tables into deploy-time schema."""
from pathlib import Path
from alembic import op
revision = '0004_deferred_tables'
down_revision = '0003_operational_contracts'
branch_labels = None
depends_on = None


def upgrade():
    sql = (Path(__file__).parents[1] / 'sql/0004_deferred_tables.sql').read_text()
    op.get_bind().exec_driver_sql(sql, execution_options={'no_parameters': True})


def downgrade():
    op.execute('DROP TRIGGER orders_queue_risk_refresh ON kirana_kart.orders')
    op.execute('DROP TRIGGER complaints_queue_risk_refresh ON kirana_kart.complaints')
    op.execute('DROP FUNCTION kirana_kart.queue_risk_profile_refresh()')
    for table in ('risk_profile_change_log','customer_risk_profile','complaints','deduplication_log',
                  'spike_reports','conversation_qa_scores','agent_quality_flags'):
        op.execute(f'DROP TABLE kirana_kart.{table}')
