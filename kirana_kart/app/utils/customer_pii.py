"""Customer storage boundary. Legacy reads support a staged, resumable cutover.

All new writes encrypt; a missing key is an error. The explicit envelope avoids
mistaking long base64-like plaintext for ciphertext. Blind search is exact email
(case-folded and trimmed), while customer IDs retain substring search.
"""
import hashlib
import hmac
from collections.abc import Mapping

from app.utils.encryption import _load_key, encrypt_pii, decrypt_pii

PREFIX = 'pii:v1:'
FIELDS = ('email', 'phone', 'date_of_birth')


def email_index(email: str | None) -> str | None:
    if email is None:
        return None
    # Domain-separated HMAC key; rotate the index with the encryption key.
    key = hmac.digest(_load_key(), b'orgsense:customer-email-index:v1', 'sha256')
    return hmac.new(key, email.strip().casefold().encode(), hashlib.sha256).hexdigest()


def encode(value) -> str | None:
    if value is None:
        return None
    # Inputs at the write boundary are always plaintext, even if they happen
    # to start with PREFIX; migration code explicitly decodes first.
    return PREFIX + encrypt_pii(str(value))


def decode(value):
    if isinstance(value, str) and value.startswith(PREFIX):
        return decrypt_pii(value[len(PREFIX):])
    return value


def protect_customer(row: Mapping) -> dict:
    result = dict(row)
    for field in FIELDS:
        if field in result:
            result[field] = encode(result[field])
    if 'email' in row:
        result['email_blind_index'] = email_index(row['email'])
    return result


def reveal_customer(row: Mapping) -> dict:
    result = dict(row)
    for field in FIELDS:
        if field in result:
            result[field] = decode(result[field])
    result.pop('email_blind_index', None)
    return result
