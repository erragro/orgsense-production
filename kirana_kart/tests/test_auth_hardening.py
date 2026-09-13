"""
tests/test_auth_hardening.py
============================
Regression tests for the authentication fixes.

Covered flaws:
  * get_current_user trusted the permissions snapshot baked into the JWT, so
    deactivating a user or revoking a module had no effect until the token
    expired (up to JWT_ACCESS_EXPIRE_MINUTES).
  * logout dropped the refresh token but left the access token usable.
  * The `jti` claim was generated and never checked.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

from app.admin.services import auth_service
from app.admin.services.auth_service import (
    UserContext,
    create_access_token,
    get_current_user,
    invalidate_user_cache,
)
from app.config import settings


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


@pytest.fixture
def viewer() -> UserContext:
    return UserContext(
        id=7,
        email="viewer@example.com",
        full_name="Viewer",
        avatar_url=None,
        is_super_admin=False,
        permissions={"dashboard": {"view": True, "edit": False, "admin": False}},
    )


@pytest.fixture(autouse=True)
def _clear_cache():
    invalidate_user_cache()
    yield
    invalidate_user_cache()


@pytest.fixture(autouse=True)
def _redis_absent():
    """Default to Redis being unavailable; revocation tests opt in explicitly."""
    with patch.object(auth_service, "is_token_revoked", return_value=False):
        yield


class TestPermissionsComeFromTheDatabase:

    def test_stale_super_admin_claim_in_token_is_ignored(self, viewer):
        """
        A token minted while the user was a super admin must not keep working
        after the demotion. The claim in the token says True; the database
        says False, and the database wins.
        """
        elevated = UserContext(**{**viewer.__dict__, "is_super_admin": True})
        token = create_access_token(elevated)
        assert jwt.get_unverified_claims(token)["is_super_admin"] is True

        with patch.object(auth_service, "build_user_context_from_db", return_value=viewer):
            resolved = get_current_user(_creds(token))

        assert resolved.is_super_admin is False

    def test_revoked_module_is_dropped_immediately(self, viewer):
        token = create_access_token(
            UserContext(**{**viewer.__dict__,
                           "permissions": {"customers": {"view": True}}})
        )
        with patch.object(auth_service, "build_user_context_from_db", return_value=viewer):
            resolved = get_current_user(_creds(token))

        assert "customers" not in resolved.permissions

    def test_deactivated_account_is_rejected(self, viewer):
        """build_user_context_from_db raises 403 for is_active = FALSE."""
        token = create_access_token(viewer)
        with patch.object(
            auth_service, "build_user_context_from_db",
            side_effect=HTTPException(status_code=403, detail="inactive"),
        ):
            with pytest.raises(HTTPException) as exc:
                get_current_user(_creds(token))
        assert exc.value.status_code == 401

    def test_deleted_account_is_rejected(self, viewer):
        token = create_access_token(viewer)
        with patch.object(
            auth_service, "build_user_context_from_db",
            side_effect=HTTPException(status_code=404, detail="gone"),
        ):
            with pytest.raises(HTTPException) as exc:
                get_current_user(_creds(token))
        assert exc.value.status_code == 401

    def test_result_is_cached_within_the_ttl(self, viewer):
        token = create_access_token(viewer)
        with patch.object(
            auth_service, "build_user_context_from_db", return_value=viewer
        ) as loader:
            get_current_user(_creds(token))
            get_current_user(_creds(token))
        assert loader.call_count == 1

    def test_invalidation_forces_a_reload(self, viewer):
        token = create_access_token(viewer)
        with patch.object(
            auth_service, "build_user_context_from_db", return_value=viewer
        ) as loader:
            get_current_user(_creds(token))
            invalidate_user_cache(viewer.id)
            get_current_user(_creds(token))
        assert loader.call_count == 2


class TestTokenIntegrity:

    def test_token_signed_with_another_key_is_rejected(self, viewer):
        forged = jwt.encode(
            {"sub": "7", "email": "x@y.z", "is_super_admin": True,
             "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
            "REDACTED",                      # the old hardcoded default
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(HTTPException) as exc:
            get_current_user(_creds(forged))
        assert exc.value.status_code == 401

    def test_expired_token_is_rejected(self, viewer):
        expired = jwt.encode(
            {"sub": "7", "email": "x@y.z",
             "exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
            settings.jwt_secret_key,
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(HTTPException) as exc:
            get_current_user(_creds(expired))
        assert exc.value.status_code == 401

    def test_access_token_carries_a_jti(self, viewer):
        claims = jwt.get_unverified_claims(create_access_token(viewer))
        assert claims.get("jti")


class TestRevocation:

    def test_revoked_jti_is_rejected(self, viewer):
        token = create_access_token(viewer)
        with patch.object(auth_service, "is_token_revoked", return_value=True):
            with pytest.raises(HTTPException) as exc:
                get_current_user(_creds(token))
        assert exc.value.status_code == 401
        assert "revoked" in exc.value.detail.lower()

    def test_revoke_denylists_the_jti_with_the_remaining_ttl(self, viewer):
        token = create_access_token(viewer)
        jti = jwt.get_unverified_claims(token)["jti"]

        fake_redis = type("R", (), {"calls": [],
                                    "setex": lambda self, k, t, v: self.calls.append((k, t, v))})()
        with patch.object(auth_service, "get_redis", return_value=fake_redis):
            auth_service.revoke_access_token(token)

        assert len(fake_redis.calls) == 1
        key, ttl, _ = fake_redis.calls[0]
        assert jti in key
        assert 0 < ttl <= settings.jwt_access_expire_minutes * 60

    def test_revocation_survives_redis_being_down(self, viewer):
        """Logout must not fail because the denylist is unreachable."""
        with patch.object(auth_service, "get_redis", side_effect=RuntimeError("down")):
            auth_service.revoke_access_token(create_access_token(viewer))  # no raise

    def test_is_token_revoked_fails_open(self):
        with patch.object(auth_service, "get_redis", side_effect=RuntimeError("down")):
            assert auth_service.is_token_revoked("any-jti") is False


@pytest.fixture(autouse=True)
def _credential_version():
    with patch.object(auth_service, '_current_auth_version', return_value=0):
        yield


def test_reset_version_rejects_cached_session_without_redis(viewer):
    token = create_access_token(viewer)
    with patch.object(auth_service, 'build_user_context_from_db', return_value=viewer):
        assert get_current_user(_creds(token)).id == viewer.id
        with patch.object(auth_service, '_current_auth_version', return_value=1):
            with pytest.raises(HTTPException) as exc:
                get_current_user(_creds(token))
            assert exc.value.status_code == 401
