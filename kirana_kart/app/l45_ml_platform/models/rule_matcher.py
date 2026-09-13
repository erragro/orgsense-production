"""
Model B — Semantic Rule Matcher
================================
Uses all-MiniLM-L6-v2 (80MB, CPU-fast, 384-dim) to:
  1. Detect duplicate rules (cosine > 0.92)
  2. Detect conflicting rules (same conditions, different action, cosine > 0.80)
  3. Suggest similar existing rules (top-3 for the rule suggestion UI)

Architecture:
  - Input: rule text = "{issue_type_l1} {issue_type_l2} {action_name} {conditions_summary}"
  - Embeddings: all-MiniLM-L6-v2 via sentence-transformers (downloaded on first use)
  - Index: in-memory numpy matrix rebuilt per version (< 50 rules typical → fast)
  - Inference: < 5ms per rule on CPU

Usage:
  matcher = RuleMatcher()
  results = matcher.check_rule(new_rule_text, existing_rules)
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger("kirana_kart.rule_matcher")

_MODEL_NAME = "all-MiniLM-L6-v2"


class RuleMatcher:
    """Semantic similarity checker for policy rules."""

    DUPLICATE_THRESHOLD = 0.92   # cosine score above which rules are considered duplicates
    CONFLICT_THRESHOLD = 0.80    # cosine score for same-conditions / different-action pairs

    def __init__(self):
        self._model = None   # lazy-loaded on first use
        self._ready = False

    def _load(self) -> bool:
        """Lazy-load the sentence transformer model. Returns True if successful."""
        if self._ready:
            return True
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore[import]
            self._model = SentenceTransformer(_MODEL_NAME)
            self._ready = True
            logger.info("RuleMatcher: loaded %s", _MODEL_NAME)
        except ImportError:
            logger.warning("sentence-transformers not installed — RuleMatcher disabled")
        except Exception as e:
            logger.warning("RuleMatcher load failed: %s", e)
        return self._ready

    @staticmethod
    def rule_to_text(rule: dict) -> str:
        """Convert a rule dict to a searchable text representation."""
        parts = [
            rule.get("issue_type_l1", ""),
            rule.get("issue_type_l2", "") or "",
            rule.get("action_name", "") or rule.get("action_code_id", ""),
            rule.get("customer_segment", "") or "",
            rule.get("fraud_segment", "") or "",
        ]
        conds = rule.get("conditions", {})
        if isinstance(conds, dict):
            parts.extend(str(v) for v in conds.values())
        return " ".join(p for p in parts if p).strip()

    def check_rule(
        self,
        candidate: dict,
        existing_rules: list[dict],
    ) -> dict:
        """
        Check a candidate rule against existing rules.

        Returns:
            {
              "duplicate_flag": bool,
              "duplicate_rule_ids": list[str],
              "conflict_candidates": list[str],
              "similar_rules": list[dict],  # top-3 by similarity
              "model_available": bool,
            }
        """
        if not existing_rules:
            return self._empty_result()

        if not self._load():
            return self._empty_result(model_available=False)

        try:
            import numpy as np

            candidate_text = self.rule_to_text(candidate)
            existing_texts = [self.rule_to_text(r) for r in existing_rules]

            # Embed all rules
            all_texts = [candidate_text] + existing_texts
            embeddings = self._model.encode(all_texts, batch_size=32, show_progress_bar=False)

            cand_emb = embeddings[0]
            existing_embs = embeddings[1:]

            # Cosine similarities
            cand_norm = cand_emb / (np.linalg.norm(cand_emb) + 1e-10)
            norms = np.linalg.norm(existing_embs, axis=1, keepdims=True) + 1e-10
            existing_normed = existing_embs / norms
            sims = existing_normed @ cand_norm

            candidate_action = candidate.get("action_name", "") or candidate.get("action_code_id", "")

            duplicates = []
            conflicts = []
            similar = []

            for i, sim in enumerate(sims):
                sim_val = float(sim)
                rule = existing_rules[i]
                rule_id = rule.get("rule_id", str(i))
                existing_action = rule.get("action_name", "") or rule.get("action_code_id", "")

                if sim_val >= self.DUPLICATE_THRESHOLD:
                    duplicates.append({"rule_id": rule_id, "score": round(sim_val, 3)})
                elif sim_val >= self.CONFLICT_THRESHOLD and existing_action != candidate_action:
                    conflicts.append({"rule_id": rule_id, "score": round(sim_val, 3)})

                similar.append({"rule_id": rule_id, "score": round(sim_val, 3), "action": existing_action})

            # Sort similar by score, top-3
            similar.sort(key=lambda x: x["score"], reverse=True)
            top3 = [s for s in similar if s["rule_id"] not in [d["rule_id"] for d in duplicates]][:3]

            return {
                "duplicate_flag": len(duplicates) > 0,
                "duplicate_rule_ids": [d["rule_id"] for d in duplicates],
                "duplicate_scores": duplicates,
                "conflict_candidates": [c["rule_id"] for c in conflicts],
                "conflict_scores": conflicts,
                "similar_rules": top3,
                "model_available": True,
            }

        except Exception as e:
            logger.warning("RuleMatcher.check_rule failed: %s", e)
            return self._empty_result()

    def batch_check(self, rules: list[dict]) -> list[dict]:
        """
        Check all rules in a version against each other.
        Returns list of {rule_id, issue, other_rule_id, score} findings.
        """
        if len(rules) < 2 or not self._load():
            return []

        try:
            import numpy as np

            texts = [self.rule_to_text(r) for r in rules]
            embeddings = self._model.encode(texts, batch_size=32, show_progress_bar=False)

            norms = np.linalg.norm(embeddings, axis=1, keepdims=True) + 1e-10
            normed = embeddings / norms
            sim_matrix = normed @ normed.T

            findings = []
            n = len(rules)
            for i in range(n):
                for j in range(i + 1, n):
                    sim = float(sim_matrix[i, j])
                    r_i = rules[i].get("rule_id", str(i))
                    r_j = rules[j].get("rule_id", str(j))
                    action_i = rules[i].get("action_name", "")
                    action_j = rules[j].get("action_name", "")

                    if sim >= self.DUPLICATE_THRESHOLD:
                        findings.append({
                            "rule_id": r_i,
                            "other_rule_id": r_j,
                            "issue": "duplicate",
                            "score": round(sim, 3),
                            "message": f"Rules {r_i} and {r_j} appear to be duplicates (similarity {sim:.0%})",
                        })
                    elif sim >= self.CONFLICT_THRESHOLD and action_i != action_j:
                        findings.append({
                            "rule_id": r_i,
                            "other_rule_id": r_j,
                            "issue": "conflict",
                            "score": round(sim, 3),
                            "message": f"Rules {r_i} and {r_j} may conflict: same conditions, different actions (similarity {sim:.0%})",
                        })
            return findings

        except Exception as e:
            logger.warning("RuleMatcher.batch_check failed: %s", e)
            return []

    @staticmethod
    def _empty_result(model_available: bool = True) -> dict:
        return {
            "duplicate_flag": False,
            "duplicate_rule_ids": [],
            "duplicate_scores": [],
            "conflict_candidates": [],
            "conflict_scores": [],
            "similar_rules": [],
            "model_available": model_available,
        }


# Singleton — shared across request handlers (model loaded once)
_matcher: Optional[RuleMatcher] = None


def get_matcher() -> RuleMatcher:
    global _matcher
    if _matcher is None:
        _matcher = RuleMatcher()
    return _matcher
