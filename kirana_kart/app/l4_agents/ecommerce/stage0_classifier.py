from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.l4_agents import policy_knowledge
from app.l4_agents.ecommerce.llm_client import LLMClient
from app.l4_agents.ecommerce.retrieval import RetrievalService

logger = logging.getLogger("stage0_classifier")


def _build_query(ticket_context: dict) -> str:
    subject = ticket_context.get("subject") or ""
    description = ticket_context.get("description") or ""
    return f"{subject}\n{description}".strip()


def _knowledge(fields: dict) -> policy_knowledge.RuntimeKnowledge:
    return policy_knowledge.load_runtime(
        fields.get("active_policy") or "", fields.get("business_line") or "",
    )


def run(
    ticket_id: int,
    execution_id: str,
    ticket_context: dict,
    fields: dict,
) -> dict[str, Any]:
    """
    Classify the ticket into the live policy's issue taxonomy.

    With a taxonomy, the model chooses from its codes and the answer is
    checked against it: an answer outside it becomes UNCLASSIFIED (and
    Stage 2 sends the ticket to a person) instead of an invented label no
    rule can match. Without one (no live policy, or it cannot be read) the
    earlier open classification runs, reported as taxonomy_status
    'unavailable'.
    """
    llm = LLMClient()
    taxonomy = _knowledge(fields).taxonomy

    candidates: list[dict] = []
    if not taxonomy:
        candidates = RetrievalService().issue_candidates(_build_query(ticket_context), version="v1", top_k=5)

    if taxonomy:
        system = (
            "You are a support issue classifier. Classify the ticket into exactly one issue "
            "from the taxonomy provided. Return JSON with keys: issue_code (copied exactly from "
            "the taxonomy, the most specific issue that fits, or \"UNCLASSIFIED\" if none fits), "
            "image_required, confidence, reasoning."
        )
        user = {
            "ticket": {"subject": ticket_context.get("subject"),
                       "description": ticket_context.get("description")},
            "taxonomy": taxonomy.prompt_view(),
        }
    else:
        system = (
            "You are a support issue classifier. "
            "Return JSON with keys: issue_type_l1, issue_type_l2, image_required, confidence."
        )
        user = {
            "ticket": {"subject": ticket_context.get("subject"),
                       "description": ticket_context.get("description")},
            "candidates": candidates,
        }

    result: dict[str, Any] = {
        "issue_type_l1": "delivery",
        "issue_type_l2": "not_received",
        "image_required": False,
        "confidence": 0.5,
        "reasoning": "fallback",
        "raw_response": None,
        "taxonomy_status": "unavailable",
    }

    response: dict | None = None
    try:
        response = llm.chat_json(settings.model1, system, str(user))
    except Exception as exc:
        logger.warning("Stage0 LLM failed: %s", exc)

    if taxonomy:
        resp = response or {}
        code = resp.get("issue_code")
        resolved = policy_knowledge.resolve_issue(
            taxonomy, resp.get("issue_type_l1"), code or resp.get("issue_type_l2"),
        )
        result.update(resolved)
        result["confidence"] = 0.0 if response is None else _confidence(response, 0.5)
        if resolved["taxonomy_status"] == "unmapped":
            result["confidence"] = min(result["confidence"], 0.3)
        result.update({
            "image_required": bool(resp.get("image_required", False)),
            "reasoning": resp.get("reasoning", "LLM classification") if response else "fallback",
            "raw_response": response,
            "model_issue": code or resp.get("issue_type_l2") or resp.get("issue_type_l1"),
        })
        return result

    if response is not None:
        result.update({
            "issue_type_l1": response.get("issue_type_l1", result["issue_type_l1"]),
            "issue_type_l2": response.get("issue_type_l2", result["issue_type_l2"]),
            "image_required": bool(response.get("image_required", result["image_required"])),
            "confidence": _confidence(response, result["confidence"]),
            "reasoning": response.get("reasoning", "LLM classification"),
            "raw_response": response,
        })
    elif candidates:
        top = candidates[0]
        result["issue_type_l1"] = (top.get("label") or "delivery").lower().replace(" ", "_")
        result["issue_type_l2"] = (top.get("issue_code") or "not_received").lower()

    return result


def _confidence(response: dict, fallback: float) -> float:
    try:
        return max(0.0, min(1.0, float(response.get("confidence", fallback))))
    except (TypeError, ValueError):
        return fallback
