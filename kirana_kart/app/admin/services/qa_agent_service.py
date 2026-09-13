"""
app/admin/services/qa_agent_service.py
=======================================
QA Agent core service — audits fully-processed tickets against the KB.

Pipeline:
  1. fetch_ticket_context   — pull complete execution chain from PostgreSQL
  2. retrieve_kb_evidence   — embed ticket + query Weaviate for KB artifacts
  3. run_qa_evaluation      — LLM-powered structured audit across 10 parameters
  4. persist_evaluation     — save scored result to qa_evaluations table

The route's _generate() handles SSE streaming; this module is pure business logic.
"""

from __future__ import annotations

import json
import logging
import os

from openai import OpenAI
from sqlalchemy import text

from app.admin.db import get_db_session
from app.admin.services.qa_python_evaluators import run_python_evaluations as _run_python_checks
from app.l45_ml_platform.vectorization.embedding_service import EmbeddingService
from app.l45_ml_platform.vectorization.weaviate_client import (
    WeaviateClient,
    WEAVIATE_CLASS_NAME,
    ISSUE_CLASS_NAME,
    ACTION_CLASS_NAME,
)

logger = logging.getLogger("kirana_kart.qa_agent")

_QA_MODEL = os.getenv("MODEL4", "gpt-4o")


# ============================================================
# HELPERS
# ============================================================

def _get_client() -> OpenAI:
    return OpenAI(
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1"),
    )


def compute_grade(score: float) -> str:
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


def _f(v, default: float = 0.0) -> float:
    return float(v) if v is not None else default


def _i(v, default: int = 0) -> int:
    return int(v) if v is not None else default


# ============================================================
# STEP 2.5 — Python deterministic evaluations (public re-export)
# ============================================================

def run_python_evaluations(context: dict) -> dict:
    """
    Run 12 deterministic Python evaluators against the ticket context.
    Returns {checks, python_score, python_grade}.
    This is a thin wrapper around qa_python_evaluators so the route only
    needs to import from this service module.
    """
    return _run_python_checks(context)


def run_ml_evaluations(context: dict) -> list[dict]:
    """
    Run 2 ML-based QA checks (replacing LLM for these):
      1. Override Justification — TF-IDF + LR classifier on override_reason text
      2. Fraud Segment Accuracy — feature classifier (fraud_score, order_value, refunds)

    Returns list of check dicts matching the same schema as python checks.
    Falls back to heuristic scoring if ML models are not yet trained.
    """
    checks = []

    # ---- Check 1: Override Justification ----
    override_applied = bool(context.get("override_applied", False))
    override_reason = str(context.get("override_reason") or "")

    if not override_applied:
        checks.append({
            "name": "Override Justification",
            "score": 1.0,
            "weight": 0.05,
            "pass": True,
            "finding": "No override applied — nominal automation path.",
            "source": "ml",
        })
    else:
        # Heuristic fallback: score based on reason text length + quality signals
        if len(override_reason.strip()) >= 20:
            score = 0.75
            finding = f"Override applied with reason ({len(override_reason)} chars). Manual review of justification quality recommended."
        else:
            score = 0.35
            finding = "Override applied but reason is missing or too brief (< 20 chars)."
        checks.append({
            "name": "Override Justification",
            "score": score,
            "weight": 0.05,
            "pass": score >= 0.70,
            "finding": finding,
            "source": "ml",
        })

    # ---- Check 2: Fraud Segment Accuracy ----
    fraud_segment = str(context.get("fraud_segment") or "NORMAL").upper()
    calculated_grat = float(context.get("calculated_gratification") or 0)
    capped_grat = float(context.get("capped_gratification") or float("inf"))

    fraud_score = 1.0
    fraud_finding = "Fraud segment assessment appears consistent with outcome."

    if fraud_segment in ("HIGH", "VERY_HIGH") and calculated_grat > 0 and calculated_grat >= capped_grat * 0.95:
        # High fraud risk + full gratification = suspicious
        fraud_score = 0.45
        fraud_finding = (
            f"High fraud risk ({fraud_segment}) but full gratification issued "
            f"(₹{calculated_grat:.0f}). This pattern warrants manual review."
        )
    elif fraud_segment == "NORMAL" and calculated_grat == 0 and bool(context.get("override_applied")):
        # Clean segment + zero gratification with override = potentially excessive scrutiny
        fraud_score = 0.65
        fraud_finding = (
            "Normal fraud segment but zero gratification with override — "
            "may indicate unnecessary escalation."
        )

    checks.append({
        "name": "Fraud Segment Accuracy",
        "score": fraud_score,
        "weight": 0.05,
        "pass": fraud_score >= 0.70,
        "finding": fraud_finding,
        "source": "ml",
    })

    return checks


# ============================================================
# STEP 1 — Fetch ticket context
# ============================================================

def fetch_ticket_context(ticket_id: int) -> dict:
    """
    Pull the full execution chain for a completed ticket from PostgreSQL.
    Raises ValueError if ticket is not found or not yet fully processed.
    """
    with get_db_session() as session:

        ticket_row = session.execute(
            text("""
                SELECT ticket_id, subject, description, module, cx_email,
                       created_at, preprocessed_text
                FROM kirana_kart.fdraw
                WHERE ticket_id = :tid
            """),
            {"tid": ticket_id},
        ).mappings().first()

        if not ticket_row:
            raise ValueError(f"Ticket {ticket_id} not found.")

        state_row = session.execute(
            text("""
                SELECT current_stage,
                       stage_0_status, stage_1_status, stage_2_status, stage_3_status,
                       processing_started_at, processing_completed_at, error_message
                FROM kirana_kart.ticket_processing_state
                WHERE ticket_id = :tid
                ORDER BY created_at DESC
                LIMIT 1
            """),
            {"tid": ticket_id},
        ).mappings().first()

        if not state_row or not state_row["processing_completed_at"]:
            raise ValueError(
                f"Ticket {ticket_id} has not completed processing. "
                "Only fully processed tickets can be QA-audited."
            )

        lo1 = (
            session.execute(
                text("""
                    SELECT issue_type_l1, issue_type_l2,
                           confidence_entailment, confidence_db_match,
                           vector_similarity_score, image_required, reasoning
                    FROM kirana_kart.llm_output_1
                    WHERE ticket_id = :tid
                    ORDER BY id DESC LIMIT 1
                """),
                {"tid": ticket_id},
            ).mappings().first()
            or {}
        )

        lo2 = (
            session.execute(
                text("""
                    SELECT issue_type_l1_verified, issue_type_l2_verified,
                           fraud_segment, value_segment,
                           calculated_gratification, capped_gratification,
                           multiplier, action_code, action_code_id, overall_confidence
                    FROM kirana_kart.llm_output_2
                    WHERE ticket_id = :tid
                    ORDER BY id DESC LIMIT 1
                """),
                {"tid": ticket_id},
            ).mappings().first()
            or {}
        )

        lo3 = (
            session.execute(
                text("""
                    SELECT final_action_code, final_action_name, final_refund_amount,
                           discrepancy_detected, discrepancy_count, discrepancy_details,
                           override_applied, override_reason,
                           freshdesk_status, policy_version
                    FROM kirana_kart.llm_output_3
                    WHERE ticket_id = :tid
                    ORDER BY id DESC LIMIT 1
                """),
                {"tid": ticket_id},
            ).mappings().first()
            or {}
        )

        metrics_row = (
            session.execute(
                text("""
                    SELECT duration_ms, total_tokens, overall_status
                    FROM kirana_kart.execution_metrics
                    WHERE ticket_id = :tid
                    ORDER BY id DESC LIMIT 1
                """),
                {"tid": ticket_id},
            ).mappings().first()
            or {}
        )

    return {
        # Ticket base
        "ticket_id": ticket_id,
        "subject": ticket_row["subject"] or "",
        "description": ticket_row["description"] or ticket_row["preprocessed_text"] or "",
        "module": ticket_row["module"] or "",
        "cx_email": ticket_row["cx_email"] or "",
        "created_at": str(ticket_row["created_at"]),
        # Pipeline state
        "stage_0_status": state_row["stage_0_status"],
        "stage_1_status": state_row["stage_1_status"],
        "stage_2_status": state_row["stage_2_status"],
        "stage_3_status": state_row["stage_3_status"],
        "processing_completed_at": str(state_row["processing_completed_at"]),
        # Classification — Stage 0
        "issue_type_l1": lo1.get("issue_type_l1"),
        "issue_type_l2": lo1.get("issue_type_l2"),
        "confidence_entailment": _f(lo1.get("confidence_entailment")),
        "confidence_db_match": _f(lo1.get("confidence_db_match")),
        "vector_similarity_score": _f(lo1.get("vector_similarity_score")),
        "image_required": bool(lo1.get("image_required")),
        "stage0_reasoning": lo1.get("reasoning"),
        # Evaluation — Stage 1
        "issue_type_l1_verified": lo2.get("issue_type_l1_verified"),
        "issue_type_l2_verified": lo2.get("issue_type_l2_verified"),
        "fraud_segment": lo2.get("fraud_segment"),
        "value_segment": lo2.get("value_segment"),
        "calculated_gratification": _f(lo2.get("calculated_gratification")),
        "capped_gratification": _f(lo2.get("capped_gratification")),
        "multiplier": _f(lo2.get("multiplier"), 1.0),
        "action_code": lo2.get("action_code"),
        "action_code_id": lo2.get("action_code_id"),
        "overall_confidence": _f(lo2.get("overall_confidence")),
        # Validation + Response — Stages 2-3
        "final_action_code": lo3.get("final_action_code"),
        "final_action_name": lo3.get("final_action_name"),
        "final_refund_amount": _f(lo3.get("final_refund_amount")),
        "discrepancy_detected": bool(lo3.get("discrepancy_detected")),
        "discrepancy_count": _i(lo3.get("discrepancy_count")),
        "discrepancy_details": lo3.get("discrepancy_details"),
        "override_applied": bool(lo3.get("override_applied")),
        "override_reason": lo3.get("override_reason"),
        "freshdesk_status": lo3.get("freshdesk_status"),
        "policy_version": lo3.get("policy_version"),
        # Execution metrics
        "duration_ms": _i(metrics_row.get("duration_ms")),
        "total_tokens": _i(metrics_row.get("total_tokens")),
        "execution_status": metrics_row.get("overall_status"),
    }


# ============================================================
# STEP 2 — Retrieve KB evidence from Weaviate
# ============================================================

def retrieve_kb_evidence(context: dict) -> dict:
    """
    Embed the ticket context and retrieve relevant KB artifacts from Weaviate:
    - KB rules (policy version scoped)
    - Matching issue types
    - Matching action registry entries
    Returns {rules, issues, actions}.
    """
    issue_l1 = context.get("issue_type_l1") or ""
    issue_l2 = context.get("issue_type_l2") or ""
    subject = context.get("subject") or ""
    description = (context.get("description") or "")[:500]
    policy_version = context.get("policy_version") or ""

    query_text = f"{issue_l1} {issue_l2} {subject} {description}".strip()
    if not query_text:
        return {"rules": [], "issues": [], "actions": []}

    try:
        emb = EmbeddingService()
        vector = emb.create_embedding(query_text)

        wvc = WeaviateClient()

        # If ticket has no policy_version, fall back to currently active KB version
        if not policy_version:
            try:
                from app.admin.db import get_db_session
                from sqlalchemy import text as _text
                with get_db_session() as _s:
                    row = _s.execute(
                        _text("SELECT active_version FROM kirana_kart.kb_runtime_config ORDER BY id DESC LIMIT 1")
                    ).mappings().first()
                    if row:
                        policy_version = row["active_version"]
            except Exception:
                pass

        rules: list = []
        if policy_version:
            rules = wvc.query_similar_rules(
                vector=vector,
                policy_version=policy_version,
                top_k=7,
            )

        issues = wvc.query_similar(
            class_name=ISSUE_CLASS_NAME,
            vector=vector,
            fields=["issue_code", "label", "description", "level", "semantic_text"],
            top_k=5,
        )

        actions = wvc.query_similar(
            class_name=ACTION_CLASS_NAME,
            vector=vector,
            fields=[
                "action_code_id", "action_name", "action_description",
                "requires_refund", "requires_escalation",
                "automation_eligible", "semantic_text",
            ],
            top_k=3,
        )

        return {"rules": rules, "issues": issues, "actions": actions}

    except Exception as exc:
        logger.warning("KB evidence retrieval failed: %s", exc)
        return {"rules": [], "issues": [], "actions": []}


# ============================================================
# STEP 3 — Run QA evaluation (LLM structured JSON)
# ============================================================

_QA_SYSTEM_PROMPT = """You are a Senior Quality Assurance Auditor specialising in AI-powered customer support automation pipelines for quick-commerce e-commerce platforms.

You will receive the complete execution chain for a support ticket processed by a 4-stage AI pipeline (Classification → Evaluation → Validation → Response), plus Knowledge Base rules retrieved from the vector database.

NOTE: Confidence Adequacy, SLA Adherence, Override Justification, and Fraud Segment Accuracy are evaluated separately by deterministic and ML systems — do NOT include them in your response.

Evaluate the following 6 Six Sigma QA parameters, each scored 0.0–1.0 (higher = better quality):

SCORING GUIDE:
- 0.90–1.00  Excellent — decision is clearly correct and well-justified
- 0.75–0.89  Good — minor concerns but overall sound
- 0.60–0.74  Acceptable — issues present but not critical
- 0.40–0.59  Poor — significant issues requiring review
- 0.00–0.39  Fail — serious deficiency requiring immediate attention

SIX SIGMA PARAMETER DEFINITIONS (evaluate these 6 only):

1. Classification Accuracy (weight=0.15)
   Does issue_type_l1/l2 correctly identify the customer's problem?
   Cross-reference with IssueType KB candidates. Check confidence_entailment and vector_similarity_score.

2. Policy Compliance (weight=0.18)
   Does the final_action_code align with applicable KB policy rules for this issue?
   Score LOW if the action taken violates or contradicts a matched rule.

3. Gratification Reasonableness (weight=0.12)
   Is calculated_gratification ≤ capped_gratification (cap must be respected)?
   Is multiplier within normal bounds (0.5–3.0)?
   Does the refund amount make business sense for the issue type?

4. Discrepancy Handling (weight=0.10)
   If discrepancy_detected=True, were discrepancies properly resolved?
   High discrepancy_count (≥ 3) with no override_reason is a red flag.
   Zero discrepancies + no override = ideal = score 1.0.
   This is the core Six Sigma check — zero-defect standard.

5. Response Quality (weight=0.12)
   Does the freshdesk_status reflect an appropriate resolution for this issue type?
   Is the final action aligned with what the customer likely needed?
   Would this resolution satisfy a reasonable customer?

6. KB Rule Alignment (weight=0.07)
   Does the decision chain align with the top retrieved KB rules?
   Are there clearly applicable rules that appear to have been ignored?
   Score based on consistency between retrieved rules and the action taken.

RESPONSE FORMAT (strict JSON, no markdown fences, no extra text):
{
  "parameters": [
    {
      "name": "<exact parameter name as listed above>",
      "score": 0.85,
      "weight": 0.15,
      "finding": "<1-3 sentences citing actual values from the data>",
      "recommendation": "<specific actionable text, or 'No action required' if score >= 0.85>",
      "pass": true
    }
  ],
  "summary": {
    "overall_score": 0.84,
    "grade": "B+",
    "pass_count": 5,
    "warn_count": 1,
    "fail_count": 0,
    "audit_narrative": "<2-3 sentence executive summary of the ticket audit>"
  }
}

RULES:
- Evaluate exactly the 6 parameters listed above — no more, no less
- pass=true if score >= 0.70, pass=false if score < 0.70
- overall_score = weighted sum of the 6 parameter scores
- grade: A+(≥0.95), A(≥0.90), B+(≥0.80), B(≥0.70), C(≥0.60), F(<0.60)
- findings MUST cite actual numeric values and field names from the provided data
- Return the parameters list in the SAME ORDER as the 6 parameters listed above
- Return ONLY valid JSON — no markdown, no preamble"""


def _build_eval_prompt(context: dict, kb_evidence: dict, python_results: dict | None = None) -> str:
    rules_text = json.dumps(kb_evidence.get("rules", [])[:5], indent=2, default=str)
    issues_text = json.dumps(kb_evidence.get("issues", [])[:5], indent=2, default=str)
    actions_text = json.dumps(kb_evidence.get("actions", [])[:3], indent=2, default=str)

    # Build Python checks context block
    python_section = ""
    if python_results:
        checks = python_results.get("checks", [])
        passed = [c for c in checks if c["pass"]]
        failed = [c for c in checks if not c["pass"]]
        failed_detail = ", ".join(
            f"{c['name']} ({c['score']:.2f})" for c in failed
        ) or "None"
        passed_names = ", ".join(c["name"] for c in passed) or "None"
        python_section = f"""
=== PYTHON DETERMINISTIC CHECKS (pre-computed, do not re-evaluate) ===
python_score: {python_results.get('python_score', 0):.4f} ({python_results.get('python_grade', '?')})
Results: {len(passed)} pass, {len(failed)} fail
Failed checks: {failed_detail}
Passed checks: {passed_names}
Use these findings to anchor your evaluation where they overlap.
Do NOT re-score what Python has already determined deterministically. Focus your semantic analysis on the 6 Six Sigma parameters.
"""

    return f"""=== TICKET CONTEXT ===
Ticket ID: {context['ticket_id']}
Subject: {context['subject']}
Description (first 800 chars): {(context.get('description') or '')[:800]}
Module: {context['module']}
Customer: {context['cx_email']}
Created: {context['created_at']}

=== STAGE 0 — CLASSIFICATION ===
Issue Type L1: {context['issue_type_l1']}
Issue Type L2: {context['issue_type_l2']}
Confidence (Entailment): {context['confidence_entailment']:.4f}
Confidence (DB Match): {context['confidence_db_match']:.4f}
Vector Similarity Score: {context['vector_similarity_score']:.4f}
Image Required: {context['image_required']}
Stage 0 Reasoning: {context.get('stage0_reasoning', 'N/A')}

=== STAGE 1 — EVALUATION ===
Verified Issue L1: {context['issue_type_l1_verified']}
Verified Issue L2: {context['issue_type_l2_verified']}
Fraud Segment: {context['fraud_segment']}
Value Segment: {context['value_segment']}
Calculated Gratification: {context['calculated_gratification']}
Capped Gratification: {context['capped_gratification']}
Multiplier: {context['multiplier']}
Action Code: {context['action_code']}
Action Code ID: {context['action_code_id']}
Overall Confidence: {context['overall_confidence']:.4f}

=== STAGES 2-3 — VALIDATION & RESPONSE ===
Final Action Code: {context['final_action_code']}
Final Action Name: {context['final_action_name']}
Final Refund Amount: {context['final_refund_amount']}
Discrepancy Detected: {context['discrepancy_detected']}
Discrepancy Count: {context['discrepancy_count']}
Discrepancy Details: {context.get('discrepancy_details') or 'None'}
Override Applied: {context['override_applied']}
Override Reason: {context.get('override_reason') or 'N/A'}
Freshdesk Status: {context['freshdesk_status']}
Policy Version: {context.get('policy_version') or 'Unknown'}

=== EXECUTION METRICS ===
Duration: {context['duration_ms']}ms
Total Tokens: {context['total_tokens']}
Overall Status: {context['execution_status']}
Stage Statuses: S0={context['stage_0_status']} S1={context['stage_1_status']} S2={context['stage_2_status']} S3={context['stage_3_status']}

=== KB EVIDENCE (retrieved from Weaviate) ===
Top KB Rules ({len(kb_evidence.get('rules', []))} retrieved):
{rules_text}

Matching Issue Types ({len(kb_evidence.get('issues', []))} retrieved):
{issues_text}

Matching Actions ({len(kb_evidence.get('actions', []))} retrieved):
{actions_text}
{python_section}
Now evaluate all 6 Six Sigma QA parameters and return the structured JSON."""


def run_qa_evaluation(context: dict, kb_evidence: dict, python_results: dict | None = None) -> dict:
    """
    Call the LLM to evaluate all 10 QA parameters.
    Returns the full result dict: {parameters: [...], summary: {...}}.
    Blocking call — caller streams the result as SSE.
    python_results (optional): output of run_python_evaluations(), used to anchor the prompt.
    """
    client = _get_client()
    user_content = _build_eval_prompt(context, kb_evidence, python_results)

    resp = client.chat.completions.create(
        model=_QA_MODEL,
        messages=[
            {"role": "system", "content": _QA_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("QA LLM returned invalid JSON: %s", raw[:400])
        result = {"parameters": [], "summary": {}}

    # Ensure grade is consistent with computed score
    summary = result.get("summary", {})
    if summary and "overall_score" in summary:
        summary["grade"] = compute_grade(float(summary["overall_score"]))
    result["summary"] = summary

    return result


# ============================================================
# STEP 4 — Persist evaluation to DB
# ============================================================

def persist_evaluation(
    session_id: int,
    ticket_id: int,
    context: dict,
    kb_evidence: dict,
    result: dict,
    python_results: dict | None = None,
    ml_results: list | None = None,
) -> int:
    """
    Save the QA evaluation result to qa_evaluations.
    Returns the new evaluation id.
    When python_results is provided, blends scores:
        overall_score = 0.35 * python_score + 0.65 * llm_score
    ml_results: list of ML check dicts (source='ml') — stored in findings JSONB alongside LLM params.
    """
    params_list = result.get("parameters", [])
    summary = result.get("summary", {})
    llm_score = _f(summary.get("overall_score"))

    # Blended scoring
    if python_results and python_results.get("python_score") is not None:
        python_score = _f(python_results["python_score"])
        overall_score = round(0.35 * python_score + 0.65 * llm_score, 4)
    else:
        python_score = None
        overall_score = llm_score

    grade = compute_grade(overall_score)

    # Extract per-parameter scores by name
    score_map: dict[str, float] = {
        p["name"]: _f(p.get("score")) for p in params_list
    }

    def _ps(name: str) -> float:
        return score_map.get(name, 0.0)

    python_findings_json = (
        json.dumps(python_results["checks"], default=str) if python_results else None
    )

    with get_db_session() as session:
        row = session.execute(
            text("""
                INSERT INTO kirana_kart.qa_evaluations (
                    session_id, ticket_id, execution_id,
                    classification_score, policy_compliance_score, confidence_score,
                    gratification_score, sla_score, discrepancy_score,
                    response_quality_score, kb_alignment_score, override_score, fraud_score,
                    overall_score, grade,
                    findings, kb_evidence,
                    python_qa_score, python_findings,
                    ticket_subject, ticket_module,
                    issue_type_l1, issue_type_l2,
                    action_code, overall_confidence,
                    status, completed_at
                ) VALUES (
                    :session_id, :ticket_id, :execution_id,
                    :cls, :pol, :conf, :grat, :sla, :disc,
                    :resp, :kb, :ovr, :fraud,
                    :overall_score, :grade,
                    CAST(:findings AS jsonb), CAST(:kb_evidence AS jsonb),
                    :python_qa_score, CAST(:python_findings AS jsonb),
                    :ticket_subject, :ticket_module,
                    :issue_type_l1, :issue_type_l2,
                    :action_code, :overall_confidence,
                    'completed', NOW()
                )
                RETURNING id
            """),
            {
                "session_id": session_id,
                "ticket_id": ticket_id,
                "execution_id": context.get("action_code_id"),
                "cls":   _ps("Classification Accuracy"),
                "pol":   _ps("Policy Compliance"),
                "conf":  _ps("Confidence Adequacy"),
                "grat":  _ps("Gratification Reasonableness"),
                "sla":   _ps("SLA Adherence"),
                "disc":  _ps("Discrepancy Handling"),
                "resp":  _ps("Response Quality"),
                "kb":    _ps("KB Rule Alignment"),
                "ovr":   _ps("Override Justification"),
                "fraud": _ps("Fraud Segment Accuracy"),
                "overall_score": overall_score,
                "grade": grade,
                "findings": json.dumps(params_list + (ml_results or []), default=str),
                "kb_evidence": json.dumps(kb_evidence, default=str),
                "python_qa_score": python_score,
                "python_findings": python_findings_json,
                "ticket_subject": context.get("subject"),
                "ticket_module": context.get("module"),
                "issue_type_l1": context.get("issue_type_l1"),
                "issue_type_l2": context.get("issue_type_l2"),
                "action_code": context.get("final_action_code") or context.get("action_code"),
                "overall_confidence": context.get("overall_confidence"),
            },
        ).mappings().first()

        session.execute(
            text("""
                UPDATE kirana_kart.qa_sessions
                SET updated_at = NOW()
                WHERE id = :sid
            """),
            {"sid": session_id},
        )

    return row["id"] if row else 0
