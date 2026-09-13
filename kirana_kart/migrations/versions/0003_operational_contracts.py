"""Reproduce enrichment columns and track grievance response deadlines."""
from alembic import op

revision = '0003_operational_contracts'
down_revision = '0002_customer_pii'
branch_labels = None
depends_on = None

# These fields are already read by the Cardinal customer profile query; the
# repository's historical export predates them. Defaults preserve unknown data.
CUSTOMER_COLUMNS = {
    'is_blocked': 'BOOLEAN NOT NULL DEFAULT FALSE', 'block_reason': 'TEXT',
    'membership_tier': "TEXT DEFAULT 'STANDARD'", 'lifetime_value': 'NUMERIC DEFAULT 0',
    'total_refunds': 'INTEGER DEFAULT 0', 'total_refund_amount': 'NUMERIC DEFAULT 0',
    'dietary_preference': 'TEXT', 'vip_flag': 'BOOLEAN DEFAULT FALSE',
    'abuse_incident_count': 'INTEGER DEFAULT 0', 'chargebacks_count': 'INTEGER DEFAULT 0',
}


def upgrade():
    for name, definition in CUSTOMER_COLUMNS.items():
        op.execute(f'ALTER TABLE kirana_kart.customers ADD COLUMN IF NOT EXISTS {name} {definition}')
    op.execute("""ALTER TABLE kirana_kart.grievances
        ADD COLUMN due_at TIMESTAMPTZ,
        ADD COLUMN owner_user_id INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL""")
    op.execute("UPDATE kirana_kart.grievances SET due_at=created_at + INTERVAL '30 days'")
    op.execute("ALTER TABLE kirana_kart.grievances ALTER COLUMN due_at SET NOT NULL, ALTER COLUMN due_at SET DEFAULT (NOW() + INTERVAL '30 days')")
    op.execute("CREATE INDEX ix_grievances_due ON kirana_kart.grievances(due_at) WHERE resolved_at IS NULL")


def downgrade():
    op.execute('DROP INDEX kirana_kart.ix_grievances_due')
    op.execute('ALTER TABLE kirana_kart.grievances DROP COLUMN owner_user_id, DROP COLUMN due_at')
    # Enrichment columns may predate Alembic on an adopted live database. Keep
    # them on downgrade so rollback never deletes pre-existing business data.
