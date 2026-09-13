"""
app/middleware/pii_audit_middleware.py
=======================================
DPDP Act §8(2) — Audit logging for all PII data access.

Records every read/write of customer or user PII fields to a dedicated
pii_access_log table, enabling:
  - Data breach investigation (who accessed what data, when)
  - Regulatory audit trails (DPDP Act compliance evidence)
  - Anomaly detection (unusual access patterns)

Usage — decorate route handlers that return PII:

    from app.middleware.pii_audit_middleware import log_pii_access

    @router.get("/{customer_id}")
    def get_customer(customer_id: str, user: UserContext = Depends(_view)):
        log_pii_access(user.id, "customer", customer_id, ["email", "phone", "date_of_birth"])
        ...

The log_pii_access() call is non-blocking; failures are swallowed silently
so that audit log unavailability never breaks business operations.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text

from app.admin.db import get_db_session

logger = logging.getLogger("kirana_kart.pii_audit")


def ensure_pii_audit_table() -> None:
    """Create the pii_access_log table if it doesn't exist. Call at startup."""
    ddl = """
        CREATE TABLE IF NOT EXISTS kirana_kart.pii_access_log (
            id           BIGSERIAL PRIMARY KEY,
            accessed_by  INTEGER,            -- user_id of the person making the request
            entity_type  VARCHAR(30)  NOT NULL, -- 'customer' | 'user' | 'order' | 'conversation'
            entity_id    VARCHAR(100) NOT NULL,
            fields_accessed TEXT[]    NOT NULL,
            endpoint     VARCHAR(300),
            ip_address   INET,
            accessed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_pii_audit_entity
            ON kirana_kart.pii_access_log (entity_type, entity_id);

        CREATE INDEX IF NOT EXISTS idx_pii_audit_accessor
            ON kirana_kart.pii_access_log (accessed_by, accessed_at DESC);

        CREATE TABLE IF NOT EXISTS kirana_kart.consent_records (
            id                    SERIAL PRIMARY KEY,
            data_principal_id     INTEGER,
            principal_type        VARCHAR(30)  NOT NULL DEFAULT 'user',
            purpose               VARCHAR(200) NOT NULL,
            consent_given         BOOLEAN      NOT NULL,
            consent_timestamp     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            withdrawal_timestamp  TIMESTAMPTZ,
            ip_address            INET,
            version               VARCHAR(20)  NOT NULL DEFAULT '1.0'
        );

        CREATE INDEX IF NOT EXISTS idx_consent_principal
            ON kirana_kart.consent_records (data_principal_id, principal_type);

        CREATE TABLE IF NOT EXISTS kirana_kart.retention_policies (
            data_category   VARCHAR(50) PRIMARY KEY,
            retention_days  INTEGER     NOT NULL,
            action_on_expiry VARCHAR(20) NOT NULL DEFAULT 'anonymize',
            description     TEXT
        );

        CREATE TABLE IF NOT EXISTS kirana_kart.grievances (
            id             SERIAL PRIMARY KEY,
            user_id        INTEGER,
            grievance_type VARCHAR(100) NOT NULL,
            description    TEXT        NOT NULL,
            contact_email  VARCHAR(255) NOT NULL,
            status         VARCHAR(30)  NOT NULL DEFAULT 'pending',
            created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            resolved_at    TIMESTAMPTZ,
            resolution     TEXT
        );
    """
    try:
        with get_db_session() as session:
            session.execute(text(ddl))

        # Seed default retention policies
        _seed_retention_policies()
        logger.info("PII audit + DPDP compliance tables verified / created.")
    except Exception as exc:
        logger.error("Failed to create PII audit tables: %s", exc)


def _seed_retention_policies() -> None:
    """Insert default DPDP-compliant data retention policies if not already present."""
    policies = [
        ("customer_pii",    3 * 365, "anonymize", "Customer personal data — 3-year retention then anonymise"),
        ("orders",          7 * 365, "anonymize", "Order records — 7-year tax/legal hold"),
        ("conversations",   1 * 365, "delete",    "Support conversation transcripts — 1-year retention"),
        ("csat_responses",  2 * 365, "delete",    "CSAT feedback — 2-year retention"),
        ("access_logs",     1 * 365, "delete",    "PII access audit logs — 1-year retention"),
        ("refresh_tokens",  30,      "delete",    "Auth refresh tokens — 30-day expiry (also enforced in app)"),
    ]
    try:
        with get_db_session() as session:
            for category, days, action, desc in policies:
                session.execute(
                    text("""
                        INSERT INTO kirana_kart.retention_policies
                            (data_category, retention_days, action_on_expiry, description)
                        VALUES (:cat, :days, :action, :desc)
                        ON CONFLICT (data_category) DO NOTHING
                    """),
                    {"cat": category, "days": days, "action": action, "desc": desc},
                )
    except Exception as exc:
        logger.warning("Failed to seed retention policies: %s", exc)


def log_pii_access(
    accessed_by: Optional[int],
    entity_type: str,
    entity_id: str,
    fields: list[str],
    endpoint: Optional[str] = None,
    ip_address: Optional[str] = None,
) -> None:
    """
    Write a PII access record to pii_access_log.

    This is intentionally fire-and-forget (swallows all exceptions)
    so audit logging never disrupts normal request processing.
    """
    try:
        with get_db_session() as session:
            session.execute(
                text("""
                    INSERT INTO kirana_kart.pii_access_log
                        (accessed_by, entity_type, entity_id, fields_accessed, endpoint, ip_address)
                    VALUES (:by, :etype, :eid, :fields, :ep, CAST(:ip AS inet))
                """),
                {
                    "by": accessed_by,
                    "etype": entity_type,
                    "eid": str(entity_id),
                    "fields": fields,
                    "ep": endpoint,
                    "ip": ip_address,
                },
            )
    except Exception as exc:
        # Never fail the main request due to audit log issues
        logger.warning("PII audit log write failed: %s", exc)
