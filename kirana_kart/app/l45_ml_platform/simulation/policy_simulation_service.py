"""
Policy Simulation Service
=========================

Runs offline simulations comparing two policy versions.

Supports:
- Batch simulation over sample tickets
- Per-ticket simulation with full evaluation trace
  (fetch a real ticket and evaluate it against two versions side-by-side)
- Full Cardinal pipeline simulation
  (run real ticket through all 4 stages for two versions — LLM + Weaviate + deterministic)
"""

import copy
import logging
import uuid

from sqlalchemy import text

logger = logging.getLogger("policy_simulation")
logger.setLevel(logging.INFO)


class PolicySimulationService:

    def __init__(self, engine):
        self.engine = engine

    # ============================================================
    # PUBLIC: TICKET SEARCH (for simulation picker)
    # ============================================================

    def get_tickets(self, search: str | None = None, limit: int = 20) -> list:
        """Return real tickets from fdraw + evaluation context for simulation selection."""
        with self.engine.connect() as conn:
            base = """
                SELECT
                    f.ticket_id,
                    f.subject,
                    f.module,
                    f.cx_email,
                    f.created_at,
                    l1.issue_type_l1           AS issue_type_l1,
                    l1.issue_type_l2           AS issue_type_l2,
                    l3.final_action_code,
                    l3.automation_pathway,
                    l3.final_refund_amount,
                    l3.policy_version          AS evaluated_on_version
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.llm_output_1 l1 ON l1.ticket_id = f.ticket_id
                LEFT JOIN kirana_kart.llm_output_3 l3 ON l3.ticket_id = f.ticket_id
                WHERE 1=1
            """
            params: dict = {"lim": limit}
            if search:
                base += " AND (f.subject ILIKE :s OR CAST(f.ticket_id AS TEXT) = :exact)"
                params["s"] = f"%{search}%"
                params["exact"] = search
            base += " ORDER BY f.created_at DESC LIMIT :lim"
            rows = conn.execute(text(base), params).mappings().all()
        return [dict(r) for r in rows]

    # ============================================================
    # PUBLIC: SINGLE TICKET DETAIL
    # ============================================================

    def get_ticket_detail(self, ticket_id: int) -> dict:
        """Load full ticket context for simulation (fdraw + llm_output_1/2/3)."""
        with self.engine.connect() as conn:
            row = conn.execute(text("""
                SELECT
                    f.ticket_id,
                    f.subject,
                    f.description,
                    f.module,
                    f.cx_email,
                    f.created_at,
                    l1.issue_type_l1            AS issue_type_l1,
                    l1.issue_type_l2            AS issue_type_l2,
                    l1.confidence_entailment,
                    l2.order_value,
                    l2.fraud_segment,
                    l2.value_segment,
                    l2.greedy_classification,
                    l2.sla_breach,
                    l2.calculated_gratification,
                    l2.capped_gratification,
                    l2.multiplier,
                    l2.action_code_id           AS l2_action_code_id,
                    l3.final_action_code,
                    l3.final_refund_amount,
                    l3.automation_pathway,
                    l3.detailed_reasoning,
                    l3.policy_version           AS evaluated_on_version,
                    l3.discrepancy_detected
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.llm_output_1 l1 ON l1.ticket_id = f.ticket_id
                LEFT JOIN kirana_kart.llm_output_2 l2 ON l2.ticket_id = f.ticket_id
                LEFT JOIN kirana_kart.llm_output_3 l3 ON l3.ticket_id = f.ticket_id
                WHERE f.ticket_id = :tid
                LIMIT 1
            """), {"tid": ticket_id}).mappings().first()
        if not row:
            raise Exception(f"Ticket {ticket_id} not found")
        return dict(row)

    # ============================================================
    # PUBLIC: PER-TICKET SIMULATION WITH TRACE
    # ============================================================

    def simulate_ticket(
        self,
        ticket_id: int,
        baseline_version: str,
        candidate_version: str,
    ) -> dict:
        """
        Run one real ticket through two policy versions.
        Returns full evaluation trace for both, plus comparison summary.
        """
        logger.info(
            "simulate_ticket ticket_id=%s baseline=%s candidate=%s",
            ticket_id, baseline_version, candidate_version,
        )

        ticket = self.get_ticket_detail(ticket_id)
        ticket_ctx = self._build_ticket_context(ticket)

        baseline_rules = self._load_rules_enriched(baseline_version)
        candidate_rules = self._load_rules_enriched(candidate_version)

        baseline_eval = self._evaluate_with_trace(ticket_ctx, baseline_rules)
        candidate_eval = self._evaluate_with_trace(ticket_ctx, candidate_rules)

        # Rule IDs that matched in each version
        b_matched = {r["rule_id"] for r in baseline_eval["matched_rules"]}
        c_matched = {r["rule_id"] for r in candidate_eval["matched_rules"]}

        # All rule IDs across both versions
        b_all = {r["rule_id"] for r in baseline_rules}
        c_all = {r["rule_id"] for r in candidate_rules}

        comparison = {
            "decision_changed": baseline_eval["final_action"] != candidate_eval["final_action"],
            "final_action_baseline": baseline_eval["final_action"],
            "final_action_candidate": candidate_eval["final_action"],
            "common_matched_rules": sorted(b_matched & c_matched),
            "baseline_only_matched": sorted(b_matched - c_matched),
            "candidate_only_matched": sorted(c_matched - b_matched),
            "rules_added_in_candidate": sorted(c_all - b_all),
            "rules_removed_in_candidate": sorted(b_all - c_all),
            "total_rules_baseline": len(baseline_rules),
            "total_rules_candidate": len(candidate_rules),
        }

        return {
            "ticket": ticket,
            "ticket_context": ticket_ctx,
            "baseline": {
                "version": baseline_version,
                **baseline_eval,
            },
            "candidate": {
                "version": candidate_version,
                **candidate_eval,
            },
            "comparison": comparison,
        }

    # ============================================================
    # PUBLIC: FULL CARDINAL SIMULATION (4-stage LLM pipeline)
    # ============================================================

    def simulate_ticket_cardinal(
        self,
        ticket_id: int,
        baseline_version: str,
        candidate_version: str,
    ) -> dict:
        """
        Run a real ticket through all 4 Cardinal stages for two policy versions.

        Stage 0 (classification) runs ONCE — it is policy-version agnostic.
        Stages 1, 2, 3 run for EACH version because Stage 1 uses Weaviate
        `policy_rule_candidates(query, policy_version)` which is version-sensitive.

        No DB writes — calls stage runner functions directly, bypassing the
        _run_stage_* wrappers in worker.py that write to llm_output_* tables.
        """
        logger.info(
            "simulate_ticket_cardinal ticket_id=%s baseline=%s candidate=%s",
            ticket_id, baseline_version, candidate_version,
        )

        # 1. Fetch ticket + canonical_payload
        ticket_full = self._fetch_ticket_with_payload(ticket_id)
        canonical_payload = ticket_full.get("canonical_payload") or {}
        if isinstance(canonical_payload, str):
            import json
            try:
                canonical_payload = json.loads(canonical_payload)
            except Exception:
                canonical_payload = {}
        customer_context = canonical_payload.get("customer_context") or {}

        # 2. Build ticket_context (used by Stage 0 and Stage 1)
        ticket_context = {
            "ticket_id": ticket_id,
            "subject": ticket_full.get("subject"),
            "description": ticket_full.get("description"),
            "order_id": (
                canonical_payload.get("order_id")
                or (canonical_payload.get("raw_payload") or {}).get("order_id")
            ),
            "cx_email": ticket_full.get("cx_email"),
            "module": ticket_full.get("module"),
            "channel": "email",
        }

        # 3. Build base fields dict (enriched from canonical_payload)
        order_ctx = customer_context.get("order") or {}
        risk_ctx = customer_context.get("risk") or {}
        policy_ctx = customer_context.get("policy") or {}
        customer_profile = customer_context.get("customer") or {}

        base_fields = {
            "order_context": order_ctx,
            "risk_context": risk_ctx,
            "policy_context": policy_ctx,
            "customer_profile": customer_profile,
            "prior_complaints_30d": int(
                customer_context.get("prior_complaints_30d") or 0
            ),
            "module": ticket_full.get("module", ""),
            "subject": ticket_full.get("subject", ""),
            "cx_email": ticket_full.get("cx_email", ""),
            "channel": "email",
            "recommended_queue": "STANDARD_REVIEW",
        }

        # 4. Stage 0 — runs ONCE (classification is policy-version agnostic)
        sim_exec_id = f"sim-{ticket_id}-{uuid.uuid4().hex[:8]}"
        try:
            from app.l4_agents.ecommerce.stage0_classifier import run as stage0_run
            stage0_result = stage0_run(
                ticket_id=ticket_id,
                execution_id=sim_exec_id,
                ticket_context=ticket_context,
                fields=base_fields,
            )
        except Exception as e:
            logger.warning("Stage0 failed in simulation: %s", e)
            stage0_result = {
                "issue_type_l1": ticket_full.get("issue_type_l1", "unknown"),
                "issue_type_l2": ticket_full.get("issue_type_l2", "unknown"),
                "confidence": 0.5,
                "image_required": False,
                "reasoning": f"Stage0 unavailable: {e}",
                "raw_response": None,
            }

        # 5. Per-version runner: Stage 1 → 2 → (3 if HITL)
        def _run_for_version(version: str) -> dict:
            fields = copy.deepcopy(base_fields)
            fields["active_policy"] = version
            pc = copy.deepcopy(fields.get("policy_context") or {})
            pc["active_version"] = version
            fields["policy_context"] = pc

            rules = []
            try:
                rules = self._load_rules_enriched(version)
            except Exception as e:
                logger.warning("Rules load failed for version=%s: %s", version, e)

            # Stage 1 — LLM evaluation with Weaviate rule candidates
            stage1_error = None
            try:
                from app.l4_agents.ecommerce.stage1_evaluator import run as stage1_run
                stage1_result = stage1_run(
                    ticket_id=ticket_id,
                    execution_id=f"{sim_exec_id}-{version}",
                    ticket_context=ticket_context,
                    stage0_result=stage0_result,
                    rules=rules,
                    fields=fields,
                )
            except Exception as e:
                stage1_error = str(e)
                logger.warning("Stage1 failed for version=%s: %s", version, e)
                stage1_result = {
                    "action_code": "REFUND_PARTIAL",
                    "calculated_gratification": 0.0,
                    "fraud_segment": "NORMAL",
                    "greedy_classification": "NORMAL",
                    "reasoning": f"Stage1 unavailable: {e}",
                    "overall_confidence": 0.5,
                }

            # Stage 2 — deterministic validation (no LLM)
            stage2_error = None
            try:
                from app.l4_agents.ecommerce.stage2_validator import run as stage2_run
                stage2_result = stage2_run(
                    ticket_id=ticket_id,
                    execution_id=f"{sim_exec_id}-{version}",
                    stage0_result=stage0_result,
                    stage1_result=stage1_result,
                    rules=rules,
                    fields=fields,
                )
            except Exception as e:
                stage2_error = str(e)
                logger.warning("Stage2 failed for version=%s: %s", version, e)
                stage2_result = {
                    "final_action_code": stage1_result.get("action_code", "UNKNOWN"),
                    "final_refund_amount": stage1_result.get("calculated_gratification", 0),
                    "automation_pathway": "MANUAL_REVIEW",
                    "reasoning": f"Stage2 unavailable: {e}",
                }

            automation_pathway = stage2_result.get("automation_pathway", "AUTO_RESOLVED")

            # Stage 3 — response draft (only for HITL, pure Python)
            stage3_result = None
            if automation_pathway == "HITL":
                try:
                    from app.l4_agents.ecommerce.stage3_responder import run as stage3_run
                    stage3_result = stage3_run(
                        ticket_id=ticket_id,
                        execution_id=f"{sim_exec_id}-{version}",
                        stage0_result=stage0_result,
                        stage1_result=stage1_result,
                        stage2_result=stage2_result,
                        fields=fields,
                    )
                except Exception as e:
                    logger.warning("Stage3 failed for version=%s: %s", version, e)
                    stage3_result = {"response_draft": f"Stage3 unavailable: {e}"}

            return {
                "version": version,
                "stage1": {
                    "action_code": stage1_result.get("action_code"),
                    "calculated_gratification": stage1_result.get("calculated_gratification"),
                    "fraud_segment": stage1_result.get("fraud_segment"),
                    "greedy_classification": stage1_result.get("greedy_classification"),
                    "greedy_signals_count": stage1_result.get("greedy_signals_count"),
                    "sla_breach": stage1_result.get("sla_breach"),
                    "order_value": stage1_result.get("order_value"),
                    "overall_confidence": stage1_result.get("overall_confidence"),
                    "standard_logic_passed": stage1_result.get("standard_logic_passed"),
                    "reasoning": stage1_result.get("reasoning"),
                    "error": stage1_error,
                },
                "stage2": {
                    "final_action_code": stage2_result.get("final_action_code"),
                    "final_refund_amount": float(stage2_result.get("final_refund_amount") or 0),
                    "automation_pathway": automation_pathway,
                    "discrepancy_detected": stage2_result.get("discrepancy_detected"),
                    "discrepancy_details": stage2_result.get("discrepancy_details"),
                    "override_applied": stage2_result.get("override_applied"),
                    "override_reason": stage2_result.get("override_reason"),
                    "validation_status": stage2_result.get("validation_status"),
                    "reasoning": stage2_result.get("reasoning"),
                    "error": stage2_error,
                },
                "stage3": stage3_result,
                "automation_pathway": automation_pathway,
                "final_action_code": stage2_result.get("final_action_code"),
                "final_refund_amount": float(stage2_result.get("final_refund_amount") or 0),
                "rules_count": len(rules),
            }

        baseline_eval = _run_for_version(baseline_version)
        candidate_eval = _run_for_version(candidate_version)

        # 6. Build comparison
        b_action = baseline_eval["final_action_code"]
        c_action = candidate_eval["final_action_code"]
        b_pathway = baseline_eval["automation_pathway"]
        c_pathway = candidate_eval["automation_pathway"]
        b_refund = baseline_eval["final_refund_amount"]
        c_refund = candidate_eval["final_refund_amount"]

        comparison = {
            "decision_changed": b_action != c_action,
            "pathway_changed": b_pathway != c_pathway,
            "refund_changed": abs(float(b_refund or 0) - float(c_refund or 0)) > 0.01,
            "final_action_baseline": b_action,
            "final_action_candidate": c_action,
            "pathway_baseline": b_pathway,
            "pathway_candidate": c_pathway,
            "refund_baseline": b_refund,
            "refund_candidate": c_refund,
            "stage1_action_changed": (
                baseline_eval["stage1"].get("action_code") !=
                candidate_eval["stage1"].get("action_code")
            ),
            "stage1_action_baseline": baseline_eval["stage1"].get("action_code"),
            "stage1_action_candidate": candidate_eval["stage1"].get("action_code"),
            "greedy_changed": (
                baseline_eval["stage1"].get("greedy_classification") !=
                candidate_eval["stage1"].get("greedy_classification")
            ),
            "greedy_baseline": baseline_eval["stage1"].get("greedy_classification"),
            "greedy_candidate": candidate_eval["stage1"].get("greedy_classification"),
            "rules_baseline": baseline_eval["rules_count"],
            "rules_candidate": candidate_eval["rules_count"],
        }

        return {
            "ticket": self.get_ticket_detail(ticket_id),
            "ticket_context": ticket_context,
            "stage0": {
                "issue_type_l1": stage0_result.get("issue_type_l1"),
                "issue_type_l2": stage0_result.get("issue_type_l2"),
                "confidence": stage0_result.get("confidence"),
                "image_required": stage0_result.get("image_required"),
                "reasoning": stage0_result.get("reasoning"),
            },
            "baseline": baseline_eval,
            "candidate": candidate_eval,
            "comparison": comparison,
        }

    # ============================================================
    # INTERNAL: FETCH TICKET WITH CANONICAL PAYLOAD
    # ============================================================

    def _fetch_ticket_with_payload(self, ticket_id: int) -> dict:
        """Fetch fdraw row including canonical_payload for simulation context building."""
        with self.engine.connect() as conn:
            row = conn.execute(text("""
                SELECT
                    f.ticket_id,
                    f.subject,
                    f.description,
                    f.module,
                    f.cx_email,
                    f.created_at,
                    f.canonical_payload,
                    l1.issue_type_l1,
                    l1.issue_type_l2
                FROM kirana_kart.fdraw f
                LEFT JOIN kirana_kart.llm_output_1 l1 ON l1.ticket_id = f.ticket_id
                WHERE f.ticket_id = :tid
                LIMIT 1
            """), {"tid": ticket_id}).mappings().first()
        if not row:
            raise Exception(f"Ticket {ticket_id} not found")
        return dict(row)

    # ============================================================
    # PUBLIC: BATCH SIMULATION (original)
    # ============================================================

    def run_simulation(self, candidate_version: str, baseline_version: str):
        logger.info(
            "run_simulation baseline=%s candidate=%s",
            baseline_version, candidate_version,
        )

        tickets = self._load_sample_tickets()
        if not tickets:
            raise Exception("No sample tickets found in simulation_tickets table")

        baseline_rules = self._load_rules_enriched(baseline_version)
        candidate_rules = self._load_rules_enriched(candidate_version)

        differences = []
        for ticket in tickets:
            b_action = self._evaluate(ticket, baseline_rules)
            c_action = self._evaluate(ticket, candidate_rules)
            if b_action != c_action:
                differences.append({
                    "ticket_id": ticket["ticket_id"],
                    "baseline": b_action,
                    "candidate": c_action,
                })

        result = {
            "tickets_tested": len(tickets),
            "differences": len(differences),
            "examples": differences[:20],
        }
        logger.info("run_simulation done: %s", result)
        return result

    # ============================================================
    # INTERNAL: LOAD RULES (enriched with action_code_id string)
    # ============================================================

    def _load_rules_enriched(self, version: str) -> list:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    rr.rule_id,
                    rr.module_name,
                    rr.rule_type,
                    rr.priority,
                    rr.rule_scope,
                    rr.issue_type_l1,
                    rr.issue_type_l2,
                    rr.business_line,
                    rr.customer_segment,
                    rr.fraud_segment,
                    rr.min_order_value,
                    rr.max_order_value,
                    rr.min_repeat_count,
                    rr.max_repeat_count,
                    rr.sla_breach_required,
                    rr.evidence_required,
                    rr.conditions,
                    rr.action_id,
                    rr.action_payload,
                    rr.overrideable,
                    mac.action_code_id,
                    mac.action_name,
                    mac.requires_refund,
                    mac.requires_escalation
                FROM kirana_kart.rule_registry rr
                LEFT JOIN kirana_kart.master_action_codes mac ON mac.id = rr.action_id
                WHERE rr.policy_version = :v
                ORDER BY rr.priority DESC
            """), {"v": version}).mappings().all()

        if not rows:
            raise Exception(f"No rules found for policy version '{version}'")

        return [dict(r) for r in rows]

    # ============================================================
    # INTERNAL: LOAD SAMPLE TICKETS (batch sim)
    # ============================================================

    def _load_sample_tickets(self) -> list:
        with self.engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    ticket_id, issue_type, order_value,
                    fraud_score, customer_tier, business_line
                FROM kirana_kart.simulation_tickets
                LIMIT 1000
            """)).mappings().all()
        return [dict(r) for r in rows]

    # ============================================================
    # INTERNAL: BUILD TICKET CONTEXT FROM REAL DATA
    # ============================================================

    def _build_ticket_context(self, ticket: dict) -> dict:
        """Normalise fdraw + llm_output_* fields into a context dict for rule matching."""
        return {
            "ticket_id": ticket.get("ticket_id"),
            "issue_type": ticket.get("issue_type_l1") or ticket.get("module"),
            "issue_type_l1": ticket.get("issue_type_l1"),
            "issue_type_l2": ticket.get("issue_type_l2"),
            "business_line": ticket.get("module"),
            "order_value": float(ticket.get("order_value") or 0),
            "fraud_segment": ticket.get("fraud_segment"),
            "value_segment": ticket.get("value_segment"),
            "greedy_classification": ticket.get("greedy_classification"),
            "sla_breach": bool(ticket.get("sla_breach")),
            # no fraud_score / customer_tier available from pipeline outputs
        }

    # ============================================================
    # INTERNAL: EVALUATE WITH FULL TRACE
    # ============================================================

    def _evaluate_with_trace(self, ticket_ctx: dict, rules: list) -> dict:
        """
        Evaluate ticket against all rules (priority-ordered, highest first).
        The first matching rule is the decisive action.
        Returns trace list + summary.
        """
        trace = []
        final_action = None
        final_action_code = None
        final_rule_id = None
        matched_rules = []

        for rule in rules:
            matched, skip_reasons = self._rule_matches_detail(ticket_ctx, rule)
            entry = {
                "rule_id": rule.get("rule_id"),
                "module_name": rule.get("module_name", ""),
                "action_id": rule.get("action_id"),
                "action_code_id": rule.get("action_code_id", ""),
                "action_name": rule.get("action_name", ""),
                "priority": rule.get("priority", 0),
                "matched": matched,
                "skip_reasons": skip_reasons,   # list of why rule didn't match
                "is_decisive": False,
            }
            if matched:
                matched_rules.append(entry)
                if final_action is None:
                    final_action = rule.get("action_id")
                    final_action_code = rule.get("action_code_id", str(rule.get("action_id")))
                    final_rule_id = rule.get("rule_id")
                    entry["is_decisive"] = True

            trace.append(entry)

        return {
            "evaluation_trace": trace,
            "matched_rules": matched_rules,
            "final_action": final_action_code or "NO_MATCH",
            "final_action_id": final_action,
            "final_rule_id": final_rule_id,
        }

    # ============================================================
    # INTERNAL: RULE MATCHING (simple)
    # ============================================================

    def _evaluate(self, ticket: dict, rules: list) -> str:
        for rule in rules:
            matched, _ = self._rule_matches_detail(ticket, rule)
            if matched:
                return rule.get("action_code_id") or str(rule.get("action_id", "NO_ACTION"))
        return "NO_MATCH"

    def _rule_matches_detail(self, ticket: dict, rule: dict) -> tuple[bool, list]:
        """
        Returns (matched: bool, skip_reasons: list[str]).
        skip_reasons is empty when matched=True.
        """
        reasons = []

        # issue_type_l1
        if rule.get("issue_type_l1"):
            ticket_l1 = ticket.get("issue_type_l1") or ticket.get("issue_type")
            if ticket_l1 != rule["issue_type_l1"]:
                reasons.append(
                    f"issue_type_l1: expected '{rule['issue_type_l1']}', got '{ticket_l1}'"
                )

        # business_line
        if rule.get("business_line"):
            if ticket.get("business_line") != rule["business_line"]:
                reasons.append(
                    f"business_line: expected '{rule['business_line']}', got '{ticket.get('business_line')}'"
                )

        # order_value
        ov = float(ticket.get("order_value") or 0)
        if rule.get("min_order_value") is not None and ov < float(rule["min_order_value"]):
            reasons.append(f"order_value {ov} < min {rule['min_order_value']}")
        if rule.get("max_order_value") is not None and ov > float(rule["max_order_value"]):
            reasons.append(f"order_value {ov} > max {rule['max_order_value']}")

        # fraud_segment
        if rule.get("fraud_segment"):
            if ticket.get("fraud_segment") != rule["fraud_segment"]:
                reasons.append(
                    f"fraud_segment: expected '{rule['fraud_segment']}', got '{ticket.get('fraud_segment')}'"
                )

        # customer_segment (maps to value_segment)
        if rule.get("customer_segment"):
            if ticket.get("value_segment") != rule["customer_segment"]:
                reasons.append(
                    f"customer_segment: expected '{rule['customer_segment']}', got '{ticket.get('value_segment')}'"
                )

        # sla_breach_required
        if rule.get("sla_breach_required") and not ticket.get("sla_breach"):
            reasons.append("sla_breach_required but ticket has no SLA breach")

        # conditions JSON
        conditions = rule.get("conditions") or {}

        fraud_limit = conditions.get("max_fraud_score")
        if fraud_limit is not None:
            fraud_score = ticket.get("fraud_score", 0)
            if fraud_score > fraud_limit:
                reasons.append(f"fraud_score {fraud_score} > max {fraud_limit}")

        required_tier = conditions.get("customer_tier")
        if required_tier:
            if ticket.get("customer_tier") != required_tier:
                reasons.append(
                    f"customer_tier: expected '{required_tier}', got '{ticket.get('customer_tier')}'"
                )

        greedy_req = conditions.get("greedy_classification")
        if greedy_req:
            if ticket.get("greedy_classification") != greedy_req:
                reasons.append(
                    f"greedy_classification: expected '{greedy_req}', got '{ticket.get('greedy_classification')}'"
                )

        matched = len(reasons) == 0
        return matched, reasons

    # ============================================================
    # LEGACY COMPAT
    # ============================================================

    def _load_rules(self, version: str) -> list:
        return self._load_rules_enriched(version)

    def _evaluate_old(self, ticket, rules):
        for rule in rules:
            if self._rule_matches(ticket, rule):
                return rule.get("action_code_id") or str(rule.get("action_id", "NO_ACTION"))
        return "NO_ACTION"

    def _rule_matches(self, ticket, rule):
        matched, _ = self._rule_matches_detail(ticket, rule)
        return matched
