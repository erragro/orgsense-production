"""Revoke all credentials atomically on administrative password reset."""
from alembic import op
revision = '0006_session_versions'
down_revision = '0005_operational_defaults'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE kirana_kart.users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0')
    op.execute('ALTER TABLE kirana_kart.refresh_tokens ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0')


def downgrade():
    op.execute('DELETE FROM kirana_kart.refresh_tokens')
    op.execute('ALTER TABLE kirana_kart.refresh_tokens DROP COLUMN auth_version')
    op.execute('ALTER TABLE kirana_kart.users DROP COLUMN auth_version')
