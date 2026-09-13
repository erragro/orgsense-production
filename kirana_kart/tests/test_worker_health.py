from io import BytesIO
from unittest.mock import MagicMock
import worker_health


def test_worker_process_exit_is_unhealthy(monkeypatch):
    child = MagicMock()
    child.poll.return_value = 1
    monkeypatch.setattr(worker_health, 'child', child)
    handler = object.__new__(worker_health.HealthHandler)
    handler.path = '/health'
    handler.wfile = BytesIO()
    handler.send_response = MagicMock()
    handler.send_header = MagicMock()
    handler.end_headers = MagicMock()
    handler.do_GET()
    handler.send_response.assert_called_once_with(503)


def test_worker_ready_checks_dependencies(monkeypatch):
    from app import readiness
    child = MagicMock()
    child.poll.return_value = None
    monkeypatch.setattr(worker_health, 'child', child)
    monkeypatch.setattr(readiness, 'readiness', lambda: MagicMock(status_code=503,body=b'dependency unavailable'))
    handler = object.__new__(worker_health.HealthHandler)
    handler.path = '/ready'
    handler.wfile = BytesIO()
    handler.send_response = MagicMock()
    handler.send_header = MagicMock()
    handler.end_headers = MagicMock()
    handler.do_GET()
    handler.send_response.assert_called_once_with(503)


def test_child_metrics_are_visible_from_supervisor(tmp_path):
    import os, subprocess, sys
    from prometheus_client import CollectorRegistry, generate_latest, multiprocess
    env = {**os.environ, 'PROMETHEUS_MULTIPROC_DIR': str(tmp_path)}
    subprocess.run([sys.executable, '-c',
        "from prometheus_client import Counter; Counter('worker_test_operations','test').inc()"], env=env, check=True)
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry, path=str(tmp_path))
    assert b'worker_test_operations_total 1.0' in generate_latest(registry)
