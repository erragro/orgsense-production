"""
tests/test_simulation_gate.py
=============================
Tests for the BPM simulation gate (POST /bpm/kb/{kb_id}/simulate).

The flaw: the endpoint was a declared stub that returned

    unchanged_rate = 0.94 if rule_count > 0 else 1.0
    passed = unchanged_rate >= 0.80

so the gate passed unconditionally whenever any rule existed, and the number
shown to the reviewer was a constant. The frontend compounded it with its own
`?? 0.94` fallback, displaying "94.0% decisions unchanged" even when the
backend returned nothing at all.

It now runs PolicySimulationService.run_simulation and, when that genuinely
cannot run, reports status="unavailable" with no metrics rather than a guess.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.admin.routes import bpm_routes
from app.admin.routes.bpm_routes import SIMULATION_GATE_THRESHOLD, simulate_version


@pytest.fixture
def user():
    u = MagicMock()
    u.id = 1
    u.email = "reviewer@example.com"
    return u


def _engine(rule_count: int, baseline: str | None):
    """Engine whose connection answers the gate's two lookup queries."""
    scalars = [rule_count, baseline]
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)

    def execute(stmt, params=None):
        res = MagicMock()
        res.scalar.side_effect = lambda: scalars.pop(0) if scalars else None
        res.mappings.return_value.first.return_value = None  # no BPM instance
        return res

    conn.execute.side_effect = execute
    engine = MagicMock()
    engine.connect.return_value = conn
    return engine


def _run(engine, sim_result=None, sim_error=None, user=None):
    service = MagicMock()
    if sim_error:
        service.return_value.run_simulation.side_effect = sim_error
    else:
        service.return_value.run_simulation.return_value = sim_result

    with patch.object(bpm_routes, "engine", engine), \
         patch.object(bpm_routes, "_require_kb_access", MagicMock()), \
         patch(
             "app.l45_ml_platform.simulation.policy_simulation_service."
             "PolicySimulationService",
             service,
         ):
        return simulate_version("default", {"entity_id": "v_candidate"}, user)


class TestHonestUnavailability:
    """Every branch that cannot produce a real number must say so."""

    def test_no_rules(self, user):
        res = _run(_engine(rule_count=0, baseline="v_live"), user=user)
        assert res["status"] == "unavailable"
        assert res["passed"] is None
        assert res["metrics"] is None
        assert "no generated rules" in res["reason"].lower()

    def test_no_active_baseline(self, user):
        res = _run(_engine(rule_count=5, baseline=None), user=user)
        assert res["status"] == "unavailable"
        assert res["passed"] is None
        assert "first live version" in res["reason"].lower()

    def test_candidate_is_already_the_baseline(self, user):
        res = _run(_engine(rule_count=5, baseline="v_candidate"), user=user)
        assert res["status"] == "unavailable"
        assert res["passed"] is None

    def test_simulator_failure_is_reported_not_invented(self, user):
        res = _run(
            _engine(rule_count=5, baseline="v_live"),
            sim_error=Exception("No sample tickets found in simulation_tickets table"),
            user=user,
        )
        assert res["status"] == "unavailable"
        assert res["passed"] is None
        assert "sample tickets" in res["reason"]

    def test_zero_tickets_tested(self, user):
        res = _run(
            _engine(rule_count=5, baseline="v_live"),
            sim_result={"tickets_tested": 0, "differences": 0, "examples": []},
            user=user,
        )
        assert res["status"] == "unavailable"
        assert res["metrics"] is None

    def test_never_returns_the_old_hardcoded_rate(self, user):
        """0.94 must only ever appear as a genuinely computed value."""
        for res in (
            _run(_engine(0, "v_live"), user=user),
            _run(_engine(5, None), user=user),
            _run(_engine(5, "v_live"), sim_error=Exception("boom"), user=user),
        ):
            assert res["metrics"] is None


class TestRealVerdict:

    def test_small_change_passes(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={"tickets_tested": 100, "differences": 5, "examples": []},
            user=user,
        )
        assert res["status"] == "ok"
        assert res["passed"] is True
        assert res["metrics"]["unchanged_rate"] == 0.95
        assert res["metrics"]["changed_count"] == 5
        assert res["metrics"]["ticket_count"] == 100

    def test_large_change_fails(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={"tickets_tested": 100, "differences": 40, "examples": []},
            user=user,
        )
        assert res["passed"] is False
        assert res["metrics"]["unchanged_rate"] == 0.60

    def test_threshold_boundary_passes(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={"tickets_tested": 100, "differences": 20, "examples": []},
            user=user,
        )
        assert res["metrics"]["unchanged_rate"] == SIMULATION_GATE_THRESHOLD
        assert res["passed"] is True

    def test_identical_decisions_pass(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={"tickets_tested": 50, "differences": 0, "examples": []},
            user=user,
        )
        assert res["passed"] is True
        assert res["metrics"]["unchanged_rate"] == 1.0

    def test_result_names_what_was_compared(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={"tickets_tested": 10, "differences": 1, "examples": []},
            user=user,
        )
        assert res["metrics"]["baseline_version"] == "v_live"
        assert res["metrics"]["candidate_version"] == "v_candidate"

    def test_examples_are_capped(self, user):
        res = _run(
            _engine(rule_count=12, baseline="v_live"),
            sim_result={
                "tickets_tested": 100,
                "differences": 30,
                "examples": [{"ticket_id": i} for i in range(50)],
            },
            user=user,
        )
        assert len(res["examples"]) == 20


class TestValidation:

    def test_entity_id_is_required(self, user):
        from fastapi import HTTPException

        with patch.object(bpm_routes, "engine", MagicMock()):
            with pytest.raises(HTTPException) as exc:
                simulate_version("default", {}, user)
        assert exc.value.status_code == 400
