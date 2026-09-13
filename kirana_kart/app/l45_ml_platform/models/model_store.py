"""
model_store.py — Model Registry & Health
==========================================
Queries ml_model_registry for accuracy history.
Reports model health for the MLHealthPanel UI.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger("kirana_kart.model_store")


def get_model_health(engine: Engine, kb_id: str = "default") -> list[dict]:
    """
    Return current status for all 3 ML models.
    Used by the MLHealthPanel admin UI.
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT DISTINCT ON (model_name)
                    model_name, version, accuracy, f1_score,
                    training_sample_count, is_active, trained_at
                FROM kirana_kart.ml_model_registry
                WHERE kb_id = :kb_id OR kb_id = 'default'
                ORDER BY model_name, trained_at DESC
            """), {"kb_id": kb_id}).mappings().all()

            # Sample counts per model from training_samples
            sample_rows = conn.execute(text("""
                SELECT model_name, COUNT(*) as cnt
                FROM kirana_kart.ml_training_samples
                WHERE kb_id = :kb_id OR kb_id = 'default'
                GROUP BY model_name
            """), {"kb_id": kb_id}).mappings().all()

        sample_counts = {r["model_name"]: r["cnt"] for r in sample_rows}

        DISPLAY = {
            "rule_extractor": "Rule Extractor",
            "rule_matcher": "Rule Conflict Detector",
            "gate_predictor": "Version Gate Predictor",
        }

        registered = {r["model_name"]: dict(r) for r in rows}

        result = []
        for key, label in DISPLAY.items():
            reg = registered.get(key)
            cnt = sample_counts.get(key, 0)

            if reg and reg["is_active"]:
                result.append({
                    "model_key": key,
                    "display_name": label,
                    "status": "active",
                    "accuracy": reg["accuracy"],
                    "f1_score": reg["f1_score"],
                    "sample_count": reg["training_sample_count"],
                    "trained_at": str(reg["trained_at"]),
                })
            elif cnt > 0:
                from app.l45_ml_platform.models.gate_predictor import MIN_SAMPLES
                needed = MIN_SAMPLES if key == "gate_predictor" else 20
                result.append({
                    "model_key": key,
                    "display_name": label,
                    "status": "learning",
                    "accuracy": None,
                    "sample_count": cnt,
                    "samples_needed": max(0, needed - cnt),
                })
            else:
                result.append({
                    "model_key": key,
                    "display_name": label,
                    "status": "no_data",
                    "accuracy": None,
                    "sample_count": 0,
                })

        return result

    except Exception as e:
        logger.warning("get_model_health failed: %s", e)
        return []


def record_model_version(
    engine: Engine,
    model_name: str,
    kb_id: str,
    accuracy: float,
    f1_score: Optional[float],
    sample_count: int,
    model_path: str,
) -> None:
    """Record a newly trained model version in ml_model_registry."""
    try:
        import uuid
        version = f"v{uuid.uuid4().hex[:8]}"
        with engine.begin() as conn:
            # Deactivate previous versions
            conn.execute(text("""
                UPDATE kirana_kart.ml_model_registry
                SET is_active = FALSE
                WHERE model_name = :name AND kb_id = :kb_id
            """), {"name": model_name, "kb_id": kb_id})

            conn.execute(text("""
                INSERT INTO kirana_kart.ml_model_registry
                    (model_name, kb_id, version, accuracy, f1_score,
                     training_sample_count, model_path, is_active)
                VALUES
                    (:name, :kb_id, :version, :acc, :f1,
                     :cnt, :path, TRUE)
            """), {
                "name": model_name,
                "kb_id": kb_id,
                "version": version,
                "acc": accuracy,
                "f1": f1_score,
                "cnt": sample_count,
                "path": model_path,
            })
    except Exception as e:
        logger.warning("record_model_version failed: %s", e)
