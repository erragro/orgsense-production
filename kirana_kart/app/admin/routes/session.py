from __future__ import annotations

from fastapi import APIRouter, Depends

from app.admin.services.auth_service import UserContext, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
def me(user: UserContext = Depends(get_current_user)):
    """Return the current user's profile and permissions from the JWT."""
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "avatar_url": user.avatar_url,
        "is_super_admin": user.is_super_admin,
        "permissions": user.permissions,
    }
