"""
tests/test_rbac_defaults.py
===========================
Pins the default permission set for newly created accounts.

The original defaults granted can_view on every module except
{cardinal, biAgent, qaAgent, crm}. Combined with an open /auth/signup that
returned working tokens, that meant anyone on the internet could register
and immediately read customer email, phone and date of birth via
GET /customers.
"""

from app.admin.services.auth_service import ADMIN_ONLY_MODULES, ALL_MODULES


# Endpoints under these modules return personal data or customer free text.
PII_BEARING_MODULES = {"customers", "tickets", "analytics", "crm", "biAgent", "qaAgent"}


def test_pii_modules_are_not_granted_by_default():
    leaked = PII_BEARING_MODULES - ADMIN_ONLY_MODULES
    assert not leaked, (
        f"{sorted(leaked)} would be readable by any newly created account. "
        "Modules exposing personal data must be granted explicitly."
    )


def test_admin_only_modules_are_all_real_modules():
    unknown = ADMIN_ONLY_MODULES - set(ALL_MODULES)
    assert not unknown, f"ADMIN_ONLY_MODULES references unknown modules: {sorted(unknown)}"


def test_some_modules_remain_available_by_default():
    """A newly approved account should still land somewhere useful."""
    default_view = set(ALL_MODULES) - ADMIN_ONLY_MODULES
    assert "dashboard" in default_view
