"""
tests/test_policy_lifecycle.py
==============================
Decision rules of the Policy Studio lifecycle that sit outside the replay
gate and activation (covered in test_simulation_gate / test_bpm_publish):
editing locks, evidence invalidation, approval requests, manual transitions,
and validation of LLM output and reviewer edits.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.admin.routes import bpm_routes
from app.admin.services import policy_lifecycle as lifecycle
from app.admin.services.policy_lifecycle import LifecycleError
from tests.policy_fakes import FakeConn, actor


class TestEditing:

    @pytest.mark.parametrize("stage", ["DRAFT", "AI_COMPILE_QUEUED", "AI_COMPILE_FAILED", "RULE_EDIT"])
    def test_authoring_stages_edit_in_place(self, stage):
        conn = FakeConn(stage=stage)
        lifecycle.open_for_editing(conn, conn.instance, actor(), "Rule changed")
        assert conn.transitions == []

    @pytest.mark.parametrize("stage", ["SIMULATION_GATE", "SIMULATION_FAILED", "SHADOW_GATE",
                                       "SHADOW_DIVERGENCE_HIGH", "REJECTED"])
    def test_editing_tested_rules_discards_the_evidence(self, stage):
        conn = FakeConn(stage=stage)
        lifecycle.open_for_editing(conn, conn.instance, actor(), "Rule changed")
        assert conn.transitions == [(stage, "RULE_EDIT")]

    @pytest.mark.parametrize("stage", ["PENDING_APPROVAL", "ACTIVE", "RETIRED", "ROLLBACK_PENDING"])
    def test_frozen_stages_refuse_edits(self, stage):
        conn = FakeConn(stage=stage)
        with pytest.raises(LifecycleError) as exc:
            lifecycle.open_for_editing(conn, conn.instance, actor(), "Rule changed")
        assert exc.value.status_code == 409

    def test_analysis_records_start_and_failure(self):
        conn = FakeConn(stage="DRAFT")
        lifecycle.start_analysis(conn, conn.instance, actor())
        lifecycle.analysis_failed(conn, conn.instance, actor(), "Taxonomy analysis failed")
        assert conn.transitions == [("DRAFT", "AI_COMPILE_QUEUED"), ("AI_COMPILE_QUEUED", "AI_COMPILE_FAILED")]

    def test_generated_rules_move_the_proposal_to_rule_edit(self):
        conn = FakeConn(stage="AI_COMPILE_QUEUED")
        lifecycle.rules_generated(conn, conn.instance, actor(), 0)
        assert conn.transitions == []
        lifecycle.rules_generated(conn, conn.instance, actor(), 3)
        assert conn.stage == "RULE_EDIT"


class TestSubmission:

    def _submit(self, conn, justification=None):
        with patch("app.l45_ml_platform.compiler.sop_extractor.taxonomy_problems", return_value=[]):
            return lifecycle.submit_for_approval(conn, "default", "v_candidate", actor(3), justification)

    @pytest.mark.parametrize("stage", ["DRAFT", "RULE_EDIT", "REJECTED"])
    def test_untested_proposals_cannot_be_submitted(self, stage):
        with pytest.raises(LifecycleError) as exc:
            self._submit(FakeConn(stage=stage))
        assert exc.value.status_code == 409 and "comparison" in exc.value.detail

    def test_tested_proposal_is_frozen_and_queued_for_preparation(self):
        conn = FakeConn(stage="SHADOW_GATE", runtime=("v_live", None))
        result = self._submit(conn)
        assert result["stage"] == "PENDING_APPROVAL"
        assert any("INSERT INTO kirana_kart.policy_versions" in s for s in conn.statements)
        assert any("INSERT INTO kirana_kart.kb_vector_jobs" in s for s in conn.statements)
        assert any("status = 'superseded'" in s for s in conn.statements)

    def test_larger_change_needs_a_written_justification(self):
        with pytest.raises(LifecycleError) as exc:
            self._submit(FakeConn(stage="SIMULATION_FAILED"), "because")
        assert exc.value.status_code == 400
        conn = FakeConn(stage="SIMULATION_FAILED")
        self._submit(conn, "Replacements are now the promised remedy for missing items.")
        assert conn.transitions == [("SIMULATION_FAILED", "SHADOW_GATE"), ("SHADOW_GATE", "PENDING_APPROVAL")]

    def test_open_review_items_block_submission(self):
        with pytest.raises(LifecycleError) as exc:
            self._submit(FakeConn(stage="SHADOW_GATE", counts={"taxonomy_pending": 1}))
        assert exc.value.status_code == 409

    def test_broken_category_hierarchy_blocks_submission(self):
        with patch("app.l45_ml_platform.compiler.sop_extractor.taxonomy_problems",
                   return_value=["X has no accepted or existing parent category"]):
            with pytest.raises(LifecycleError) as exc:
                lifecycle.submit_for_approval(FakeConn(stage="SHADOW_GATE"), "default", "v_candidate", actor())
        assert "parent category" in exc.value.detail


class TestRejection:

    def test_rejection_needs_a_reason(self):
        conn = FakeConn(stage="PENDING_APPROVAL", approval={"id": 9, "requested_by_id": 3})
        with pytest.raises(LifecycleError) as exc:
            lifecycle.reject_proposal(conn, "default", 42, actor(), "  ")
        assert exc.value.status_code == 400
        lifecycle.reject_proposal(conn, "default", 42, actor(), "Threshold missing")
        assert conn.stage == "REJECTED"


def _client(conn, user):
    from app.admin.services.auth_service import get_current_user
    app = FastAPI()
    app.include_router(bpm_routes.router)
    app.dependency_overrides[get_current_user] = lambda: user
    engine = MagicMock()
    engine.begin.return_value.__enter__.return_value = conn
    return TestClient(app), engine


class TestManualTransitions:

    def _post(self, stage, to_stage, entity_type="kb_version"):
        conn = FakeConn(stage=stage, entity_type=entity_type)
        user = MagicMock(id=1, email="editor@example.test", is_super_admin=True, permissions={})
        client, engine = _client(conn, user)
        with patch.object(bpm_routes, "engine", engine), \
             patch.object(bpm_routes._bpm_service, "get_instance", return_value={"id": 42}):
            response = client.post("/bpm/default/instances/42/transition", json={"to_stage": to_stage})
        return response, conn

    def test_no_process_can_be_moved_to_active_by_hand(self):
        for entity_type in ("kb_version", "taxonomy_version"):
            response, conn = self._post("PENDING_APPROVAL", "ACTIVE", entity_type)
            assert response.status_code == 409
            assert conn.transitions == []

    def test_policy_proposals_cannot_skip_their_gates(self):
        response, conn = self._post("RULE_EDIT", "PENDING_APPROVAL")
        assert response.status_code == 409 and conn.transitions == []

    def test_reopening_for_editing_is_allowed(self):
        response, conn = self._post("SIMULATION_FAILED", "RULE_EDIT")
        assert response.status_code == 200
        assert conn.transitions == [("SIMULATION_FAILED", "RULE_EDIT")]

    def test_instance_from_another_kb_is_not_found(self):
        conn = FakeConn()
        conn.instance = None
        user = MagicMock(id=1, email="x@example.test", is_super_admin=True, permissions={})
        client, engine = _client(conn, user)
        with patch.object(bpm_routes, "engine", engine):
            assert client.get("/bpm/other/instances/42").status_code == 404


class TestApprovalAuthorisation:

    def test_policy_versions_need_policy_admin_on_top_of_kb_admin(self):
        user = MagicMock(id=5, is_super_admin=False, permissions={"knowledgeBase": {"admin": True}})
        with patch.object(bpm_routes, "_require_kb_access") as kb_access:
            with pytest.raises(HTTPException) as exc:
                bpm_routes._authorise_decision(user, {"kb_id": "restricted", "entity_type": "kb_version"})
        kb_access.assert_called_once_with(user, "restricted", "admin")
        assert exc.value.status_code == 403

    def test_decision_is_checked_against_the_approvals_own_kb(self):
        user = MagicMock(id=5, is_super_admin=False, permissions={})
        with patch.object(bpm_routes._bpm_service, "check_kb_access", return_value=False):
            with pytest.raises(HTTPException) as exc:
                bpm_routes._authorise_decision(user, {"kb_id": "other", "entity_type": "taxonomy_version"})
        assert exc.value.status_code == 403


class TestProposalCleaning:

    def test_llm_taxonomy_is_normalised_and_unstorable_rows_dropped(self):
        from app.l45_ml_platform.compiler.sop_extractor import _clean_taxonomy
        cleaned = _clean_taxonomy([
            {"issue_code": "missing item", "label": "Missing", "level": 1, "proposal_type": "existing"},
            {"issue_code": "MISSING_ITEM", "label": "Duplicate", "level": 1},
            {"issue_code": "DEEP", "label": "Too deep", "level": 9},
            {"issue_code": "", "label": "No code", "level": 1},
            {"issue_code": "CHILD", "label": "Child", "level": "2", "parent_code": "missing-item",
             "extraction_confidence": 7},
            "not a dict",
        ], known_codes=set())
        assert [c["issue_code"] for c in cleaned] == ["MISSING_ITEM", "CHILD"]
        assert cleaned[0]["proposal_type"] == "new"      # 'existing' not confirmed by registry
        assert cleaned[1]["parent_code"] == "MISSING_ITEM"
        assert cleaned[1]["extraction_confidence"] is None

    def test_confirmed_existing_codes_keep_their_type(self):
        from app.l45_ml_platform.compiler.sop_extractor import _clean_actions
        cleaned = _clean_actions([
            {"action_code_id": "REFUND", "action_name": "Refund", "proposal_type": "existing",
             "parent_issue_codes": ["a b", "", "A_B"]},
            {"action_code_id": "NO_NAME"},
        ], known_codes={"REFUND"})
        assert len(cleaned) == 1
        assert cleaned[0]["proposal_type"] == "existing"
        assert cleaned[0]["parent_issue_codes"] == ["A_B"]

    def test_rule_ids_are_deterministic_and_distinct(self):
        from app.l45_ml_platform.compiler.sop_extractor import _rule_id
        long_issue = "A" * 30
        assert _rule_id(long_issue + "X", "REFUND") != _rule_id(long_issue + "Y", "REFUND")
        assert _rule_id("ISSUE", "REFUND") == _rule_id("ISSUE", "REFUND")


class TestReviewEdits:

    def test_only_reviewable_fields_can_be_edited(self):
        body = bpm_routes.ReviewProposalRequest(status="edited", user_output={"issue_code": "X"})
        with pytest.raises(HTTPException) as exc:
            bpm_routes._validated_edits(body, bpm_routes._TAXONOMY_EDIT_FIELDS)
        assert exc.value.status_code == 400

    def test_names_cannot_be_blanked(self):
        body = bpm_routes.ReviewProposalRequest(status="edited", user_output={"action_name": " "})
        with pytest.raises(HTTPException):
            bpm_routes._validated_edits(body, bpm_routes._ACTION_EDIT_FIELDS)

    def test_accept_ignores_submitted_edits(self):
        body = bpm_routes.ReviewProposalRequest(status="accepted", user_output={"label": "ignored"})
        assert bpm_routes._validated_edits(body, bpm_routes._TAXONOMY_EDIT_FIELDS) is None

    def test_unknown_status_is_rejected(self):
        with pytest.raises(HTTPException):
            bpm_routes._validated_edits(bpm_routes.ReviewProposalRequest(status="approved"),
                                        bpm_routes._TAXONOMY_EDIT_FIELDS)


class TestLateAnalysis:

    def test_resubmitting_a_request_without_preparation_queues_it(self):
        conn = FakeConn(stage="PENDING_APPROVAL", approval={"id": 9, "requested_by_id": 3})
        result = lifecycle.submit_for_approval(conn, "default", "v_candidate", actor(3))
        assert result["approval"]["id"] == 9
        assert any("INSERT INTO kirana_kart.kb_vector_jobs" in s for s in conn.statements)
        assert conn.transitions == []

    def test_analysis_finishing_after_submission_does_not_rewrite_proposals(self):
        from app.l45_ml_platform.compiler import sop_extractor
        write_conn = MagicMock()
        engine = MagicMock()
        engine.begin.return_value.__enter__.return_value = write_conn

        def frozen(conn):
            raise LifecycleError(409, "awaiting approval")

        with patch.object(sop_extractor, "_call_llm", return_value={"taxonomy": [
                {"issue_code": "X", "label": "X", "level": 1}]}), \
             patch.object(sop_extractor, "_get_existing_taxonomy", return_value=[]), \
             patch.object(sop_extractor, "_get_extraction_standards", return_value=""):
            with pytest.raises(LifecycleError):
                sop_extractor.extract_taxonomy(engine, "default", "v1", "SOP", before_write=frozen)
        assert not any("DELETE" in str(c.args[0]) for c in write_conn.execute.call_args_list)


class TestLegacyPublication:

    @pytest.mark.parametrize("path,body", [("/kb/publish", {"version_label": "v2", "published_by": "x"}),
                                           ("/kb/rollback/v1", None)])
    def test_kb_admin_alone_cannot_change_the_live_policy(self, path, body):
        from app.admin.services.auth_service import get_current_user
        from app.l1_ingestion.kb_registry import routes as kb_routes
        app = FastAPI()
        app.include_router(kb_routes.router)
        actor = MagicMock(is_super_admin=False, permissions={"knowledgeBase": {"admin": True}})
        app.dependency_overrides[get_current_user] = lambda: actor
        with patch.object(kb_routes, "service") as service:
            response = TestClient(app).post(path, json=body)
        assert response.status_code == 403 and "policy.admin" in response.json()["detail"]
        service.publish_version.assert_not_called()
        service.rollback.assert_not_called()

    def test_publisher_of_record_is_the_authenticated_user(self):
        from app.l1_ingestion.kb_registry import routes as kb_routes
        actor = MagicMock(email="publisher@example.test")
        with patch.object(kb_routes, "service") as service:
            kb_routes.publish_kb(kb_routes.PublishRequest(version_label="v2", published_by="someone-else"), actor)
        assert service.publish_version.call_args.kwargs["published_by"] == "publisher@example.test"
