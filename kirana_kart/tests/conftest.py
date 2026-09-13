"""
tests/conftest.py
=================
Shared pytest fixtures for the Kirana Kart test suite.

Fixtures here are available to all test modules without explicit imports.
"""

import os

import pytest
from unittest.mock import MagicMock, patch


# ============================================================
# IMPORT-TIME ENVIRONMENT
# ============================================================
# app/config.py validates and instantiates its `settings` singleton at import
# time, which happens when a test module does `from app.config import ...` —
# before any fixture runs. Values that config refuses to start without must
# therefore be set here, at conftest import, not in the fixture below.

os.environ.setdefault("DEPLOYMENT_ENV", "test")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-" + "0" * 40)
# Never allow import-time singletons to inherit developer/production .env values.
# Integration tests opt in using explicitly supplied TEST_DATABASE_URL.
os.environ["SETTINGS_ENV_FILE"] = ""
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_PASSWORD", "test_pass")
os.environ.setdefault("PII_ENCRYPTION_KEY", "")


# ============================================================
# ENVIRONMENT ISOLATION
# ============================================================

@pytest.fixture(autouse=True)
def isolate_env(monkeypatch):
    """
    Ensure tests do not accidentally read the real .env file.
    Sets minimal safe defaults for all config values.
    """
    monkeypatch.setenv("DB_HOST",     "localhost")
    monkeypatch.setenv("DB_PORT",     "5432")
    monkeypatch.setenv("DB_NAME",     "test_db")
    monkeypatch.setenv("DB_USER",     "test_user")
    monkeypatch.setenv("DB_PASSWORD", "test_pass")
    monkeypatch.setenv("REDIS_URL",   "redis://localhost:6379/9")
    monkeypatch.setenv("LLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("LOG_FORMAT",  "text")
    # Re-assert the import-time values so a test that clears them still has
    # a valid config to build Settings() from.
    monkeypatch.setenv("JWT_SECRET_KEY", "test-secret-" + "0" * 40)
    monkeypatch.setenv("DEPLOYMENT_ENV", "test")


# ============================================================
# MOCK FIXTURES
# ============================================================

@pytest.fixture
def mock_redis():
    """Return a MagicMock that behaves like a redis.Redis client."""
    r = MagicMock()
    r.ping.return_value = True
    r.get.return_value = None
    r.set.return_value = True
    r.exists.return_value = 0
    return r


@pytest.fixture
def mock_db_session():
    """Return a MagicMock that behaves like a SQLAlchemy Session."""
    session = MagicMock()
    session.__enter__ = MagicMock(return_value=session)
    session.__exit__ = MagicMock(return_value=False)
    return session
