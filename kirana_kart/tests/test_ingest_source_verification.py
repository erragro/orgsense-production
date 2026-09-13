"""
tests/test_ingest_source_verification.py
========================================
Tests for _verify_source — the only authentication on POST /cardinal/ingest,
which is a public webhook endpoint with no FastAPI dependency guarding it.

Two bypasses existed here:

  * `is_sandbox` is derived from metadata.test_mode and the org name, both
    caller-supplied. Posting {"org": "sandbox", ...} skipped verification
    entirely, so anyone could inject tickets into the pipeline.
  * source="gmail" returned verified=True unconditionally, because OAuth2
    verification was never implemented.
"""

from unittest.mock import patch

import pytest

from app.l2_cardinal import phase3_handler
from app.l2_cardinal.phase3_handler import _verify_source


class _Env:
    """Stand-in for the settings singleton — is_production is a read-only property."""

    def __init__(self, is_production: bool):
        self.is_production = is_production


@pytest.fixture
def in_production():
    with patch.object(phase3_handler, "settings", _Env(True)):
        yield


@pytest.fixture
def in_development():
    with patch.object(phase3_handler, "settings", _Env(False)):
        yield


def _verify(source="api", is_sandbox=False, raw_body=None, auth_token=None):
    return _verify_source(
        source=source, is_sandbox=is_sandbox, raw_body=raw_body, auth_token=auth_token
    )


class TestSandboxClaim:

    def test_sandbox_without_token_is_denied_in_production(self, in_production):
        """A caller-supplied sandbox flag must not waive authentication."""
        with patch.object(phase3_handler, "_verify_api_token",
                          return_value=(False, "token", None)):
            verified, method, _ = _verify(is_sandbox=True)
        assert verified is False
        assert method == "sandbox_token"

    def test_sandbox_with_valid_token_is_allowed_in_production(self, in_production):
        with patch.object(phase3_handler, "_verify_api_token",
                          return_value=(True, "token", None)):
            verified, method, warning = _verify(is_sandbox=True, auth_token="Bearer good")
        assert verified is True
        assert method == "sandbox_token"
        assert warning

    def test_sandbox_still_skips_verification_in_development(self, in_development):
        verified, method, _ = _verify(is_sandbox=True)
        assert verified is True
        assert method == "skipped"


class TestGmailSource:

    def test_gmail_without_token_is_denied(self, in_production):
        """Previously returned verified=True for any anonymous caller."""
        with patch.object(phase3_handler, "_verify_api_token",
                          return_value=(False, "token", None)):
            verified, method, _ = _verify(source="gmail")
        assert verified is False
        assert method == "gmail_unimplemented"

    def test_gmail_with_valid_token_is_allowed_and_warns(self, in_production):
        with patch.object(phase3_handler, "_verify_api_token",
                          return_value=(True, "token", None)):
            verified, method, warning = _verify(source="gmail", auth_token="Bearer good")
        assert verified is True
        assert method == "gmail_token_fallback"
        assert "not implemented" in warning


class TestOtherSources:

    def test_api_source_requires_a_token(self, in_production):
        with patch.object(phase3_handler, "_verify_api_token",
                          return_value=(False, "token", None)) as check:
            verified, _, _ = _verify(source="api")
        assert verified is False
        check.assert_called_once()

    def test_unknown_source_is_denied(self, in_production):
        verified, method, _ = _verify(source="carrier-pigeon")
        assert verified is False
        assert method == "unknown_source"


@pytest.mark.parametrize('header', [None, '', 'bad', '0' * 64])
def test_freshdesk_rejects_missing_or_invalid_signature(monkeypatch, header):
    monkeypatch.setattr(phase3_handler, 'FRESHDESK_WEBHOOK_SECRET', 'test-signing-secret')
    assert not phase3_handler._verify_freshdesk_signature(b'{"ticket":1}', header)[0]


def test_freshdesk_accepts_signed_body_and_rejects_tampering(monkeypatch):
    import hmac, hashlib
    secret = 'test-signing-secret'
    body = b'{"ticket":1}'
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    monkeypatch.setattr(phase3_handler, 'FRESHDESK_WEBHOOK_SECRET', secret)
    assert phase3_handler._verify_freshdesk_signature(body, signature)[0]
    assert not phase3_handler._verify_freshdesk_signature(body + b' ', signature)[0]
    monkeypatch.setattr(phase3_handler, 'FRESHDESK_WEBHOOK_SECRET', '')
    assert not phase3_handler._verify_freshdesk_signature(body, signature)[0]


def test_unsigned_webhook_never_reaches_pipeline(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.l2_cardinal import routes
    from unittest.mock import MagicMock
    monkeypatch.setattr(phase3_handler, 'FRESHDESK_WEBHOOK_SECRET', '')
    pipeline = MagicMock()
    monkeypatch.setattr(routes.pipeline, 'run', pipeline)
    app = FastAPI()
    app.include_router(routes.router)
    response = TestClient(app).post('/cardinal/ingest', json={
        # 'module' must be a real module, not a business_line. With an invalid
        # value the request is rejected at schema validation (422) and never
        # reaches source verification — the test would pass for the wrong
        # reason and prove nothing about authentication.
        'org': 'kirana', 'source': 'freshdesk', 'module': 'delivery',
        'channel': 'email', 'business_line': 'ecommerce',
        'payload': {'ticket_id': 1, 'group_id': '1', 'subject': 'test'},
    })
    assert response.status_code == 401
    pipeline.assert_not_called()
