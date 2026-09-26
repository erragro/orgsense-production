"""A failed runtime preparation is marked failed by job id (see the PostgreSQL test too)."""
from unittest.mock import MagicMock

import pytest

from app.l45_ml_platform.vectorization import vector_service


def _service(conn):
    service = object.__new__(vector_service.VectorService)
    service._get_connection = lambda: conn
    return service


def test_failure_is_recorded_by_job_id_in_the_error_column():
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value = {"id": 7, "version_label": "v1"}
    service = _service(conn)

    def boom(conn, version):
        raise RuntimeError("embedding service down")
    service._vectorize_policy = boom

    with pytest.raises(RuntimeError):
        service.run_pending_jobs()

    failed_sql, failed_params = cur.execute.call_args_list[-2].args
    assert "error = %s" in failed_sql and "error_message" not in failed_sql
    assert failed_params[:2] == ("embedding service down", 7)
    assert "vector_status = 'failed'" in cur.execute.call_args_list[-1].args[0]
    conn.rollback.assert_called_once()
    assert conn.commit.called


def test_long_errors_are_truncated():
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    _service(conn)._mark_failed_job("v1", "x" * 5000, None)
    params = cur.execute.call_args_list[0].args[1]
    assert len(params[0]) == 2000 and params[1:] == (None, None, "v1")
