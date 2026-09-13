"""
app/admin/services/bpm_service.py
===================================
BPM Process Engine

Manages the lifecycle of KB policy versions and taxonomy versions through
explicit, mandatory stage gates with full audit trails.

Stages (KB policy):
  DRAFT → AI_COMPILE_QUEUED → RULE_EDIT → SIMULATION_GATE
        → SHADOW_GATE → PENDING_APPROVAL → ACTIVE → RETIRED
        (with FAILED / HIGH_DIVERGENCE / REJECTED branches)

Stages (taxonomy):
  DRAFT → DIFF_REVIEW → PENDING_APPROVAL → ACTIVE → RETIRED

All transitions are logged to bpm_stage_transitions.
Rollbacks require ROLLBACK_PENDING → approval → ACTIVE (previous version).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger("kirana_kart.bpm_service")

# ---------------------------------------------------------------------------
# Valid forward transitions per stage (enforced — cannot skip stages)
# ---------------------------------------------------------------------------

KB_TRANSITIONS: Dict[str, List[str]] = {
    "DRAFT":                   ["AI_COMPILE_QUEUED"],
    "AI_COMPILE_QUEUED":       ["AI_COMPILE_FAILED", "RULE_EDIT"],
    "AI_COMPILE_FAILED":       ["AI_COMPILE_QUEUED", "DRAFT"],
    "RULE_EDIT":               ["SIMULATION_GATE"],
    "SIMULATION_GATE":         ["SIMULATION_FAILED", "SHADOW_GATE"],
    "SIMULATION_FAILED":       ["RULE_EDIT"],
    "SHADOW_GATE":             ["SHADOW_DIVERGENCE_HIGH", "PENDING_APPROVAL"],
    "SHADOW_DIVERGENCE_HIGH":  ["RULE_EDIT"],
    "PENDING_APPROVAL":        ["REJECTED", "ACTIVE"],
    "REJECTED":                ["RULE_EDIT"],
    "ACTIVE":                  ["ROLLBACK_PENDING", "RETIRED"],
    "ROLLBACK_PENDING":        ["ACTIVE", "REJECTED"],
    "RETIRED":                 [],
}

TAXONOMY_TRANSITIONS: Dict[str, List[str]] = {
    "DRAFT":            ["DIFF_REVIEW"],
    "DIFF_REVIEW":      ["PENDING_APPROVAL", "DRAFT"],
    "PENDING_APPROVAL": ["REJECTED", "ACTIVE"],
    "REJECTED":         ["DRAFT"],
    "ACTIVE":           ["ROLLBACK_PENDING", "RETIRED"],
    "ROLLBACK_PENDING": ["ACTIVE", "REJECTED"],
    "RETIRED":          [],
}

TERMINAL_STAGES = {"ACTIVE", "RETIRED"}


def _transition_map(process_name: str) -> Dict[str, List[str]]:
    if "taxonomy" in process_name:
        return TAXONOMY_TRANSITIONS
    return KB_TRANSITIONS


class BPMService:
    """
    Core BPM engine. All methods are synchronous; use in FastAPI with run_in_executor
    if needed, or simply call directly (they are fast DB operations).
    """

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    # ================================================================
    # CREATE INSTANCE
    # ================================================================

    def create_instance(
        self,
        kb_id: str,
        entity_id: str,
        entity_type: str,
        process_name: str,
        created_by_id: int,
        created_by_name: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a new BPM process instance starting at DRAFT.

        Args:
            kb_id:          Which KB this version belongs to
            entity_id:      version_label (e.g., 'v2.1') or taxonomy snapshot label
            entity_type:    'kb_version' | 'taxonomy_version'
            process_name:   References bpm_process_definitions.process_name
            created_by_id:  User ID of the initiator
            created_by_name: Human name for display
            metadata:       Optional extra data to store on the instance

        Returns:
            The created instance dict.
        """
        with self.engine.begin() as conn:
            row = conn.execute(text("""
                INSERT INTO kirana_kart.bpm_process_instances
                    (kb_id, process_name, entity_id, entity_type,
                     current_stage, created_by_id, created_by_name, metadata)
                VALUES
                    (:kb_id, :process_name, :entity_id, :entity_type,
                     'DRAFT', :created_by_id, :created_by_name, :metadata)
                RETURNING *
            """), {
                "kb_id":           kb_id,
                "process_name":    process_name,
                "entity_id":       entity_id,
                "entity_type":     entity_type,
                "created_by_id":   created_by_id,
                "created_by_name": created_by_name,
                "metadata":        json.dumps(metadata or {}),
            }).mappings().first()

            instance = dict(row)

            # Log initial DRAFT transition
            conn.execute(text("""
                INSERT INTO kirana_kart.bpm_stage_transitions
                    (instance_id, from_stage, to_stage, actor_id, actor_name, notes)
                VALUES (:instance_id, 'START', 'DRAFT', :actor_id, :actor_name,
                        'Instance created')
            """), {
                "instance_id": instance["id"],
                "actor_id":    created_by_id,
                "actor_name":  created_by_name,
            })

        logger.info(
            "BPM: created instance %d | kb=%s entity=%s process=%s",
            instance["id"], kb_id, entity_id, process_name,
        )
        return instance

    # ================================================================
    # TRANSITION STAGE
    # ================================================================

    def transition(
        self,
        instance_id: int,
        to_stage: str,
        actor_id: Optional[int] = None,
        actor_name: Optional[str] = None,
        notes: Optional[str] = None,
        transition_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Move an instance to the next stage (enforces valid transitions).

        Raises ValueError if the transition is not allowed from the current stage.
        """
        with self.engine.begin() as conn:
            row = conn.execute(text("""
                SELECT id, current_stage, process_name, kb_id, entity_id
                FROM kirana_kart.bpm_process_instances
                WHERE id = :id
                FOR UPDATE
            """), {"id": instance_id}).mappings().first()

            if not row:
                raise ValueError(f"BPM instance {instance_id} not found")

            current_stage = row["current_stage"]
            process_name  = row["process_name"]
            allowed       = _transition_map(process_name).get(current_stage, [])

            if to_stage not in allowed:
                raise ValueError(
                    f"Cannot transition from {current_stage} → {to_stage} "
                    f"(allowed: {allowed})"
                )

            completed_at = "NOW()" if to_stage in TERMINAL_STAGES else "NULL"

            conn.execute(text(f"""
                UPDATE kirana_kart.bpm_process_instances
                SET current_stage  = :to_stage,
                    completed_at   = {completed_at},
                    updated_at     = NOW()
                WHERE id = :id
            """), {"to_stage": to_stage, "id": instance_id})

            conn.execute(text("""
                INSERT INTO kirana_kart.bpm_stage_transitions
                    (instance_id, from_stage, to_stage, actor_id, actor_name,
                     notes, transition_data)
                VALUES (:instance_id, :from_stage, :to_stage, :actor_id, :actor_name,
                        :notes, :transition_data)
            """), {
                "instance_id":     instance_id,
                "from_stage":      current_stage,
                "to_stage":        to_stage,
                "actor_id":        actor_id,
                "actor_name":      actor_name,
                "notes":           notes,
                "transition_data": json.dumps(transition_data or {}),
            })

        logger.info(
            "BPM: transition %d | %s → %s | actor=%s",
            instance_id, current_stage, to_stage, actor_name,
        )
        return self.get_instance(instance_id)

    # ================================================================
    # REQUEST APPROVAL
    # ================================================================

    def request_approval(
        self,
        instance_id: int,
        stage: str,
        requested_by_id: int,
        requested_by: str,
    ) -> Dict[str, Any]:
        """
        Create a pending approval request for the current stage.
        Used at PENDING_APPROVAL and ROLLBACK_PENDING stages.
        """
        with self.engine.begin() as conn:
            # Cancel any existing pending approval for this instance+stage
            conn.execute(text("""
                UPDATE kirana_kart.bpm_approvals
                SET status = 'superseded'
                WHERE instance_id = :id AND stage = :stage AND status = 'pending'
            """), {"id": instance_id, "stage": stage})

            row = conn.execute(text("""
                INSERT INTO kirana_kart.bpm_approvals
                    (instance_id, stage, status, requested_by_id, requested_by)
                VALUES (:instance_id, :stage, 'pending', :req_id, :req_name)
                RETURNING *
            """), {
                "instance_id": instance_id,
                "stage":       stage,
                "req_id":      requested_by_id,
                "req_name":    requested_by,
            }).mappings().first()

        return dict(row)

    # ================================================================
    # APPROVE
    # ================================================================

    def approve(
        self,
        approval_id: int,
        reviewer_id: int,
        reviewer_name: str,
        notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Approve a pending approval, then auto-transition the instance
        to the next stage (ACTIVE for PENDING_APPROVAL, ACTIVE for ROLLBACK_PENDING).
        """
        with self.engine.begin() as conn:
            approval = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_approvals
                WHERE id = :id AND status = 'pending'
                FOR UPDATE
            """), {"id": approval_id}).mappings().first()

            if not approval:
                raise ValueError(f"Approval {approval_id} not found or not pending")

            conn.execute(text("""
                UPDATE kirana_kart.bpm_approvals
                SET status        = 'approved',
                    reviewer_id   = :reviewer_id,
                    reviewer_name = :reviewer_name,
                    review_notes  = :notes,
                    reviewed_at   = NOW()
                WHERE id = :id
            """), {
                "id":            approval_id,
                "reviewer_id":   reviewer_id,
                "reviewer_name": reviewer_name,
                "notes":         notes,
            })

        # Auto-transition instance to ACTIVE
        return self.transition(
            instance_id=approval["instance_id"],
            to_stage="ACTIVE",
            actor_id=reviewer_id,
            actor_name=reviewer_name,
            notes=f"Approved by {reviewer_name}. {notes or ''}".strip(),
        )

    # ================================================================
    # REJECT
    # ================================================================

    def reject(
        self,
        approval_id: int,
        reviewer_id: int,
        reviewer_name: str,
        notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Reject a pending approval, sending instance back to REJECTED stage.
        """
        with self.engine.begin() as conn:
            approval = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_approvals
                WHERE id = :id AND status = 'pending'
                FOR UPDATE
            """), {"id": approval_id}).mappings().first()

            if not approval:
                raise ValueError(f"Approval {approval_id} not found or not pending")

            conn.execute(text("""
                UPDATE kirana_kart.bpm_approvals
                SET status        = 'rejected',
                    reviewer_id   = :reviewer_id,
                    reviewer_name = :reviewer_name,
                    review_notes  = :notes,
                    reviewed_at   = NOW()
                WHERE id = :id
            """), {
                "id":            approval_id,
                "reviewer_id":   reviewer_id,
                "reviewer_name": reviewer_name,
                "notes":         notes,
            })

        return self.transition(
            instance_id=approval["instance_id"],
            to_stage="REJECTED",
            actor_id=reviewer_id,
            actor_name=reviewer_name,
            notes=f"Rejected by {reviewer_name}. {notes or ''}".strip(),
        )

    # ================================================================
    # RECORD GATE RESULT
    # ================================================================

    def record_gate_result(
        self,
        instance_id: int,
        gate_type: str,
        passed: bool,
        metrics: Dict[str, Any],
        ml_prediction: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Store a simulation / shadow / diff_review gate outcome.
        Called by the simulation service and shadow service after each gate run.
        """
        with self.engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO kirana_kart.bpm_gate_results
                    (instance_id, gate_type, passed, metrics, ml_prediction)
                VALUES (:instance_id, :gate_type, :passed, :metrics, :ml_prediction)
            """), {
                "instance_id":   instance_id,
                "gate_type":     gate_type,
                "passed":        passed,
                "metrics":       json.dumps(metrics),
                "ml_prediction": json.dumps(ml_prediction) if ml_prediction else None,
            })

    # ================================================================
    # QUERY
    # ================================================================

    def get_instance(self, instance_id: int) -> Dict[str, Any]:
        with self.engine.connect() as conn:
            row = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_process_instances
                WHERE id = :id
            """), {"id": instance_id}).mappings().first()
            if not row:
                raise ValueError(f"BPM instance {instance_id} not found")
            return dict(row)

    def get_instance_by_entity(
        self, kb_id: str, entity_id: str, entity_type: str
    ) -> Optional[Dict[str, Any]]:
        with self.engine.connect() as conn:
            row = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_process_instances
                WHERE kb_id = :kb_id
                  AND entity_id = :entity_id
                  AND entity_type = :entity_type
                ORDER BY started_at DESC
                LIMIT 1
            """), {
                "kb_id":       kb_id,
                "entity_id":   entity_id,
                "entity_type": entity_type,
            }).mappings().first()
            return dict(row) if row else None

    def list_instances(
        self,
        kb_id: str,
        stage_filter: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            query = """
                SELECT i.*,
                       (SELECT COUNT(*) FROM kirana_kart.bpm_approvals a
                        WHERE a.instance_id = i.id AND a.status = 'pending')
                       AS pending_approvals
                FROM kirana_kart.bpm_process_instances i
                WHERE i.kb_id = :kb_id
            """
            params: Dict[str, Any] = {"kb_id": kb_id, "limit": limit}
            if stage_filter:
                query += " AND i.current_stage = :stage"
                params["stage"] = stage_filter
            query += " ORDER BY i.started_at DESC LIMIT :limit"

            rows = conn.execute(text(query), params).mappings().all()
            return [dict(r) for r in rows]

    def get_audit_trail(self, instance_id: int) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_stage_transitions
                WHERE instance_id = :id
                ORDER BY transitioned_at ASC
            """), {"id": instance_id}).mappings().all()
            return [dict(r) for r in rows]

    def get_gate_results(self, instance_id: int) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_gate_results
                WHERE instance_id = :id
                ORDER BY ran_at DESC
            """), {"id": instance_id}).mappings().all()
            return [dict(r) for r in rows]

    def get_pending_approvals(self, instance_id: int) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT * FROM kirana_kart.bpm_approvals
                WHERE instance_id = :id AND status = 'pending'
                ORDER BY requested_at DESC
            """), {"id": instance_id}).mappings().all()
            return [dict(r) for r in rows]

    # ================================================================
    # KB MANAGEMENT
    # ================================================================

    def list_kbs(self, user_id: Optional[int] = None, is_super_admin: bool = False) -> List[Dict[str, Any]]:
        """
        List KBs accessible to the user.
        Super admins see all; others see only KBs with kb_user_access rows.
        """
        with self.engine.connect() as conn:
            if is_super_admin:
                rows = conn.execute(text("""
                    SELECT kb.*,
                           (SELECT COUNT(*) FROM kirana_kart.kb_user_access a WHERE a.kb_id = kb.kb_id) AS member_count,
                           rc.active_version
                    FROM kirana_kart.knowledge_bases kb
                    LEFT JOIN kirana_kart.kb_runtime_config rc ON rc.kb_id = kb.kb_id
                    WHERE kb.is_active = TRUE
                    ORDER BY kb.created_at ASC
                """)).mappings().all()
            else:
                rows = conn.execute(text("""
                    SELECT kb.*,
                           a.role AS my_role,
                           rc.active_version
                    FROM kirana_kart.knowledge_bases kb
                    JOIN kirana_kart.kb_user_access a
                         ON a.kb_id = kb.kb_id AND a.user_id = :user_id
                    LEFT JOIN kirana_kart.kb_runtime_config rc ON rc.kb_id = kb.kb_id
                    WHERE kb.is_active = TRUE
                    ORDER BY kb.created_at ASC
                """), {"user_id": user_id}).mappings().all()
        return [dict(r) for r in rows]

    def create_kb(
        self,
        kb_id: str,
        kb_name: str,
        description: Optional[str],
        created_by_id: int,
    ) -> Dict[str, Any]:
        with self.engine.begin() as conn:
            row = conn.execute(text("""
                INSERT INTO kirana_kart.knowledge_bases
                    (kb_id, kb_name, description, created_by)
                VALUES (:kb_id, :kb_name, :description, :created_by)
                RETURNING *
            """), {
                "kb_id":       kb_id,
                "kb_name":     kb_name,
                "description": description,
                "created_by":  created_by_id,
            }).mappings().first()

            # Insert default BPM process definitions for this KB
            for process_name, stages, gate_config in [
                (
                    f"kb_policy_lifecycle_{kb_id}",
                    '["DRAFT","AI_COMPILE_QUEUED","AI_COMPILE_FAILED","RULE_EDIT",'
                    '"SIMULATION_GATE","SIMULATION_FAILED","SHADOW_GATE",'
                    '"SHADOW_DIVERGENCE_HIGH","PENDING_APPROVAL","REJECTED","ACTIVE",'
                    '"ROLLBACK_PENDING","RETIRED"]',
                    '{"SIMULATION_GATE":{"max_change_rate":0.20},'
                    '"SHADOW_GATE":{"min_tickets":500,"max_divergence_rate":0.10}}',
                ),
                (
                    f"taxonomy_lifecycle_{kb_id}",
                    '["DRAFT","DIFF_REVIEW","PENDING_APPROVAL","REJECTED","ACTIVE","ROLLBACK_PENDING","RETIRED"]',
                    "{}",
                ),
            ]:
                conn.execute(text("""
                    INSERT INTO kirana_kart.bpm_process_definitions
                        (process_name, kb_id, stages, gate_config)
                    VALUES (:process_name, :kb_id, :stages::jsonb, :gate_config::jsonb)
                    ON CONFLICT (process_name) DO NOTHING
                """), {
                    "process_name": process_name,
                    "kb_id":        kb_id,
                    "stages":       stages,
                    "gate_config":  gate_config,
                })

        logger.info("BPM: created KB %s (%s)", kb_id, kb_name)
        return dict(row)

    def set_kb_member_role(
        self,
        kb_id: str,
        user_id: int,
        role: str,
        granted_by_id: int,
    ) -> None:
        with self.engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO kirana_kart.kb_user_access
                    (kb_id, user_id, role, granted_by)
                VALUES (:kb_id, :user_id, :role, :granted_by)
                ON CONFLICT (kb_id, user_id)
                DO UPDATE SET role = :role, granted_by = :granted_by, granted_at = NOW()
            """), {
                "kb_id":      kb_id,
                "user_id":    user_id,
                "role":       role,
                "granted_by": granted_by_id,
            })

    def remove_kb_member(self, kb_id: str, user_id: int) -> None:
        with self.engine.begin() as conn:
            conn.execute(text("""
                DELETE FROM kirana_kart.kb_user_access
                WHERE kb_id = :kb_id AND user_id = :user_id
            """), {"kb_id": kb_id, "user_id": user_id})

    def get_kb_members(self, kb_id: str) -> List[Dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT a.id, a.kb_id, a.user_id, a.role, a.granted_at,
                       u.email, u.full_name
                FROM kirana_kart.kb_user_access a
                JOIN kirana_kart.users u ON u.id = a.user_id
                WHERE a.kb_id = :kb_id
                ORDER BY a.granted_at ASC
            """), {"kb_id": kb_id}).mappings().all()
            return [dict(r) for r in rows]

    def check_kb_access(
        self,
        kb_id: str,
        user_id: int,
        required_role: str,
        is_super_admin: bool = False,
    ) -> bool:
        """
        Returns True if the user has at least the required_role on this KB.
        Super admins always return True.
        Role hierarchy: admin > edit > view
        """
        if is_super_admin:
            return True

        role_rank = {"view": 1, "edit": 2, "admin": 3}
        required_rank = role_rank.get(required_role, 99)

        with self.engine.connect() as conn:
            row = conn.execute(text("""
                SELECT role FROM kirana_kart.kb_user_access
                WHERE kb_id = :kb_id AND user_id = :user_id
            """), {"kb_id": kb_id, "user_id": user_id}).first()

        if not row:
            return False
        return role_rank.get(row[0], 0) >= required_rank
