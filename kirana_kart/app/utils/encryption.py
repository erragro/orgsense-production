"""
app/utils/encryption.py
=======================
Field-level AES-256-GCM encryption for sensitive PII columns.

Usage:
    from app.utils.encryption import encrypt_pii, decrypt_pii

    # Before INSERT:
    encrypted_email = encrypt_pii(customer_email)

    # After SELECT:
    plaintext_email = decrypt_pii(encrypted_email)

Design:
  - AES-256-GCM: authenticated encryption, detects tampering
  - Each value gets a fresh 12-byte random nonce (prepended to ciphertext)
  - Output is base64-encoded for safe storage in VARCHAR/TEXT columns
  - Key sourced from PII_ENCRYPTION_KEY env var (32 hex bytes = 64 hex chars)
  - Returns None safely for None inputs (nullable columns)

Customer storage wiring is implemented in app/utils/customer_pii.py. Existing
rows require the explicit, resumable scripts/customer_pii_backfill.py cutover.
This primitive alone is not a claim of regulatory compliance.

Key rotation:
  When rotating keys, use decrypt_pii(old_key=...) + encrypt_pii(new_key=...).
  A migration script should be used for bulk re-encryption.
"""

from __future__ import annotations

import base64
import os
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings

# ---------------------------------------------------------------------------
# Key loading
# ---------------------------------------------------------------------------

_NONCE_LENGTH = 12  # 96 bits — standard for AES-GCM


def _load_key(key_hex: str | None = None) -> bytes:
    """
    Load the AES-256 key from settings or provided hex string.
    Raises ValueError if key is missing or invalid length.
    """
    raw = settings.pii_encryption_key if key_hex is None else key_hex
    if not raw:
        raise ValueError(
            "PII_ENCRYPTION_KEY is not set. "
            "Generate with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    try:
        key_bytes = bytes.fromhex(raw)
    except ValueError:
        raise ValueError("PII_ENCRYPTION_KEY must be a valid hex string")
    if len(key_bytes) != 32:
        raise ValueError(
            f"PII_ENCRYPTION_KEY must be 64 hex chars (32 bytes). "
            f"Got {len(key_bytes)} bytes."
        )
    return key_bytes


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def encrypt_pii(plaintext: str | None, key_hex: str | None = None) -> str | None:
    """
    Encrypt a plaintext PII value.

    Returns:
        Base64-encoded string of (nonce || ciphertext || tag), or None if input is None.
    """
    if plaintext is None:
        return None

    key = _load_key(key_hex)
    aesgcm = AESGCM(key)
    nonce = os.urandom(_NONCE_LENGTH)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), associated_data=None)
    # Prepend nonce so it travels with the ciphertext
    payload = nonce + ciphertext
    return base64.b64encode(payload).decode("ascii")


def decrypt_pii(ciphertext_b64: str | None, key_hex: str | None = None) -> str | None:
    """
    Decrypt a PII value previously encrypted with encrypt_pii().

    Returns:
        Original plaintext string, or None if input is None.

    Raises:
        ValueError: if the ciphertext is tampered, malformed, or key is wrong.
    """
    if ciphertext_b64 is None:
        return None

    key = _load_key(key_hex)
    try:
        payload = base64.b64decode(ciphertext_b64.encode("ascii"))
    except Exception:
        raise ValueError("Invalid PII ciphertext: not valid base64")

    if len(payload) < _NONCE_LENGTH + 16:  # 16 = GCM tag minimum
        raise ValueError("Invalid PII ciphertext: too short")

    nonce = payload[:_NONCE_LENGTH]
    encrypted = payload[_NONCE_LENGTH:]

    try:
        aesgcm = AESGCM(key)
        plaintext_bytes = aesgcm.decrypt(nonce, encrypted, associated_data=None)
    except Exception:
        raise ValueError("PII decryption failed: invalid key or tampered ciphertext")

    return plaintext_bytes.decode("utf-8")


def is_encrypted(value: str | None) -> bool:
    """
    Heuristic check: returns True if the value looks like an encrypt_pii() output.
    Use for migration scripts to avoid double-encrypting already-encrypted values.
    """
    if value is None:
        return False
    try:
        decoded = base64.b64decode(value.encode("ascii"))
        # AES-GCM output is always: 12 (nonce) + len(plaintext) + 16 (tag) bytes
        return len(decoded) >= 12 + 16
    except Exception:
        return False
