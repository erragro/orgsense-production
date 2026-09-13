"""
tests/test_policy_activation.py
===============================
Regression tests for policy activation.

The flaw: nothing in the codebase ever set policy_versions.is_active = TRUE.
compiler_service inserts the row with is_active = FALSE, and
phase4_enricher refuses to process any ticket unless it is TRUE:

    "Policy version '{v}' exists but is_active=False."

KBRegistryService.publish_version() set kb_runtime_config.active_version and
stopped there, so every published policy failed enrichment on every ticket.
The database export in this repo shows exactly that state — four compiled
versions, all is_active = f, with kb_runtime_config pointing at one of them.
"""

from unittest.mock import MagicMock

import pytest

from app.l1_ingestion.kb_registry.kb_registry_service import KBRegistryService


class _Conn:
    """Records executed statements and replays canned scalar results."""

    def __init__(self, scalars=None, rowcounts=None):
        self.statements: list[tuple[str, dict]] = []
        self._scalars = list(scalars or [])
        self._rowcounts = list(rowcounts or [])

    def execute(self, stmt, params=None):
        self.statements.append((str(stmt), params or {}))
        result = MagicMock()
        # Consume a canned value only when the caller actually asks for one,
        # so statements that ignore the result do not eat the queue.
        result.scalar.side_effect = lambda: self._scalars.pop(0) if self._scalars else None
        result.rowcount = self._rowcounts.pop(0) if self._rowcounts else 1
        return result

    def sql_matching(self, *fragments: str) -> list[str]:
        return [
            sql for sql, _ in self.statements
            if all(f.lower() in sql.lower() for f in fragments)
        ]


class TestActivateVersion:

    def test_sets_policy_versions_is_active(self):
        """The write that was missing entirely."""
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")

        activations = conn.sql_matching("update", "policy_versions", "is_active = TRUE")
        assert activations, "policy_versions.is_active is never set to TRUE"

    def test_sets_activated_at(self):
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")
        assert conn.sql_matching("update", "policy_versions", "activated_at")

    def test_deactivates_every_other_version(self):
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")

        deactivations = conn.sql_matching("update", "policy_versions", "is_active = FALSE")
        assert deactivations, "previous versions are never deactivated"
        assert "policy_version <> :version_label" in deactivations[0]

    def test_updates_runtime_config(self):
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")
        assert conn.sql_matching("update", "kb_runtime_config", "active_version")

    def test_runtime_config_update_is_scoped_to_one_row(self):
        """
        The read path uses ORDER BY id DESC LIMIT 1, so an unqualified UPDATE
        would rewrite historical rows as well.
        """
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")

        update = conn.sql_matching("update", "kb_runtime_config")[0]
        assert "where id = :id" in update.lower()

    def test_inserts_runtime_config_when_absent(self):
        conn = _Conn(scalars=[None])   # no existing kb_runtime_config row
        KBRegistryService._activate_version(conn, "v_first")
        assert conn.sql_matching("insert into", "kb_runtime_config")

    def test_uncompiled_version_is_rejected(self):
        """No policy_versions row means nothing to activate — fail loudly."""
        conn = _Conn(scalars=[1], rowcounts=[1, 0])  # deactivate ok, activate matches nothing
        with pytest.raises(Exception, match="must be compiled"):
            KBRegistryService._activate_version(conn, "v_never_compiled")

    def test_both_tables_are_written_together(self):
        """
        The two writes have to happen in one call. Splitting them is what
        allowed kb_runtime_config to point at a version that policy_versions
        still marked inactive.
        """
        conn = _Conn(scalars=[1])
        KBRegistryService._activate_version(conn, "v_test4")

        assert conn.sql_matching("policy_versions", "is_active = TRUE")
        assert conn.sql_matching("kb_runtime_config", "active_version")
