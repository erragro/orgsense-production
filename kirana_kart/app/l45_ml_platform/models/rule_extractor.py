"""
Model A — Rule Field Extractor
================================
Extracts structured rule fields from markdown text segments using:
  Stage 1: TF-IDF + LogisticRegression to predict action_code
  Stage 2: Regex/keyword extraction for thresholds, segments, conditions

Architecture (CPU-only, scikit-learn):
  - Training data: ml_training_samples WHERE model_name = 'rule_extractor'
  - Confidence threshold: 0.75 → below this, LLM fallback is used
  - Auto-retraining: nightly via Celery beat task

Day 1 behaviour: model file doesn't exist → always returns confidence=0 → LLM handles all
Week N:         model trained on LLM outputs → starts handling routine patterns
Month N:        LLM called only for low-confidence (novel) inputs
"""

from __future__ import annotations

import json
import logging
import pickle
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger("kirana_kart.rule_extractor")

MODEL_DIR = Path(__file__).resolve().parents[4] / "models"
MODEL_PATH = MODEL_DIR / "rule_extractor.pkl"
CONFIDENCE_THRESHOLD = 0.75


class RuleExtractor:
    """
    Predicts action_code + extracts rule fields from text.
    Falls back to returning confidence=0 if model not available.
    """

    def __init__(self):
        self._pipeline = None
        self._action_codes: list[str] = []
        self._load()

    def _load(self) -> None:
        """Load model from disk if available."""
        if not MODEL_PATH.exists():
            logger.info("RuleExtractor: no model file found at %s — LLM mode active", MODEL_PATH)
            return
        try:
            with open(MODEL_PATH, "rb") as f:
                data = pickle.load(f)
            self._pipeline = data.get("pipeline")
            self._action_codes = data.get("action_codes", [])
            logger.info("RuleExtractor: loaded model (%d action codes)", len(self._action_codes))
        except Exception as e:
            logger.warning("RuleExtractor load failed: %s", e)

    def predict(self, text: str) -> dict:
        """
        Given a rule text segment, predict action_code and extract fields.

        Returns:
            {
              "confidence": float,          # 0.0–1.0
              "action_code": str | None,    # predicted action code
              "extracted_fields": dict,     # thresholds, segments, etc.
              "model_used": bool,           # False = LLM should handle this
            }
        """
        extracted = self._extract_fields(text)

        if self._pipeline is None:
            return {
                "confidence": 0.0,
                "action_code": None,
                "extracted_fields": extracted,
                "model_used": False,
            }

        try:
            proba = self._pipeline.predict_proba([text])[0]
            max_conf = float(proba.max())
            pred_idx = proba.argmax()
            action_code = self._action_codes[pred_idx] if pred_idx < len(self._action_codes) else None

            return {
                "confidence": round(max_conf, 3),
                "action_code": action_code if max_conf >= CONFIDENCE_THRESHOLD else None,
                "extracted_fields": extracted,
                "model_used": max_conf >= CONFIDENCE_THRESHOLD,
            }
        except Exception as e:
            logger.warning("RuleExtractor.predict failed: %s", e)
            return {
                "confidence": 0.0,
                "action_code": None,
                "extracted_fields": extracted,
                "model_used": False,
            }

    def _extract_fields(self, text: str) -> dict:
        """
        Regex/keyword extraction for numeric thresholds and categorical segments.
        Deterministic — does not depend on trained model.
        """
        fields: dict = {}

        # Order value thresholds
        money_above = re.search(r"(?:above|more than|greater than|≥|>=|min(?:imum)?)[^\d]*(\d[\d,]*)", text, re.I)
        money_below = re.search(r"(?:below|less than|under|≤|<=|max(?:imum)?)[^\d]*(\d[\d,]*)", text, re.I)
        if money_above:
            fields["min_order_value"] = float(money_above.group(1).replace(",", ""))
        if money_below:
            fields["max_order_value"] = float(money_below.group(1).replace(",", ""))

        # Customer segments
        for seg in ["platinum", "gold", "silver", "normal"]:
            if seg in text.lower():
                fields["customer_segment"] = seg.capitalize()
                break

        # Fraud segments
        for fseg in ["very high", "very_high", "high risk", "suspicious"]:
            if fseg.lower() in text.lower():
                fields["fraud_segment"] = fseg.upper().replace(" ", "_")
                break

        # SLA
        if re.search(r"\bsla\b.*breach|breach.*\bsla\b", text, re.I):
            fields["sla_breach_required"] = True

        # Repeat count
        repeat_match = re.search(r"(\d+)\s*(?:or more|times|previous|repeat)", text, re.I)
        if repeat_match:
            fields["min_repeat_count"] = int(repeat_match.group(1))

        return fields

    def train(self, training_samples: list[dict]) -> dict:
        """
        Train/retrain the model on new samples.
        Each sample: {"input_text": str, "action_code": str}

        Returns {"accuracy": float, "sample_count": int, "saved": bool}
        """
        if len(training_samples) < 20:
            return {"accuracy": 0.0, "sample_count": len(training_samples), "saved": False,
                    "reason": "Insufficient training data (< 20 samples)"}

        try:
            from sklearn.pipeline import Pipeline  # type: ignore[import]
            from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore[import]
            from sklearn.linear_model import LogisticRegression  # type: ignore[import]
            from sklearn.model_selection import cross_val_score  # type: ignore[import]
            import numpy as np

            X = [s["input_text"] for s in training_samples]
            y = [s["action_code"] for s in training_samples]
            action_codes = list(dict.fromkeys(y))

            pipeline = Pipeline([
                ("tfidf", TfidfVectorizer(max_features=500, ngram_range=(1, 2))),
                ("clf", LogisticRegression(max_iter=200, C=1.0, class_weight="balanced")),
            ])

            scores = cross_val_score(pipeline, X, y, cv=min(5, len(set(y))), scoring="accuracy")
            accuracy = float(np.mean(scores))

            pipeline.fit(X, y)

            MODEL_DIR.mkdir(exist_ok=True)
            with open(MODEL_PATH, "wb") as f:
                pickle.dump({"pipeline": pipeline, "action_codes": action_codes}, f)

            # Reload
            self._pipeline = pipeline
            self._action_codes = action_codes

            logger.info(
                "RuleExtractor retrained | samples=%d accuracy=%.3f",
                len(training_samples), accuracy,
            )
            return {"accuracy": round(accuracy, 3), "sample_count": len(training_samples), "saved": True}

        except ImportError:
            return {"accuracy": 0.0, "sample_count": 0, "saved": False,
                    "reason": "scikit-learn not installed"}
        except Exception as e:
            logger.exception("RuleExtractor training failed: %s", e)
            return {"accuracy": 0.0, "sample_count": len(training_samples), "saved": False, "reason": str(e)}


_extractor: Optional[RuleExtractor] = None


def get_extractor() -> RuleExtractor:
    global _extractor
    if _extractor is None:
        _extractor = RuleExtractor()
    return _extractor
