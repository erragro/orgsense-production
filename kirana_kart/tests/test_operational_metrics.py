import pytest
from app.operational_metrics import operations


def test_enrichment_failure_increments_real_metric(monkeypatch):
    from app.l2_cardinal import phase4_enricher
    monkeypatch.setattr(phase4_enricher, '_get_connection', lambda: (_ for _ in ()).throw(RuntimeError('unavailable')))
    # Exercise the decorated public operation, not just the decorator in isolation.
    from unittest.mock import MagicMock
    before = operations.labels('enrichment', 'error')._value.get()
    with pytest.raises(Exception):
        phase4_enricher.run(MagicMock())
    assert operations.labels('enrichment', 'error')._value.get() == before + 1
