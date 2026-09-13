"""
app/admin/routes/auth.py
=========================
Re-exports JWT dependency helpers from auth_service for use across all route files.

This replaces the old token-based authorize() / require_role() approach.
"""

from app.admin.services.auth_service import (
    UserContext,
    get_current_user,
    require_permission,
)

__all__ = ["UserContext", "get_current_user", "require_permission"]
