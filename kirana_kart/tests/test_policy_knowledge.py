"""
Closed-taxonomy classification, SOP knowledge passages, variables and the
reviewer-lesson loop (app/l4_agents/policy_knowledge.py,
app/admin/services/policy_knowledge_service.py).
"""
from unittest.mock import MagicMock, patch

import pytest

from app.admin.services import policy_knowledge_service as knowledge
from app.l4_agents import policy_knowledge as pk
from app.l4_agents.ecommerce import stage0_classifier, stage2_validator, stage3_responder

TAXONOMY = pk.Taxonomy.build([
    {"issue_code": "MISSING_ITEM", "label": "Missing item", "level": 1, "parent_code": None},
    {"issue_code": "MISSING_ITEM_PARTIAL", "label": "Part of order missing", "level": 2,
     "parent_code": "MISSING_ITEM"},
    {"issue_code": "MISSING_ITEM_PARTIAL_HIGH", "label": "Expensive part missing", "level": 3,
     "parent_code": "MISSING_ITEM_PARTIAL"},
    {"issue_code": "ORPHAN", "label": "Orphan", "level": 2, "parent_code": "RETIRED_PARENT"},
])


# ============================================================
# ISSUE RESOLUTION
# ============================================================

class TestResolveIssue:

    def test_most_specific_node_carries_its_root(self):
        assert pk.resolve_issue(TAXONOMY, "MISSING_ITEM", "MISSING_ITEM_PARTIAL_HIGH") == {
            "issue_type_l1": "MISSING_ITEM", "issue_type_l2": "MISSING_ITEM_PARTIAL_HIGH",
            "issue_label": "Expensive part missing", "taxonomy_status": "mapped"}

    def test_codes_and_labels_are_recognised_in_any_spelling(self):
        assert pk.resolve_issue(TAXONOMY, None, "missing-item partial")["issue_type_l2"] == "MISSING_ITEM_PARTIAL"
        assert pk.resolve_issue(TAXONOMY, None, "Part of order missing")["issue_type_l2"] == "MISSING_ITEM_PARTIAL"

    def test_level_one_answer_has_no_l2(self):
        resolved = pk.resolve_issue(TAXONOMY, "missing_item", None)
        assert (resolved["issue_type_l1"], resolved["issue_type_l2"]) == ("MISSING_ITEM", None)

    def test_an_unknown_specific_answer_falls_back_to_a_known_category(self):
        assert pk.resolve_issue(TAXONOMY, "MISSING_ITEM", "made_up")["issue_type_l1"] == "MISSING_ITEM"

    @pytest.mark.parametrize("l1,l2", [("delivery", "not_received"), (None, None), (None, "ORPHAN")])
    def test_anything_outside_the_live_taxonomy_is_unclassified(self, l1, l2):
        resolved = pk.resolve_issue(TAXONOMY, l1, l2)
        assert resolved["issue_type_l1"] == pk.UNCLASSIFIED and resolved["taxonomy_status"] == "unmapped"

    def test_prompt_view_is_ordered_and_capped(self):
        view = TAXONOMY.prompt_view(limit=2)
        assert [n["issue_code"] for n in view] == ["MISSING_ITEM", "MISSING_ITEM_PARTIAL"]


class _LLM:
    answer: object = None

    def chat_json(self, model, system, user):
        if isinstance(_LLM.answer, Exception):
            raise _LLM.answer
        return _LLM.answer


def _stage0(answer, taxonomy=TAXONOMY, candidates=()):
    _LLM.answer = answer
    knowledge_ = pk.RuntimeKnowledge("kb", taxonomy, [], {})
    retrieval = MagicMock()
    retrieval.return_value.issue_candidates.return_value = list(candidates)
    with patch.object(stage0_classifier, "LLMClient", _LLM), \
         patch.object(stage0_classifier, "RetrievalService", retrieval), \
         patch.object(pk, "load_runtime", return_value=knowledge_):
        return stage0_classifier.run(1, "e", {"subject": "s", "description": "d"}, {"active_policy": "v1"}), retrieval


class TestStage0:

    def test_answer_is_checked_against_the_taxonomy(self):
        result, retrieval = _stage0({"issue_code": "MISSING_ITEM_PARTIAL", "confidence": 0.8})
        assert result["taxonomy_status"] == "mapped" and result["issue_type_l2"] == "MISSING_ITEM_PARTIAL"
        retrieval.return_value.issue_candidates.assert_not_called()    # the taxonomy is the candidate list

    def test_an_invented_answer_is_unclassified_with_low_confidence(self):
        result, _ = _stage0({"issue_code": "BRAND_NEW", "confidence": 0.99})
        assert result["issue_type_l1"] == pk.UNCLASSIFIED and result["confidence"] <= 0.3
        assert result["model_issue"] == "BRAND_NEW"

    def test_model_failure_is_unclassified_not_a_guess(self):
        result, _ = _stage0(RuntimeError("down"))
        assert result["taxonomy_status"] == "unmapped" and result["confidence"] == 0.0

    def test_without_a_taxonomy_the_open_classification_still_runs(self):
        result, _ = _stage0({"issue_type_l1": "delivery", "issue_type_l2": "late", "confidence": "x"},
                            taxonomy=pk.Taxonomy())
        assert result["taxonomy_status"] == "unavailable" and result["issue_type_l2"] == "late"
        assert result["confidence"] == 0.5
        fallback, _ = _stage0(RuntimeError("down"), taxonomy=pk.Taxonomy(),
                              candidates=[{"label": "Missing Item", "issue_code": "PARTIAL"}])
        assert (fallback["issue_type_l1"], fallback["issue_type_l2"]) == ("missing_item", "partial")


def test_an_unclassified_ticket_goes_to_a_person_not_auto_resolution():
    stage1 = {"action_code": "REJECT", "calculated_gratification": 0, "overall_confidence": 0.9,
              "greedy_classification": "NORMAL", "fraud_segment": "NORMAL"}
    fields = {"order_context": {"order_value": 500}, "risk_context": {},
              "customer_profile": {"membership_tier": "GOLD"}, "prior_complaints_30d": 0}
    meta = {"requires_refund": False, "requires_escalation": False, "automation_eligible": True}
    with patch.object(stage2_validator, "_load_action_meta", return_value=meta):
        mapped = stage2_validator.run(1, "e", {"issue_type_l1": "MISSING_ITEM", "taxonomy_status": "mapped"},
                                      stage1, [], fields, rule_mode="observe")
        unmapped = stage2_validator.run(1, "e", {"issue_type_l1": pk.UNCLASSIFIED, "taxonomy_status": "unmapped",
                                                 "model_issue": "BRAND_NEW"},
                                        stage1, [], fields, rule_mode="observe")
    assert mapped["automation_pathway"] == "AUTO_RESOLVED"
    assert unmapped["automation_pathway"] == "HITL"
    assert "issue_not_in_taxonomy:BRAND_NEW" in unmapped["discrepancy_details"]


# ============================================================
# VARIABLES AND PASSAGES
# ============================================================

class TestVariables:

    def test_placeholders_are_found_once_in_order(self):
        assert pk.placeholders("{{ Support_Hours }} and {{tone}} and {{support_hours}}") == ["support_hours", "tone"]

    def test_undefined_ignores_ticket_values_and_defined_settings(self):
        texts = ["{{order_value}} {{support_hours}} {{escalation_contact}}"]
        assert pk.undefined_variables(texts, {"support_hours"}) == ["escalation_contact"]

    def test_missing_values_stay_visible(self):
        assert pk.render("Open {{support_hours}}; tier {{customer_tier}}", {"support_hours": "9-5"}) == \
            "Open 9-5; tier [customer_tier not set]"

    def test_ticket_values(self):
        values = pk.ticket_values(
            {"order_context": {"order_value": 1234.5, "order_id": "O1"},
             "risk_context": {"refunds_last_30_days": 2},
             "customer_profile": {"membership_tier": "GOLD"}},
            {"issue_label": "Missing item"}, {"final_refund_amount": 100}, "Refunded.")
        assert values == {"customer_tier": "GOLD", "order_id": "O1", "order_value": "₹1,234.50",
                          "order_history_summary": "2 refunds and 0 complaints in the last 30 days",
                          "issue_label": "Missing item", "refund_amount": "₹100.00",
                          "resolution_summary": "Refunded."}
        assert pk.ticket_values({}) == {}

    def test_ticket_facts_win_over_tenant_settings(self):
        runtime = pk.RuntimeKnowledge("kb", pk.Taxonomy(), [], {"order_value": "tenant", "tone": "warm"})
        assert runtime.values({"order_value": "₹5"}) == {"order_value": "₹5", "tone": "warm"}

    @pytest.mark.parametrize("name", ["X", "1abc", "has space", "order_value", "a" * 51])
    def test_invalid_or_reserved_names_are_refused(self, name):
        with pytest.raises(ValueError):
            knowledge.validate_variable_name(name)


class TestPassageSelection:
    CHUNKS = [
        {"chunk_key": "general", "purpose": "both", "issue_codes": [], "body": "g" * 10, "sort_order": 0},
        {"chunk_key": "category", "purpose": "decision", "issue_codes": ["MISSING_ITEM"], "body": "c", "sort_order": 1},
        {"chunk_key": "specific", "purpose": "decision", "issue_codes": ["missing_item_partial"], "body": "s",
         "sort_order": 2},
        {"chunk_key": "reply", "purpose": "response", "issue_codes": [], "body": "r", "sort_order": 3},
        {"chunk_key": "other", "purpose": "both", "issue_codes": ["WRONG_ITEM"], "body": "o", "sort_order": 4},
    ]

    def keys(self, **kw):
        args = {"issue_l1": "MISSING_ITEM", "issue_l2": "MISSING_ITEM_PARTIAL", "purpose": "decision", "limit": 10}
        return [c["chunk_key"] for c in pk.select_chunks(self.CHUNKS, **{**args, **kw})]

    def test_specific_then_category_then_general_and_never_other_problems(self):
        assert self.keys() == ["specific", "category", "general"]
        assert self.keys(purpose="response") == ["general", "reply"]

    def test_limits(self):
        assert self.keys(limit=1) == ["specific"]
        assert self.keys(char_budget=2) == ["specific", "category"]

    def test_rendered_output(self):
        assert pk.rendered([{"title": "T", "body": "Hi {{x}}", "chunk_key": "K"}], {"x": "y"}) == [
            {"title": "T", "text": "Hi y", "chunk_key": "K"}]


def test_stage3_draft_uses_reply_passages_and_business_name():
    runtime = pk.RuntimeKnowledge("kb", TAXONOMY, [
        {"chunk_key": "K1", "title": "Reply", "purpose": "response", "issue_codes": [],
         "body": "Our team is here {{support_hours}}. {{resolution_summary}}", "sort_order": 0},
        {"chunk_key": "K2", "title": "Rule", "purpose": "decision", "issue_codes": [], "body": "internal",
         "sort_order": 1},
    ], {"support_hours": "all day", "business_name": "Kirana"})
    with patch.object(pk, "load_runtime", return_value=runtime):
        draft = stage3_responder.run(
            1, "e", {"issue_type_l1": "MISSING_ITEM", "issue_type_l2": None, "issue_label": "Missing item"}, {},
            {"final_action_code": "REFUND_PARTIAL", "final_refund_amount": 50}, {"order_context": {"order_value": 200}})
    text = draft["response_draft"]
    assert "Our team is here all day. We have approved a partial refund of INR 50.00" in text
    assert "internal" not in text and "Kirana Support Team" in text
    assert "your missing item complaint" in text and draft["policy_knowledge_used"] == ["K1"]


# ============================================================
# RUNTIME LOADING
# ============================================================

class TestRuntimeLoading:

    def setup_method(self):
        pk.clear_cache()

    def teardown_method(self):
        pk.clear_cache()

    def test_no_live_policy_means_no_knowledge(self):
        assert pk.load_runtime("") is pk.EMPTY

    def test_database_failure_keeps_the_pipeline_running(self):
        def broken():
            raise RuntimeError("db down")
        assert pk.load_runtime("v1", connect=broken) is pk.EMPTY

    def test_results_are_cached_per_version_and_business_line(self):
        calls = []

        def fake_query(connect, version, line):
            calls.append((version, line))
            return pk.RuntimeKnowledge("kb", pk.Taxonomy(), [], {})
        with patch.object(pk, "_query", side_effect=fake_query):
            first = pk.load_runtime("v1", "Ecommerce", connect=object)
            assert pk.load_runtime("v1", "ecommerce", connect=object) is first
            pk.load_runtime("v1", "grocery", connect=object)
        assert calls == [("v1", "ecommerce"), ("v1", "grocery")]


# ============================================================
# EDIT LOG AND LESSONS
# ============================================================

class TestLessons:

    def test_field_changes_only_lists_real_changes(self):
        changes = knowledge.field_changes(
            {"priority": 500.0, "issue_codes": ["B", "A"], "body": "x", "untouched": 1},
            {"priority": 500, "issue_codes": ["A", "B"], "body": "y"},
            ("priority", "issue_codes", "body", "untouched"))
        assert changes == {"body": {"ai": "x", "human": "y"}}

    def test_lessons_put_this_business_line_first_and_carry_reasons(self):
        conn = MagicMock()
        conn.execute.return_value.mappings.return_value.all.return_value = [
            {"stage": "chunk", "item_ref": "K1", "edit_type": "edited", "edit_reason": "Name the business",
             "field_changes": '{"body": {"ai": "Sorry", "human": "Sorry — Kirana"}}', "same_line": True},
            {"stage": "gap", "item_ref": "DAMAGED", "edit_type": "rejected", "edit_reason": "Courier SOP",
             "field_changes": None, "same_line": False},
            {"stage": "rule", "item_ref": "R1", "edit_type": "manual_add", "edit_reason": None,
             "field_changes": None, "same_line": True},
        ]
        text = knowledge.lessons_for(conn, "kb", "ecommerce", ("chunk", "gap", "rule"))
        lines = text.splitlines()
        assert lines[1] == "For ecommerce:"
        assert 'chunk K1 corrected (body: AI Sorry → reviewer Sorry — Kirana). Why: Name the business' in lines[2]
        assert lines[3] == "- reviewers added rule R1 the AI missed"
        assert lines[4] == "Shared across this knowledge base:"
        assert lines[5] == "- reviewers rejected the AI's gap proposal DAMAGED. Why: Courier SOP"
        sql, params = conn.execute.call_args.args
        assert "created_by IS NOT NULL" in str(sql) and params["bl"] == "ecommerce"

    def test_no_corrections_means_no_prompt_text(self):
        conn = MagicMock()
        conn.execute.return_value.mappings.return_value.all.return_value = []
        assert knowledge.lessons_for(conn, "kb", None, ("taxonomy",)) == ""

    def test_long_values_are_clipped(self):
        line = knowledge._describe({"stage": "rule", "item_ref": "R", "edit_type": "edited", "edit_reason": "",
                                    "field_changes": {"conditions": {"ai": {"x": "y" * 500}, "human": {}}}})
        assert len(line) <= 400 and "…" in line


class TestCitationsAndFields:

    def test_quotes_are_found_despite_case_and_whitespace(self):
        doc = "# Refunds\nRefund   them\nwithin a DAY.\nOther text"
        start, end = knowledge.locate_quote(doc, "refund them within a day.")
        assert doc[start:end] == "Refund   them\nwithin a DAY."
        assert knowledge.locate_quote(doc, "within a DAY.") == (doc.index("within"), doc.index("\nOther"))
        assert knowledge.locate_quote(doc, "not in the document at all") is None
        assert knowledge.locate_quote(doc, "short") is None

    def test_business_lines_are_normalised_like_tickets(self):
        assert knowledge.normalise_business_line(" Quick Commerce ") == "quick_commerce"
        assert knowledge.normalise_business_line("") is None
        with pytest.raises(ValueError):
            knowledge.normalise_business_line("x" * 60)

    def test_passage_fields_are_validated(self):
        clean = knowledge.clean_chunk_fields(
            {"title": " T ", "body": " B ", "purpose": "response", "issue_codes": ["a", "A", " "]}, {"A"})
        assert clean == {"title": "T", "body": "B", "purpose": "response", "issue_codes": ["A"]}
        for bad in ({"title": ""}, {"body": "x" * 5000}, {"purpose": "other"},
                    {"issue_codes": "A"}, {"issue_codes": ["Z"]}):
            with pytest.raises(ValueError):
                knowledge.clean_chunk_fields(bad, {"A"})

    def test_chunk_keys_are_stable_and_distinct(self):
        assert knowledge.chunk_key("v1", 3, "T") == knowledge.chunk_key("v1", 3, "T")
        assert knowledge.chunk_key("v1", 3, "T") != knowledge.chunk_key("v2", 3, "T")
        assert knowledge.chunk_key("v1", 3, "T").startswith("K003-")


class TestReviewReasons:

    def test_corrections_need_a_reason_but_acceptance_does_not(self):
        from fastapi import HTTPException
        from app.admin.routes import bpm_routes
        with pytest.raises(HTTPException):
            bpm_routes._require_reason("rejected", "  ")
        with pytest.raises(HTTPException):
            bpm_routes._require_reason("edited", None)
        bpm_routes._require_reason("accepted", None)
        bpm_routes._require_reason("edited", "Wrong refund window")

    def test_an_edit_must_change_something(self):
        from fastapi import HTTPException
        from app.admin.routes import bpm_routes
        body = bpm_routes.ReviewProposalRequest(status="edited", user_output={}, edit_reason="nothing")
        with pytest.raises(HTTPException):
            bpm_routes._validated_edits(body, bpm_routes._ACTION_EDIT_FIELDS)
