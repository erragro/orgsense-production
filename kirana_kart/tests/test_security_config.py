"""
tests/test_security_config.py
=============================
Regression tests for the configuration-level security controls.

Each test here pins a fix for a flaw that existed in the codebase:

  * JWT_SECRET_KEY had a hardcoded default ("REDACTED"), and the check that
    would have caught it only ran when DEPLOYMENT_ENV == "production" —
    a value nothing in the deployment pipeline set.
  * DEPLOYMENT_ENV defaulted to "development", so an unset value disabled
    every production check silently.
  * BI_DB_USER fell back to the application owner role, which meant
    LLM-generated SQL ran with write privileges.
"""

import pytest

from app.config import Settings


STRONG_SECRET = "x" * 64


def _settings(monkeypatch, **env) -> Settings:
    """Build a Settings instance from an explicit environment."""
    base = {
        "JWT_SECRET_KEY": STRONG_SECRET,
        "DEPLOYMENT_ENV": "test",
        "LLM_API_KEY": "sk-test",
    }
    base.update(env)
    for key, value in base.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, str(value))
    return Settings(_env_file=None)


class TestJwtSecret:

    def test_missing_secret_is_rejected(self, monkeypatch):
        with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
            _settings(monkeypatch, JWT_SECRET_KEY="")

    def test_short_secret_is_rejected(self, monkeypatch):
        with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
            _settings(monkeypatch, JWT_SECRET_KEY="too-short")

    def test_secret_is_required_even_in_development(self, monkeypatch):
        """The old guard only ran in production, so dev kept the known default."""
        with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
            _settings(monkeypatch, DEPLOYMENT_ENV="development", JWT_SECRET_KEY="")

    def test_strong_secret_is_accepted(self, monkeypatch):
        s = _settings(monkeypatch)
        assert s.jwt_secret_key == STRONG_SECRET


class TestEnvironmentDetection:

    def test_unset_deployment_env_is_treated_as_production(self, monkeypatch):
        """Fail closed: a deployment that forgets the tag still gets the checks."""
        s = _settings(monkeypatch, DEPLOYMENT_ENV=None, DB_PASSWORD="pw",
                      FRONTEND_URL="https://orgsense.in")
        assert s.deployment_env == "production"
        assert s.is_production is True

    @pytest.mark.parametrize("env", ["development", "dev", "local", "test", "CI"])
    def test_known_dev_environments_are_not_production(self, monkeypatch, env):
        assert _settings(monkeypatch, DEPLOYMENT_ENV=env).is_production is False

    def test_production_rejects_plaintext_frontend_url(self, monkeypatch):
        with pytest.raises(ValueError, match="FRONTEND_URL"):
            _settings(monkeypatch, DEPLOYMENT_ENV="production", DB_PASSWORD="pw",
                      FRONTEND_URL="http://orgsense.in")

    def test_production_rejects_empty_db_password(self, monkeypatch):
        with pytest.raises(ValueError, match="DB_PASSWORD"):
            _settings(monkeypatch, DEPLOYMENT_ENV="production", DB_PASSWORD="",
                      FRONTEND_URL="https://orgsense.in")

    def test_localhost_over_http_is_allowed(self, monkeypatch):
        s = _settings(monkeypatch, DEPLOYMENT_ENV="production", DB_PASSWORD="pw",
                      FRONTEND_URL="http://localhost:5173")
        assert s.is_production is True


class TestBiAgentCredentials:

    def test_bi_agent_disabled_without_dedicated_role(self, monkeypatch):
        s = _settings(monkeypatch, BI_DB_USER="", BI_DB_PASSWORD="")
        assert s.bi_agent_enabled is False

    def test_bi_url_refuses_to_fall_back_to_owner_role(self, monkeypatch):
        """
        The old computed property silently used db_user/db_password, so the
        'read-only engine' the BI service documents ran as the schema owner.
        """
        s = _settings(monkeypatch, BI_DB_USER="", BI_DB_PASSWORD="",
                      DB_USER="orguser", DB_PASSWORD="owner-pw")
        with pytest.raises(RuntimeError, match="BI_DB_USER"):
            _ = s.bi_database_url

    def test_bi_url_uses_the_readonly_role(self, monkeypatch):
        s = _settings(monkeypatch, BI_DB_USER="bi_readonly", BI_DB_PASSWORD="ro-pw",
                      DB_USER="orguser", DB_PASSWORD="owner-pw",
                      DB_HOST="pg", DB_PORT="5432", DB_NAME="db")
        assert s.bi_agent_enabled is True
        assert s.bi_database_url == "postgresql+psycopg2://bi_readonly:ro-pw@pg:5432/db"
        assert "orguser" not in s.bi_database_url


class TestSignupGating:

    def test_signup_disabled_by_default(self, monkeypatch):
        assert _settings(monkeypatch, SIGNUP_ENABLED=None).signup_enabled is False

    def test_no_allowlist_permits_any_domain(self, monkeypatch):
        s = _settings(monkeypatch, SIGNUP_ALLOWED_DOMAINS="")
        assert s.is_email_domain_allowed("anyone@example.com") is True

    def test_allowlist_blocks_other_domains(self, monkeypatch):
        s = _settings(monkeypatch, SIGNUP_ALLOWED_DOMAINS="kiranakart.com, example.org")
        assert s.is_email_domain_allowed("dev@kiranakart.com") is True
        assert s.is_email_domain_allowed("DEV@Example.ORG") is True
        assert s.is_email_domain_allowed("attacker@gmail.com") is False
