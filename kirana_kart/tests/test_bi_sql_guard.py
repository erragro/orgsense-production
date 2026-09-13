"""
tests/test_bi_sql_guard.py
==========================
Tests for validate_sql — the guard standing between LLM-generated SQL and
the database.

The regex is a denylist over attacker-influenceable input, so it is not the
primary control (that is the SELECT-only database role, enforced in
app/config.py). These tests pin the behaviour it does provide.
"""

import pytest

from app.admin.services.bi_agent_service import validate_sql


class TestAccepts:

    def test_plain_select(self):
        assert validate_sql("SELECT 1").startswith("SELECT")

    def test_leading_whitespace_and_comments(self):
        cleaned = validate_sql("  -- a comment\n SELECT id FROM kirana_kart.fdraw")
        assert cleaned.startswith("SELECT")

    def test_trailing_semicolon_is_fine(self):
        """A single trailing semicolon is not a stacked query."""
        assert validate_sql("SELECT 1;") == "SELECT 1;"


class TestRejects:

    @pytest.mark.parametrize("sql", [
        "DELETE FROM kirana_kart.fdraw",
        "UPDATE kirana_kart.users SET is_super_admin = TRUE",
        "DROP TABLE kirana_kart.customers",
        "INSERT INTO kirana_kart.users VALUES (1)",
        "TRUNCATE kirana_kart.orders",
        "GRANT ALL ON SCHEMA kirana_kart TO PUBLIC",
    ])
    def test_write_statements(self, sql):
        with pytest.raises(ValueError):
            validate_sql(sql)

    def test_stacked_statements(self):
        with pytest.raises(ValueError, match="Multi-statement"):
            validate_sql("SELECT 1; DROP TABLE kirana_kart.customers")

    def test_write_hidden_behind_a_comment(self):
        """Comments are stripped before the keyword check, not after."""
        with pytest.raises(ValueError):
            validate_sql("SELECT 1 /* x */ ; DELETE FROM kirana_kart.fdraw")

    @pytest.mark.parametrize("sql", [
        "SELECT pg_read_file('/etc/passwd')",
        "SELECT lo_export(1, '/tmp/x')",
        "SELECT dblink('host=evil', 'SELECT 1')",
        "SELECT pg_terminate_backend(1)",
    ])
    def test_filesystem_and_superuser_functions(self, sql):
        with pytest.raises(ValueError):
            validate_sql(sql)

    def test_non_select_leading_statement(self):
        with pytest.raises(ValueError, match="Only SELECT"):
            validate_sql("WITH x AS (DELETE FROM kirana_kart.fdraw RETURNING 1) SELECT * FROM x")
