"""
app/tasks/retention_sweep.py
================================
DPDP Act §8(7) — Data retention enforcement.

Celery Beat task that runs daily to:
  1. Anonymise customer PII past the 3-year retention window
  2. Delete conversation records past the 1-year window
  3. Delete CSAT responses past the 2-year window
  4. Delete expired PII access logs past the 1-year window
  5. Purge expired refresh tokens (belt-and-suspenders cleanup)

Register the beat schedule in your Celery configuration:
    CELERY_BEAT_SCHEDULE = {
        "retention-sweep": {
            "task": "app.tasks.retention_sweep.run_retention_sweep",
            "schedule": crontab(hour=2, minute=0),  # Daily at 02:00
        }
    }
"""

from __future__ import annotations

import logging

from sqlalchemy import text

from app.admin.db import get_db_session

logger = logging.getLogger("kirana_kart.retention_sweep")


def run_retention_sweep() -> dict:
    """
    Execute all data retention policies. Returns a summary of rows affected.
    Safe to run multiple times (idempotent).
    """
    summary = {}

    # -----------------------------------------------------------------------
    # 1. Anonymise customer PII past retention window
    # -----------------------------------------------------------------------
    try:
        with get_db_session() as session:
            result = session.execute(
                text("""
                    UPDATE kirana_kart.customers c
                    SET email         = NULL,
                        email_blind_index = NULL,
                        phone         = NULL,
                        date_of_birth = NULL
                    FROM kirana_kart.retention_policies rp
                    WHERE rp.data_category = 'customer_pii'
                      AND c.signup_date < NOW() - (rp.retention_days || ' days')::INTERVAL
                      AND (c.email IS NOT NULL OR c.phone IS NOT NULL OR c.date_of_birth IS NOT NULL OR c.email_blind_index IS NOT NULL)
                    RETURNING c.customer_id
                """)
            )
            count = len(result.fetchall())
            summary["customer_pii_anonymised"] = count
            if count:
                logger.info("Retention sweep: anonymised %d customer PII records", count)
    except Exception as exc:
        logger.error("Retention sweep failed (customer_pii): %s", exc)
        summary["customer_pii_error"] = str(exc)

    # -----------------------------------------------------------------------
    # 2. Delete conversation transcripts past 1-year retention
    # -----------------------------------------------------------------------
    try:
        with get_db_session() as session:
            result = session.execute(
                text("""
                    DELETE FROM kirana_kart.conversation_turns c
                    USING kirana_kart.retention_policies rp
                    WHERE rp.data_category = 'conversations'
                      AND c.created_at < NOW() - (rp.retention_days || ' days')::INTERVAL
                    RETURNING c.id
                """)
            )
            count = len(result.fetchall())
            summary["conversations_deleted"] = count
            if count:
                logger.info("Retention sweep: deleted %d conversation records", count)
    except Exception as exc:
        logger.error("Retention sweep failed (conversations): %s", exc)
        summary["conversations_error"] = str(exc)

    # -----------------------------------------------------------------------
    # 3. Delete CSAT responses past 2-year retention
    # -----------------------------------------------------------------------
    try:
        with get_db_session() as session:
            result = session.execute(
                text("""
                    DELETE FROM kirana_kart.csat_responses r
                    USING kirana_kart.retention_policies rp
                    WHERE rp.data_category = 'csat_responses'
                      AND r.created_at < NOW() - (rp.retention_days || ' days')::INTERVAL
                    RETURNING r.id
                """)
            )
            count = len(result.fetchall())
            summary["csat_deleted"] = count
            if count:
                logger.info("Retention sweep: deleted %d CSAT response records", count)
    except Exception as exc:
        logger.error("Retention sweep failed (csat_responses): %s", exc)
        summary["csat_error"] = str(exc)

    # -----------------------------------------------------------------------
    # 4. Delete PII access logs past 1-year retention
    # -----------------------------------------------------------------------
    try:
        with get_db_session() as session:
            result = session.execute(
                text("""
                    DELETE FROM kirana_kart.pii_access_log l
                    USING kirana_kart.retention_policies rp
                    WHERE rp.data_category = 'access_logs'
                      AND l.accessed_at < NOW() - (rp.retention_days || ' days')::INTERVAL
                    RETURNING l.id
                """)
            )
            count = len(result.fetchall())
            summary["pii_logs_deleted"] = count
            if count:
                logger.info("Retention sweep: deleted %d PII access log entries", count)
    except Exception as exc:
        logger.error("Retention sweep failed (access_logs): %s", exc)
        summary["pii_logs_error"] = str(exc)

    # -----------------------------------------------------------------------
    # 5. Purge expired refresh tokens (belt-and-suspenders)
    # -----------------------------------------------------------------------
    try:
        with get_db_session() as session:
            result = session.execute(
                text("""
                    DELETE FROM kirana_kart.refresh_tokens
                    WHERE expires_at < NOW() - INTERVAL '1 day'
                    RETURNING id
                """)
            )
            count = len(result.fetchall())
            summary["refresh_tokens_purged"] = count
            if count:
                logger.info("Retention sweep: purged %d expired refresh tokens", count)
    except Exception as exc:
        logger.error("Retention sweep failed (refresh_tokens): %s", exc)
        summary["refresh_tokens_error"] = str(exc)

    logger.info("Retention sweep complete: %s", summary)
    return summary
