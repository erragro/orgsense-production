"""
Model C — BPM Gate Predictor
================================
Predicts BPM gate outcomes (simulation pass/fail, shadow divergence) before running
expensive operations, giving users early warning.

Architecture (CPU-only, scikit-learn RandomForestClassifier):
  Features:
    - rule_count: total rules in version
    - rule_count_delta: change vs active version
    - action_code_entropy: distribution entropy of action codes
    - conditions_complexity: average depth of conditions JSONB
    - user_edit_count: edits made during RULE_EDIT stage
    - duplicate_rule_count: from Model B
    - priority_conflict_count: conflicting rules (same conditions, different action)

  Targets:
    - simulation_pass (binary)
    - shadow_divergence_high (binary)

Day 1: < 50 samples → model returns None (no prediction shown)
After 50+ BPM gate runs: model starts predicting
"""

from __future__ import annotations

import logging
import pickle
from pathlib import Path
from typing import Optional

logger = logging.getLogger("kirana_kart.gate_predictor")

MODEL_DIR = Path(__file__).resolve().parents[4] / "models"
SIMULATION_MODEL_PATH = MODEL_DIR / "gate_predictor_simulation.pkl"
SHADOW_MODEL_PATH = MODEL_DIR / "gate_predictor_shadow.pkl"

MIN_SAMPLES = 50   # minimum training samples before predictions are shown


class GatePredictor:
    """Predicts BPM gate outcomes from version feature vectors."""

    def __init__(self):
        self._sim_model = None
        self._shadow_model = None
        self._load()

    def _load(self) -> None:
        for path, attr in [
            (SIMULATION_MODEL_PATH, "_sim_model"),
            (SHADOW_MODEL_PATH, "_shadow_model"),
        ]:
            if path.exists():
                try:
                    with open(path, "rb") as f:
                        setattr(self, attr, pickle.load(f))
                    logger.info("GatePredictor: loaded %s", path.name)
                except Exception as e:
                    logger.warning("GatePredictor load failed for %s: %s", path.name, e)

    def predict(self, features: dict) -> dict:
        """
        Predict gate outcomes for a policy version.

        Args:
            features: dict with keys matching the feature set above

        Returns:
            {
              "simulation_pass_probability": float | None,
              "shadow_divergence_risk": float | None,
              "prediction_available": bool,
              "feature_importances": dict | None,
            }
        """
        if self._sim_model is None and self._shadow_model is None:
            return {
                "simulation_pass_probability": None,
                "shadow_divergence_risk": None,
                "prediction_available": False,
                "reason": "Collecting data — predictions will be available after 50+ version reviews",
            }

        try:
            X = self._features_to_vector(features)
            result: dict = {"prediction_available": True}

            if self._sim_model is not None:
                sim_proba = self._sim_model.predict_proba([X])[0]
                # Class 1 = pass
                result["simulation_pass_probability"] = round(float(sim_proba[1]), 3)
            else:
                result["simulation_pass_probability"] = None

            if self._shadow_model is not None:
                shadow_proba = self._shadow_model.predict_proba([X])[0]
                # Class 1 = divergence high
                result["shadow_divergence_risk"] = round(float(shadow_proba[1]), 3)
            else:
                result["shadow_divergence_risk"] = None

            # Feature importances (for interpretability panel)
            if hasattr(self._sim_model, "feature_importances_"):
                names = self._feature_names()
                imps = self._sim_model.feature_importances_
                result["feature_importances"] = {
                    names[i]: round(float(imps[i]), 3)
                    for i in range(min(len(names), len(imps)))
                }

            return result

        except Exception as e:
            logger.warning("GatePredictor.predict failed: %s", e)
            return {
                "simulation_pass_probability": None,
                "shadow_divergence_risk": None,
                "prediction_available": False,
                "reason": str(e),
            }

    @staticmethod
    def _feature_names() -> list[str]:
        return [
            "rule_count", "rule_count_delta", "action_entropy",
            "avg_conditions_depth", "user_edit_count",
            "duplicate_rule_count", "conflict_count",
        ]

    def _features_to_vector(self, f: dict) -> list[float]:
        import math

        def entropy(counts: list[int]) -> float:
            total = sum(counts)
            if total == 0:
                return 0.0
            return -sum((c / total) * math.log2(c / total + 1e-10) for c in counts if c > 0)

        action_counts = list(f.get("action_distribution", {}).values())
        return [
            float(f.get("rule_count", 0)),
            float(f.get("rule_count_delta", 0)),
            entropy(action_counts),
            float(f.get("avg_conditions_depth", 0)),
            float(f.get("user_edit_count", 0)),
            float(f.get("duplicate_rule_count", 0)),
            float(f.get("conflict_count", 0)),
        ]

    def train(self, gate_results: list[dict]) -> dict:
        """
        Train on historical BPM gate results.
        Each record: {features: dict, simulation_passed: bool, shadow_diverged: bool}
        """
        if len(gate_results) < MIN_SAMPLES:
            return {
                "trained": False,
                "reason": f"Need {MIN_SAMPLES} samples, have {len(gate_results)}",
                "sample_count": len(gate_results),
            }

        try:
            from sklearn.ensemble import RandomForestClassifier  # type: ignore[import]
            from sklearn.model_selection import cross_val_score  # type: ignore[import]
            import numpy as np

            X = [self._features_to_vector(r["features"]) for r in gate_results]

            results = {}
            for target, path, attr in [
                ("simulation_passed", SIMULATION_MODEL_PATH, "_sim_model"),
                ("shadow_diverged", SHADOW_MODEL_PATH, "_shadow_model"),
            ]:
                if not all(target in r for r in gate_results):
                    continue

                y = [int(r[target]) for r in gate_results]
                if len(set(y)) < 2:
                    continue   # all same class — nothing to learn yet

                clf = RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42)
                scores = cross_val_score(clf, X, y, cv=min(5, len(y)), scoring="accuracy")
                accuracy = float(np.mean(scores))

                clf.fit(X, y)
                MODEL_DIR.mkdir(exist_ok=True)
                with open(path, "wb") as f:
                    pickle.dump(clf, f)
                setattr(self, attr, clf)

                results[target] = {"accuracy": round(accuracy, 3)}
                logger.info("GatePredictor %s retrained | accuracy=%.3f samples=%d",
                            target, accuracy, len(gate_results))

            return {"trained": True, "sample_count": len(gate_results), **results}

        except ImportError:
            return {"trained": False, "reason": "scikit-learn not installed"}
        except Exception as e:
            logger.exception("GatePredictor training failed")
            return {"trained": False, "reason": str(e)}


_predictor: Optional[GatePredictor] = None


def get_predictor() -> GatePredictor:
    global _predictor
    if _predictor is None:
        _predictor = GatePredictor()
    return _predictor
