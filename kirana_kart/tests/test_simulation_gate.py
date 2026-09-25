"""
tests/test_simulation_gate.py
=============================
Tests for the Policy Studio sample replay gate
(policy_lifecycle.run_simulation_gate, served by POST /bpm/kb/{kb_id}/simulate).

The original flaw: the endpoint was a declared stub that returned

    unchanged_rate = 0.94 if rule_count > 0 else 1.0

so the gate passed unconditionally and the reviewer saw a constant. It must
report "unavailable" with no metrics when the replay cannot run, and — now
that the gate drives the proposal's stage — must not move the stage then.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.admin.services.policy_lifecycle import (
    LifecycleError,
    SIMULATION_GATE_THRESHOLD,
    run_simulation_gate,
)
from tests.policy_fakes import FakeConn, actor


def _run(conn, sim_result=None, sim_error=None):
    simulator = MagicMock()
    if sim_error:
        simulator.run_simulation.side_effect = sim_error
    else:
        simulator.run_simulation.return_value = sim_result
    return run_simulation_gate(conn, "default", "v_candidate", actor(), simulator), simulator


class TestHonestUnavailability:
    """Every branch that cannot produce a real number must say so and change nothing."""

    def test_no_rules(self):
        conn = FakeConn(counts={"rules": 0}, runtime=("v_live", None))
        res, _ = _run(conn)
        assert res["status"] == "unavailable" and res["passed"] is None and res["metrics"] is None
        assert "no generated rules" in res["reason"].lower()
        assert conn.transitions == [] and conn.gates == []

    def test_pending_review_items_block_the_replay(self):
        conn = FakeConn(counts={"actions_pending": 2}, runtime=("v_live", None))
        res, simulator = _run(conn)
        assert res["status"] == "unavailable" and "2 review items" in res["reason"]
        simulator.run_simulation.assert_not_called()

    def test_candidate_is_already_the_baseline(self):
        conn = FakeConn(runtime=("v_candidate", None))
        res, _ = _run(conn)
        assert res["status"] == "unavailable" and res["passed"] is None

    def test_simulator_failure_is_reported_not_invented(self):
        conn = FakeConn(runtime=("v_live", None))
        res, _ = _run(conn, sim_error=Exception("No sample tickets found in simulation_tickets table"))
        assert res["status"] == "unavailable" and res["passed"] is None
        assert "sample tickets" in res["reason"]
        assert conn.transitions == [] and conn.gates == []

    def test_zero_tickets_tested(self):
        conn = FakeConn(runtime=("v_live", None))
        res, _ = _run(conn, sim_result={"tickets_tested": 0, "differences": 0, "examples": []})
        assert res["status"] == "unavailable" and res["metrics"] is None

    def test_never_returns_the_old_hardcoded_rate(self):
        """0.94 must only ever appear as a genuinely computed value."""
        for conn, error in (
            (FakeConn(counts={"rules": 0}, runtime=("v_live", None)), None),
            (FakeConn(runtime=("v_live", None)), Exception("boom")),
        ):
            res, _ = _run(conn, sim_error=error)
            assert res["metrics"] is None


class TestFirstVersion:

    def test_no_live_policy_is_not_applicable_not_a_measured_rate(self):
        conn = FakeConn(runtime=None)
        res, simulator = _run(conn)
        simulator.run_simulation.assert_not_called()
        assert res["status"] == "not_applicable" and res["passed"] is True
        assert "unchanged_rate" not in res["metrics"]
        assert "first live version" in res["reason"].lower()
        assert res["stage"] == "SHADOW_GATE"


class TestRealVerdict:

    def _verdict(self, tested, differences, examples=()):
        conn = FakeConn(runtime=("v_live", None))
        res, _ = _run(conn, sim_result={"tickets_tested": tested, "differences": differences,
                                        "examples": list(examples)})
        return res, conn

    def test_small_change_passes_and_advances(self):
        res, conn = self._verdict(100, 5)
        assert res["status"] == "ok" and res["passed"] is True
        assert res["metrics"]["unchanged_rate"] == 0.95
        assert res["metrics"]["changed_count"] == 5 and res["metrics"]["ticket_count"] == 100
        assert conn.transitions == [("RULE_EDIT", "SIMULATION_GATE"), ("SIMULATION_GATE", "SHADOW_GATE")]
        assert len(conn.gates) == 1 and conn.gates[0]["passed"] is True

    def test_large_change_fails_and_is_recorded(self):
        res, conn = self._verdict(100, 40)
        assert res["passed"] is False and res["metrics"]["unchanged_rate"] == 0.60
        assert res["stage"] == "SIMULATION_FAILED"
        assert conn.gates[0]["passed"] is False

    def test_threshold_boundary_passes(self):
        res, _ = self._verdict(100, 20)
        assert res["metrics"]["unchanged_rate"] == SIMULATION_GATE_THRESHOLD
        assert res["passed"] is True

    def test_identical_decisions_pass(self):
        res, _ = self._verdict(50, 0)
        assert res["passed"] is True and res["metrics"]["unchanged_rate"] == 1.0

    def test_result_names_what_was_compared(self):
        res, _ = self._verdict(10, 1)
        assert res["metrics"]["baseline_version"] == "v_live"
        assert res["metrics"]["candidate_version"] == "v_candidate"

    def test_examples_are_capped(self):
        res, _ = self._verdict(100, 30, [{"ticket_id": i} for i in range(50)])
        assert len(res["examples"]) == 20

    def test_rerun_after_failure_starts_from_rule_edit(self):
        conn = FakeConn(stage="SIMULATION_FAILED", runtime=("v_live", None))
        _run(conn, sim_result={"tickets_tested": 10, "differences": 0, "examples": []})
        assert conn.transitions[0] == ("SIMULATION_FAILED", "RULE_EDIT")
        assert conn.stage == "SHADOW_GATE"

    def test_draft_with_rules_is_advanced_through_rule_edit(self):
        conn = FakeConn(stage="DRAFT", runtime=("v_live", None))
        _run(conn, sim_result={"tickets_tested": 10, "differences": 0, "examples": []})
        assert [t[1] for t in conn.transitions] == [
            "AI_COMPILE_QUEUED", "RULE_EDIT", "SIMULATION_GATE", "SHADOW_GATE"]


class TestLocked:

    @pytest.mark.parametrize("stage", ["PENDING_APPROVAL", "ACTIVE", "RETIRED"])
    def test_cannot_retest_a_frozen_version(self, stage):
        with pytest.raises(LifecycleError) as exc:
            _run(FakeConn(stage=stage, runtime=("v_live", None)))
        assert exc.value.status_code == 409


class TestValidation:

    def test_entity_id_is_required(self):
        from app.admin.routes import bpm_routes
        with patch.object(bpm_routes, "engine", MagicMock()):
            with pytest.raises(HTTPException) as exc:
                bpm_routes.simulate_version("default", {}, actor())
        assert exc.value.status_code == 400
