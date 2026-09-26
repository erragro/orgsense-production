"""
A failed runtime preparation is recorded as failed (PostgreSQL).

Policy Studio's approver waits for policy_versions.vector_status. The failure
path used to roll back the job's 'in_progress' status and then update a
column that does not exist (error_message), so the job stayed pending and
was retried every poll, and the proposal showed 'pending' with no way to
retry — reproduced on the docker-compose stack with a wrong embedding size.
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
    version = "vec-it-" + uuid.uuid4().hex[:8]
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO kirana_kart.policy_versions (policy_version, kb_id, vector_status)
            VALUES (:v, 'default', 'pending')
        """), {"v": version})
        conn.execute(text("""
            INSERT INTO kirana_kart.kb_vector_jobs (version_label, status, kb_id)
            VALUES (:v, 'pending', 'default')
        """), {"v": version})
    yield engine, version
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM kirana_kart.kb_vector_jobs WHERE version_label = :v"), {"v": version})
        conn.execute(text("DELETE FROM kirana_kart.policy_versions WHERE policy_version = :v"), {"v": version})
    engine.dispose()


def test_failed_preparation_is_recorded_and_not_retried_forever(db, monkeypatch):
    import psycopg2
    from app.l45_ml_platform.vectorization import vector_service

    engine, version = db
    url = engine.url
    service = object.__new__(vector_service.VectorService)     # no embedding / Weaviate clients needed
    monkeypatch.setattr(service, "_get_connection", lambda: psycopg2.connect(
        host=url.host, port=url.port, dbname=url.database, user=url.username, password=url.password))

    def boom(conn, policy_version):
        raise RuntimeError("Unexpected embedding dimension: 1536")
    monkeypatch.setattr(service, "_vectorize_policy", boom)

    with pytest.raises(RuntimeError):
        service.run_pending_jobs()

    with engine.connect() as conn:
        job = conn.execute(text("""
            SELECT status, error FROM kirana_kart.kb_vector_jobs WHERE version_label = :v
        """), {"v": version}).mappings().one()
        status = conn.execute(text("""
            SELECT vector_status FROM kirana_kart.policy_versions WHERE policy_version = :v
        """), {"v": version}).scalar()
    assert job["status"] == "failed" and "embedding dimension" in job["error"]
    assert status == "failed"      # the approver sees it and can retry preparation
