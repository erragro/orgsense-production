"""
tests/test_rule_engine.py
=========================
The deterministic rule evaluator shared by the live pipeline (Stage 2) and the
sample replay, and Stage 2's use of it in observe and enforce modes.

Before this, the runtime only showed the LLM the first five rules and never
evaluated a condition; the replay read three legacy condition keys.
"""

from unittest.mock import patch

import pytest

from app.l4_agents import rule_engine as engine
from app.l4_agents.ecommerce import stage2_validator

FACTS = {
    "issue_type_l1": "missing_item", "issue_type_l2": "partial",
    "order_value": 1000.0, "customer_segment": "GOLD", "fraud_segment": "NORMAL",
    "fraud_score": 0.1, "repeat_count": 1.0, "sla_breach": True, "business_line": "grocery",
    "greedy_classification": "NORMAL",
}


def rule(**kw):
    base = {"rule_id": "R-1", "priority": 500, "issue_type_l1": "MISSING_ITEM",
            "action_code_id": "REFUND", "action_id": 1, "deterministic": True,
            "conditions": {}, "action_payload": {}}
    return {**base, **kw}


def leaf(field, op, value):
    return {"type": "leaf", "field": field, "op": op, "value": value}


class TestMatching:

    def test_issue_codes_compare_across_stage0_and_rule_spelling(self):
        assert engine.match_reasons(rule(issue_type_l1="MISSING_ITEM"), FACTS) == []
        assert engine.match_reasons(rule(issue_type_l1="WRONG_ITEM"), FACTS)

    def test_specific_situation_must_match_when_the_rule_names_one(self):
        assert engine.match_reasons(rule(issue_type_l2="PARTIAL"), FACTS) == []
        assert engine.match_reasons(rule(issue_type_l2="WHOLE_ORDER"), FACTS)
        assert engine.match_reasons(rule(issue_type_l2="PARTIAL"), {**FACTS, "issue_type_l2": None})

    @pytest.mark.parametrize("column,value,ok", [
        ("business_line", "Grocery", True), ("business_line", "pharmacy", False),
        ("customer_segment", "Gold", True), ("customer_segment", "Normal", False),
        ("fraud_segment", "NORMAL", True), ("fraud_segment", "HIGH", False),
    ])
    def test_column_filters(self, column, value, ok):
        assert (engine.match_reasons(rule(**{column: value}), FACTS) == []) is ok

    def test_normal_segment_means_standard_tier(self):
        assert engine.match_reasons(rule(customer_segment="Normal"), {**FACTS, "customer_segment": "STANDARD"}) == []

    def test_bounds_and_sla(self):
        assert engine.match_reasons(rule(min_order_value=500, max_order_value=1500), FACTS) == []
        assert engine.match_reasons(rule(min_order_value=1500), FACTS)
        assert engine.match_reasons(rule(max_repeat_count=0), FACTS)
        assert engine.match_reasons(rule(sla_breach_required=True), FACTS) == []
        assert engine.match_reasons(rule(sla_breach_required=True), {**FACTS, "sla_breach": None})

    def test_condition_tree_all_and_any(self):
        both = {"type": "group", "operator": "AND", "conditions": [
            leaf("order_value", "gte", 500), leaf("customer_segment", "in", ["Gold", "Platinum"])]}
        either = {"type": "group", "operator": "OR", "conditions": [
            leaf("order_value", "gte", 5000), leaf("sla_breach", "eq", True)]}
        neither = {"type": "group", "operator": "OR", "conditions": [
            leaf("order_value", "gte", 5000), leaf("repeat_count", "gte", 3)]}
        assert engine.match_reasons(rule(conditions=both), FACTS) == []
        assert engine.match_reasons(rule(conditions=either), FACTS) == []
        assert engine.match_reasons(rule(conditions=neither), FACTS)

    def test_nested_groups_and_empty_group(self):
        tree = {"type": "group", "operator": "AND", "conditions": [
            {"type": "group", "operator": "OR", "conditions": [leaf("fraud_segment", "eq", "HIGH"),
                                                                leaf("order_value", "lte", 2000)]},
            {"type": "group", "operator": "AND", "conditions": []}]}
        assert engine.match_reasons(rule(conditions=tree), FACTS) == []

    @pytest.mark.parametrize("conditions", [
        {"weird_key": 1},                                             # unknown legacy key
        {"type": "leaf", "field": "order_value", "op": "between", "value": 1},
        {"type": "group", "operator": "XOR", "conditions": []},
        {"type": "leaf", "field": "mood", "op": "eq", "value": "angry"},   # fact never known
        ["not", "a", "tree"],
    ])
    def test_unreadable_conditions_never_match(self, conditions):
        """Fail closed: a rule the evaluator cannot read must not take over decisions."""
        assert engine.match_reasons(rule(conditions=conditions), FACTS)

    def test_legacy_condition_keys_still_evaluate(self):
        assert engine.match_reasons(rule(conditions={"max_fraud_score": 0.5}), FACTS) == []
        assert engine.match_reasons(rule(conditions={"max_fraud_score": 0.05}), FACTS)
        assert engine.match_reasons(rule(conditions={"customer_tier": "gold"}), FACTS) == []
        assert engine.match_reasons(rule(conditions={"greedy_classification": "FRAUD"}), FACTS)


class TestDecision:

    def test_first_match_in_runtime_precedence_wins(self):
        rules = [rule(rule_id="R-B", priority=300, action_code_id="LATER"),
                 rule(rule_id="R-A", priority=100, action_code_id="FIRST"),
                 rule(rule_id="R-C", priority=100, action_code_id="TIE_LOSES")]
        decision = engine.decide(rules, FACTS)
        assert decision.rule_id == "R-A" and decision.action_code == "FIRST"

    def test_guidance_rules_never_decide(self):
        rules = [rule(rule_id="R-G", priority=1, deterministic=False), rule(rule_id="R-D", priority=9)]
        assert engine.decide(rules, FACTS).rule_id == "R-D"
        assert engine.decide([rule(deterministic=False)], FACTS) is None

    def test_unset_deterministic_flag_means_the_column_default(self):
        assert engine.decide([rule(deterministic=None)], FACTS) is not None

    def test_no_match_leaves_the_ai_to_decide(self):
        assert engine.decide([rule(issue_type_l1="WRONG_ITEM")], FACTS) is None

    def test_amounts(self):
        fixed = engine.decide([rule(action_payload={"refund_amount": 250})], FACTS)
        assert fixed.amount(proposed=900, order_value=1000) == 250
        percent = engine.decide([rule(action_payload={"refund_percent": 50, "max_refund": 400})], FACTS)
        assert percent.amount(proposed=0, order_value=1000) == 400
        ai = engine.decide([rule(action_payload={"max_refund": 300})], FACTS)
        assert ai.amount(proposed=900, order_value=1000) == 300
        assert ai.amount(proposed=100, order_value=1000) == 100
        order_cap = engine.decide([rule(action_payload={"refund_amount": 5000})], FACTS)
        assert order_cap.amount(proposed=0, order_value=1000) == 1000

    def test_relevant_rules_for_the_ai_are_about_the_issue(self):
        rules = [rule(rule_id="R-X", issue_type_l1="WRONG_ITEM", priority=1),
                 rule(rule_id="R-Y", priority=2), rule(rule_id="R-Z", issue_type_l1=None, priority=3)]
        assert [r["rule_id"] for r in engine.relevant(rules, FACTS)] == ["R-Y", "R-Z"]

    def test_prompt_view_is_compact_and_serialisable(self):
        from decimal import Decimal
        view = engine.prompt_view([rule(min_order_value=Decimal("500.00"), business_line=None)])
        assert view[0]["min_order_value"] == 500.0 and "business_line" not in view[0]


class TestPayloadValidation:

    def test_valid_payload_is_normalised(self):
        assert engine.validate_payload({"refund_percent": "50", "max_refund": 400, "note": "x"}) == {
            "refund_percent": 50.0, "max_refund": 400.0, "note": "x"}
        assert engine.validate_payload(None) == {}

    @pytest.mark.parametrize("payload", [
        {"refund_amount": -1}, {"refund_percent": 150}, {"max_refund": "lots"},
        {"refund_amount": 10, "refund_percent": 10}, ["refund"],
    ])
    def test_invalid_payloads_are_refused(self, payload):
        with pytest.raises(ValueError):
            engine.validate_payload(payload)

    def test_rule_routes_refuse_invalid_amounts(self):
        from pydantic import ValidationError
        from app.admin.routes.rule_routes import RuleCreate, RuleUpdate
        with pytest.raises(ValidationError):
            RuleCreate(policy_version="v1", issue_type_l1="X", action_id=1, action_payload={"refund_percent": 101})
        assert RuleUpdate(action_payload={"refund_amount": "25"}).action_payload == {"refund_amount": 25.0}


# ============================================================
# STAGE 2
# ============================================================

META = {
    "REFUND": {"requires_refund": True, "requires_escalation": False, "automation_eligible": True},
    "REJECT": {"requires_refund": False, "requires_escalation": False, "automation_eligible": True},
}


def stage2(rules, mode, action="REJECT", amount=0.0, tier="STANDARD", prior=1, greedy="NORMAL", order_value=1000):
    stage0 = {"issue_type_l1": "missing_item", "issue_type_l2": "partial"}
    stage1 = {"action_code": action, "calculated_gratification": amount, "overall_confidence": 0.9,
              "greedy_classification": greedy, "fraud_segment": "NORMAL", "standard_logic_passed": True}
    fields = {"order_context": {"order_value": order_value}, "risk_context": {},
              "customer_profile": {"membership_tier": tier}, "prior_complaints_30d": prior}
    with patch.object(stage2_validator, "_load_action_meta", side_effect=lambda code: META.get(code, META["REJECT"])):
        return stage2_validator.run(1, "exec", stage0, stage1, rules, fields, rule_mode=mode)


REFUND_RULE = rule(rule_id="R-REFUND", action_code_id="REFUND", action_payload={"refund_percent": 50, "max_refund": 400})


class TestStage2:

    def test_observe_mode_changes_nothing_and_records_the_comparison(self):
        without = stage2([], "observe")
        observed = stage2([REFUND_RULE], "observe")
        for key in ("final_action_code", "final_refund_amount", "automation_pathway",
                    "discrepancy_detected", "discrepancy_details"):
            assert observed[key] == without[key]
        record = observed["rule_decision"]
        assert record["matched"] and not record["applied"]
        assert record["rule_action"] == "REFUND" and record["rule_amount"] == 400
        assert record["agrees"] is False and record["ai_action"] == "REJECT"

    def test_enforce_mode_lets_the_rule_decide(self):
        result = stage2([REFUND_RULE], "enforce")
        assert result["final_action_code"] == "REFUND"
        assert result["final_refund_amount"] == 400
        assert result["automation_pathway"] == "HITL"          # money still goes to a person
        assert result["rule_decision"]["applied"] is True
        assert "rule_decided:R-REFUND:REJECT->REFUND" in result["discrepancy_details"]

    def test_no_matching_rule_keeps_the_ai_proposal(self):
        result = stage2([rule(issue_type_l1="WRONG_ITEM")], "enforce", action="REFUND", amount=120)
        assert result["final_action_code"] == "REFUND" and result["final_refund_amount"] == 120
        assert result["rule_decision"]["matched"] is False

    def test_non_refund_rule_without_amount_pays_nothing(self):
        reject = rule(rule_id="R-REJECT", action_code_id="REJECT")
        result = stage2([reject], "enforce", action="REFUND", amount=300)
        assert result["final_action_code"] == "REJECT" and result["final_refund_amount"] == 0

    def test_fraud_zeroing_still_applies_after_a_rule(self):
        result = stage2([REFUND_RULE], "enforce", greedy="FRAUD")
        assert result["final_refund_amount"] == 0
        assert result["automation_pathway"] == "MANUAL_REVIEW"

    def test_evidence_rule_goes_to_a_person_even_with_tier_bypass(self):
        evidence = {**REFUND_RULE, "evidence_required": True}
        result = stage2([evidence], "enforce", tier="GOLD", prior=0)
        assert result["automation_pathway"] == "HITL"
        assert result["validation_status"] != "TIER_AUTO_APPROVED"

    def test_tier_bypass_uses_the_rules_decision(self):
        result = stage2([REFUND_RULE], "enforce", tier="GOLD", prior=0)
        assert result["validation_status"] == "TIER_AUTO_APPROVED"
        assert result["final_action_code"] == "REFUND" and result["final_refund_amount"] == 400
        assert result["rule_decision"]["applied"]

    def test_rule_with_unknown_action_is_recorded_not_applied(self):
        orphan = rule(rule_id="R-ORPHAN", action_code_id=None)
        result = stage2([orphan], "enforce", action="REFUND", amount=50)
        assert result["final_action_code"] == "REFUND"
        assert result["rule_decision"]["applied"] is False and result["rule_decision"]["note"]

    def test_mode_defaults_to_the_setting(self):
        from app.config import settings
        assert settings.rule_enforcement == "observe"
        assert stage2([REFUND_RULE], None)["rule_decision"]["mode"] == "observe"


class TestReplay:

    def test_replay_uses_the_same_evaluator(self):
        from app.l45_ml_platform.simulation.policy_simulation_service import AI_DECIDES, PolicySimulationService
        sim = PolicySimulationService(engine=None)
        ticket = {"ticket_id": "t1", "issue_type": "MISSING_ITEM", "order_value": 800, "customer_tier": "Gold"}
        tree = {"type": "group", "operator": "AND", "conditions": [leaf("customer_segment", "eq", "Gold")]}
        assert sim._evaluate(ticket, [rule(conditions=tree)]) == "REFUND"
        assert sim._evaluate(ticket, [rule(conditions={"type": "group", "operator": "AND",
                                                       "conditions": [leaf("order_value", "gte", 900)]})]) == AI_DECIDES
        assert sim._evaluate(ticket, [rule(deterministic=False)]) == AI_DECIDES
