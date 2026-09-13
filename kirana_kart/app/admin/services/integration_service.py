"""
app/admin/services/integration_service.py
==========================================
Integration management service — database setup, email polling, ticket submission.

Supported integration types:
  gmail   — Gmail API via google-auth + google-api-python-client
  outlook — Microsoft Graph API via msal
  smtp    — Standard IMAP via imaplib (stdlib)
  api     — API key only; no polling needed

Polling thread (run_integration_poller):
  Sleeps 60s between sweeps.
  For each active integration whose last_synced_at is older than poll_interval_minutes,
  fetches new emails and submits them to the Cardinal ingest endpoint.
"""

from __future__ import annotations

import email as email_lib
import imaplib
import json
import logging
import re
import secrets
import time
from datetime import datetime, timezone
from email.header import decode_header as _decode_header
from typing import Optional

import httpx
from sqlalchemy import text

from app.admin.db import engine

logger = logging.getLogger("kirana_kart.integration_service")

INGEST_URL = "http://ingest:8000/cardinal/ingest"

# ============================================================
# TABLE SETUP
# ============================================================


def ensure_integration_tables() -> None:
    """Create the integrations table if it does not exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS kirana_kart.integrations (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(200) NOT NULL,
        type            VARCHAR(20)  NOT NULL CHECK (type IN ('gmail','outlook','smtp','api')),
        org             VARCHAR(100) NOT NULL DEFAULT 'default',
        business_line   VARCHAR(50)  NOT NULL DEFAULT 'ecommerce',
        module          VARCHAR(50)  NOT NULL DEFAULT 'delivery',
        is_active       BOOLEAN      NOT NULL DEFAULT FALSE,
        config          JSONB        NOT NULL DEFAULT '{}',
        last_synced_at  TIMESTAMPTZ,
        sync_status     VARCHAR(20)  NOT NULL DEFAULT 'idle'
                            CHECK (sync_status IN ('idle','running','ok','error')),
        sync_error      TEXT,
        created_by      INTEGER REFERENCES kirana_kart.users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    """
    try:
        with engine.connect() as conn:
            conn.execute(text(ddl))
            conn.commit()
        logger.info("Integration tables ensured.")
    except Exception as exc:
        logger.error("Failed to create integration tables: %s", exc)


# ============================================================
# API KEY GENERATION
# ============================================================


def generate_api_key() -> str:
    """Generate a unique kk_live_ prefixed API key."""
    return f"kk_live_{secrets.token_hex(32)}"


def register_api_key_in_admin_users(api_key: str) -> None:
    """Insert the API key into admin_users so Phase 3 _verify_api_token() accepts it."""
    with engine.connect() as conn:
        conn.execute(
            text("""
                INSERT INTO kirana_kart.admin_users (api_token, role)
                VALUES (:key, 'viewer')
                ON CONFLICT (api_token) DO NOTHING
            """),
            {"key": api_key},
        )
        conn.commit()


def remove_api_key_from_admin_users(api_key: str) -> None:
    """Remove the API key from admin_users when an API integration is deleted."""
    with engine.connect() as conn:
        conn.execute(
            text("DELETE FROM kirana_kart.admin_users WHERE api_token = :key"),
            {"key": api_key},
        )
        conn.commit()


# ============================================================
# EMAIL HELPERS
# ============================================================


def _decode_mime_header(value: Optional[str]) -> str:
    if not value:
        return ""
    parts = []
    for raw_bytes, charset in _decode_header(value):
        if isinstance(raw_bytes, bytes):
            parts.append(raw_bytes.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(raw_bytes)
    return "".join(parts)


def _extract_plain_text(msg) -> str:
    """Walk a parsed email.message.Message and return the first text/plain part."""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            disp = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in disp:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace") if payload else ""
    else:
        payload = msg.get_payload(decode=True)
        charset = msg.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace") if payload else ""
    return ""


def _strip_html(text: str) -> str:
    """Very lightweight HTML tag stripper for email bodies."""
    return re.sub(r"<[^>]+>", " ", text).strip()


# ============================================================
# TICKET SUBMISSION
# ============================================================


def submit_email_as_ticket(
    *,
    subject: str,
    body: str,
    from_email: str,
    message_id: Optional[str],
    integration: dict,
) -> bool:
    """
    Map an inbound email to a CardinalIngestRequest and POST it to the ingest service.
    Returns True on 202/200 (accepted/duplicate), False otherwise.
    """
    source_map = {"gmail": "gmail", "outlook": "api", "smtp": "smtp"}
    source = source_map.get(integration["type"], "api")

    payload = {
        "cx_email": from_email,
        "subject": subject[:500],
        "description": body[:50_000],
    }
    if message_id:
        payload["thread_id"] = message_id

    body_data = {
        "channel": "email",
        "source": source,
        "org": integration.get("org", "default"),
        "business_line": integration.get("business_line", "ecommerce"),
        "module": integration.get("module", "delivery"),
        "payload": payload,
        "metadata": {
            "called_by": "integration_poller",
            "environment": "production",
        },
    }

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(INGEST_URL, json=body_data)
        if resp.status_code in (200, 202):
            logger.info(
                "Submitted email ticket | integration=%s subject=%r status=%s",
                integration.get("id"),
                subject[:60],
                resp.status_code,
            )
            return True
        logger.warning(
            "Ingest returned %s for integration=%s: %s",
            resp.status_code,
            integration.get("id"),
            resp.text[:200],
        )
        return False
    except Exception as exc:
        logger.error("Failed to submit email ticket: %s", exc)
        return False


# ============================================================
# IMAP POLLING (smtp type)
# ============================================================


def poll_imap(integration: dict) -> tuple[int, Optional[str]]:
    """
    Poll an IMAP mailbox for unseen messages and submit them as tickets.
    Returns (count_submitted, error_message_or_None).
    """
    cfg = integration.get("config", {})
    host = cfg.get("imap_host", "")
    port = int(cfg.get("imap_port", 993))
    username = cfg.get("username", "")
    password = cfg.get("password", "")
    folder = cfg.get("folder", "INBOX")
    mark_as_read = cfg.get("mark_as_read", True)
    use_ssl = cfg.get("use_ssl", True)

    if not (host and username and password):
        return 0, "Missing IMAP credentials (imap_host, username, password)"

    try:
        mail = imaplib.IMAP4_SSL(host, port) if use_ssl else imaplib.IMAP4(host, port)
        mail.login(username, password)
        mail.select(folder)

        status, data = mail.search(None, "UNSEEN")
        if status != "OK":
            mail.logout()
            return 0, "IMAP SEARCH failed"

        ids = data[0].split() if data[0] else []
        submitted = 0

        for num in ids:
            try:
                _, msg_data = mail.fetch(num, "(RFC822)")
                raw = msg_data[0][1]
                msg = email_lib.message_from_bytes(raw)

                subject = _decode_mime_header(msg.get("Subject", "(no subject)"))
                from_addr = _decode_mime_header(msg.get("From", ""))
                message_id = msg.get("Message-ID")
                body = _extract_plain_text(msg)

                # Extract plain email from "Name <email>" format
                m = re.search(r"<([^>]+)>", from_addr)
                from_email = m.group(1) if m else from_addr.strip()

                ok = submit_email_as_ticket(
                    subject=subject,
                    body=body,
                    from_email=from_email,
                    message_id=message_id,
                    integration=integration,
                )
                if ok:
                    submitted += 1
                    if mark_as_read:
                        mail.store(num, "+FLAGS", "\\Seen")
            except Exception as exc:
                logger.warning("Error processing IMAP message %s: %s", num, exc)

        mail.logout()
        return submitted, None

    except imaplib.IMAP4.error as exc:
        return 0, f"IMAP error: {exc}"
    except Exception as exc:
        return 0, f"Unexpected error: {exc}"


def test_imap(config: dict) -> tuple[bool, str]:
    """Verify IMAP credentials by connecting and logging in."""
    host = config.get("imap_host", "")
    port = int(config.get("imap_port", 993))
    username = config.get("username", "")
    password = config.get("password", "")
    use_ssl = config.get("use_ssl", True)

    if not (host and username and password):
        return False, "Missing required fields: imap_host, username, password"

    try:
        mail = imaplib.IMAP4_SSL(host, port) if use_ssl else imaplib.IMAP4(host, port)
        mail.login(username, password)
        mail.logout()
        return True, f"Connected successfully to {host}"
    except imaplib.IMAP4.error as exc:
        return False, f"IMAP login failed: {exc}"
    except Exception as exc:
        return False, f"Connection error: {exc}"


# ============================================================
# GMAIL POLLING
# ============================================================


def poll_gmail(integration: dict) -> tuple[int, Optional[str]]:
    """
    Poll Gmail via the Google API using stored OAuth2 tokens.
    Returns (count_submitted, error_or_None).
    """
    cfg = integration.get("config", {})
    access_token = cfg.get("access_token", "")
    refresh_token = cfg.get("refresh_token", "")
    client_id = cfg.get("client_id", "")
    client_secret = cfg.get("client_secret", "")
    label_filter = cfg.get("label_filter", "INBOX")
    mark_as_read = cfg.get("mark_as_read", True)

    if not (access_token or refresh_token):
        return 0, "Missing Gmail OAuth tokens"

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
        )

        # Refresh if expired
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _update_integration_tokens(
                integration["id"],
                access_token=creds.token,
                refresh_token=creds.refresh_token,
            )

        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        result = service.users().messages().list(
            userId="me",
            labelIds=[label_filter],
            q="is:unread",
            maxResults=50,
        ).execute()

        messages = result.get("messages", [])
        submitted = 0

        for msg_ref in messages:
            try:
                msg = service.users().messages().get(
                    userId="me", id=msg_ref["id"], format="full"
                ).execute()
                headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
                subject = headers.get("Subject", "(no subject)")
                from_email = headers.get("From", "")
                message_id = headers.get("Message-ID")

                m = re.search(r"<([^>]+)>", from_email)
                from_email = m.group(1) if m else from_email.strip()

                # Extract body
                body = _extract_gmail_body(msg.get("payload", {}))

                ok = submit_email_as_ticket(
                    subject=subject,
                    body=body,
                    from_email=from_email,
                    message_id=message_id,
                    integration=integration,
                )
                if ok:
                    submitted += 1
                    if mark_as_read:
                        service.users().messages().modify(
                            userId="me",
                            id=msg_ref["id"],
                            body={"removeLabelIds": ["UNREAD"]},
                        ).execute()
            except Exception as exc:
                logger.warning("Error processing Gmail message %s: %s", msg_ref.get("id"), exc)

        return submitted, None

    except ImportError:
        return 0, "google-auth / google-api-python-client not installed"
    except Exception as exc:
        return 0, f"Gmail API error: {exc}"


def _extract_gmail_body(payload: dict) -> str:
    """Recursively extract plain text from a Gmail message payload."""
    import base64

    mime_type = payload.get("mimeType", "")
    body_data = payload.get("body", {}).get("data", "")

    if mime_type == "text/plain" and body_data:
        try:
            return base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
        except Exception:
            pass

    if mime_type == "text/html" and body_data:
        try:
            html = base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
            return _strip_html(html)
        except Exception:
            pass

    for part in payload.get("parts", []):
        text = _extract_gmail_body(part)
        if text:
            return text

    return ""


def _update_integration_tokens(integration_id: int, access_token: str, refresh_token: Optional[str]) -> None:
    """Persist refreshed OAuth tokens back to the integrations table."""
    try:
        with engine.connect() as conn:
            conn.execute(
                text("""
                    UPDATE kirana_kart.integrations
                    SET config = config
                            || jsonb_build_object('access_token', :at)
                            || CASE WHEN :rt IS NOT NULL
                               THEN jsonb_build_object('refresh_token', :rt)
                               ELSE '{}'::jsonb END,
                        updated_at = NOW()
                    WHERE id = :id
                """),
                {"at": access_token, "rt": refresh_token, "id": integration_id},
            )
            conn.commit()
    except Exception as exc:
        logger.warning("Failed to persist refreshed tokens for integration %s: %s", integration_id, exc)


def test_gmail(config: dict) -> tuple[bool, str]:
    """Verify Gmail OAuth credentials by listing labels."""
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials(
            token=config.get("access_token", ""),
            refresh_token=config.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=config.get("client_id", ""),
            client_secret=config.get("client_secret", ""),
        )
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        profile = service.users().getProfile(userId="me").execute()
        email_addr = profile.get("emailAddress", "unknown")
        return True, f"Connected to Gmail as {email_addr}"
    except ImportError:
        return False, "google-auth / google-api-python-client not installed"
    except Exception as exc:
        return False, f"Gmail auth failed: {exc}"


# ============================================================
# OUTLOOK POLLING
# ============================================================


def poll_outlook(integration: dict) -> tuple[int, Optional[str]]:
    """
    Poll Outlook via Microsoft Graph API using MSAL client credentials.
    Returns (count_submitted, error_or_None).
    """
    cfg = integration.get("config", {})
    tenant_id = cfg.get("tenant_id", "")
    client_id = cfg.get("client_id", "")
    client_secret = cfg.get("client_secret", "")
    email_address = cfg.get("email_address", "")
    folder = cfg.get("folder", "Inbox")
    mark_as_read = cfg.get("mark_as_read", True)

    if not (tenant_id and client_id and client_secret and email_address):
        return 0, "Missing Outlook credentials (tenant_id, client_id, client_secret, email_address)"

    try:
        import msal

        app = msal.ConfidentialClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=client_secret,
        )
        result = app.acquire_token_for_client(["https://graph.microsoft.com/.default"])
        if "access_token" not in result:
            return 0, f"MSAL token error: {result.get('error_description', 'unknown')}"

        access_token = result["access_token"]
        headers = {"Authorization": f"Bearer {access_token}"}

        # Fetch unread messages from the specified folder
        url = (
            f"https://graph.microsoft.com/v1.0/users/{email_address}"
            f"/mailFolders/{folder}/messages"
            "?$filter=isRead eq false&$select=id,subject,body,from,receivedDateTime,internetMessageId"
            "&$top=50"
        )
        with httpx.Client(timeout=20) as client:
            resp = client.get(url, headers=headers)

        if resp.status_code != 200:
            return 0, f"Graph API error {resp.status_code}: {resp.text[:200]}"

        messages = resp.json().get("value", [])
        submitted = 0

        for msg in messages:
            try:
                subject = msg.get("subject", "(no subject)")
                from_info = msg.get("from", {}).get("emailAddress", {})
                from_email = from_info.get("address", "")
                message_id = msg.get("internetMessageId")
                body_content = msg.get("body", {}).get("content", "")
                body_type = msg.get("body", {}).get("contentType", "text")
                body = _strip_html(body_content) if body_type == "html" else body_content

                ok = submit_email_as_ticket(
                    subject=subject,
                    body=body,
                    from_email=from_email,
                    message_id=message_id,
                    integration=integration,
                )
                if ok:
                    submitted += 1
                    if mark_as_read:
                        patch_url = (
                            f"https://graph.microsoft.com/v1.0/users/{email_address}"
                            f"/messages/{msg['id']}"
                        )
                        with httpx.Client(timeout=10) as client:
                            client.patch(
                                patch_url,
                                headers={**headers, "Content-Type": "application/json"},
                                json={"isRead": True},
                            )
            except Exception as exc:
                logger.warning("Error processing Outlook message: %s", exc)

        return submitted, None

    except ImportError:
        return 0, "msal not installed"
    except Exception as exc:
        return 0, f"Outlook API error: {exc}"


def test_outlook(config: dict) -> tuple[bool, str]:
    """Verify Outlook credentials by acquiring an access token."""
    try:
        import msal

        app = msal.ConfidentialClientApplication(
            config.get("client_id", ""),
            authority=f"https://login.microsoftonline.com/{config.get('tenant_id', '')}",
            client_credential=config.get("client_secret", ""),
        )
        result = app.acquire_token_for_client(["https://graph.microsoft.com/.default"])
        if "access_token" in result:
            return True, "Outlook credentials verified (token acquired)"
        return False, f"Token error: {result.get('error_description', 'unknown')}"
    except ImportError:
        return False, "msal not installed"
    except Exception as exc:
        return False, f"Outlook auth failed: {exc}"


# ============================================================
# SYNC STATUS HELPERS
# ============================================================


def _set_sync_status(integration_id: int, status: str, error: Optional[str] = None) -> None:
    try:
        with engine.connect() as conn:
            conn.execute(
                text("""
                    UPDATE kirana_kart.integrations
                    SET sync_status = :status,
                        sync_error  = :error,
                        last_synced_at = NOW(),
                        updated_at = NOW()
                    WHERE id = :id
                """),
                {"status": status, "error": error, "id": integration_id},
            )
            conn.commit()
    except Exception as exc:
        logger.warning("Failed to update sync status for integration %s: %s", integration_id, exc)


def run_one_integration(integration: dict) -> None:
    """Run one poll cycle for a single integration and update its status."""
    itype = integration.get("type")
    iid = integration.get("id")

    _set_sync_running(iid)

    if itype == "gmail":
        count, err = poll_gmail(integration)
    elif itype == "outlook":
        count, err = poll_outlook(integration)
    elif itype == "smtp":
        count, err = poll_imap(integration)
    else:
        # API type — no polling needed
        _set_sync_status(iid, "ok")
        return

    if err:
        logger.error("Integration %s (%s) poll error: %s", iid, itype, err)
        _set_sync_status(iid, "error", err)
    else:
        logger.info("Integration %s (%s) submitted %d tickets", iid, itype, count)
        _set_sync_status(iid, "ok")


def _set_sync_running(integration_id: int) -> None:
    try:
        with engine.connect() as conn:
            conn.execute(
                text("""
                    UPDATE kirana_kart.integrations
                    SET sync_status = 'running', updated_at = NOW()
                    WHERE id = :id
                """),
                {"id": integration_id},
            )
            conn.commit()
    except Exception:
        pass


# ============================================================
# BACKGROUND POLLER
# ============================================================


def _get_due_integrations() -> list[dict]:
    """Return active integrations whose next poll is due."""
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text("""
                    SELECT id, name, type, org, business_line, module, config,
                           last_synced_at, sync_status,
                           COALESCE((config->>'poll_interval_minutes')::int, 10) AS poll_minutes
                    FROM kirana_kart.integrations
                    WHERE is_active = TRUE
                      AND type != 'api'
                      AND sync_status != 'running'
                      AND (
                          last_synced_at IS NULL
                          OR last_synced_at < NOW() - INTERVAL '1 minute'
                              * COALESCE((config->>'poll_interval_minutes')::int, 10)
                      )
                """)
            ).mappings().all()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.error("Failed to query due integrations: %s", exc)
        return []


# Advisory lock namespace for the poller. Any constant works as long as it is
# not reused by another advisory lock in this database — the startup DDL lock
# in app/admin/main.py uses a different id.
_POLLER_LOCK_ID = 0x4B4B_504F  # "KKPO"


def _poll_one_sweep() -> None:
    """
    Run a single poll sweep, holding a Postgres advisory lock for its duration.

    The governance service runs with replicas > 1 and each replica starts this
    poller in-process. `_get_due_integrations` filters on sync_status, but that
    is a read followed by a separate write, so two replicas would both see the
    same integration as due and both ingest it. A session-level advisory lock
    makes the sweep mutually exclusive across replicas; whichever replica does
    not get the lock simply skips this minute.
    """
    with engine.connect() as conn:
        acquired = conn.execute(
            text("SELECT pg_try_advisory_lock(:id)"),
            {"id": _POLLER_LOCK_ID},
        ).scalar()

        if not acquired:
            logger.debug("Integration poll sweep already running elsewhere — skipping.")
            return

        try:
            due = _get_due_integrations()
            if due:
                logger.info("Integration poller: %d integration(s) due", len(due))
            for integration in due:
                try:
                    run_one_integration(integration)
                except Exception as exc:
                    logger.error(
                        "Uncaught error in integration poller for id=%s: %s",
                        integration.get("id"),
                        exc,
                        exc_info=True,
                    )
        finally:
            conn.execute(
                text("SELECT pg_advisory_unlock(:id)"),
                {"id": _POLLER_LOCK_ID},
            )


def run_integration_poller() -> None:
    """
    Background daemon loop — runs every 60 seconds.
    Picks up active integrations that are due for a poll and runs them.
    """
    logger.info("Integration poller started.")
    while True:
        try:
            _poll_one_sweep()
        except Exception as exc:
            logger.error("Integration poller sweep error: %s", exc, exc_info=True)

        time.sleep(60)
