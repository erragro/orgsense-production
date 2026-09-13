"""
stage3_responder.py
===================
Stage 3: Response Generation (HITL cases only)

Pure Python — no LLM call.

Runs ONLY when stage2 sets automation_pathway = "HITL".
Generates a structured draft for the human agent who will
review and approve the monetary action before replying.

Does NOT run for:
  - AUTO_RESOLVED  (ticket closes automatically, no agent contact)
  - MANUAL_REVIEW  (agent writes their own response from scratch)
"""
from __future__ import annotations

from typing import Any


def run(
    ticket_id: int,
    execution_id: str,
    stage0_result: dict,
    stage1_result: dict,
    stage2_result: dict,
    fields: dict,
) -> dict[str, Any]:

    action_code   = stage2_result.get("final_action_code", "REFUND_PARTIAL")
    refund_amount = float(stage2_result.get("final_refund_amount", 0) or 0)
    issue_l1      = stage0_result.get("issue_type_l1", "Issue")
    issue_l2      = stage0_result.get("issue_type_l2", "")
    order_value   = float((fields.get("order_context") or {}).get("order_value", 0) or 0)
    channel       = fields.get("channel", "email")
    sla_breach    = bool((fields.get("order_context") or {}).get("sla_breach", False))

    # Determine human-readable action summary
    action_summary = _action_summary(action_code, refund_amount, order_value)

    # Determine which HITL queue this should go to
    hitl_queue = _resolve_queue(
        action_code=action_code,
        refund_amount=refund_amount,
        order_value=order_value,
        sla_breach=sla_breach,
        recommended_queue=fields.get("recommended_queue", "STANDARD_REVIEW"),
    )

    # Build the draft response the agent will review and edit before sending
    issue_label = f"{issue_l1} — {issue_l2}" if issue_l2 else issue_l1
    draft_lines = [
        f"[DRAFT — HITL REVIEW REQUIRED | Queue: {hitl_queue}]",
        "",
        f"Ticket #{ticket_id} | Issue: {issue_label} | Channel: {channel}",
        "",
        "Hi,",
        "",
        f"Thank you for reaching out. We have reviewed your {issue_label.lower()} complaint.",
        "",
        action_summary,
        "",
        "If you have any questions or require further assistance, please do not hesitate to get in touch.",
        "",
        "Warm regards,",
        "Customer Support Team",
        "",
        "---",
        f"[Agent note: Refund amount = INR {refund_amount:.2f} | Action = {action_code} | "
        f"Order value = INR {order_value:.2f} | SLA breach = {sla_breach}]",
    ]

    return {
        "response_draft": "\n".join(draft_lines),
        "hitl_queue":     hitl_queue,
        "action_code":    action_code,
        "refund_amount":  refund_amount,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _action_summary(action_code: str, refund_amount: float, order_value: float) -> str:
    """Return a customer-facing sentence describing the resolution action."""
    code = action_code.upper()

    if "REFUND_FULL" in code:
        return (
            f"We are pleased to confirm a full refund of INR {refund_amount:.2f} "
            "for your order. This will be processed within 5–7 business days."
        )
    if "REFUND_PARTIAL" in code:
        return (
            f"We have approved a partial refund of INR {refund_amount:.2f} "
            "for the affected items. This will be credited within 5–7 business days."
        )
    if "COUPON" in code or "VOUCHER" in code:
        return (
            f"We are issuing a coupon/voucher credit of INR {refund_amount:.2f} "
            "as compensation. Details will be shared on your registered contact."
        )
    if "REPLACEMENT" in code or "REDELIVER" in code:
        return "We have arranged a replacement/redelivery for your order at no additional cost."
    if "TRACK" in code:
        return "Your order is currently being tracked. Our team will provide an update within 24 hours."
    if "ESCALATE" in code:
        return "Your complaint has been escalated to our specialist team for review."
    if "REJECT" in code or "DENY" in code:
        return (
            "After a thorough review of your complaint, we regret that we are unable "
            "to process a refund in this instance based on our current policy."
        )
    # Generic fallback
    return (
        f"We have reviewed your complaint and are processing the appropriate resolution "
        f"(ref: {action_code}). Our team will follow up with further details."
    )


def _resolve_queue(
    action_code: str,
    refund_amount: float,
    order_value: float,
    sla_breach: bool,
    recommended_queue: str,
) -> str:
    """
    Assign the HITL review queue based on ticket characteristics.
    Mirrors the Freshdesk group routing intent from the original pipeline design.
    """
    code = action_code.upper()

    # High-value refunds go to senior review
    if refund_amount >= 1000 or (order_value and refund_amount >= order_value * 0.8):
        return "SENIOR_REVIEW"

    # SLA breach cases get priority handling
    if sla_breach:
        return "SLA_BREACH_REVIEW"

    # Escalation-tagged actions
    if "ESCALATE" in code or "L2" in code or "SENIOR" in code:
        return "ESCALATION_QUEUE"

    # Use the recommended queue from customer risk context if provided
    if recommended_queue and recommended_queue not in ("STANDARD_REVIEW", ""):
        return recommended_queue

    return "STANDARD_REVIEW"
