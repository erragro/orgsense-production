"""Preserve operational defaults previously seeded by startup DDL."""
import json
from pathlib import Path
from alembic import op
from sqlalchemy import text
revision = '0005_operational_defaults'
down_revision = '0004_deferred_tables'
branch_labels = None
depends_on = None


def upgrade():
    defaults = json.loads((Path(__file__).parents[1] / 'sql/0005_operational_defaults.json').read_text())
    conn = op.get_bind()
    for row in defaults['schedules']:
        conn.execute(text('''INSERT INTO kirana_kart.cardinal_beat_schedule
            (task_key,task_name,display_name,description,schedule_type,interval_seconds,cron_expression,enabled)
            VALUES (:task_key,:task_name,:display_name,:description,:schedule_type,:interval_seconds,:cron_expression,TRUE)
            ON CONFLICT(task_key) DO NOTHING'''), row)
    for rule in defaults['rules']:
        if conn.execute(text('SELECT 1 FROM kirana_kart.crm_automation_rules WHERE name=:name'),rule).scalar():
            continue
        conn.execute(text('''INSERT INTO kirana_kart.crm_automation_rules
            (name,description,trigger_event,condition_logic,conditions,actions,priority,is_active,is_seeded)
            VALUES (:name,:description,:trigger_event,:condition_logic,CAST(:conditions AS jsonb),CAST(:actions AS jsonb),:priority,TRUE,TRUE)'''),
            {**rule,'conditions':json.dumps(rule['conditions']),'actions':json.dumps(rule['actions'])})


def downgrade():
    # Defaults are operator-editable business configuration. Preserve them on
    # rollback rather than delete a policy an operator may have customised.
    pass
