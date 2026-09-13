"""
tests/test_bpm_publish.py
=========================
Tests for POST /bpm/kb/{kb_id}/publish — the button at the end of the policy
version wizard.

Two flaws:

  * The handler only moved the BPM stage marker to ACTIVE. It never ran the
    activation path, so a version published through the wizard appeared
    ACTIVE in the UI while the Cardinal runtime kept serving the previous
    policy. Its own docstring claimed it "delegates to the existing KB
    publish logic"; it did not.
  * commit_proposals_to_registry was wrapped in
    `except Exception: logger.warning(... non-fatal ...)`, so publish
    returned success while issue_taxonomy and master_action_codes were
    never updated.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.admin.routes import bpm_routes
from app.admin.routes.bpm_routes import publish_version_bpm


@pytest.fixture
def user():
    u = MagicMock()
    u.id = 3
    u.email = "admin@example.com"
    return u


def _engine(stage: str | None):
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    row = None if stage is None else {"id": 42, "current_stage": stage}
    conn.execute.return_value.mappings.return_value.first.return_value = row
    engine = MagicMock()
    engine.connect.return_value = conn
    return engine


def _publish(stage="PENDING_APPROVAL", commit_error=None, publish_error=None,
             user=None):
    commit = MagicMock(side_effect=commit_error) if commit_error else MagicMock()
    registry = MagicMock()
    if publish_error:
        registry.return_value.publish_version.side_effect = publish_error
    bpm_service = MagicMock()

    with patch.object(bpm_routes, "engine", _engine(stage)), \
         patch.object(bpm_routes, "_bpm_service", bpm_service), \
         patch(
             "app.l45_ml_platform.compiler.sop_extractor."
             "commit_proposals_to_registry", commit,
         ), \
         patch(
             "app.l1_ingestion.kb_registry.kb_registry_service."
             "KBRegistryService", registry,
         ):
        try:
            result = publish_version_bpm("default", {"entity_id": "v_new"}, user)
        except HTTPException as exc:
            return {"error": exc}, commit, registry, bpm_service
        return result, commit, registry, bpm_service


class TestActivation:

    def test_publish_actually_activates_the_version(self, user):
        """The step that was missing: without it the runtime never switches."""
        result, _commit, registry, _bpm = _publish(user=user)
        registry.return_value.publish_version.assert_called_once()
        kwargs = registry.return_value.publish_version.call_args.kwargs
        assert kwargs["version_label"] == "v_new"
        assert result["active_version"] == "v_new"

    def test_stage_advances_only_after_activation_succeeds(self, user):
        result, _commit, _registry, bpm = _publish(user=user)
        bpm.transition.assert_called_once()
        assert bpm.transition.call_args.kwargs["to_stage"] == "ACTIVE"
        assert result["message"] == "Published"

    def test_failed_activation_leaves_the_stage_untouched(self, user):
        """
        A version that could not be activated must not be recorded as ACTIVE —
        that is exactly the state that made the old bug invisible.
        """
        result, _commit, _registry, bpm = _publish(
            publish_error=Exception("vectorization incomplete"), user=user,
        )
        assert result["error"].status_code == 400
        bpm.transition.assert_not_called()

    def test_republishing_an_active_version_is_a_no_op(self, user):
        result, _commit, _registry, bpm = _publish(
            stage="ACTIVE",
            publish_error=Exception("Version 'v_new' already published"),
            user=user,
        )
        assert result["already_live"] is True
        bpm.transition.assert_not_called()


class TestRegistryCommit:

    def test_commit_failure_fails_the_publish(self, user):
        """Previously swallowed as 'non-fatal' and reported as success."""
        result, _commit, registry, bpm = _publish(
            commit_error=Exception("constraint violation"), user=user,
        )
        assert result["error"].status_code == 500
        assert "not been published" in result["error"].detail
        registry.return_value.publish_version.assert_not_called()
        bpm.transition.assert_not_called()

    def test_proposals_are_committed_before_activation(self, user):
        _result, commit, registry, _bpm = _publish(user=user)
        commit.assert_called_once()
        registry.return_value.publish_version.assert_called_once()


class TestValidation:

    def test_entity_id_is_required(self, user):
        with patch.object(bpm_routes, "engine", MagicMock()):
            with pytest.raises(HTTPException) as exc:
                publish_version_bpm("default", {}, user)
        assert exc.value.status_code == 400

    def test_missing_bpm_instance_is_404(self, user):
        result, _c, _r, _b = _publish(stage=None, user=user)
        assert result["error"].status_code == 404

    def test_cannot_publish_from_draft(self, user):
        result, _c, registry, _b = _publish(stage="DRAFT", user=user)
        assert result["error"].status_code == 400
        registry.return_value.publish_version.assert_not_called()
