"""
app/l4_agents/rule_engine.py
============================
Deterministic evaluation of Policy Studio rules.

One evaluator serves both the live pipeline (stage2_validator) and the
sample replay (PolicySimulationService), so a replay predicts what the
runtime does. Previously the runtime only showed the LLM the first five rules
and never evaluated a condition, while the replay read three legacy keys.

A rule decides a ticket when it is deterministic and everything it states
holds: issue category, the column filters and its condition tree. Rules are
tried in runtime precedence (priority ASC — a lower number wins — then
rule_id). Anything the evaluator cannot establish counts as *not matched*:
a rule it cannot read never takes over a decision.

Amounts come from the rule's action_payload:
    refund_amount   fixed amount (₹)
    refund_percent  percentage of the order value
    max_refund      cap on whatever amount is chosen (rule's or the AI's)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

PAYLOAD_KEYS = ("refund_amount", "refund_percent", "max_refund")

# Segment labels used by the rule editors vs membership tiers from enrichment.
_SEGMENT_ALIASES = {"NORMAL": "STANDARD"}

_TRUE = {"true", "1", "yes", "y"}


def _norm(value: Any) -> Optional[str]:
    if value is None:
        return None
    # Stage 0 emits "missing_item"; rules store "MISSING_ITEM".
    text = str(value).strip().upper().replace(" ", "_").replace("-", "_")
    return _SEGMENT_ALIASES.get(text, text) or None


def _number(value: Any) -> Optional[float]:
    try:
        return None if value is None or value == "" else float(value)
    except (TypeError, ValueError):
        return None


def _bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    return str(value).strip().lower() in _TRUE


# ============================================================
# FACTS
# ============================================================

def facts_from_pipeline(stage0_result: dict, stage1_result: dict, fields: dict) -> dict:
    """The deterministic facts a live ticket offers rules. Enrichment wins over the LLM."""
    order_ctx = fields.get("order_context") or {}
    risk_ctx = fields.get("risk_context") or {}
    profile = fields.get("customer_profile") or {}
    return {
        "issue_type_l1": stage0_result.get("issue_type_l1"),
        "issue_type_l2": stage0_result.get("issue_type_l2"),
        "order_value": _number(order_ctx.get("order_value")),
        "customer_segment": profile.get("membership_tier"),
        "fraud_segment": fields.get("fraud_risk_classification") or stage1_result.get("fraud_segment"),
        "fraud_score": _number(risk_ctx.get("fraud_score")),
        "repeat_count": _number(fields.get("prior_complaints_30d")),
        "sla_breach": _bool(order_ctx.get("sla_breach")),
        "business_line": fields.get("business_line") or fields.get("module"),
        "greedy_classification": stage1_result.get("greedy_classification"),
    }


def facts_from_sample(ticket: dict) -> dict:
    """Facts a saved simulation case offers (simulation_tickets has one issue type)."""
    return {
        "issue_type_l1": ticket.get("issue_type_l1") or ticket.get("issue_type"),
        "issue_type_l2": ticket.get("issue_type_l2"),
        "order_value": _number(ticket.get("order_value")),
        "customer_segment": ticket.get("customer_segment") or ticket.get("customer_tier"),
        "fraud_segment": ticket.get("fraud_segment"),
        "fraud_score": _number(ticket.get("fraud_score")),
        "repeat_count": _number(ticket.get("repeat_count")),
        "sla_breach": _bool(ticket.get("sla_breach")),
        "business_line": ticket.get("business_line"),
        "greedy_classification": ticket.get("greedy_classification"),
    }


# ============================================================
# MATCHING
# ============================================================

def _equal(field_name: str, expected: Any, facts: dict, reasons: list[str]) -> None:
    actual = facts.get(field_name)
    if actual is None:
        reasons.append(f"{field_name}: not known for this ticket")
    elif _norm(actual) != _norm(expected):
        reasons.append(f"{field_name}: expected '{expected}', got '{actual}'")


def _bound(field_name: str, minimum: Any, maximum: Any, facts: dict, reasons: list[str]) -> None:
    low, high = _number(minimum), _number(maximum)
    if low is None and high is None:
        return
    actual = _number(facts.get(field_name))
    if actual is None:
        reasons.append(f"{field_name}: not known for this ticket")
    elif low is not None and actual < low:
        reasons.append(f"{field_name} {actual:g} < min {low:g}")
    elif high is not None and actual > high:
        reasons.append(f"{field_name} {actual:g} > max {high:g}")


def _leaf(node: dict, facts: dict) -> Optional[str]:
    """None when the leaf holds; otherwise why not."""
    name, op, expected = node.get("field"), node.get("op"), node.get("value")
    actual = facts.get(name)
    if actual is None:
        return f"{name}: not known for this ticket"
    if op in ("gte", "lte"):
        a, e = _number(actual), _number(expected)
        if a is None or e is None:
            return f"{name}: cannot compare '{actual}' with '{expected}'"
        return None if (a >= e if op == "gte" else a <= e) else f"{name} {a:g} {'<' if op == 'gte' else '>'} {e:g}"
    if op == "eq":
        if isinstance(expected, bool) or name == "sla_breach":
            return None if _bool(actual) == _bool(expected) else f"{name}: expected {expected}, got {actual}"
        return None if _norm(actual) == _norm(expected) else f"{name}: expected '{expected}', got '{actual}'"
    if op == "in":
        options = expected if isinstance(expected, list) else [expected]
        return None if _norm(actual) in {_norm(o) for o in options} else f"{name}: '{actual}' not in {options}"
    return f"unsupported condition operator '{op}'"


def _tree(node: Any, facts: dict) -> Optional[str]:
    if not isinstance(node, dict):
        return "unreadable condition"
    if node.get("type") == "leaf":
        return _leaf(node, facts)
    if node.get("type") == "group":
        children = node.get("conditions")
        operator = node.get("operator")
        if operator not in ("AND", "OR"):
            return f"unsupported condition group operator '{operator}'"
        if not isinstance(children, list):
            return "unreadable condition group"
        if not children:
            return None
        failures = [_tree(child, facts) for child in children]
        if operator == "OR":
            return None if any(f is None for f in failures) else "none of: " + "; ".join(f for f in failures if f)
        misses = [f for f in failures if f]
        return "; ".join(misses) if misses else None
    return "unreadable condition"


_LEGACY_CONDITION_KEYS = {"max_fraud_score", "customer_tier", "greedy_classification"}


def _conditions(conditions: Any, facts: dict, reasons: list[str]) -> None:
    if not conditions:
        return
    if not isinstance(conditions, dict):
        reasons.append("unreadable conditions")
        return
    if "type" in conditions:
        failure = _tree(conditions, facts)
        if failure:
            reasons.append(failure)
        return
    unknown = set(conditions) - _LEGACY_CONDITION_KEYS
    if unknown:
        # Fail closed: a condition nobody can evaluate must not be ignored.
        reasons.append(f"unsupported conditions: {', '.join(sorted(unknown))}")
        return
    if "max_fraud_score" in conditions:
        score, limit = _number(facts.get("fraud_score")), _number(conditions["max_fraud_score"])
        if score is None or limit is None:
            reasons.append("fraud_score: not known for this ticket")
        elif score > limit:
            reasons.append(f"fraud_score {score:g} > max {limit:g}")
    if "customer_tier" in conditions:
        _equal("customer_segment", conditions["customer_tier"], facts, reasons)
    if "greedy_classification" in conditions:
        _equal("greedy_classification", conditions["greedy_classification"], facts, reasons)


def match_reasons(rule: dict, facts: dict) -> list[str]:
    """Empty when the rule holds for these facts; otherwise every reason it does not."""
    reasons: list[str] = []
    if rule.get("issue_type_l1"):
        _equal("issue_type_l1", rule["issue_type_l1"], facts, reasons)
    if rule.get("issue_type_l2"):
        _equal("issue_type_l2", rule["issue_type_l2"], facts, reasons)
    if rule.get("business_line"):
        _equal("business_line", rule["business_line"], facts, reasons)
    if rule.get("customer_segment"):
        _equal("customer_segment", rule["customer_segment"], facts, reasons)
    if rule.get("fraud_segment"):
        _equal("fraud_segment", rule["fraud_segment"], facts, reasons)
    _bound("order_value", rule.get("min_order_value"), rule.get("max_order_value"), facts, reasons)
    _bound("repeat_count", rule.get("min_repeat_count"), rule.get("max_repeat_count"), facts, reasons)
    if rule.get("sla_breach_required") and facts.get("sla_breach") is not True:
        reasons.append("sla_breach required but not established")
    _conditions(rule.get("conditions"), facts, reasons)
    return reasons


def is_deciding(rule: dict) -> bool:
    """Only an explicit deterministic=FALSE makes a rule guidance; NULL means the column default (TRUE)."""
    return rule.get("deterministic") is not False


def ordered(rules: list[dict]) -> list[dict]:
    """Runtime precedence: priority ASC (lower wins), then rule_id."""
    return sorted(rules, key=lambda r: (_number(r.get("priority")) or 0, str(r.get("rule_id") or "")))


# ============================================================
# DECISION
# ============================================================

@dataclass
class RuleDecision:
    rule_id: str
    action_code: Optional[str]
    action_id: Optional[int]
    refund_amount: Optional[float] = None     # set when the rule states an amount
    max_refund: Optional[float] = None
    evidence_required: bool = False
    considered: int = 0
    trace: list = field(default_factory=list)

    def amount(self, proposed: float, order_value: Optional[float]) -> float:
        """The rule's amount (or the proposed one), within its cap and the order value."""
        amount = self.refund_amount if self.refund_amount is not None else proposed
        if self.max_refund is not None:
            amount = min(amount, self.max_refund)
        if order_value:
            amount = min(amount, order_value)
        return round(max(amount, 0.0), 2)


def _payload_amount(payload: Any, order_value: Optional[float]) -> tuple[Optional[float], Optional[float]]:
    payload = payload if isinstance(payload, dict) else {}
    fixed = _number(payload.get("refund_amount"))
    percent = _number(payload.get("refund_percent"))
    cap = _number(payload.get("max_refund"))
    if fixed is None and percent is not None and order_value is not None:
        fixed = order_value * percent / 100.0
    return fixed, cap


def decide(rules: list[dict], facts: dict) -> Optional[RuleDecision]:
    """
    The first deterministic rule that holds, or None (the AI's proposal
    stands). Non-deterministic rules remain guidance for the AI only.
    """
    trace = []
    candidates = [r for r in ordered(rules) if is_deciding(r)]
    for rule in candidates:
        reasons = match_reasons(rule, facts)
        trace.append({"rule_id": rule.get("rule_id"), "matched": not reasons, "reasons": reasons[:3]})
        if reasons:
            continue
        fixed, cap = _payload_amount(rule.get("action_payload"), _number(facts.get("order_value")))
        return RuleDecision(
            rule_id=str(rule.get("rule_id")),
            action_code=rule.get("action_code_id"),
            action_id=rule.get("action_id"),
            refund_amount=fixed,
            max_refund=cap,
            evidence_required=bool(rule.get("evidence_required")),
            considered=len(trace),
            trace=trace[-10:],
        )
    return None


def relevant(rules: list[dict], facts: dict, limit: int = 10) -> list[dict]:
    """Rules about this ticket's issue, in precedence order — guidance for the AI."""
    issue = _norm(facts.get("issue_type_l1"))
    related = [r for r in ordered(rules) if not r.get("issue_type_l1") or _norm(r["issue_type_l1"]) == issue]
    return related[:limit]


def prompt_view(rules: list[dict]) -> list[dict]:
    """What the AI is shown of each rule: only the fields that state policy."""
    keys = ("rule_id", "priority", "issue_type_l1", "issue_type_l2", "action_code_id",
            "business_line", "customer_segment", "fraud_segment", "min_order_value",
            "max_order_value", "min_repeat_count", "max_repeat_count",
            "sla_breach_required", "evidence_required", "conditions", "action_payload")
    view = []
    for rule in rules:
        item = {}
        for key in keys:
            value = rule.get(key)
            if value in (None, {}, [], False):
                continue
            item[key] = float(value) if key.endswith(("_value", "_count")) and _number(value) is not None else value
        view.append(item)
    return view


def validate_payload(payload: Any) -> dict:
    """Reject action payload amounts the engine cannot apply safely."""
    if payload in (None, {}):
        return {}
    if not isinstance(payload, dict):
        raise ValueError("action_payload must be an object")
    clean = {}
    for key, value in payload.items():
        if key not in PAYLOAD_KEYS:
            clean[key] = value            # other keys are carried, not interpreted
            continue
        if value in (None, ""):
            continue
        number = _number(value)
        if number is None or number < 0:
            raise ValueError(f"{key} must be a non-negative number")
        if key == "refund_percent" and number > 100:
            raise ValueError("refund_percent cannot exceed 100")
        clean[key] = number
    if "refund_amount" in clean and "refund_percent" in clean:
        raise ValueError("Set either refund_amount or refund_percent, not both")
    return clean
