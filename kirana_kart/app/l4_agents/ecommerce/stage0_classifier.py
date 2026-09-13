from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.l4_agents.ecommerce.llm_client import LLMClient
from app.l4_agents.ecommerce.retrieval import RetrievalService

logger = logging.getLogger("stage0_classifier")


def _build_query(ticket_context: dict) -> str:
    subject = ticket_context.get("subject") or ""
    description = ticket_context.get("description") or ""
    return f"{subject}\n{description}".strip()


def run(
    ticket_id: int,
    execution_id: str,
    ticket_context: dict,
    fields: dict,
) -> dict[str, Any]:
    retrieval = RetrievalService()
    llm = LLMClient()

    query = _build_query(ticket_context)
    candidates = retrieval.issue_candidates(query, version="v1", top_k=5)

    system = (
        "You are a support issue classifier. "
        "Return JSON with keys: issue_type_l1, issue_type_l2, image_required, confidence."
    )
    user = {
        "ticket": {
            "subject": ticket_context.get("subject"),
            "description": ticket_context.get("description"),
        },
        "candidates": candidates,
    }

    result = {
        "issue_type_l1": "delivery",
        "issue_type_l2": "not_received",
        "image_required": False,
        "confidence": 0.5,
        "reasoning": "fallback",
        "raw_response": None,
    }

    try:
        response = llm.chat_json(settings.model1, system, str(user))
        result.update({
            "issue_type_l1": response.get("issue_type_l1", result["issue_type_l1"]),
            "issue_type_l2": response.get("issue_type_l2", result["issue_type_l2"]),
            "image_required": bool(response.get("image_required", result["image_required"])),
            "confidence": float(response.get("confidence", result["confidence"])),
            "reasoning": response.get("reasoning", "LLM classification"),
            "raw_response": response,
        })
    except Exception as exc:
        logger.warning("Stage0 LLM failed: %s", exc)
        if candidates:
            top = candidates[0]
            result["issue_type_l1"] = (top.get("label") or "delivery").lower().replace(" ", "_")
            result["issue_type_l2"] = (top.get("issue_code") or "not_received").lower()

    return result
