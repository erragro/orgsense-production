import pytest
from app.config import settings
from app.utils.customer_pii import encode, decode, email_index, protect_customer, reveal_customer


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setattr(settings, 'pii_encryption_key', 'a' * 64)


def test_identity_round_trip_and_blind_lookup():
    original = {'customer_id': 'test', 'email': ' Alice@Example.com ', 'phone': '+91000123', 'date_of_birth': '1990-01-01'}
    stored = protect_customer(original)
    assert '@' not in stored['email']
    assert stored['email_blind_index'] == email_index('alice@example.COM')
    assert reveal_customer(stored) == original
    assert protect_customer(original)['email'] != stored['email']


def test_legacy_and_null_values_are_readable():
    assert decode('plain@example.com') == 'plain@example.com'
    assert decode(None) is None
    assert decode(encode('pii:v1:literal input')) == 'pii:v1:literal input'


def test_corrupt_envelope_is_not_returned_as_plaintext():
    with pytest.raises(ValueError):
        decode('pii:v1:corrupt')


def test_new_writes_fail_closed_without_key(monkeypatch):
    monkeypatch.setattr(settings, 'pii_encryption_key', '')
    with pytest.raises(ValueError):
        protect_customer({'email': 'alice@example.com'})
