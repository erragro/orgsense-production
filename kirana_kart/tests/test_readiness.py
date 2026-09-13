import json
from unittest.mock import MagicMock

import pytest
from app import readiness as probes


@pytest.mark.parametrize('database,redis,status', [(True, True, 200), (False, True, 503), (True, False, 503), (False, False, 503)])
def test_dependency_outage_removes_readiness(monkeypatch, database, redis, status):
    engine = MagicMock()
    if not database:
        engine.connect.side_effect = ConnectionError('secret connection details')
    monkeypatch.setattr(probes, 'probe_engine', engine)
    monkeypatch.setattr(probes, 'ping', lambda: redis)
    response = probes.readiness()
    assert response.status_code == status
    assert json.loads(response.body)['checks'] == {'database': database, 'redis': redis}
    assert b'secret' not in response.body
    assert response.headers['cache-control'] == 'no-store'
