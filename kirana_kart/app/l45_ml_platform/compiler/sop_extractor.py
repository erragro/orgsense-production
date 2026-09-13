"""
app/l45_ml_platform/compiler/sop_extractor.py
===============================================
3-stage SOP extraction pipeline.

Stage 1 — extract_taxonomy(kb_id, entity_id, sop_text)
    LLM reads the SOP and proposes an issue taxonomy (L1→L4 hierarchy).
    Constrained to known taxonomy codes; new codes flagged as 'new'.
    Writes draft_taxonomy_proposals rows.

Stage 2 — extract_actions(kb_id, entity_id, sop_text)
    LLM reads the SOP + accepted taxonomy proposals and extracts every
    unique action for every issue permutation.
    Constrained to known action codes; new codes flagged as 'new'.
    Writes draft_action_proposals rows.

Stage 3 — generate_rules(kb_id, entity_id)
    Deterministic. Joins accepted taxonomy × accepted action proposals
    and writes candidate rules into rule_registry (version = entity_id).
    No LLM call.

Every stage also writes to rule_edit_log for ML training.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from sqlalchemy import text
from sqlalchemy.engine import Engine

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

LLM_API_KEY = os.getenv("LLM_API_KEY")
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1")

logger = logging.getLogger("kirana_kart.sop_extractor")

_client: OpenAI | None = None


def _llm() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_API_BASE_URL)
    return _client


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_existing_taxonomy(conn, kb_id: str) -> list[dict]:
    rows = conn.execute(text("""
        SELECT issue_code, label, description, parent_id, level
        FROM kirana_kart.issue_taxonomy
        WHERE kb_id = :kb_id AND is_active = TRUE
        ORDER BY level, issue_code
    """), {"kb_id": kb_id}).mappings().all()
    return [dict(r) for r in rows]


def _get_existing_action_codes(conn) -> list[dict]:
    rows = conn.execute(text("""
        SELECT action_code_id, action_name, action_description, exact_action,
               requires_refund, requires_escalation, automation_eligible
        FROM kirana_kart.master_action_codes
        ORDER BY action_code_id
    """)).mappings().all()
    return [dict(r) for r in rows]


def _get_extraction_standards(conn, kb_id: str) -> str:
    row = conn.execute(text("""
        SELECT standards_md FROM kirana_kart.extraction_standards WHERE kb_id = :kb_id
    """), {"kb_id": kb_id}).fetchone()
    return row[0] if row else ""


def _get_accepted_taxonomy(conn, kb_id: str, entity_id: str) -> list[dict]:
    rows = conn.execute(text("""
        SELECT issue_code, label, description, parent_code, level
        FROM kirana_kart.draft_taxonomy_proposals
        WHERE kb_id = :kb_id AND entity_id = :eid
          AND status IN ('accepted', 'edited')
        ORDER BY level, issue_code
    """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()
    return [dict(r) for r in rows]


def _call_llm(system: str, user: str) -> dict:
    resp = _llm().chat.completions.create(
        model="gpt-4.1",
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return json.loads(resp.choices[0].message.content)


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Taxonomy Extraction
# ─────────────────────────────────────────────────────────────────────────────

_TAXONOMY_SYSTEM = """\
You are a Lean Six Sigma policy analyst. Your task is to extract a structured
issue taxonomy from an uploaded Standard Operating Procedure (SOP) document.

STRICT RULES:
1. Extract ONLY issue types that are explicitly described or referenced in the SOP.
2. Build a strict hierarchy: L1 → L2 → L3 → L4 (max 4 levels).
   L1 = broad category, L2 = sub-category, L3 = specific variant, L4 = edge case.
3. Use SCREAMING_SNAKE_CASE for issue_code (e.g. FOOD_SAFETY, WRONG_ITEM_DELIVERED).
4. If an issue_code already exists in the existing taxonomy list provided, set
   proposal_type = "existing" and reuse the exact same issue_code.
5. For genuinely new issues, set proposal_type = "new".
6. parent_code must be null for L1 nodes; must match an issue_code in this same
   response or in the existing taxonomy for L2+ nodes.
7. Set extraction_confidence (0.0–1.0) per node. Use < 0.75 for ambiguous mappings.
8. Do NOT invent issues. Do NOT hallucinate categories not in the SOP.

Return strict JSON only. No markdown.
"""


def extract_taxonomy(engine: Engine, kb_id: str, entity_id: str, sop_text: str) -> list[dict]:
    """
    Stage 1: LLM reads SOP → proposes taxonomy nodes.
    Writes to draft_taxonomy_proposals. Returns list of proposals.
    """
    with engine.begin() as conn:
        existing = _get_existing_taxonomy(conn, kb_id)
        standards = _get_extraction_standards(conn, kb_id)

    existing_block = "\n".join(
        f"  {r['issue_code']} (L{r['level']}): {r['label']}" for r in existing
    ) or "  (none yet — this is the first SOP for this KB)"

    standards_block = f"\n\nEXTRACTION STANDARDS (learned from past corrections):\n{standards}" if standards else ""

    user_prompt = f"""EXISTING TAXONOMY FOR THIS KB:
{existing_block}
{standards_block}

SOP DOCUMENT:
{sop_text[:12000]}

Return JSON:
{{
  "taxonomy": [
    {{
      "issue_code": "SCREAMING_SNAKE_CASE",
      "label": "Human readable label",
      "description": "One sentence description",
      "parent_code": null,
      "level": 1,
      "proposal_type": "new",
      "extraction_confidence": 0.95
    }}
  ]
}}"""

    result = _call_llm(_TAXONOMY_SYSTEM, user_prompt)
    proposals = result.get("taxonomy", [])

    with engine.begin() as conn:
        # Clear any existing proposals for this entity (idempotent re-run)
        conn.execute(text("""
            DELETE FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
        """), {"kb_id": kb_id, "eid": entity_id})

        for p in proposals:
            conn.execute(text("""
                INSERT INTO kirana_kart.draft_taxonomy_proposals
                    (kb_id, entity_id, issue_code, label, description,
                     parent_code, level, proposal_type, llm_output, extraction_confidence)
                VALUES
                    (:kb_id, :eid, :code, :label, :desc,
                     :parent, :level, :ptype, :llm, :conf)
            """), {
                "kb_id": kb_id,
                "eid": entity_id,
                "code": p.get("issue_code", ""),
                "label": p.get("label", ""),
                "desc": p.get("description", ""),
                "parent": p.get("parent_code"),
                "level": p.get("level", 1),
                "ptype": p.get("proposal_type", "new"),
                "llm": json.dumps(p),
                "conf": p.get("extraction_confidence"),
            })

        # Auto-accept 'existing' proposals (no change needed)
        conn.execute(text("""
            UPDATE kirana_kart.draft_taxonomy_proposals
            SET status = 'accepted'
            WHERE kb_id = :kb_id AND entity_id = :eid AND proposal_type = 'existing'
        """), {"kb_id": kb_id, "eid": entity_id})

        # Log to rule_edit_log
        for p in proposals:
            conn.execute(text("""
                INSERT INTO kirana_kart.rule_edit_log
                    (kb_id, entity_id, stage, item_ref, edit_type, llm_output, extraction_confidence)
                VALUES (:kb_id, :eid, 'taxonomy', :ref, 'accepted', :llm, :conf)
            """), {
                "kb_id": kb_id, "eid": entity_id,
                "ref": p.get("issue_code"),
                "llm": json.dumps(p),
                "conf": p.get("extraction_confidence"),
            })

    logger.info("Stage 1 complete: %d taxonomy proposals for entity_id=%s", len(proposals), entity_id)
    return proposals


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Action Extraction
# ─────────────────────────────────────────────────────────────────────────────

_ACTION_SYSTEM = """\
You are a Lean Six Sigma operations analyst. Your task is to extract ALL
distinct actions from an SOP document for every issue permutation.

STRICT RULES:
1. For every issue type (and its sub-types), identify what exact action the SOP
   prescribes. Each unique outcome = one action code.
2. action_code_id: SCREAMING_SNAKE_CASE (e.g. FULL_REFUND_FOOD_SAFETY).
3. action_description: What this action category means operationally (1 sentence).
4. exact_action: The precise step-by-step action to execute as written in the SOP.
   Include amounts, timelines, channels (e.g. "Issue 100% refund via payment gateway
   within 24 hours + send apology email with ₹50 coupon").
5. parent_issue_codes: list of issue_code values (from the taxonomy provided) that
   trigger this action. An action can serve multiple issue types.
6. If an action already exists in the existing registry, reuse the exact action_code_id
   and set proposal_type = "existing". Update exact_action if the SOP is more specific.
7. Do NOT invent actions. Only extract what is explicitly in the SOP.
8. Set extraction_confidence per action.

Return strict JSON only. No markdown.
"""


def extract_actions(engine: Engine, kb_id: str, entity_id: str, sop_text: str) -> list[dict]:
    """
    Stage 2: LLM reads SOP + accepted taxonomy → proposes action codes.
    Writes to draft_action_proposals. Returns list of proposals.
    """
    with engine.begin() as conn:
        accepted_taxonomy = _get_accepted_taxonomy(conn, kb_id, entity_id)
        existing_actions = _get_existing_action_codes(conn)
        standards = _get_extraction_standards(conn, kb_id)

    taxonomy_block = "\n".join(
        f"  {'  ' * (r['level'] - 1)}{r['issue_code']} (L{r['level']}): {r['label']}"
        for r in accepted_taxonomy
    ) or "  (no taxonomy accepted yet)"

    existing_block = "\n".join(
        f"  {r['action_code_id']}: {r['action_name']} — {r['action_description'] or ''}"
        for r in existing_actions
    ) or "  (none yet)"

    standards_block = f"\n\nEXTRACTION STANDARDS:\n{standards}" if standards else ""

    user_prompt = f"""ACCEPTED ISSUE TAXONOMY (from Stage 1):
{taxonomy_block}

EXISTING ACTION REGISTRY:
{existing_block}
{standards_block}

SOP DOCUMENT:
{sop_text[:12000]}

Return JSON:
{{
  "actions": [
    {{
      "action_code_id": "SCREAMING_SNAKE_CASE",
      "action_name": "Short label (max 60 chars)",
      "action_description": "Operational definition",
      "exact_action": "Exact steps as per SOP",
      "parent_issue_codes": ["ISSUE_CODE_1", "ISSUE_CODE_2"],
      "requires_refund": false,
      "requires_escalation": false,
      "automation_eligible": true,
      "proposal_type": "new",
      "extraction_confidence": 0.92
    }}
  ]
}}"""

    result = _call_llm(_ACTION_SYSTEM, user_prompt)
    proposals = result.get("actions", [])

    with engine.begin() as conn:
        conn.execute(text("""
            DELETE FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
        """), {"kb_id": kb_id, "eid": entity_id})

        for p in proposals:
            conn.execute(text("""
                INSERT INTO kirana_kart.draft_action_proposals
                    (kb_id, entity_id, action_code_id, action_name, action_description,
                     exact_action, parent_issue_codes, requires_refund, requires_escalation,
                     automation_eligible, proposal_type, llm_output, extraction_confidence)
                VALUES
                    (:kb_id, :eid, :code, :name, :desc,
                     :exact, :parents, :refund, :esc,
                     :auto, :ptype, :llm, :conf)
            """), {
                "kb_id": kb_id,
                "eid": entity_id,
                "code": p.get("action_code_id", ""),
                "name": p.get("action_name", ""),
                "desc": p.get("action_description", ""),
                "exact": p.get("exact_action", ""),
                "parents": p.get("parent_issue_codes", []),
                "refund": p.get("requires_refund", False),
                "esc": p.get("requires_escalation", False),
                "auto": p.get("automation_eligible", True),
                "ptype": p.get("proposal_type", "new"),
                "llm": json.dumps(p),
                "conf": p.get("extraction_confidence"),
            })

        conn.execute(text("""
            UPDATE kirana_kart.draft_action_proposals
            SET status = 'accepted'
            WHERE kb_id = :kb_id AND entity_id = :eid AND proposal_type = 'existing'
        """), {"kb_id": kb_id, "eid": entity_id})

        for p in proposals:
            conn.execute(text("""
                INSERT INTO kirana_kart.rule_edit_log
                    (kb_id, entity_id, stage, item_ref, edit_type, llm_output, extraction_confidence)
                VALUES (:kb_id, :eid, 'action', :ref, 'accepted', :llm, :conf)
            """), {
                "kb_id": kb_id, "eid": entity_id,
                "ref": p.get("action_code_id"),
                "llm": json.dumps(p),
                "conf": p.get("extraction_confidence"),
            })

    logger.info("Stage 2 complete: %d action proposals for entity_id=%s", len(proposals), entity_id)
    return proposals


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Rule Generation (deterministic, no LLM)
# ─────────────────────────────────────────────────────────────────────────────

def generate_rules(engine: Engine, kb_id: str, entity_id: str) -> list[dict]:
    """
    Stage 3: Deterministic join of accepted taxonomy × accepted action proposals.
    For each (issue_code, action_code_id) pair where the issue is in the action's
    parent_issue_codes, generate one rule in rule_registry.

    Returns list of generated rule dicts.
    """
    with engine.begin() as conn:
        taxonomy = _get_accepted_taxonomy(conn, kb_id, entity_id)
        actions_rows = conn.execute(text("""
            SELECT action_code_id, action_name, action_description, exact_action,
                   parent_issue_codes, requires_refund, requires_escalation, automation_eligible
            FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
              AND status IN ('accepted', 'edited')
        """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()
        actions = [dict(r) for r in actions_rows]

        # Get action db id mapping
        action_id_map: dict[str, int] = {}
        for a in actions:
            row = conn.execute(text("""
                SELECT id FROM kirana_kart.master_action_codes
                WHERE action_code_id = :code
            """), {"code": a["action_code_id"]}).fetchone()
            if row:
                action_id_map[a["action_code_id"]] = row[0]

        # Clear existing draft rules for this entity
        conn.execute(text("""
            DELETE FROM kirana_kart.rule_registry
            WHERE kb_id = :kb_id AND policy_version = :eid
        """), {"kb_id": kb_id, "eid": entity_id})

        taxonomy_by_code = {t["issue_code"]: t for t in taxonomy}
        generated = []

        for action in actions:
            parent_codes: list[str] = action["parent_issue_codes"] or []
            action_db_id = action_id_map.get(action["action_code_id"])
            if not action_db_id:
                logger.warning("No master_action_codes row for %s — skipping", action["action_code_id"])
                continue

            for issue_code in parent_codes:
                tax_node = taxonomy_by_code.get(issue_code)
                if not tax_node:
                    continue

                # Determine L1 and L2
                level = tax_node["level"]
                issue_l1 = issue_code if level == 1 else tax_node.get("parent_code") or issue_code
                issue_l2 = issue_code if level >= 2 else None

                rule_id = f"R-{issue_code[:20]}-{action['action_code_id'][:20]}"

                conn.execute(text("""
                    INSERT INTO kirana_kart.rule_registry
                        (kb_id, rule_id, policy_version, module_name, rule_type,
                         priority, issue_type_l1, issue_type_l2, action_id,
                         deterministic, overrideable, conditions, flags)
                    VALUES
                        (:kb_id, :rule_id, :version, 'default', 'issue_resolution',
                         100, :l1, :l2, :action_id,
                         :auto, FALSE, '{}', '{}')
                    ON CONFLICT DO NOTHING
                """), {
                    "kb_id": kb_id,
                    "rule_id": rule_id,
                    "version": entity_id,
                    "l1": issue_l1,
                    "l2": issue_l2,
                    "action_id": action_db_id,
                    "auto": action["automation_eligible"],
                })

                r = {
                    "rule_id": rule_id,
                    "issue_type_l1": issue_l1,
                    "issue_type_l2": issue_l2,
                    "action_code_id": action["action_code_id"],
                    "action_name": action["action_name"],
                    "exact_action": action["exact_action"],
                }
                generated.append(r)

                conn.execute(text("""
                    INSERT INTO kirana_kart.rule_edit_log
                        (kb_id, entity_id, stage, item_ref, edit_type, llm_output)
                    VALUES (:kb_id, :eid, 'rule', :ref, 'accepted', :llm)
                """), {
                    "kb_id": kb_id, "eid": entity_id,
                    "ref": rule_id, "llm": json.dumps(r),
                })

    logger.info("Stage 3 complete: %d rules generated for entity_id=%s", len(generated), entity_id)
    return generated


# ─────────────────────────────────────────────────────────────────────────────
# On-Publish: Update Extraction Standards + commit proposals to global registries
# ─────────────────────────────────────────────────────────────────────────────

def commit_proposals_to_registry(engine: Engine, kb_id: str, entity_id: str, actor_id: int | None = None) -> None:
    """
    Called on publish. Promotes accepted draft proposals to the global registries:
    - draft_taxonomy_proposals (accepted/edited) → issue_taxonomy
    - draft_action_proposals (accepted/edited) → master_action_codes
    Then regenerates extraction_standards.md for this KB.
    """
    with engine.begin() as conn:
        # Promote taxonomy proposals
        tax_rows = conn.execute(text("""
            SELECT * FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
              AND status IN ('accepted', 'edited') AND proposal_type = 'new'
        """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()

        for row in tax_rows:
            effective = json.loads(row["user_output"]) if row["user_output"] else {}
            label = effective.get("label", row["label"])
            desc = effective.get("description", row["description"])

            # Resolve parent_id from parent_code
            parent_id = None
            if row["parent_code"]:
                pr = conn.execute(text("""
                    SELECT id FROM kirana_kart.issue_taxonomy
                    WHERE issue_code = :code AND kb_id = :kb_id
                """), {"code": row["parent_code"], "kb_id": kb_id}).fetchone()
                if pr:
                    parent_id = pr[0]

            conn.execute(text("""
                INSERT INTO kirana_kart.issue_taxonomy
                    (kb_id, issue_code, label, description, parent_id, level, is_active)
                VALUES (:kb_id, :code, :label, :desc, :parent, :level, TRUE)
                ON CONFLICT (issue_code, kb_id) DO UPDATE
                    SET label = EXCLUDED.label,
                        description = EXCLUDED.description,
                        updated_at = NOW()
            """), {
                "kb_id": kb_id,
                "code": row["issue_code"],
                "label": label,
                "desc": desc,
                "parent": parent_id,
                "level": row["level"],
            })

        # Promote action proposals
        act_rows = conn.execute(text("""
            SELECT * FROM kirana_kart.draft_action_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
              AND status IN ('accepted', 'edited') AND proposal_type = 'new'
        """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()

        for row in act_rows:
            effective = json.loads(row["user_output"]) if row["user_output"] else {}
            conn.execute(text("""
                INSERT INTO kirana_kart.master_action_codes
                    (action_code_id, action_name, action_description, exact_action,
                     parent_issue_codes, requires_refund, requires_escalation, automation_eligible)
                VALUES
                    (:code, :name, :desc, :exact, :parents, :refund, :esc, :auto)
                ON CONFLICT (action_code_id) DO UPDATE
                    SET action_name        = EXCLUDED.action_name,
                        action_description = EXCLUDED.action_description,
                        exact_action       = EXCLUDED.exact_action,
                        parent_issue_codes = EXCLUDED.parent_issue_codes
            """), {
                "code": row["action_code_id"],
                "name": effective.get("action_name", row["action_name"]),
                "desc": effective.get("action_description", row["action_description"]),
                "exact": effective.get("exact_action", row["exact_action"]),
                "parents": effective.get("parent_issue_codes", row["parent_issue_codes"]) or [],
                "refund": effective.get("requires_refund", row["requires_refund"]),
                "esc": effective.get("requires_escalation", row["requires_escalation"]),
                "auto": effective.get("automation_eligible", row["automation_eligible"]),
            })

        # Regenerate extraction_standards.md
        _regenerate_standards(conn, kb_id, actor_id)

    logger.info("Proposals committed to global registry for kb_id=%s entity_id=%s", kb_id, entity_id)


def _regenerate_standards(conn, kb_id: str, actor_id: int | None) -> None:
    """Build and save extraction_standards.md from current registry + recent edit log."""

    # Action codes
    actions = conn.execute(text("""
        SELECT action_code_id, action_name, action_description, exact_action, parent_issue_codes
        FROM kirana_kart.master_action_codes ORDER BY action_code_id
    """)).mappings().all()

    # Taxonomy
    taxonomy = conn.execute(text("""
        SELECT issue_code, label, description, level, parent_id
        FROM kirana_kart.issue_taxonomy
        WHERE kb_id = :kb_id AND is_active = TRUE ORDER BY level, issue_code
    """), {"kb_id": kb_id}).mappings().all()

    # Recent edits (last 50)
    edits = conn.execute(text("""
        SELECT stage, item_ref, edit_type, llm_output, user_output, edit_reason, created_at
        FROM kirana_kart.rule_edit_log
        WHERE kb_id = :kb_id AND edit_type IN ('edited', 'rejected')
        ORDER BY created_at DESC LIMIT 50
    """), {"kb_id": kb_id}).mappings().all()

    lines = [f"# Extraction Standards — KB: {kb_id}\n"]

    lines.append("## Action Codes\n")
    for a in actions:
        lines.append(f"### {a['action_code_id']} — {a['action_name']}")
        if a["action_description"]:
            lines.append(f"**Definition:** {a['action_description']}")
        if a["exact_action"]:
            lines.append(f"**Exact action:** {a['exact_action']}")
        parents = a["parent_issue_codes"] or []
        if parents:
            lines.append(f"**Applies to issue codes:** {', '.join(parents)}")
        lines.append("")

    lines.append("## Issue Taxonomy\n")
    for t in taxonomy:
        indent = "  " * (t["level"] - 1)
        lines.append(f"{indent}- **{t['issue_code']}** (L{t['level']}): {t['label']}")
        if t["description"]:
            lines.append(f"{indent}  {t['description']}")
    lines.append("")

    if edits:
        lines.append("## Extraction Corrections (Learning History)\n")
        for e in edits:
            lines.append(f"### {e['stage'].upper()} correction — {e['item_ref']}")
            if e["llm_output"]:
                lines.append(f"**LLM extracted:** {e['llm_output']}")
            if e["user_output"]:
                lines.append(f"**User corrected to:** {e['user_output']}")
            if e["edit_reason"]:
                lines.append(f"**Reason:** {e['edit_reason']}")
            lines.append("")

    standards_md = "\n".join(lines)

    conn.execute(text("""
        INSERT INTO kirana_kart.extraction_standards (kb_id, standards_md, updated_by)
        VALUES (:kb_id, :md, :actor)
        ON CONFLICT (kb_id) DO UPDATE
            SET standards_md = EXCLUDED.standards_md,
                version = extraction_standards.version + 1,
                updated_at = NOW(),
                updated_by = EXCLUDED.updated_by
    """), {"kb_id": kb_id, "md": standards_md, "actor": actor_id})
    logger.info("extraction_standards.md regenerated for kb_id=%s", kb_id)
