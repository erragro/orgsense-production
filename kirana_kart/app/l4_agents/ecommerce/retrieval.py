from __future__ import annotations

from typing import Any

from app.l45_ml_platform.vectorization.embedding_service import EmbeddingService
from app.l45_ml_platform.vectorization.weaviate_client import (
    WeaviateClient,
    ISSUE_CLASS_NAME,
    ACTION_CLASS_NAME,
)


class RetrievalService:
    def __init__(self):
        self.embedder = EmbeddingService()
        self.weaviate = WeaviateClient()

    def issue_candidates(self, query: str, version: str = "v1", top_k: int = 5) -> list[dict[str, Any]]:
        vector = self.embedder.create_embedding(query)
        return self.weaviate.query_similar(
            ISSUE_CLASS_NAME,
            vector,
            filters={
                "path": ["corpus_version"],
                "operator": "Equal",
                "valueText": version,
            },
            top_k=top_k,
            fields=["issue_code", "label", "description", "level", "semantic_text"],
        )

    def action_candidates(self, query: str, version: str = "v1", top_k: int = 5) -> list[dict[str, Any]]:
        vector = self.embedder.create_embedding(query)
        return self.weaviate.query_similar(
            ACTION_CLASS_NAME,
            vector,
            filters={
                "path": ["corpus_version"],
                "operator": "Equal",
                "valueText": version,
            },
            top_k=top_k,
            fields=[
                "action_code_id",
                "action_key",
                "action_name",
                "action_description",
                "requires_refund",
                "requires_escalation",
                "automation_eligible",
                "semantic_text",
            ],
        )

    def policy_rule_candidates(self, query: str, policy_version: str, top_k: int = 5) -> list[dict[str, Any]]:
        vector = self.embedder.create_embedding(query)
        return self.weaviate.query_similar_rules(vector, policy_version=policy_version, top_k=top_k)
