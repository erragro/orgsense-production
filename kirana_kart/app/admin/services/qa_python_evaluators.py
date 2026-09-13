"""
app/admin/services/qa_python_evaluators.py
==========================================
Deterministic Python-based QA evaluators (no LLM, no external API call).

12 checks aligned to industry standards:
  COPC 6.0, ISO 15838, Six Sigma, ITIL, AML/Fraud, AHT, FinOps, Governance

Public API:
    run_python_evaluations(context: dict) -> dict
    Returns {checks: list[dict], python_score: float, python_grade: str}
"""

from __future__ import annotations

import logging

from sqlalchemy import text

from app.admin.db import get_db_session

logger = logging.getLogger("kirana_kart.qa_python_evaluators")


# ============================================================
# INTERNAL HELPERS
# ============================================================

def _f(v, default: float = 0.0) -> float:
    return float(v) if v is not None else default


def _i(v, default: int = 0) -> int:
    return int(v) if v is not None else default


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _linear(value: float, low: float, high: float) -> float:
    """Map value linearly from [low, high] → [0.0, 1.0]. Clamps at boundaries."""
    if value >= high:
        return 1.0
    if value <= low:
        return 0.0
    return (value - low) / (high - low)


def _grade(score: float) -> str:
    if score >= 0.95:
        return "A+"
    if score >= 0.90:
        return "A"
    if score >= 0.80:
        return "B+"
    if score >= 0.70:
        return "B"
    if score >= 0.60:
        return "C"
    return "F"


def _check(
    name: str,
    category: str,
    standard_ref: str,
    weight: float,
    score: float,
    value_observed: str,
    threshold: str,
    finding: str,
) -> dict:
    score = _clamp(round(score, 4))
    return {
        "name": name,
        "category": category,
        "standard_ref": standard_ref,
        "score": score,
        "weight": weight,
        "pass": score >= 0.70,
        "value_observed": value_observed,
        "threshold": threshold,
        "finding": finding,
        "method": "python_deterministic",
    }


def _fetch_active_policy_version() -> str | None:
    try:
        with get_db_session() as s:
            row = s.execute(
                text("SELECT active_version FROM kirana_kart.kb_runtime_config LIMIT 1")
            ).first()
            return row[0] if row else None
    except Exception as exc:
        logger.warning("Could not fetch active_version: %s", exc)
        return None


# ============================================================
# 12 INDIVIDUAL EVALUATORS
# ============================================================

def _check_confidence_threshold(ctx: dict) -> dict:
    """COPC 6.0 — overall_confidence must be ≥ 0.85 for full score; < 0.70 is fail."""
    conf = _f(ctx.get("overall_confidence"))
    if conf >= 0.85:
        score = 1.0
    elif conf >= 0.70:
        score = _linear(conf, 0.70, 0.85)
    else:
        score = 0.0
    return _check(
        name="Confidence Threshold",
        category="Accuracy",
        standard_ref="COPC 6.0",
        weight=0.12,
        score=score,
        value_observed=f"{conf:.4f}",
        threshold="≥0.85 (full), ≥0.70 (partial), <0.70 (fail)",
        finding=(
            f"Overall confidence is {conf:.4f}. "
            + ("Meets or exceeds COPC 6.0 automation threshold of 0.85."
               if conf >= 0.85
               else "Below COPC 6.0 automation threshold of 0.85; partial or no credit applied.")
        ),
    )


def _check_vector_similarity(ctx: dict) -> dict:
    """IR-Standard — vector_similarity_score ≥ 0.80 ideal; < 0.60 is fail."""
    vscore = _f(ctx.get("vector_similarity_score"))
    if vscore >= 0.80:
        score = 1.0
    elif vscore >= 0.60:
        score = _linear(vscore, 0.60, 0.80)
    else:
        score = 0.0
    return _check(
        name="Vector Similarity Score",
        category="Accuracy",
        standard_ref="IR-Standard",
        weight=0.06,
        score=score,
        value_observed=f"{vscore:.4f}",
        threshold="≥0.80 (full), ≥0.60 (partial), <0.60 (fail)",
        finding=(
            f"Vector similarity score is {vscore:.4f}. "
            + ("High semantic alignment with KB artifacts."
               if vscore >= 0.80
               else f"Semantic alignment {'moderate' if vscore >= 0.60 else 'poor'} — may indicate misclassification risk.")
        ),
    )


def _check_classification_consistency(ctx: dict) -> dict:
    """QA-Standard — issue type L1/L2 must be consistent between Stage 0 and Stage 1."""
    l1_s0 = (ctx.get("issue_type_l1") or "").strip().lower()
    l2_s0 = (ctx.get("issue_type_l2") or "").strip().lower()
    l1_s1 = (ctx.get("issue_type_l1_verified") or "").strip().lower()
    l2_s1 = (ctx.get("issue_type_l2_verified") or "").strip().lower()

    l1_match = l1_s0 and l1_s1 and l1_s0 == l1_s1
    l2_match = l2_s0 and l2_s1 and l2_s0 == l2_s1

    if l1_match and l2_match:
        score = 1.0
        finding = (
            f"L1 '{ctx.get('issue_type_l1')}' and L2 '{ctx.get('issue_type_l2')}' "
            "are consistent across Stage 0 and Stage 1."
        )
    elif l1_match:
        score = 0.5
        finding = (
            f"L1 '{ctx.get('issue_type_l1')}' matches but L2 diverged: "
            f"Stage 0='{ctx.get('issue_type_l2')}', Stage 1='{ctx.get('issue_type_l2_verified')}'. "
            "Partial consistency."
        )
    else:
        score = 0.0
        finding = (
            f"Both L1 and L2 differ between stages. "
            f"Stage 0: {ctx.get('issue_type_l1')}/{ctx.get('issue_type_l2')} → "
            f"Stage 1: {ctx.get('issue_type_l1_verified')}/{ctx.get('issue_type_l2_verified')}. "
            "Classification drift detected."
        )

    return _check(
        name="Classification Consistency",
        category="Quality",
        standard_ref="QA-Standard",
        weight=0.10,
        score=score,
        value_observed=(
            f"S0: {ctx.get('issue_type_l1')}/{ctx.get('issue_type_l2')} | "
            f"S1: {ctx.get('issue_type_l1_verified')}/{ctx.get('issue_type_l2_verified')}"
        ),
        threshold="L1 + L2 match Stage 0 ↔ Stage 1",
        finding=finding,
    )


def _check_gratification_cap(ctx: dict) -> dict:
    """Regulatory — calculated_gratification must not exceed capped_gratification."""
    calc = _f(ctx.get("calculated_gratification"))
    cap = _f(ctx.get("capped_gratification"))

    # If both are zero, no gratification scenario — treat as compliant
    if calc == 0.0 and cap == 0.0:
        score = 1.0
        finding = "No gratification applied; cap compliance is trivially satisfied."
    elif calc <= cap:
        score = 1.0
        finding = (
            f"Calculated gratification {calc:.2f} ≤ cap {cap:.2f}. "
            "Financial cap compliance confirmed."
        )
    else:
        score = 0.0
        finding = (
            f"VIOLATION: Calculated gratification {calc:.2f} exceeds cap {cap:.2f} "
            f"by {calc - cap:.2f}. Hard regulatory breach — no partial credit."
        )

    return _check(
        name="Gratification Cap Compliance",
        category="Financial",
        standard_ref="Regulatory",
        weight=0.12,
        score=score,
        value_observed=f"calc={calc:.2f}, cap={cap:.2f}",
        threshold="calculated ≤ capped (hard rule, no partial credit)",
        finding=finding,
    )


def _check_multiplier_bounds(ctx: dict) -> dict:
    """Risk Management — multiplier must be within normal operating bounds 0.5–3.0."""
    mul = _f(ctx.get("multiplier"), 1.0)

    if 0.5 <= mul <= 3.0:
        score = 1.0
        finding = f"Multiplier {mul:.2f} within normal bounds (0.5–3.0)."
    elif 3.0 < mul <= 5.0:
        score = 0.5
        finding = (
            f"Multiplier {mul:.2f} is elevated (3.0–5.0 range). "
            "Warrants review but not a hard violation."
        )
    else:
        score = 0.0
        finding = (
            f"Multiplier {mul:.2f} is {'critically high (>5.0)' if mul > 5.0 else 'critically low (<0.5)'}. "
            "Outside acceptable risk bounds."
        )

    return _check(
        name="Multiplier Bounds Check",
        category="Financial",
        standard_ref="Risk Mgmt",
        weight=0.06,
        score=score,
        value_observed=f"{mul:.2f}",
        threshold="0.5 ≤ multiplier ≤ 3.0 (full); 3.0–5.0 (partial); outside (fail)",
        finding=finding,
    )


def _check_policy_version_currency(ctx: dict, active_version: str | None) -> dict:
    """Governance — policy_version used must match the currently active KB version."""
    used_version = ctx.get("policy_version") or None

    if not used_version:
        score = 0.0
        finding = "Policy version is null/unknown. Cannot verify KB currency."
        observed = "null"
    elif not active_version:
        # Can't determine active version — give benefit of doubt
        score = 0.8
        finding = (
            f"Policy version '{used_version}' was used, but active version could not be "
            "determined from kb_runtime_config. Partial credit awarded."
        )
        observed = used_version
    elif used_version == active_version:
        score = 1.0
        finding = (
            f"Policy version '{used_version}' matches active version '{active_version}'. "
            "KB is current."
        )
        observed = used_version
    else:
        score = 0.0
        finding = (
            f"Policy version mismatch: used '{used_version}', active is '{active_version}'. "
            "Decision was made against a stale KB version."
        )
        observed = used_version

    return _check(
        name="Policy Version Currency",
        category="Compliance",
        standard_ref="Governance",
        weight=0.06,
        score=score,
        value_observed=observed,
        threshold=f"Must match active version: {active_version or 'unknown'}",
        finding=finding,
    )


def _check_pipeline_stage_health(ctx: dict) -> dict:
    """ITIL — all 4 pipeline stages must be 'completed'."""
    stages = {
        "S0": ctx.get("stage_0_status") or "",
        "S1": ctx.get("stage_1_status") or "",
        "S2": ctx.get("stage_2_status") or "",
        "S3": ctx.get("stage_3_status") or "",
    }
    completed = [k for k, v in stages.items() if v.lower() == "completed"]
    not_completed = {k: v for k, v in stages.items() if v.lower() != "completed"}

    score = len(completed) / 4.0
    if not_completed:
        details = ", ".join(f"{k}={v}" for k, v in not_completed.items())
        finding = (
            f"{len(completed)}/4 stages completed. "
            f"Non-completed: {details}. "
            "Each failed/pending stage deducts 0.25 from score."
        )
    else:
        finding = "All 4 pipeline stages (S0→S3) completed successfully."

    return _check(
        name="Pipeline Stage Health",
        category="Operational",
        standard_ref="ITIL",
        weight=0.10,
        score=score,
        value_observed=f"{len(completed)}/4 completed ({', '.join(f'{k}={v}' for k,v in stages.items())})",
        threshold="All 4 stages = 'completed'",
        finding=finding,
    )


def _check_processing_time_sla(ctx: dict) -> dict:
    """AHT — total processing duration should be < 30,000ms; > 120,000ms is fail."""
    duration = _i(ctx.get("duration_ms"))

    if duration < 30_000:
        score = 1.0
        finding = (
            f"Processing time {duration}ms is within the 30s AHT target. "
            "Excellent automation throughput."
        )
    elif duration <= 120_000:
        score = _linear(duration, 30_000, 120_000)
        score = 1.0 - score  # invert: lower is better
        finding = (
            f"Processing time {duration}ms exceeds 30s AHT target "
            f"but within 120s ceiling. Score: {_clamp(1.0 - _linear(duration, 30_000, 120_000)):.2f}."
        )
    else:
        score = 0.0
        finding = (
            f"Processing time {duration}ms exceeds the 120s SLA ceiling. "
            "Significant operational delay."
        )

    return _check(
        name="Processing Time SLA",
        category="Operational",
        standard_ref="AHT ≤30s",
        weight=0.06,
        score=score,
        value_observed=f"{duration}ms",
        threshold="<30,000ms (full); 30,000–120,000ms (partial); >120,000ms (fail)",
        finding=finding,
    )


def _check_discrepancy_rate(ctx: dict) -> dict:
    """Six Sigma — discrepancy_count: 0=ideal, 1=warn, 2=poor, ≥3=fail."""
    count = _i(ctx.get("discrepancy_count"))

    if count == 0:
        score = 1.0
        finding = "Zero discrepancies detected across validation stage. Six Sigma ideal."
    elif count == 1:
        score = 0.7
        finding = (
            f"1 discrepancy detected. Marginal deviation from Six Sigma standard. "
            f"Details: {ctx.get('discrepancy_details') or 'None provided'}."
        )
    elif count == 2:
        score = 0.4
        finding = (
            f"2 discrepancies detected. Significant quality gap. "
            f"Details: {ctx.get('discrepancy_details') or 'None provided'}."
        )
    else:
        score = 0.0
        finding = (
            f"{count} discrepancies detected — exceeds Six Sigma tolerance. "
            f"Details: {ctx.get('discrepancy_details') or 'None provided'}."
        )

    return _check(
        name="Discrepancy Rate",
        category="Quality",
        standard_ref="Six Sigma",
        weight=0.10,
        score=score,
        value_observed=f"{count} discrepancies",
        threshold="0 (full=1.0), 1 (0.7), 2 (0.4), ≥3 (0.0)",
        finding=finding,
    )


def _check_override_documentation(ctx: dict) -> dict:
    """Audit Trail — if override applied, reason must be documented (≥10 chars)."""
    override = bool(ctx.get("override_applied"))
    reason = (ctx.get("override_reason") or "").strip()

    if not override:
        score = 1.0
        finding = "No override applied; nominal pipeline path taken. Full score."
    elif len(reason) >= 10:
        score = 0.85
        finding = (
            f"Override applied with documented reason ({len(reason)} chars): '{reason[:80]}…' "
            if len(reason) > 80 else
            f"Override applied with documented reason: '{reason}'. Audit trail compliant."
        )
    else:
        score = 0.0
        finding = (
            f"Override applied but reason is {'absent' if not reason else f'too short ({len(reason)} chars)'}. "
            "Audit trail non-compliant — reason must be ≥10 characters."
        )

    return _check(
        name="Override Documentation",
        category="Compliance",
        standard_ref="Audit Trail",
        weight=0.06,
        score=score,
        value_observed=(
            f"override={override}, reason_len={len(reason)}"
        ),
        threshold="No override=1.0; override+reason≥10chars=0.85; override+no reason=0.0",
        finding=finding,
    )


def _check_fraud_refund_alignment(ctx: dict) -> dict:
    """AML/Fraud — fraud_segment must align with refund/gratification decision."""
    fraud = (ctx.get("fraud_segment") or "CLEAN").upper()
    refund = _f(ctx.get("final_refund_amount"))
    cap = _f(ctx.get("capped_gratification"))

    if "CLEAN" in fraud:
        score = 1.0
        finding = (
            f"Fraud segment is '{fraud}' — clean customer profile. "
            "Gratification/refund decision is appropriately unrestricted."
        )
    elif "HIGH_RISK" in fraud or "HIGH" in fraud:
        if refund > 0 or cap > 0:
            score = 0.0
            finding = (
                f"RISK VIOLATION: Fraud segment '{fraud}' but refund={refund:.2f} / "
                f"cap={cap:.2f} > 0. High-risk customer should not receive gratification."
            )
        else:
            score = 1.0
            finding = (
                f"Fraud segment '{fraud}' with zero refund/gratification. "
                "AML/Fraud controls correctly applied."
            )
    else:
        # MEDIUM or similar
        if refund <= cap or cap == 0:
            score = 0.6
            finding = (
                f"Fraud segment '{fraud}' (medium risk) with refund={refund:.2f} ≤ cap={cap:.2f}. "
                "Acceptable with caution."
            )
        else:
            score = 0.3
            finding = (
                f"Fraud segment '{fraud}' (medium risk) with refund={refund:.2f} > cap={cap:.2f}. "
                "Elevated risk — refund exceeds cap for non-clean segment."
            )

    return _check(
        name="Fraud-Refund Risk Alignment",
        category="Risk",
        standard_ref="AML/Fraud",
        weight=0.10,
        score=score,
        value_observed=(
            f"fraud_segment={fraud}, refund={refund:.2f}, cap={cap:.2f}"
        ),
        threshold="CLEAN=1.0; HIGH_RISK+any refund=0.0; MEDIUM+within cap=0.6",
        finding=finding,
    )


def _check_token_efficiency(ctx: dict) -> dict:
    """FinOps — total_tokens ≤ 4,000 is efficient; > 12,000 is wasteful."""
    tokens = _i(ctx.get("total_tokens"))

    if tokens <= 4_000:
        score = 1.0
        finding = f"Total token usage {tokens:,} is within the FinOps target of 4,000."
    elif tokens <= 12_000:
        score = _clamp(1.0 - _linear(tokens, 4_000, 12_000))
        finding = (
            f"Total token usage {tokens:,} exceeds 4,000 FinOps target. "
            f"Efficiency score: {score:.2f}. Review prompt verbosity."
        )
    else:
        score = 0.0
        finding = (
            f"Total token usage {tokens:,} exceeds 12,000 FinOps ceiling. "
            "Significant cost inefficiency — optimise prompts and context."
        )

    return _check(
        name="Token Efficiency",
        category="Cost",
        standard_ref="FinOps",
        weight=0.06,
        score=score,
        value_observed=f"{tokens:,} tokens",
        threshold="≤4,000 (full); 4,000–12,000 (partial); >12,000 (fail)",
        finding=finding,
    )


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def run_python_evaluations(context: dict) -> dict:
    """
    Run all 12 deterministic Python evaluators against the ticket context.

    Returns:
        {
            "checks": list[PythonCheck],   # 12 items
            "python_score": float,         # weighted sum 0.0–1.0
            "python_grade": str,           # A+/A/B+/B/C/F
        }
    """
    active_version = _fetch_active_policy_version()

    checks = [
        _check_confidence_threshold(context),
        _check_vector_similarity(context),
        _check_classification_consistency(context),
        _check_gratification_cap(context),
        _check_multiplier_bounds(context),
        _check_policy_version_currency(context, active_version),
        _check_pipeline_stage_health(context),
        _check_processing_time_sla(context),
        _check_discrepancy_rate(context),
        _check_override_documentation(context),
        _check_fraud_refund_alignment(context),
        _check_token_efficiency(context),
    ]

    # Sanity-check weights sum to ~1.0
    weight_sum = sum(c["weight"] for c in checks)
    if abs(weight_sum - 1.0) > 0.01:
        logger.warning("Python evaluator weights sum to %.4f (expected 1.0)", weight_sum)

    python_score = round(
        sum(c["score"] * c["weight"] for c in checks), 4
    )
    python_grade = _grade(python_score)

    logger.info(
        "Python QA evaluation complete: score=%.4f grade=%s pass=%d fail=%d",
        python_score,
        python_grade,
        sum(1 for c in checks if c["pass"]),
        sum(1 for c in checks if not c["pass"]),
    )

    return {
        "checks": checks,
        "python_score": python_score,
        "python_grade": python_grade,
    }
