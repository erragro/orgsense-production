from __future__ import annotations

import logging
import re
from typing import Any

from app.config import settings
from app.l4_agents.ecommerce.llm_client import LLMClient
from app.l4_agents.ecommerce.retrieval import RetrievalService

logger = logging.getLogger("stage1_evaluator")


def _coerce_float(value: Any, fallback: float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "")
        match = re.search(r"-?\d+(\.\d+)?", cleaned)
        if match:
            try:
                return float(match.group(0))
            except ValueError:
                pass
    return fallback


def _risk_bool(value: Any, threshold: float, op: str = "<=") -> bool:
    try:
        val = float(value or 0)
    except (TypeError, ValueError):
        val = 0.0
    if op == "<":
        return val < threshold
    if op == ">":
        return val > threshold
    return val <= threshold


def run(
    ticket_id: int,
    execution_id: str,
    ticket_context: dict,
    stage0_result: dict,
    rules: list,
    fields: dict,
) -> dict[str, Any]:
    llm = LLMClient()
    retrieval = RetrievalService()

    order_ctx = fields.get("order_context") or {}
    risk_ctx = fields.get("risk_context") or {}
    policy_ctx = fields.get("policy_context") or {}

    query = f"{stage0_result.get('issue_type_l1')} {stage0_result.get('issue_type_l2')}"
    actions = retrieval.action_candidates(query, version="v1", top_k=5)
    policy_version = policy_ctx.get("active_version") or fields.get("active_policy") or ""
    rule_hits = []
    if policy_version:
        rule_hits = retrieval.policy_rule_candidates(query, policy_version=policy_version, top_k=5)

    system = (
        "You are an automated support decision engine. "
        "Return JSON with keys: action_code, calculated_gratification, "
        "fraud_segment, greedy_classification, reasoning."
    )
    user = {
        "issue": stage0_result,
        "order": order_ctx,
        "risk": risk_ctx,
        "candidate_actions": actions,
        "rules": rules[:5],
        "vector_rules": rule_hits,
    }

    order_value = float(order_ctx.get("order_value", 0) or 0)
    refunds_30d = risk_ctx.get("refunds_last_30_days", 0)
    complaints_30d = risk_ctx.get("complaints_last_30_days", 0)
    refund_rate_30d = risk_ctx.get("refund_rate_30d", 0.0)
    marked_delivered_90d = risk_ctx.get("marked_delivered_claims_90d", 0)
    delivery_delay = order_ctx.get("delivery_delay_minutes")

    lifetime_igcc_check = _risk_bool(refund_rate_30d, 0.2, "<=")
    exceptions_60d_check = _risk_bool(complaints_30d, 6, "<=")
    igcc_history_check = _risk_bool(refunds_30d, 2, "<=")
    same_issue_check = _risk_bool(complaints_30d, 2, "<=")
    standard_logic_passed = all([lifetime_igcc_check, exceptions_60d_check, igcc_history_check, same_issue_check])

    greedy_signals = 0
    if refund_rate_30d and float(refund_rate_30d) > 0.25:
        greedy_signals += 1
    if marked_delivered_90d and int(marked_delivered_90d) >= 2:
        greedy_signals += 1
    if complaints_30d and int(complaints_30d) >= 5:
        greedy_signals += 1

    # R-003: GPS confirms delivery but customer claims non-receipt (policy violation)
    gps_confirmed_delivery = bool(order_ctx.get("gps_confirmed_delivery", False))
    delivery_status        = (order_ctx.get("delivery_status") or "unknown").lower()
    issue_l2               = (stage0_result.get("issue_type_l2") or "").lower()
    if (
        gps_confirmed_delivery
        and delivery_status == "delivered"
        and any(kw in issue_l2 for kw in ("not_received", "not received", "missing", "undelivered"))
    ):
        greedy_signals += 1  # GPS-confirmed delivery + non-receipt claim = R-003 signal

    if greedy_signals >= 2:
        greedy_classification = "FRAUD"
    elif greedy_signals == 1:
        greedy_classification = "SUSPICIOUS"
    else:
        greedy_classification = "NORMAL"

    value_segment = "high" if order_value >= 1000 else "medium" if order_value >= 300 else "low"
    fraud_segment = risk_ctx.get("fraud_risk_classification", "NORMAL")

    default_gratification = order_value * 0.3

    result = {
        "action_code": "REFUND_PARTIAL",
        "calculated_gratification": default_gratification,
        "fraud_segment": fraud_segment,
        "value_segment": value_segment,
        "standard_logic_passed": standard_logic_passed,
        "lifetime_igcc_check": lifetime_igcc_check,
        "exceptions_60d_check": exceptions_60d_check,
        "igcc_history_check": igcc_history_check,
        "same_issue_check": same_issue_check,
        "aon_bod_eligible": risk_ctx.get("orders_last_90_days", 0) >= 10,
        "super_subscriber": False,
        "hrx_applicable": False,
        "hrx_passed": None,
        "greedy_check_applicable": True,
        "greedy_signals_count": greedy_signals,
        "greedy_classification": greedy_classification,
        "sla_check_applicable": True,
        "sla_breach": order_ctx.get("sla_breach"),
        "delivery_delay_minutes": delivery_delay,
        "multiplier": 0.3,
        "order_value": order_value,
        "cap_applied": None,
        "overall_confidence": 0.7,
        "issue_confidence": stage0_result.get("confidence", 0.5),
        "evaluation_confidence": 0.7,
        "action_confidence": 0.7,
        "reasoning": "fallback",
        "raw_response": None,
    }

    try:
        response = llm.chat_json(settings.model2, system, str(user))
        fallback_amount = float(result["calculated_gratification"])
        result.update({
            "action_code": response.get("action_code", result["action_code"]),
            "calculated_gratification": _coerce_float(
                response.get("calculated_gratification", fallback_amount),
                fallback_amount,
            ),
            "fraud_segment": response.get("fraud_segment", result["fraud_segment"]),
            "value_segment": response.get("value_segment", result["value_segment"]),
            "standard_logic_passed": response.get("standard_logic_passed", result["standard_logic_passed"]),
            "greedy_classification": response.get("greedy_classification", result["greedy_classification"]),
            "reasoning": response.get("reasoning", "LLM evaluation"),
            "raw_response": response,
        })
    except Exception as exc:
        logger.warning("Stage1 LLM failed: %s", exc)

    return result
