"""
app/admin/services/policy_lifecycle.py
======================================
Server-enforced lifecycle for Policy Studio proposals (kb_version instances).

Stages used to be advisory: nothing moved a proposal forward, any KB editor
could request an arbitrary transition, and approval flipped the stage to
ACTIVE without activating anything. Every stage change now follows from the
work it describes:

  DRAFT ─analysis→ AI_COMPILE_QUEUED ─rules generated→ RULE_EDIT
  RULE_EDIT ─sample replay→ SIMULATION_GATE → SHADOW_GATE | SIMULATION_FAILED
  SHADOW_GATE | SIMULATION_FAILED (+ justification) ─submit→ PENDING_APPROVAL
  PENDING_APPROVAL ─approve (another person)→ ACTIVE   (one transaction:
      registry commit + runtime activation + stage + previous version retired)
  PENDING_APPROVAL ─reject→ REJECTED

Editing a tested proposal returns it to RULE_EDIT, because the recorded
evidence no longer describes its rules. Nothing can be edited while it awaits
approval or after it is live.

Every function takes the caller's connection; callers own the transaction.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Optional

from sqlalchemy import text

from app.admin.services.bpm_service import BPMService
from app.admin.services import policy_knowledge_service as knowledge

logger = logging.getLogger("kirana_kart.policy_lifecycle")

# The share of sample decisions that must stay unchanged for the replay gate
# to pass. Below this, the change is large enough that a person must justify
# it before approval is requested.
SIMULATION_GATE_THRESHOLD = 0.80
MIN_JUSTIFICATION_CHARS = 20

AUTHORING_STAGES = frozenset({"DRAFT", "AI_COMPILE_QUEUED", "AI_COMPILE_FAILED", "RULE_EDIT"})
# Stages carrying test evidence (or a rejection) for the current rules.
EVIDENCE_STAGES = frozenset({
    "SIMULATION_GATE", "SIMULATION_FAILED", "SHADOW_GATE", "SHADOW_DIVERGENCE_HIGH", "REJECTED",
})
EDITABLE_STAGES = AUTHORING_STAGES | EVIDENCE_STAGES


class LifecycleError(Exception):
    """A request the lifecycle refuses; carries the HTTP status to return."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ============================================================
# LOOKUP
# ============================================================

def load_proposal(conn, kb_id: str, entity_id: str, lock: bool = False) -> dict:
    row = conn.execute(text(f"""
        SELECT * FROM kirana_kart.bpm_process_instances
        WHERE kb_id = :kb_id AND entity_id = :eid AND entity_type = 'kb_version'
        ORDER BY started_at DESC, id DESC
        LIMIT 1 {'FOR UPDATE' if lock else ''}
    """), {"kb_id": kb_id, "eid": entity_id}).mappings().first()
    if not row:
        raise LifecycleError(404, "Policy proposal not found in this knowledge base")
    return dict(row)


def load_instance(conn, kb_id: str, instance_id: int, lock: bool = False) -> dict:
    """An instance, only if it belongs to kb_id: the KB in the URL is what was authorised."""
    row = conn.execute(text(f"""
        SELECT * FROM kirana_kart.bpm_process_instances
        WHERE id = :id AND kb_id = :kb_id {'FOR UPDATE' if lock else ''}
    """), {"id": instance_id, "kb_id": kb_id}).mappings().first()
    if not row:
        raise LifecycleError(404, f"BPM instance {instance_id} not found")
    return dict(row)


def review_counts(conn, kb_id: str, entity_id: str) -> dict:
    row = conn.execute(text("""
        SELECT
          (SELECT COUNT(*) FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb AND entity_id = :eid AND status = 'pending')   AS taxonomy_pending,
          (SELECT COUNT(*) FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb AND entity_id = :eid AND status IN ('accepted','edited')) AS taxonomy_accepted,
          (SELECT COUNT(*) FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb AND entity_id = :eid AND status = 'pending')   AS actions_pending,
          (SELECT COUNT(*) FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb AND entity_id = :eid AND status IN ('accepted','edited')) AS actions_accepted,
          (SELECT COUNT(*) FROM kirana_kart.rule_registry
            WHERE kb_id = :kb AND policy_version = :eid)                     AS rules,
          (SELECT COUNT(*) FROM kirana_kart.policy_knowledge_chunks
            WHERE kb_id = :kb AND entity_id = :eid AND status = 'pending')   AS knowledge_pending,
          (SELECT COUNT(*) FROM kirana_kart.policy_knowledge_chunks
            WHERE kb_id = :kb AND entity_id = :eid AND status IN ('accepted','edited')) AS knowledge_accepted,
          (SELECT COUNT(*) FROM kirana_kart.policy_taxonomy_gaps
            WHERE kb_id = :kb AND entity_id = :eid AND status = 'open')      AS gaps_open
    """), {"kb": kb_id, "eid": entity_id}).mappings().first()
    return {k: int(v or 0) for k, v in dict(row).items()}


def runtime_versions(conn) -> tuple[Optional[str], Optional[str]]:
    """The single live pointer the Cardinal runtime reads (phase4_enricher)."""
    row = conn.execute(text("""
        SELECT active_version, shadow_version FROM kirana_kart.kb_runtime_config
        ORDER BY id DESC LIMIT 1
    """)).mappings().first()
    return (row["active_version"], row["shadow_version"]) if row else (None, None)


def rules_fingerprint(conn, entity_id: str) -> str:
    """
    Hash of everything in a version that affects a decision: its rules and
    the knowledge passages Stage 1 and Stage 3 read. An approval covers
    exactly this; any later change invalidates it.
    """
    rows = conn.execute(text("""
        SELECT rule_id, module_name, rule_type, priority, rule_scope,
               issue_type_l1, issue_type_l2, business_line, customer_segment,
               fraud_segment, min_order_value, max_order_value,
               min_repeat_count, max_repeat_count, sla_breach_required,
               evidence_required, conditions, action_id, action_payload,
               deterministic, overrideable
        FROM kirana_kart.rule_registry
        WHERE policy_version = :eid
        ORDER BY rule_id, id
    """), {"eid": entity_id}).mappings().all()
    chunks = conn.execute(text("""
        SELECT chunk_key, business_line, title, body, issue_codes, purpose, sort_order
        FROM kirana_kart.policy_knowledge_chunks
        WHERE entity_id = :eid AND status IN ('accepted', 'edited')
        ORDER BY chunk_key
    """), {"eid": entity_id}).mappings().all()
    content = [dict(r) for r in rows]
    if chunks:
        # Versions without passages keep the hash they were approved with.
        content = {"rules": content, "knowledge": [dict(c) for c in chunks]}
    payload = json.dumps(content, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


# ============================================================
# STAGE MOVES
# ============================================================

def _move(conn, instance: dict, to_stage: str, actor, notes: str,
          data: Optional[dict] = None) -> None:
    BPMService.transition_on(
        conn, instance["id"], to_stage,
        actor_id=actor.id, actor_name=actor.email, notes=notes, transition_data=data,
    )
    instance["current_stage"] = to_stage


def _locked_message(stage: str) -> str:
    if stage == "PENDING_APPROVAL":
        return ("This proposal is awaiting approval and cannot be changed. "
                "An approver can reject it to reopen it for editing.")
    if stage == "ACTIVE":
        return "This version is live and cannot be edited. Create a new policy change instead."
    return f"This proposal is in stage {stage} and can no longer be edited."


def open_for_editing(conn, instance: dict, actor, change: str) -> None:
    """Allow a change to the proposal, discarding evidence it would invalidate."""
    stage = instance["current_stage"]
    if stage in AUTHORING_STAGES:
        return
    if stage in EVIDENCE_STAGES:
        _move(conn, instance, "RULE_EDIT", actor,
              f"{change}. Earlier test results no longer describe this proposal.")
        return
    raise LifecycleError(409, _locked_message(stage))


def start_analysis(conn, instance: dict, actor) -> None:
    open_for_editing(conn, instance, actor, "SOP analysis re-run")
    if instance["current_stage"] in ("DRAFT", "AI_COMPILE_FAILED"):
        _move(conn, instance, "AI_COMPILE_QUEUED", actor, "SOP analysis started")


def analysis_failed(conn, instance: dict, actor, reason: str) -> None:
    if instance["current_stage"] == "AI_COMPILE_QUEUED":
        _move(conn, instance, "AI_COMPILE_FAILED", actor, reason[:500])


def _advance_to_rule_edit(conn, instance: dict, actor, notes: str) -> None:
    if instance["current_stage"] in ("DRAFT", "AI_COMPILE_FAILED"):
        _move(conn, instance, "AI_COMPILE_QUEUED", actor, notes)
    if instance["current_stage"] == "AI_COMPILE_QUEUED":
        _move(conn, instance, "RULE_EDIT", actor, notes)
    elif instance["current_stage"] in EVIDENCE_STAGES:
        _move(conn, instance, "RULE_EDIT", actor, notes)


def rules_generated(conn, instance: dict, actor, rule_count: int) -> None:
    if rule_count > 0:
        _advance_to_rule_edit(conn, instance, actor, f"{rule_count} decisions generated for review")


# ============================================================
# SAMPLE REPLAY GATE
# ============================================================

def _unavailable(entity_id: str, reason: str) -> dict:
    logger.info("Simulation gate unavailable for %s: %s", entity_id, reason)
    return {"status": "unavailable", "passed": None, "reason": reason, "metrics": None, "examples": []}


def run_simulation_gate(conn, kb_id: str, entity_id: str, actor, simulator) -> dict:
    """
    Replay saved cases against the live policy and this proposal, record the
    result, and move the proposal to SHADOW_GATE (within threshold, or no live
    policy to compare against) or SIMULATION_FAILED.

    When the replay genuinely cannot run, nothing is recorded and the stage is
    unchanged: a gate that guesses is worse than one that admits it has
    nothing to report.
    """
    instance = load_proposal(conn, kb_id, entity_id, lock=True)
    stage = instance["current_stage"]
    if stage not in EDITABLE_STAGES:
        raise LifecycleError(409, _locked_message(stage))

    counts = review_counts(conn, kb_id, entity_id)
    if counts["rules"] == 0:
        return _unavailable(entity_id, "This version has no generated rules yet — run rule generation first.")
    pending = counts["taxonomy_pending"] + counts["actions_pending"]
    if pending:
        return _unavailable(entity_id, f"Resolve the {pending} review items still pending before testing.")

    baseline, _shadow = runtime_versions(conn)
    if baseline == entity_id:
        return _unavailable(entity_id, "This version is already the active baseline.")

    if baseline is None:
        # Nothing is live, so no existing decision can change. Recorded as
        # not applicable — never as a measured rate.
        passed = True
        metrics: dict[str, Any] = {
            "status": "not_applicable",
            "reason": "No policy is currently active, so there is nothing to compare against. "
                      "This will be the first live version.",
            "rule_count": counts["rules"],
            "candidate_version": entity_id,
        }
        examples: list = []
    else:
        try:
            result = simulator.run_simulation(candidate_version=entity_id, baseline_version=baseline)
        except Exception as exc:
            # "No sample tickets" / "no rules for version X" are real
            # conditions the reviewer needs to see, not a 500.
            return _unavailable(entity_id, str(exc))
        tested = int(result.get("tickets_tested") or 0)
        changed = int(result.get("differences") or 0)
        if tested == 0:
            return _unavailable(entity_id, "No sample tickets available to simulate against.")
        unchanged_rate = (tested - changed) / tested
        passed = unchanged_rate >= SIMULATION_GATE_THRESHOLD
        examples = result.get("examples", [])[:20]
        metrics = {
            "unchanged_rate": round(unchanged_rate, 4),
            "changed_count": changed,
            "ticket_count": tested,
            "rule_count": counts["rules"],
            "ai_decided_count": int(result.get("ai_decided") or 0),
            "baseline_version": baseline,
            "candidate_version": entity_id,
            "threshold": SIMULATION_GATE_THRESHOLD,
            "sample_source": "Saved simulation cases (up to 1,000; not a dated or representative sample)",
            "examples": examples,
            "measurement_scope": (
                "Final action differences only, as rules would decide under RULE_ENFORCEMENT=enforce; "
                "cases no rule decides are left to the AI and not replayed. Financial impact and "
                "customer outcomes are not measured"
            ),
            "rules_fingerprint": rules_fingerprint(conn, entity_id),
        }

    _advance_to_rule_edit(conn, instance, actor, "Rules finalised for testing")
    _move(conn, instance, "SIMULATION_GATE", actor, "Sample replay started")
    gate_id = conn.execute(text("""
        INSERT INTO kirana_kart.bpm_gate_results (instance_id, gate_type, passed, metrics)
        VALUES (:iid, 'simulation', :passed, :metrics)
        RETURNING id
    """), {"iid": instance["id"], "passed": passed,
           "metrics": json.dumps(metrics, default=str)}).scalar()
    if passed:
        note = ("No live policy to compare against" if metrics.get("status") == "not_applicable"
                else "Sample replay within the change threshold")
        _move(conn, instance, "SHADOW_GATE", actor, note, {"gate_result_id": gate_id})
    else:
        _move(conn, instance, "SIMULATION_FAILED", actor,
              "Sample replay changed more decisions than the threshold allows", {"gate_result_id": gate_id})

    return {
        "status": "not_applicable" if metrics.get("status") == "not_applicable" else "ok",
        "passed": passed,
        "reason": metrics.get("reason"),
        "metrics": metrics,
        "examples": examples,
        "stage": instance["current_stage"],
    }


# ============================================================
# APPROVAL REQUEST
# ============================================================

def _pending_approval(conn, instance_id: int, approval_id: Optional[int] = None) -> Optional[dict]:
    row = conn.execute(text("""
        SELECT * FROM kirana_kart.bpm_approvals
        WHERE instance_id = :iid AND status = 'pending'
          AND (CAST(:aid AS INTEGER) IS NULL OR id = :aid)
        ORDER BY id DESC LIMIT 1
        FOR UPDATE
    """), {"iid": instance_id, "aid": approval_id}).mappings().first()
    return dict(row) if row else None


def _enqueue_preparation(conn, kb_id: str, entity_id: str, instance: dict, fingerprint: str) -> None:
    """
    Freeze the reviewed rules as a compiled policy version and queue the
    vectorization the runtime needs before it may serve them. The background
    vector worker (app.admin.main) completes it.
    """
    brief = (instance.get("metadata") or {}).get("business_brief") or {}
    conn.execute(text("""
        INSERT INTO kirana_kart.policy_versions
            (policy_version, artifact_hash, description, is_active, vector_status, kb_id)
        VALUES (:eid, :hash, :desc, FALSE, 'pending', :kb_id)
        ON CONFLICT (policy_version) DO UPDATE
            SET artifact_hash = EXCLUDED.artifact_hash,
                description   = EXCLUDED.description,
                vector_status = 'pending',
                kb_id         = EXCLUDED.kb_id
            WHERE kirana_kart.policy_versions.is_active = FALSE
    """), {"eid": entity_id, "hash": fingerprint,
           "desc": (brief.get("name") or "Policy Studio proposal")[:500], "kb_id": kb_id})
    conn.execute(text("""
        INSERT INTO kirana_kart.kb_vector_jobs (version_label, status, kb_id)
        VALUES (:eid, 'pending', :kb_id)
    """), {"eid": entity_id, "kb_id": kb_id})


def submit_for_approval(conn, kb_id: str, entity_id: str, actor,
                        justification: Optional[str] = None) -> dict:
    from app.l45_ml_platform.compiler.sop_extractor import taxonomy_problems

    instance = load_proposal(conn, kb_id, entity_id, lock=True)
    stage = instance["current_stage"]
    justification = (justification or "").strip()

    if stage == "PENDING_APPROVAL":
        # Idempotent re-submit; the only work is retrying preparation that
        # failed or never ran (requests made before preparation existed).
        status = conn.execute(text("""
            SELECT vector_status FROM kirana_kart.policy_versions WHERE policy_version = :eid
        """), {"eid": entity_id}).scalar()
        if status in (None, "failed"):
            _enqueue_preparation(conn, kb_id, entity_id, instance, rules_fingerprint(conn, entity_id))
        return {"approval": _pending_approval(conn, instance["id"]), "stage": stage}

    if stage == "SIMULATION_FAILED":
        if len(justification) < MIN_JUSTIFICATION_CHARS:
            raise LifecycleError(400, (
                "The sample replay changed more decisions than the threshold allows. Explain why this "
                f"change is intended (at least {MIN_JUSTIFICATION_CHARS} characters) to request approval."
            ))
        _move(conn, instance, "SHADOW_GATE", actor,
              f"Larger change accepted for approval review: {justification}",
              {"accepted_change_justification": justification})
    elif stage != "SHADOW_GATE":
        if stage in EDITABLE_STAGES:
            raise LifecycleError(409, "Run the sample decision comparison before requesting approval.")
        raise LifecycleError(409, _locked_message(stage))

    counts = review_counts(conn, kb_id, entity_id)
    if counts["rules"] == 0:
        raise LifecycleError(409, "This proposal has no decisions to approve.")
    if counts["taxonomy_pending"] + counts["actions_pending"] + counts["knowledge_pending"]:
        raise LifecycleError(409, "Resolve every pending review item before requesting approval.")
    problems = taxonomy_problems(conn, kb_id, entity_id)
    if problems:
        raise LifecycleError(409, "Fix the customer-problem mapping first: " + "; ".join(problems))
    missing = knowledge.undefined_in_chunks(conn, kb_id, entity_id, knowledge.business_line_of(conn, kb_id, entity_id))
    if missing:
        raise LifecycleError(409, "Set these variables before requesting approval: "
                             + ", ".join("{{%s}}" % m for m in missing))
    if conn.execute(text("""
        SELECT 1 FROM kirana_kart.knowledge_base_versions WHERE version_label = :eid
    """), {"eid": entity_id}).scalar():
        raise LifecycleError(409, "This version has already been published.")

    fingerprint = rules_fingerprint(conn, entity_id)
    _enqueue_preparation(conn, kb_id, entity_id, instance, fingerprint)

    active, _ = runtime_versions(conn)
    gate = conn.execute(text("""
        SELECT id, passed, metrics FROM kirana_kart.bpm_gate_results
        WHERE instance_id = :iid AND gate_type = 'simulation'
        ORDER BY ran_at DESC, id DESC LIMIT 1
    """), {"iid": instance["id"]}).mappings().first()
    live_cases = conn.execute(text("""
        SELECT COUNT(*) FROM kirana_kart.policy_shadow_results
        WHERE candidate_policy_version = :eid AND active_policy_version = :active
    """), {"eid": entity_id, "active": active}).scalar() or 0

    _move(conn, instance, "PENDING_APPROVAL", actor, "Submitted for approval", {
        "rules_fingerprint": fingerprint,
        "rule_count": counts["rules"],
        "simulation_gate_result_id": gate["id"] if gate else None,
        "simulation_passed": gate["passed"] if gate else None,
        "live_comparison_cases": int(live_cases),
        "replaces_version": active,
    })

    conn.execute(text("""
        UPDATE kirana_kart.bpm_approvals SET status = 'superseded'
        WHERE instance_id = :iid AND status = 'pending'
    """), {"iid": instance["id"]})
    approval = conn.execute(text("""
        INSERT INTO kirana_kart.bpm_approvals (instance_id, stage, status, requested_by_id, requested_by)
        VALUES (:iid, 'PENDING_APPROVAL', 'pending', :uid, :email)
        RETURNING *
    """), {"iid": instance["id"], "uid": actor.id, "email": actor.email}).mappings().first()

    return {"approval": dict(approval), "stage": "PENDING_APPROVAL"}


def readiness(conn, kb_id: str, entity_id: str) -> dict:
    """What an approver needs to know before activation."""
    instance = load_proposal(conn, kb_id, entity_id)
    version = conn.execute(text("""
        SELECT vector_status, artifact_hash, is_active
        FROM kirana_kart.policy_versions WHERE policy_version = :eid
    """), {"eid": entity_id}).mappings().first()
    approval = conn.execute(text("""
        SELECT id, requested_by_id, requested_by, requested_at
        FROM kirana_kart.bpm_approvals
        WHERE instance_id = :iid AND status = 'pending'
        ORDER BY id DESC LIMIT 1
    """), {"iid": instance["id"]}).mappings().first()
    active, shadow = runtime_versions(conn)
    live_cases = conn.execute(text("""
        SELECT COUNT(*) FROM kirana_kart.policy_shadow_results
        WHERE candidate_policy_version = :eid AND active_policy_version = :active
    """), {"eid": entity_id, "active": active}).scalar() or 0
    return {
        "stage": instance["current_stage"],
        "review": review_counts(conn, kb_id, entity_id),
        "preparation_status": version["vector_status"] if version else None,
        "rules_unchanged_since_submission": (
            bool(version) and version["artifact_hash"] == rules_fingerprint(conn, entity_id)
        ),
        "pending_approval": dict(approval) if approval else None,
        "live_version": active,
        "live_comparison_version": shadow,
        "live_comparison_cases": int(live_cases),
        "business_line": knowledge.business_line_of(conn, kb_id, entity_id),
        "undefined_variables": knowledge.undefined_in_chunks(
            conn, kb_id, entity_id, knowledge.business_line_of(conn, kb_id, entity_id),
        ),
    }


# ============================================================
# DECISION
# ============================================================

def approve_and_activate(conn, engine, kb_id: str, instance_id: int, actor,
                         notes: Optional[str] = None, approval_id: Optional[int] = None,
                         require_separate_approver: bool = True) -> dict:
    """
    Approve the open request and make the version live — all in the caller's
    transaction. Any failure leaves the registries, the runtime pointer and
    the stage exactly as they were.
    """
    from app.l1_ingestion.kb_registry.kb_registry_service import KBRegistryService
    from app.l45_ml_platform.compiler.sop_extractor import commit_proposals_to_registry

    instance = load_instance(conn, kb_id, instance_id, lock=True)
    entity_id = instance["entity_id"]
    if instance["entity_type"] != "kb_version":
        raise LifecycleError(400, "Only policy versions are activated through Policy Studio.")

    active, _ = runtime_versions(conn)
    if instance["current_stage"] == "ACTIVE":
        if active == entity_id:
            return {"active_version": entity_id, "previous_version": None, "already_live": True}
        raise LifecycleError(409, (
            f"This version is marked active but the runtime serves '{active}'. "
            "Contact a platform administrator to reconcile the runtime state."
        ))
    if instance["current_stage"] != "PENDING_APPROVAL":
        raise LifecycleError(409, f"Cannot activate from stage '{instance['current_stage']}'. "
                                  "Submit the proposal for approval first.")

    approval = _pending_approval(conn, instance_id, approval_id)
    if not approval:
        raise LifecycleError(409, "There is no open approval request for this proposal.")
    self_approved = approval["requested_by_id"] == actor.id
    if self_approved and require_separate_approver:
        raise LifecycleError(403, "You submitted this change for approval; another policy "
                                  "administrator must approve it.")

    version = conn.execute(text("""
        SELECT vector_status, artifact_hash FROM kirana_kart.policy_versions
        WHERE policy_version = :eid FOR UPDATE
    """), {"eid": entity_id}).mappings().first()
    if not version:
        raise LifecycleError(409, "This version was not prepared for the runtime. Resubmit it for approval.")
    if version["vector_status"] != "completed":
        status = version["vector_status"] or "pending"
        hint = ("The submitter can retry preparation." if status == "failed"
                else "Try again once preparation completes.")
        raise LifecycleError(409, f"Runtime preparation for this version is {status}. {hint}")
    if version["artifact_hash"] != rules_fingerprint(conn, entity_id):
        raise LifecycleError(409, "The rules changed after submission. Reject and resubmit the proposal.")

    try:
        commit_proposals_to_registry(engine, kb_id, entity_id, actor_id=actor.id, conn=conn)
    except ValueError as exc:
        raise LifecycleError(409, f"Could not commit the approved categories and responses: {exc}")
    try:
        KBRegistryService(engine).publish_version(entity_id, actor.email, conn=conn)
    except Exception as exc:
        raise LifecycleError(409, f"Could not activate this version: {exc}")

    conn.execute(text("""
        UPDATE kirana_kart.bpm_approvals
        SET status = 'approved', reviewer_id = :uid, reviewer_name = :email,
            review_notes = :notes, reviewed_at = NOW()
        WHERE id = :id
    """), {"id": approval["id"], "uid": actor.id, "email": actor.email, "notes": notes})
    _move(conn, instance, "ACTIVE", actor,
          f"Approved and activated by {actor.email}. {notes or ''}".strip(), {
              "approval_id": approval["id"],
              "previous_version": active,
              "self_approved": self_approved,
          })

    # The runtime serves one policy. Whatever was live before is not any more.
    retired = []
    for row in conn.execute(text("""
        SELECT id, entity_id FROM kirana_kart.bpm_process_instances
        WHERE current_stage = 'ACTIVE' AND entity_type = 'kb_version' AND id <> :id
        FOR UPDATE
    """), {"id": instance_id}).mappings().all():
        BPMService.transition_on(conn, row["id"], "RETIRED", actor.id, actor.email,
                                 f"Replaced by {entity_id} as the live policy")
        retired.append(row["entity_id"])

    logger.info("Policy %s activated by %s (previous=%s)", entity_id, actor.email, active)
    return {"active_version": entity_id, "previous_version": active,
            "already_live": False, "retired": retired, "self_approved": self_approved}


def reject_proposal(conn, kb_id: str, instance_id: int, actor, notes: Optional[str],
                    approval_id: Optional[int] = None) -> dict:
    instance = load_instance(conn, kb_id, instance_id, lock=True)
    if instance["current_stage"] != "PENDING_APPROVAL":
        raise LifecycleError(409, "Only a proposal awaiting approval can be rejected.")
    notes = (notes or "").strip()
    if not notes:
        raise LifecycleError(400, "Give the reason for rejecting so the author can revise it.")
    approval = _pending_approval(conn, instance_id, approval_id)
    if not approval:
        raise LifecycleError(409, "There is no open approval request for this proposal.")
    conn.execute(text("""
        UPDATE kirana_kart.bpm_approvals
        SET status = 'rejected', reviewer_id = :uid, reviewer_name = :email,
            review_notes = :notes, reviewed_at = NOW()
        WHERE id = :id
    """), {"id": approval["id"], "uid": actor.id, "email": actor.email, "notes": notes})
    _move(conn, instance, "REJECTED", actor, f"Rejected by {actor.email}. {notes}",
          {"approval_id": approval["id"]})
    return {"stage": "REJECTED", "approval_id": approval["id"]}
