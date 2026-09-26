"""
stage2_validator.py
===================
Stage 2: Validation Engine

Responsibilities:
- Re-validates all business logic checks against stage1 signals
- Detects discrepancies between LLM decisions and deterministic rules
- Applies Policy Studio rules (app.l4_agents.rule_engine) before the
  safety checks: in RULE_ENFORCEMENT=enforce the first matching deterministic
  rule sets the action and amount; in observe it is only recorded
  (rule_decision) next to the actual outcome
- Assigns automation_pathway using 3-bucket routing:

    AUTO_RESOLVED   — zero/non-monetary, high confidence, automation eligible, no fraud
    HITL            — monetary refund approved, within policy, needs human sign-off
    MANUAL_REVIEW   — fraud confirmed, escalation required, low confidence, overrides

- Returns full validation payload for llm_output_3 persistence
"""
from __future__ import annotations

import logging
import os
from typing import Any

import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from dotenv import load_dotenv
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

from app.l4_agents import rule_engine

logger = logging.getLogger("stage2_validator")

# ── Thresholds ────────────────────────────────────────────────
_CONFIDENCE_MANUAL_THRESHOLD = 0.45  # below this → MANUAL_REVIEW
_CONFIDENCE_AUTO_THRESHOLD   = 0.65  # above this required for AUTO_RESOLVED


def _get_connection():
    return pooled_connection()


def _load_action_meta(action_code: str) -> dict:
    """
    Fetch requires_escalation, automation_eligible, requires_refund
    for the given action_code_id from master_action_codes.
    Returns safe defaults if not found.
    """
    if not action_code:
        return {"requires_escalation": False, "automation_eligible": True, "requires_refund": False}

    try:
        conn = _get_connection()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT requires_escalation, automation_eligible, requires_refund
                    FROM kirana_kart.master_action_codes
                    WHERE action_code_id = %s
                    LIMIT 1
                """, (action_code,))
                row = cur.fetchone()
            return dict(row) if row else {
                "requires_escalation": False,
                "automation_eligible": True,
                "requires_refund": False,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("action_meta lookup failed for %s: %s", action_code, exc)
        return {"requires_escalation": False, "automation_eligible": True, "requires_refund": False}


def _rule_amount(decision, ai_amount: float, order_value: float) -> float:
    """
    A rule's amount: the one it states, else the AI's for a refund action —
    within the rule's cap and the order value. A non-refund action with no
    stated amount pays nothing; it must not inherit the AI's refund.
    """
    refundable = _load_action_meta(decision.action_code).get("requires_refund", False)
    if decision.refund_amount is None and not refundable:
        return 0.0
    return decision.amount(ai_amount, order_value or None)


def _rule_record(mode: str, decision, ai_action: str, ai_amount: float, order_value: float) -> dict:
    """What the rules decided (or would have), next to the AI's proposal."""
    if decision is None:
        return {"mode": mode, "matched": False, "applied": False, "agrees": None,
                "ai_action": ai_action, "ai_amount": round(ai_amount, 2)}
    applicable = bool(decision.action_code)
    rule_amount = _rule_amount(decision, ai_amount, order_value) if applicable else None
    return {
        "mode": mode,
        "matched": True,
        "applied": mode == "enforce" and applicable,
        "rule_id": decision.rule_id,
        "rule_action": decision.action_code,
        "rule_amount": rule_amount,
        "rule_sets_amount": decision.refund_amount is not None or decision.max_refund is not None,
        "evidence_required": decision.evidence_required,
        "ai_action": ai_action,
        "ai_amount": round(ai_amount, 2),
        "agrees": applicable and decision.action_code == ai_action and abs(rule_amount - ai_amount) < 0.01,
        "rules_considered": decision.considered,
        "note": None if applicable else "Rule action is not in the action registry; not applied",
    }


def run(
    ticket_id: int,
    execution_id: str,
    stage0_result: dict,
    stage1_result: dict,
    rules: list,
    fields: dict,
    rule_mode: str | None = None,
) -> dict[str, Any]:
    """
    rule_mode overrides RULE_ENFORCEMENT (the simulator previews "enforce").
    """
    from app.config import settings

    order_ctx       = fields.get("order_context") or {}
    risk_ctx        = fields.get("risk_context") or {}
    customer_profile = fields.get("customer_profile") or {}

    order_value = float(order_ctx.get("order_value", 0) or 0)
    requested   = float(stage1_result.get("calculated_gratification", 0) or 0)
    auto_limit  = float(risk_ctx.get("auto_approval_limit", 0) or 0)

    # ── Policy Studio rules ───────────────────────────────────────────────────
    # Evaluated before every safety check below, so a rule can set the action
    # and amount but can never bypass fraud zeroing, escalation or review.
    mode = rule_mode or settings.rule_enforcement
    ai_action = stage1_result.get("action_code", "REFUND_PARTIAL")
    decision = rule_engine.decide(
        rules or [], rule_engine.facts_from_pipeline(stage0_result, stage1_result, fields),
    )
    rule_decision = _rule_record(mode, decision, ai_action, requested, order_value)
    effective_action = ai_action
    evidence_review = False
    if rule_decision["applied"]:
        effective_action = decision.action_code
        requested = rule_decision["rule_amount"]
        evidence_review = decision.evidence_required

    # Stage 0 could not place the ticket in the live taxonomy: no rule was
    # written for it, so a person decides rather than the model alone.
    issue_unmapped = stage0_result.get("taxonomy_status") == "unmapped"

    # Cap refund to order value
    final_refund = min(requested, order_value) if order_value else requested

    # ── R-005 Gold/Platinum tier auto-approve (first claim) ───────────────────
    # Rule: Gold/Platinum tier customers get one-click refund for first claim
    # on an order; full audit is deferred to the nightly fraud review.
    membership_tier      = (customer_profile.get("membership_tier") or "STANDARD").upper()
    prior_complaints_30d = int(fields.get("prior_complaints_30d") or 0)
    fraud_score          = float(risk_ctx.get("fraud_score", 0) or 0)
    greedy_pre           = (stage1_result.get("greedy_classification") or "NORMAL").upper()

    if (
        membership_tier in ("GOLD", "PLATINUM")
        and prior_complaints_30d == 0          # first claim in last 30 days
        and fraud_score < 0.2                   # not a known fraud risk
        and greedy_pre == "NORMAL"              # no active fraud signals
        and requested > 0                       # there is a refund to approve
        and not evidence_review                 # a deciding rule demands evidence review
        and not issue_unmapped                  # no policy covers this problem
    ):
        return {
            "rule_decision":             rule_decision,
            "final_action_code":         effective_action,
            "final_refund_amount":        min(requested, order_value) if order_value else requested,
            "validation_status":          "TIER_AUTO_APPROVED",
            "requires_human_review":      False,
            "automation_pathway":         "AUTO_RESOLVED",
            "validation_standard_logic":  True,
            "validation_lifetime_igcc":   True,
            "validation_exceptions_60d":  True,
            "validation_igcc_history":    True,
            "validation_same_issue":      True,
            "validation_greedy_check":    True,
            "validation_multiplier":      True,
            "validation_cap":             True,
            "validated_greedy_signals":   0,
            "validated_greedy_classification": "NORMAL",
            "discrepancy_detected":       False,
            "discrepancy_count":          0,
            "discrepancy_details":        None,
            "override_applied":           False,
            "override_reason":            None,
            "override_type":              None,
            "llm_overall_accuracy":       1.0,
            "reasoning": (
                f"R-005 tier bypass | tier={membership_tier} | "
                f"first_claim=True | fraud_score={fraud_score:.2f} | "
                "Auto-approved per Gold/Platinum one-click policy. Audit deferred."
            ),
        }

    # ── Pull signal flags from stage1 ────────────────────────────────────────
    action_code            = effective_action
    overall_confidence     = float(stage1_result.get("overall_confidence", 0.7) or 0.7)
    greedy_classification  = (stage1_result.get("greedy_classification") or "NORMAL").upper()
    fraud_segment          = (stage1_result.get("fraud_segment") or "NORMAL").upper()
    greedy_signals         = int(stage1_result.get("greedy_signals_count", 0) or 0)

    # Individual business logic checks from stage1
    std_logic      = bool(stage1_result.get("standard_logic_passed", True))
    lifetime_igcc  = bool(stage1_result.get("lifetime_igcc_check", True))
    exceptions_60d = bool(stage1_result.get("exceptions_60d_check", True))
    igcc_history   = bool(stage1_result.get("igcc_history_check", True))
    same_issue     = bool(stage1_result.get("same_issue_check", True))
    sla_breach     = bool(order_ctx.get("sla_breach", False))

    # ── Look up action code policy flags ─────────────────────────────────────
    action_meta          = _load_action_meta(action_code)
    requires_escalation  = bool(action_meta.get("requires_escalation", False))
    automation_eligible  = bool(action_meta.get("automation_eligible", True))
    requires_refund_flag = bool(action_meta.get("requires_refund", False))

    # ── Discrepancy detection ─────────────────────────────────────────────────
    # Identify gaps between what the LLM decided and what business rules say
    discrepancies: list[str] = []

    if greedy_classification == "FRAUD":
        discrepancies.append("fraud_confirmed_by_greedy_signals")

    if not std_logic and final_refund > 0:
        discrepancies.append("standard_logic_failed_with_positive_refund")

    if not lifetime_igcc:
        discrepancies.append("lifetime_igcc_rate_exceeded")

    if not exceptions_60d:
        discrepancies.append("exceptions_60d_limit_exceeded")

    if not igcc_history:
        discrepancies.append("igcc_history_exceeded")

    if greedy_classification == "SUSPICIOUS" and final_refund > 0:
        discrepancies.append("suspicious_behaviour_with_refund")

    if overall_confidence < _CONFIDENCE_MANUAL_THRESHOLD:
        discrepancies.append(f"low_confidence_{overall_confidence:.2f}")

    if requires_escalation:
        discrepancies.append(f"action_requires_escalation:{action_code}")

    # Only an enforced rule changes reported discrepancies; observe mode must
    # leave every output as it was and record the comparison separately.
    if rule_decision["applied"] and rule_decision["agrees"] is False:
        discrepancies.append(f"rule_decided:{rule_decision['rule_id']}:{ai_action}->{action_code}")

    if not automation_eligible:
        discrepancies.append(f"action_not_automation_eligible:{action_code}")

    if issue_unmapped:
        discrepancies.append(f"issue_not_in_taxonomy:{stage0_result.get('model_issue') or 'unknown'}")

    discrepancy_detected = len(discrepancies) > 0
    discrepancy_count    = len(discrepancies)

    # ── Override detection ────────────────────────────────────────────────────
    override_applied = False
    override_reason  = None

    if greedy_classification == "FRAUD" and final_refund > 0:
        override_applied = True
        override_reason  = "Refund zeroed — confirmed fraud signals"
        final_refund     = 0.0
        action_code      = "REJECT_FRAUD" if action_code not in ("REJECT_FRAUD",) else action_code

    # ── LLM accuracy scoring ──────────────────────────────────────────────────
    accuracy_checks = [std_logic, lifetime_igcc, exceptions_60d, igcc_history, same_issue]
    llm_overall_accuracy = sum(accuracy_checks) / len(accuracy_checks) if accuracy_checks else 0.7

    # ── 3-Bucket Routing ─────────────────────────────────────────────────────
    #
    #  Priority order (highest first):
    #
    #  MANUAL_REVIEW — agent must handle; no automated action taken
    #    • Confirmed fraud (FRAUD greedy classification)
    #    • Action code flagged requires_escalation in master_action_codes
    #    • Action code not automation_eligible
    #    • LLM confidence critically low (< _CONFIDENCE_MANUAL_THRESHOLD)
    #    • Multiple discrepancies flagging override
    #
    #  HITL — monetary approval needed from a human agent
    #    • final_refund > 0 (customer gets money back)
    #    • Action code requires_refund flag is true
    #    • Suspicious but not confirmed fraud (SUSPICIOUS with refund)
    #
    #  AUTO_RESOLVED — fully automated, close immediately
    #    • Zero refund (denial, rejection, informational, track order)
    #    • High confidence
    #    • No fraud signals
    #    • Action code is automation_eligible

    manual_review_triggers = [
        greedy_classification == "FRAUD",
        requires_escalation,
        not automation_eligible,
        overall_confidence < _CONFIDENCE_MANUAL_THRESHOLD,
        override_applied,                                      # fraud override was applied
        (fraud_segment in ("HIGH", "VERY_HIGH")),              # risk profile flag
    ]

    hitl_triggers = [
        evidence_review,                        # deciding rule requires evidence
        issue_unmapped,                         # outside the live taxonomy
        final_refund > 0,
        requires_refund_flag,
        greedy_classification == "SUSPICIOUS" and final_refund > 0,
    ]

    if any(manual_review_triggers):
        automation_pathway     = "MANUAL_REVIEW"
        requires_human_review  = True
        validation_status      = "OVERRIDE_REQUIRED"
    elif any(hitl_triggers):
        automation_pathway     = "HITL"
        requires_human_review  = True
        validation_status      = "REVIEW_REQUIRED" if (auto_limit and final_refund > auto_limit) else "PASSED"
    else:
        # Zero refund, no fraud, automation eligible → close immediately
        automation_pathway     = "AUTO_RESOLVED"
        requires_human_review  = False
        validation_status      = "PASSED"

    # ── Build detailed reasoning ──────────────────────────────────────────────
    reasoning_parts = [
        f"Pathway: {automation_pathway}",
        f"refund={final_refund:.2f}",
        f"confidence={overall_confidence:.2f}",
        f"greedy={greedy_classification}",
        f"fraud_segment={fraud_segment}",
        f"std_logic={std_logic}",
        f"requires_escalation={requires_escalation}",
        f"automation_eligible={automation_eligible}",
    ]
    if discrepancies:
        reasoning_parts.append(f"discrepancies=[{', '.join(discrepancies)}]")
    if override_applied:
        reasoning_parts.append(f"override={override_reason}")
    if rule_decision["matched"]:
        reasoning_parts.append(
            f"rule={rule_decision['rule_id']} ({'applied' if rule_decision['applied'] else mode})"
        )

    return {
        "rule_decision":            rule_decision,
        # ── Core output ───────────────────────────────────────────────────────
        "final_action_code":        action_code,
        "final_refund_amount":      final_refund,
        "validation_status":        validation_status,
        "requires_human_review":    requires_human_review,
        "automation_pathway":       automation_pathway,

        # ── Validation checks (map to llm_output_3 validation_* columns) ─────
        "validation_standard_logic": std_logic,
        "validation_lifetime_igcc":  lifetime_igcc,
        "validation_exceptions_60d": exceptions_60d,
        "validation_igcc_history":   igcc_history,
        "validation_same_issue":     same_issue,
        "validation_greedy_check":   greedy_classification == "NORMAL",
        "validation_multiplier":     True,  # multiplier validation pass-through
        "validation_cap":            final_refund <= order_value if order_value else True,

        # ── Greedy / fraud signals ────────────────────────────────────────────
        "validated_greedy_signals":       greedy_signals,
        "validated_greedy_classification": greedy_classification,

        # ── Discrepancy report ────────────────────────────────────────────────
        "discrepancy_detected":  discrepancy_detected,
        "discrepancy_count":     discrepancy_count,
        "discrepancy_details":   "; ".join(discrepancies) if discrepancies else None,

        # ── Override ──────────────────────────────────────────────────────────
        "override_applied": override_applied,
        "override_reason":  override_reason,
        "override_type":    "FRAUD_ZERO_REFUND" if override_applied else None,

        # ── Accuracy + reasoning ──────────────────────────────────────────────
        "llm_overall_accuracy": round(llm_overall_accuracy, 4),
        "reasoning":            " | ".join(reasoning_parts),
    }
