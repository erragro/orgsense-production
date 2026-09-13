"""
app/admin/services/auth_service.py
===================================
JWT authentication service — token creation, validation, and FastAPI
dependency injection helpers for protecting routes with RBAC.

Exported FastAPI dependencies:
    get_current_user    — decodes JWT, returns UserContext
    require_permission  — factory that returns a dependency checking
                          a specific module+action permission

Database helpers (called once at startup):
    ensure_auth_tables  — creates users / user_permissions / refresh_tokens tables
    ensure_bootstrap_admin — inserts super-admin if no users exist
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.redis_client import get_redis
from app.config import settings

logger = logging.getLogger("kirana_kart.auth")

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# All modules that carry per-user permissions
ALL_MODULES: list[str] = [
    "dashboard",
    "tickets",
    "taxonomy",
    "knowledgeBase",
    "policy",
    "customers",
    "analytics",
    "system",
    "biAgent",
    "sandbox",
    "cardinal",
    "qaAgent",
    "crm",
]

# Modules where new-user default view = False (admin must grant explicitly).
#
# "customers", "tickets" and "analytics" are in this set because those
# endpoints return customer PII — email, phone, date of birth — and free
# text written by customers. A newly approved account must not see personal
# data until someone deliberately grants it.
ADMIN_ONLY_MODULES: set[str] = {
    "cardinal",
    "biAgent",
    "qaAgent",
    "crm",
    "customers",
    "tickets",
    "analytics",
}

# ---------------------------------------------------------------------------
# User context dataclass returned by get_current_user
# ---------------------------------------------------------------------------


@dataclass
class UserContext:
    id: int
    email: str
    full_name: str
    avatar_url: str | None
    is_super_admin: bool
    permissions: dict[str, dict[str, bool]] = field(default_factory=dict)
    auth_version: int = 0


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------


def _permissions_from_db(user_id: int) -> dict[str, dict[str, bool]]:
    """Load this user's module permissions from DB."""
    with get_db_session() as session:
        rows = session.execute(
            text("""
                SELECT module, can_view, can_edit, can_admin
                FROM kirana_kart.user_permissions
                WHERE user_id = :uid
            """),
            {"uid": user_id},
        ).mappings().all()

    return {
        r["module"]: {
            "view": bool(r["can_view"]),
            "edit": bool(r["can_edit"]),
            "admin": bool(r["can_admin"]),
        }
        for r in rows
    }


def create_access_token(user: UserContext) -> str:
    """Create a short-lived JWT access token embedding the user's permissions."""
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.jwt_access_expire_minutes)

    payload: dict[str, Any] = {
        "sub": str(user.id),
        "auth_version": user.auth_version,
        "email": user.email,
        "full_name": user.full_name,
        "avatar_url": user.avatar_url,
        "is_super_admin": user.is_super_admin,
        "permissions": user.permissions,
        "iat": now,
        "exp": expire,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


# ---------------------------------------------------------------------------
# Access-token revocation
# ---------------------------------------------------------------------------
# Access tokens carry a `jti` that was generated and never used. Logging out
# deleted the refresh token but left the access token valid until expiry, so
# there was no way to cut off a live session. The jti now goes on a Redis
# denylist for the remainder of its lifetime.

_REVOKED_PREFIX = "auth:revoked_jti:"


def revoke_access_token(token: str) -> None:
    """Deny-list an access token's jti until the token would have expired."""
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"verify_exp": False},
        )
    except JWTError:
        return  # nothing useful to revoke

    jti = payload.get("jti")
    exp = payload.get("exp")
    if not jti or not exp:
        return

    ttl = int(exp - datetime.now(timezone.utc).timestamp())
    if ttl <= 0:
        return

    try:
        get_redis().setex(f"{_REVOKED_PREFIX}{jti}", ttl, "1")
    except Exception as exc:
        # Redis being unavailable must not break logout, but it does mean the
        # token stays live until expiry — worth a warning.
        logger.warning("Could not deny-list access token jti=%s: %s", jti, exc)


def is_token_revoked(jti: str) -> bool:
    """True when this jti has been deny-listed. Fails open if Redis is down."""
    try:
        return bool(get_redis().exists(f"{_REVOKED_PREFIX}{jti}"))
    except Exception:
        return False


def create_refresh_token(user_id: int) -> tuple[str, str]:
    """
    Create a refresh token.
    Returns (raw_token, token_hash) — store the hash in the DB.
    """
    raw = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def _hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def store_refresh_token(user_id: int, token_hash: str, auth_version: int | None = None) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_expire_days)
    with get_db_session() as session:
        version = session.execute(text("SELECT auth_version FROM kirana_kart.users WHERE id=:uid AND is_active FOR UPDATE"), {"uid": user_id}).scalar()
        if version is None or (auth_version is not None and version != auth_version):
            raise HTTPException(status_code=401, detail="Credentials changed. Please sign in again.")
        session.execute(text("""INSERT INTO kirana_kart.refresh_tokens
            (user_id, token_hash, expires_at, auth_version) VALUES (:uid,:hash,:exp,:version)"""),
            {"uid": user_id, "hash": token_hash, "exp": expires_at, "version": version})


def validate_and_rotate_refresh_token(raw_token: str) -> tuple[int, str, int]:
    """Rotate atomically under the same user lock as password reset."""
    token_hash = _hash_refresh_token(raw_token)
    with get_db_session() as session:
        user = session.execute(text("""SELECT u.id,u.auth_version FROM kirana_kart.users u
            JOIN kirana_kart.refresh_tokens r ON r.user_id=u.id
            WHERE r.token_hash=:hash AND u.is_active FOR UPDATE OF u"""), {"hash": token_hash}).mappings().first()
        if not user:
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
        row = session.execute(text("""DELETE FROM kirana_kart.refresh_tokens
            WHERE token_hash=:hash AND expires_at>NOW() AND auth_version=:version RETURNING user_id"""),
            {"hash": token_hash, "version": user["auth_version"]}).first()
        if not row:
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
        raw, hashed = create_refresh_token(user["id"])
        session.execute(text("""INSERT INTO kirana_kart.refresh_tokens
            (user_id,token_hash,expires_at,auth_version) VALUES (:uid,:hash,:exp,:version)"""),
            {"uid": user["id"], "hash": hashed, "exp": datetime.now(timezone.utc)+timedelta(days=settings.jwt_refresh_expire_days), "version": user["auth_version"]})
        return user["id"], raw, user["auth_version"]


def invalidate_refresh_token(raw_token: str) -> None:
    """Delete a refresh token (logout)."""
    token_hash = _hash_refresh_token(raw_token)
    with get_db_session() as session:
        session.execute(
            text("DELETE FROM kirana_kart.refresh_tokens WHERE token_hash = :hash"),
            {"hash": token_hash},
        )


# ---------------------------------------------------------------------------
# FastAPI dependency: get_current_user
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer(auto_error=True)


# ---------------------------------------------------------------------------
# Authoritative user state
# ---------------------------------------------------------------------------
# The JWT carries a snapshot of permissions and is_super_admin taken at login.
# Trusting that snapshot for the token's full lifetime meant deactivating a
# user, revoking a module, or demoting a super-admin had no effect for up to
# JWT_ACCESS_EXPIRE_MINUTES. The database is now the authority on every
# request, behind a short TTL cache so this costs one query per user per
# _USER_CACHE_TTL seconds rather than one per request.

_USER_CACHE_TTL = 30.0
_user_cache: dict[int, tuple[float, UserContext]] = {}
_user_cache_lock = threading.Lock()


def invalidate_user_cache(user_id: int | None = None) -> None:
    """Drop cached state so a permission or status change takes effect at once."""
    with _user_cache_lock:
        if user_id is None:
            _user_cache.clear()
        else:
            _user_cache.pop(user_id, None)


def _load_user_state(user_id: int) -> UserContext:
    """Return current user state, from cache when fresh."""
    now = time.monotonic()
    with _user_cache_lock:
        hit = _user_cache.get(user_id)
        if hit and hit[0] > now:
            return hit[1]

    # build_user_context_from_db raises 404/403 for missing or inactive users.
    user = build_user_context_from_db(user_id)

    with _user_cache_lock:
        _user_cache[user_id] = (now + _USER_CACHE_TTL, user)
    return user


def _current_auth_version(user_id: int) -> int | None:
    with get_db_session() as session:
        return session.execute(text("SELECT auth_version FROM kirana_kart.users WHERE id=:uid AND is_active"), {"uid": user_id}).scalar()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> UserContext:
    """
    FastAPI dependency. Verifies the Bearer JWT, then resolves the user's
    *current* permissions and status from the database.

    Raises HTTP 401 on any token problem, on a revoked token, or when the
    account has since been deactivated or deleted.
    """
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Access token has expired")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid access token")

    jti = payload.get("jti")
    if jti and is_token_revoked(jti):
        raise HTTPException(status_code=401, detail="Access token has been revoked")

    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid access token")

    # Deliberately uncached: reset must invalidate credentials across replicas,
    # including while Redis is unavailable or permission caches are warm.
    version = _current_auth_version(user_id)
    if version is None or payload.get("auth_version", 0) != version:
        raise HTTPException(status_code=401, detail="Credentials changed. Please sign in again.")

    try:
        return _load_user_state(user_id)
    except HTTPException as exc:
        # A token for a deleted (404) or deactivated (403) account is not a
        # permissions problem — the credential itself is no longer valid.
        if exc.status_code in (403, 404):
            raise HTTPException(
                status_code=401,
                detail="This account is no longer active. Please sign in again.",
            )
        raise


# ---------------------------------------------------------------------------
# FastAPI dependency factory: require_permission
# ---------------------------------------------------------------------------


def require_permission(module: str, action: str):
    """
    Returns a FastAPI dependency that:
      1. Validates the JWT via get_current_user
      2. Checks permissions[module][action] (or is_super_admin)
      3. Raises HTTP 403 if the check fails

    Usage:
        @router.get("/taxonomy")
        def list_taxonomy(user: UserContext = Depends(require_permission("taxonomy", "view"))):
            ...
    """

    def checker(user: UserContext = Depends(get_current_user)) -> UserContext:
        if user.is_super_admin:
            return user
        perms = user.permissions.get(module, {})
        if not perms.get(action, False):
            raise HTTPException(
                status_code=403,
                detail=f"Permission denied: {module}.{action} required",
            )
        return user

    return checker


# ---------------------------------------------------------------------------
# DB bootstrap helpers
# ---------------------------------------------------------------------------


def ensure_auth_tables() -> None:
    """
    Create the three auth tables if they don't exist yet.
    Called once at governance startup.
    """
    ddl = """
        CREATE TABLE IF NOT EXISTS kirana_kart.users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            full_name VARCHAR(255) NOT NULL DEFAULT '',
            password_hash VARCHAR(255),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            oauth_provider VARCHAR(50),
            oauth_id VARCHAR(255),
            avatar_url TEXT,
            is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
            -- DPDP Act §9: children's data requires guardian consent
            date_of_birth DATE,
            guardian_consent_given BOOLEAN DEFAULT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(oauth_provider, oauth_id)
        );

        CREATE TABLE IF NOT EXISTS kirana_kart.user_permissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            module VARCHAR(50) NOT NULL,
            can_view BOOLEAN NOT NULL DEFAULT FALSE,
            can_edit BOOLEAN NOT NULL DEFAULT FALSE,
            can_admin BOOLEAN NOT NULL DEFAULT FALSE,
            UNIQUE(user_id, module)
        );

        CREATE TABLE IF NOT EXISTS kirana_kart.refresh_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES kirana_kart.users(id) ON DELETE CASCADE,
            token_hash VARCHAR(255) NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    """
    try:
        with get_db_session() as session:
            session.execute(text(ddl))
        logger.info("Auth tables verified / created.")
    except Exception as exc:
        logger.error("Failed to ensure auth tables: %s", exc)


def assign_viewer_permissions(user_id: int, session) -> None:
    """Give a new user can_view=True on all non-restricted modules.
    Modules in ADMIN_ONLY_MODULES start with can_view=False (must be granted by super-admin).
    """
    for module in ALL_MODULES:
        can_view = module not in ADMIN_ONLY_MODULES
        session.execute(
            text("""
                INSERT INTO kirana_kart.user_permissions
                    (user_id, module, can_view, can_edit, can_admin)
                VALUES (:uid, :mod, :can_view, FALSE, FALSE)
                ON CONFLICT (user_id, module) DO NOTHING
            """),
            {"uid": user_id, "mod": module, "can_view": can_view},
        )


def ensure_bootstrap_admin() -> None:
    """
    Create a super-admin user on first startup if no users exist.
    Uses BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD from settings.
    """
    email = settings.bootstrap_admin_email.strip()
    password = settings.bootstrap_admin_password.strip()
    if not email or not password:
        return

    try:
        with get_db_session() as session:
            count = session.execute(
                text("SELECT COUNT(*) FROM kirana_kart.users")
            ).scalar()

            if count and count > 0:
                return  # users already exist

            hashed = hash_password(password)
            row = session.execute(
                text("""
                    INSERT INTO kirana_kart.users
                        (email, full_name, password_hash, is_active, is_super_admin)
                    VALUES (:email, :name, :hash, TRUE, TRUE)
                    RETURNING id
                """),
                {
                    "email": email,
                    "name": settings.bootstrap_admin_name,
                    "hash": hashed,
                },
            ).mappings().first()

            if row:
                # Super-admin gets full permissions on all modules
                for module in ALL_MODULES:
                    session.execute(
                        text("""
                            INSERT INTO kirana_kart.user_permissions
                                (user_id, module, can_view, can_edit, can_admin)
                            VALUES (:uid, :mod, TRUE, TRUE, TRUE)
                            ON CONFLICT (user_id, module) DO NOTHING
                        """),
                        {"uid": row["id"], "mod": module},
                    )
                logger.info("Bootstrap super-admin created: %s", email)

    except Exception as exc:
        logger.error("Failed to create bootstrap admin: %s", exc)


def build_user_context_from_db(user_id: int) -> UserContext:
    """Build a full UserContext by loading user + permissions from DB."""
    with get_db_session() as session:
        row = session.execute(
            text("""
                SELECT id, email, full_name, avatar_url, is_super_admin, is_active, auth_version
                FROM kirana_kart.users
                WHERE id = :uid
            """),
            {"uid": user_id},
        ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account is deactivated")

    permissions = _permissions_from_db(user_id)
    return UserContext(
        id=row["id"],
        email=row["email"],
        full_name=row["full_name"],
        avatar_url=row["avatar_url"],
        is_super_admin=bool(row["is_super_admin"]),
        permissions=permissions,
        auth_version=row["auth_version"],
    )
