"""
The first customer problem can be added to an empty taxonomy (migration 0011).

Every taxonomy add snapshots the table first; an empty table used to
snapshot as NULL into a NOT NULL column, so a new installation could not add
any issue code, and Policy Studio could not map an SOP to anything.
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

pytestmark = pytest.mark.integration


@pytest.fixture
def db():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database")
    if not make_url(url).database.endswith("_test"):
        pytest.fail("Integration database name must end in _test")
    engine = create_engine(url, hide_parameters=True)
    yield engine
    engine.dispose()


def test_empty_taxonomy_snapshots_as_an_empty_list(db):
    label = "it-empty-" + uuid.uuid4().hex[:8]
    conn = db.connect()
    trans = conn.begin()
    try:
        # Empty the taxonomy inside this transaction only (rolled back below);
        # issue_taxonomy forbids deletes, so triggers are skipped for it.
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        conn.execute(text("DELETE FROM kirana_kart.issue_taxonomy"))
        conn.execute(text("SELECT kirana_kart.create_taxonomy_snapshot(:label)"), {"label": label})
        snapshot = conn.execute(text("""
            SELECT snapshot_data FROM kirana_kart.issue_taxonomy_versions WHERE version_label = :label
        """), {"label": label}).scalar()
        assert snapshot == []
    finally:
        trans.rollback()
        conn.close()
