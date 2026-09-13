from __future__ import annotations

from sqlalchemy import text

from app.admin.db import get_db_session
from app.config import settings


def ensure_bootstrap_admin() -> bool:
    """
    Ensure ADMIN_TOKEN exists in admin_users as a publisher.
    Returns True if a row was created.
    """
    token = settings.admin_token.strip()
    if not token:
        return False

    try:
        with get_db_session() as session:
            existing = session.execute(
                text("""
                    SELECT id FROM kirana_kart.admin_users
                    WHERE api_token = :token
                """),
                {"token": token},
            ).scalar()

            if existing:
                return False

            session.execute(
                text("""
                    INSERT INTO kirana_kart.admin_users (api_token, role)
                    VALUES (:token, 'publisher')
                """),
                {"token": token},
            )

        return True
    except Exception:
        # Database might not be ready on cold start; fail open.
        return False
