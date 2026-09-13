"""Expand customer storage for encrypted identity, leaving data cutover explicit."""
from alembic import op
from sqlalchemy import text

revision = '0002_customer_pii'
down_revision = '0001_baseline'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE kirana_kart.customers ALTER COLUMN date_of_birth TYPE TEXT USING date_of_birth::text')
    op.execute('ALTER TABLE kirana_kart.customers ADD COLUMN email_blind_index TEXT')
    op.execute('CREATE INDEX ix_customers_email_blind_index ON kirana_kart.customers(email_blind_index)')


def downgrade():
    # Never discard ciphertext or indexes while encrypted records still exist.
    remaining = op.get_bind().execute(text("""SELECT EXISTS(SELECT 1 FROM kirana_kart.customers
        WHERE email LIKE 'pii:v1:%' OR phone LIKE 'pii:v1:%' OR date_of_birth LIKE 'pii:v1:%')""")).scalar()
    if remaining:
        raise RuntimeError('Run the PII rollback tool with the original key before downgrading')
    op.execute('DROP INDEX kirana_kart.ix_customers_email_blind_index')
    op.execute('ALTER TABLE kirana_kart.customers DROP COLUMN email_blind_index')
    op.execute('ALTER TABLE kirana_kart.customers ALTER COLUMN date_of_birth TYPE DATE USING date_of_birth::date')
