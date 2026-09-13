"""
training_jobs.py — Nightly ML Retraining
==========================================
Celery beat task (or manual trigger) that:
1. Reads ml_training_samples from DB
2. Retrains Model A (RuleExtractor) if ≥ 20 samples
3. Retrains Model C (GatePredictor) if ≥ 50 gate result samples
4. Promotes new model if accuracy improves
5. Records results in ml_model_registry

Model B (RuleMatcher) uses a pre-trained sentence transformer —
no custom training needed, it runs out of the box.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

logger = logging.getLogger("kirana_kart.training_jobs")


def run_nightly_retraining(engine, kb_id: str = "default") -> dict:
    """
    Run all retraining jobs for a given KB.
    Safe to run repeatedly (idempotent).
    Returns summary of what was trained.
    """
    from sqlalchemy import text

    results = {"kb_id": kb_id, "timestamp": datetime.utcnow().isoformat(), "models": {}}

    logger.info("Starting nightly retraining for kb_id=%s", kb_id)

    # ---- Model A: Rule Extractor ----
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT input_data, corrected_output, correction_type
                FROM kirana_kart.ml_training_samples
                WHERE model_name = 'rule_extractor'
                  AND (kb_id = :kb_id OR kb_id = 'default')
                  AND corrected_output IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 5000
            """), {"kb_id": kb_id}).mappings().all()

        samples = []
        for row in rows:
            inp = row["input_data"]
            if isinstance(inp, str):
                inp = json.loads(inp)
            out = row["corrected_output"]
            if isinstance(out, str):
                out = json.loads(out)
            text_val = inp.get("text") or inp.get("policy_version") or str(inp)
            action_code = out.get("action_code_id") or out.get("action_id") or ""
            if text_val and action_code:
                samples.append({"input_text": str(text_val), "action_code": str(action_code)})

        if samples:
            from app.l45_ml_platform.models.rule_extractor import get_extractor
            extractor = get_extractor()
            res = extractor.train(samples)
            results["models"]["rule_extractor"] = res

            if res.get("saved"):
                from app.l45_ml_platform.models.model_store import record_model_version
                record_model_version(
                    engine, "rule_extractor", kb_id,
                    accuracy=res["accuracy"], f1_score=None,
                    sample_count=res["sample_count"],
                    model_path=str(extractor.__class__.__module__),
                )
        else:
            results["models"]["rule_extractor"] = {"skipped": True, "reason": "No training samples"}

    except Exception as e:
        logger.exception("Model A retraining failed")
        results["models"]["rule_extractor"] = {"error": str(e)}

    # ---- Model C: Gate Predictor ----
    try:
        with engine.connect() as conn:
            gate_rows = conn.execute(text("""
                SELECT
                    gr.metrics,
                    gr.gate_type,
                    gr.passed,
                    pi.metadata
                FROM kirana_kart.bpm_gate_results gr
                JOIN kirana_kart.bpm_process_instances pi ON pi.id = gr.instance_id
                WHERE pi.kb_id = :kb_id
                ORDER BY gr.ran_at DESC
                LIMIT 5000
            """), {"kb_id": kb_id}).mappings().all()

        gate_samples = []
        for row in gate_rows:
            metrics = row["metrics"]
            if isinstance(metrics, str):
                metrics = json.loads(metrics)
            meta = row["metadata"]
            if isinstance(meta, str):
                meta = json.loads(meta)

            features = {
                "rule_count": metrics.get("rule_count", 0),
                "rule_count_delta": meta.get("rule_count_delta", 0),
                "action_distribution": metrics.get("action_distribution", {}),
                "avg_conditions_depth": metrics.get("avg_conditions_depth", 0),
                "user_edit_count": meta.get("user_edit_count", 0),
                "duplicate_rule_count": meta.get("duplicate_count", 0),
                "conflict_count": meta.get("conflict_count", 0),
            }
            gate_samples.append({
                "features": features,
                "simulation_passed": row["passed"] if row["gate_type"] == "simulation" else True,
                "shadow_diverged": not row["passed"] if row["gate_type"] == "shadow" else False,
            })

        if gate_samples:
            from app.l45_ml_platform.models.gate_predictor import get_predictor
            predictor = get_predictor()
            res = predictor.train(gate_samples)
            results["models"]["gate_predictor"] = res

            if res.get("trained"):
                from app.l45_ml_platform.models.model_store import record_model_version
                sim_acc = res.get("simulation_passed", {}).get("accuracy", 0)
                record_model_version(
                    engine, "gate_predictor", kb_id,
                    accuracy=sim_acc, f1_score=None,
                    sample_count=len(gate_samples),
                    model_path="gate_predictor.pkl",
                )
        else:
            results["models"]["gate_predictor"] = {"skipped": True, "reason": "No gate results yet"}

    except Exception as e:
        logger.exception("Model C retraining failed")
        results["models"]["gate_predictor"] = {"error": str(e)}

    logger.info("Nightly retraining complete: %s", results)
    return results
