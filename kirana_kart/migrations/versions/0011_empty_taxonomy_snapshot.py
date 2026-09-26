"""Let the first issue be added to an empty taxonomy.

create_taxonomy_snapshot() stored jsonb_agg() of issue_taxonomy, which is
NULL for an empty table, in the NOT NULL snapshot_data column. Every add
snapshots first, so a new installation could never add its first customer
problem, and Policy Studio (which only maps SOPs onto live codes) could
never write a rule. An empty taxonomy now snapshots as [].
"""
from alembic import op
revision = '0011_empty_taxonomy_snapshot'
down_revision = '0010_policy_knowledge'
branch_labels = None
depends_on = None

_FUNCTION = """
CREATE OR REPLACE FUNCTION kirana_kart.create_taxonomy_snapshot(p_label character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    existing_count INT;
BEGIN
    SELECT COUNT(*) INTO existing_count
    FROM kirana_kart.issue_taxonomy_versions
    WHERE version_label = p_label;

    IF existing_count > 0 THEN
        RAISE EXCEPTION 'Snapshot version already exists: %%', p_label;
    END IF;

    INSERT INTO kirana_kart.issue_taxonomy_versions
    (version_label, created_by, snapshot_data)
    VALUES
    (
        p_label,
        current_user,
        %s
    );
END;
$$
"""


def upgrade():
    op.execute(_FUNCTION % "(SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM kirana_kart.issue_taxonomy t)")


def downgrade():
    op.execute(_FUNCTION % "(SELECT jsonb_agg(t) FROM kirana_kart.issue_taxonomy t)")
