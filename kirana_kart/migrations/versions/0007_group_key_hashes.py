"""Replace legacy group credentials with one-way hashes."""
import hashlib
from alembic import op
from sqlalchemy import text
revision = '0007_group_key_hashes'
down_revision = '0006_session_versions'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    rows = conn.execute(text("SELECT id,api_key FROM kirana_kart.crm_group_integrations WHERE api_key IS NOT NULL AND api_key NOT LIKE 'sha256:%'")).all()
    for row in rows:
        conn.execute(text('UPDATE kirana_kart.crm_group_integrations SET api_key=:key WHERE id=:id'),
                     {'id': row.id, 'key': 'sha256:' + hashlib.sha256(row.api_key.encode()).hexdigest()})


def downgrade():
    # Intentionally do not recreate plaintext credentials. Issue replacement keys
    # if rolling back to a consumer that expects legacy plaintext storage.
    pass
