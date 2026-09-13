"""
tests/test_pii_encryption.py
============================
Tests for app/utils/encryption.py.

The module is correct but currently unused — see its docstring. These tests
exist so that the wiring work, when it happens, starts from a verified
primitive rather than an unexercised one.
"""

import pytest

from app.utils.encryption import decrypt_pii, encrypt_pii

KEY = "a" * 64  # 32 bytes of hex


class TestRoundTrip:

    def test_plaintext_survives_a_round_trip(self):
        assert decrypt_pii(encrypt_pii("user@example.com", KEY), KEY) == "user@example.com"

    def test_none_passes_through(self):
        assert encrypt_pii(None, KEY) is None
        assert decrypt_pii(None, KEY) is None

    def test_unicode_survives(self):
        value = "সুরজিৎ+91-98765@ন.example"
        assert decrypt_pii(encrypt_pii(value, KEY), KEY) == value

    def test_ciphertext_is_not_the_plaintext(self):
        assert "user@example.com" not in encrypt_pii("user@example.com", KEY)


class TestNonce:

    def test_same_plaintext_encrypts_differently_each_time(self):
        """A fresh nonce per value — otherwise equal emails would be linkable."""
        a = encrypt_pii("user@example.com", KEY)
        b = encrypt_pii("user@example.com", KEY)
        assert a != b
        assert decrypt_pii(a, KEY) == decrypt_pii(b, KEY)


class TestKeyHandling:

    def test_wrong_key_cannot_decrypt(self):
        blob = encrypt_pii("user@example.com", KEY)
        with pytest.raises(Exception):
            decrypt_pii(blob, "b" * 64)

    def test_missing_key_is_rejected(self, monkeypatch):
        monkeypatch.setenv("PII_ENCRYPTION_KEY", "")
        with pytest.raises(ValueError, match="PII_ENCRYPTION_KEY"):
            encrypt_pii("x", "")

    def test_non_hex_key_is_rejected(self):
        with pytest.raises(ValueError, match="hex"):
            encrypt_pii("x", "not-hex-at-all!!")

    def test_wrong_length_key_is_rejected(self):
        with pytest.raises(ValueError):
            encrypt_pii("x", "abcd")


class TestTamperDetection:

    def test_modified_ciphertext_is_rejected(self):
        """AES-GCM is authenticated — a flipped byte must not decrypt."""
        import base64

        blob = encrypt_pii("user@example.com", KEY)
        raw = bytearray(base64.b64decode(blob))
        raw[-1] ^= 0x01
        tampered = base64.b64encode(bytes(raw)).decode()

        with pytest.raises(Exception):
            decrypt_pii(tampered, KEY)
