"""
tests/test_bpm_publish.py
=========================
Tests for Policy Studio activation (policy_lifecycle.approve_and_activate,
served by POST /bpm/kb/{kb_id}/publish and POST /bpm/approvals/{id}/approve).

Flaws this guards against:

  * Publishing only moved the BPM stage marker to ACTIVE; the runtime kept
    serving the previous policy. Approval did the same.
  * commit_proposals_to_registry failures were swallowed as "non-fatal".
  * The person who requested approval could activate their own change.
  * A version could be activated before the runtime could serve it, or after
    its rules changed.

Transactional all-or-nothing behaviour is proven against PostgreSQL in
tests/integration/test_policy_studio_lifecycle.py.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.admin.services import policy_lifecycle
from app.admin.services.policy_lifecycle import LifecycleError, approve_and_activate
from tests.policy_fakes import FakeConn, actor

FINGERPRINT = policy_lifecycle.rules_fingerprint(FakeConn(), "v_candidate")
READY = {"vector_status": "completed", "artifact_hash": FINGERPRINT}
APPROVAL = {"id": 9, "requested_by_id": 3, "instance_id": 42}


def _activate(conn=None, commit_error=None, publish_error=None, user=None, separate=True):
    conn = conn or FakeConn(stage="PENDING_APPROVAL", approval=dict(APPROVAL),
                            version=dict(READY), runtime=("v_live", None))
    order = []
    commit = MagicMock(side_effect=commit_error or (lambda *a, **k: order.append("commit")))
    registry = MagicMock()
    registry.return_value.publish_version.side_effect = publish_error or (lambda *a, **k: order.append("publish"))
    with patch("app.l45_ml_platform.compiler.sop_extractor.commit_proposals_to_registry", commit), \
         patch("app.l1_ingestion.kb_registry.kb_registry_service.KBRegistryService", registry):
        try:
            result = approve_and_activate(conn, MagicMock(), "default", 42, user or actor(),
                                          require_separate_approver=separate)
        except LifecycleError as exc:
            result = {"error": exc}
    return result, conn, commit, registry, order


class TestActivation:

    def test_approval_actually_activates_the_version(self):
        result, conn, _c, registry, _o = _activate()
        registry.return_value.publish_version.assert_called_once()
        args, kwargs = registry.return_value.publish_version.call_args
        assert args[0] == "v_candidate" and kwargs["conn"] is conn
        assert result["active_version"] == "v_candidate"
        assert result["previous_version"] == "v_live"

    def test_stage_advances_only_after_activation(self):
        _r, conn, _c, _reg, order = _activate()
        assert order == ["commit", "publish"]
        assert conn.transitions == [("PENDING_APPROVAL", "ACTIVE")]

    def test_failed_activation_is_refused(self):
        result, conn, _c, _r, _o = _activate(publish_error=Exception("vectorization incomplete"))
        assert result["error"].status_code == 409
        assert conn.transitions == []

    def test_republishing_a_live_version_is_a_no_op(self):
        conn = FakeConn(stage="ACTIVE", runtime=("v_candidate", None))
        result, _conn, commit, registry, _o = _activate(conn)
        assert result["already_live"] is True
        commit.assert_not_called()
        registry.return_value.publish_version.assert_not_called()

    def test_previous_live_version_is_retired(self):
        conn = FakeConn(stage="PENDING_APPROVAL", approval=dict(APPROVAL), version=dict(READY),
                        runtime=("v_live", None), other_active=[11])
        result, _conn, _c, _r, _o = _activate(conn)
        assert result["retired"] == ["old-11"]
        assert (11, "RETIRED") in conn.stage_updates


class TestRegistryCommit:

    def test_commit_failure_fails_the_publish(self):
        result, conn, _c, registry, _o = _activate(commit_error=ValueError("no parent category"))
        assert result["error"].status_code == 409
        assert "no parent category" in result["error"].detail
        registry.return_value.publish_version.assert_not_called()
        assert conn.transitions == []

    def test_unexpected_commit_error_propagates(self):
        with pytest.raises(RuntimeError):
            _activate(commit_error=RuntimeError("constraint violation"))


class TestGovernance:

    def test_submitter_cannot_approve_their_own_change(self):
        result, _conn, commit, _r, _o = _activate(user=actor(user_id=3))
        assert result["error"].status_code == 403
        commit.assert_not_called()

    def test_self_approval_is_recorded_when_explicitly_allowed(self):
        result, _conn, _c, _r, _o = _activate(user=actor(user_id=3), separate=False)
        assert result["self_approved"] is True

    @pytest.mark.parametrize("status", ["pending", "in_progress", "failed", None])
    def test_cannot_activate_before_runtime_preparation_completes(self, status):
        conn = FakeConn(stage="PENDING_APPROVAL", approval=dict(APPROVAL),
                        version={"vector_status": status, "artifact_hash": FINGERPRINT})
        result, _conn, commit, _r, _o = _activate(conn)
        assert result["error"].status_code == 409
        commit.assert_not_called()

    def test_rules_changed_after_submission_are_refused(self):
        conn = FakeConn(stage="PENDING_APPROVAL", approval=dict(APPROVAL),
                        version={"vector_status": "completed", "artifact_hash": "stale"})
        result, *_ = _activate(conn)
        assert result["error"].status_code == 409 and "changed after submission" in result["error"].detail

    def test_requires_an_open_approval_request(self):
        conn = FakeConn(stage="PENDING_APPROVAL", approval=None, version=dict(READY))
        result, *_ = _activate(conn)
        assert result["error"].status_code == 409

    @pytest.mark.parametrize("stage", ["DRAFT", "RULE_EDIT", "SIMULATION_GATE", "SHADOW_GATE"])
    def test_cannot_publish_before_approval_is_requested(self, stage):
        result, _conn, commit, registry, _o = _activate(FakeConn(stage=stage))
        assert result["error"].status_code == 409
        commit.assert_not_called()
        registry.return_value.publish_version.assert_not_called()

    def test_missing_instance_is_404(self):
        conn = FakeConn()
        conn.instance = None
        result, *_ = _activate(conn)
        assert result["error"].status_code == 404


class TestValidation:

    def test_entity_id_is_required(self):
        from app.admin.routes import bpm_routes
        from app.admin.routes.bpm_routes import PublishRequest
        with pytest.raises(Exception):
            PublishRequest(entity_id="")
        with patch.object(bpm_routes, "engine", MagicMock()):
            with pytest.raises(HTTPException) as exc:
                bpm_routes.simulate_version("default", {"entity_id": ""}, actor())
        assert exc.value.status_code == 400
