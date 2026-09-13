"""
app/admin/services/email_service.py
=====================================
Thin SMTP email sender for transactional outbound email.

Uses stdlib smtplib (no new dependencies). Configured via:
    SMTP_HOST  — e.g. smtp.gmail.com
    SMTP_PORT  — default 587 (STARTTLS)
    SMTP_USER  — sender login (e.g. surajit.chaudhuri.erragro@gmail.com)
    SMTP_PASS  — Gmail app password (16 chars)
    SMTP_FROM  — display From address (e.g. surajit.chaudhuri@orgsense.in)

If SMTP_HOST is empty the function is a no-op — safe in dev/test environments
where SMTP is not configured.
"""

from __future__ import annotations

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.config import settings

logger = logging.getLogger(__name__)


def send_email(
    to: str,
    subject: str,
    body_html: str,
    body_text: str = "",
) -> None:
    """
    Send a transactional email.

    Args:
        to:        Recipient email address.
        subject:   Email subject line.
        body_html: HTML body (primary).
        body_text: Plain-text fallback (optional but recommended).

    Silently skips if SMTP_HOST is not configured.
    Logs errors rather than raising — CRM action should not fail
    just because an email couldn't be delivered.
    """
    if not settings.smtp_host:
        logger.debug("SMTP not configured — skipping email to %s", to)
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to

    if body_text:
        msg.attach(MIMEText(body_text, "plain", "utf-8"))
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            s.login(settings.smtp_user, settings.smtp_pass)
            s.sendmail(msg["From"], [to], msg.as_string())
        logger.info("Email sent to %s — subject: %s", to, subject)
    except Exception:
        logger.exception("Failed to send email to %s — subject: %s", to, subject)
