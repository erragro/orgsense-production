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


# The prompt carries at most this much SOP text. Callers report when a
# document was longer, so reviewers know which part was never analysed.
SOP_CHAR_LIMIT = 12000

_PROPOSAL_TYPES = {"new", "update", "existing"}


def sop_truncated(sop_text: str) -> bool:
    return len(sop_text or "") > SOP_CHAR_LIMIT


def _code(value: Any, max_len: int) -> str:
    """Normalise an LLM-supplied code to SCREAMING_SNAKE_CASE within column limits."""
    raw = str(value or "").strip().upper().replace("-", "_").replace(" ", "_")
    return "".join(c for c in raw if c.isalnum() or c == "_")[:max_len]


def _confidence(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if 0.0 <= number <= 1.0 else None


def _clean_taxonomy(raw: Any, known_codes: set[str]) -> list[dict]:
    """
    Keep only proposals the schema can store. An LLM claim of
    proposal_type='existing' is trusted only when the registry confirms the
    code, because 'existing' proposals are accepted without human review.
    """
    cleaned: dict[str, dict] = {}
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict):
            continue
        code = _code(p.get("issue_code"), 80)
        label = str(p.get("label") or "").strip()[:255]
        try:
            level = int(p.get("level", 1))
        except (TypeError, ValueError):
            continue
        if not code or not label or not 1 <= level <= 4 or code in cleaned:
            continue
        parent = _code(p.get("parent_code"), 80) or None
        ptype = p.get("proposal_type") if p.get("proposal_type") in _PROPOSAL_TYPES else "new"
        if ptype == "existing" and code not in known_codes:
            ptype = "new"
        cleaned[code] = {
            **p,
            "issue_code": code, "label": label, "level": level,
            "parent_code": None if level == 1 else parent,
            "description": str(p.get("description") or "").strip(),
            "proposal_type": ptype,
            "extraction_confidence": _confidence(p.get("extraction_confidence")),
        }
    return list(cleaned.values())


def _clean_actions(raw: Any, known_codes: set[str]) -> list[dict]:
    cleaned: dict[str, dict] = {}
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict):
            continue
        code = _code(p.get("action_code_id"), 100)
        name = str(p.get("action_name") or "").strip()[:255]
        if not code or not name or code in cleaned:
            continue
        parents = p.get("parent_issue_codes") or []
        parents = sorted({_code(c, 80) for c in parents if _code(c, 80)}) if isinstance(parents, list) else []
        ptype = p.get("proposal_type") if p.get("proposal_type") in _PROPOSAL_TYPES else "new"
        if ptype == "existing" and code not in known_codes:
            ptype = "new"
        cleaned[code] = {
            **p,
            "action_code_id": code, "action_name": name,
            "action_description": str(p.get("action_description") or "").strip(),
            "exact_action": str(p.get("exact_action") or "").strip(),
            "parent_issue_codes": parents,
            "requires_refund": bool(p.get("requires_refund", False)),
            "requires_escalation": bool(p.get("requires_escalation", False)),
            "automation_eligible": bool(p.get("automation_eligible", True)),
            "proposal_type": ptype,
            "extraction_confidence": _confidence(p.get("extraction_confidence")),
        }
    return list(cleaned.values())


def _effective(row: dict) -> dict:
    """A proposal as the reviewer left it: their edits over the extracted values."""
    edits = row.get("user_output") or {}
    if isinstance(edits, str):
        edits = json.loads(edits)
    return {**row, **{k: v for k, v in edits.items() if v is not None}}


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


def extract_taxonomy(engine: Engine, kb_id: str, entity_id: str, sop_text: str,
                     before_write=None) -> list[dict]:
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
{sop_text[:SOP_CHAR_LIMIT]}

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
    proposals = _clean_taxonomy(result.get("taxonomy"), {r["issue_code"] for r in existing})

    with engine.begin() as conn:
        # The LLM call ran outside any lock; the caller re-checks that the
        # proposal may still change before its proposals are replaced.
        if before_write:
            before_write(conn)
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


def extract_actions(engine: Engine, kb_id: str, entity_id: str, sop_text: str,
                     before_write=None) -> list[dict]:
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
{sop_text[:SOP_CHAR_LIMIT]}

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
    proposals = _clean_actions(result.get("actions"), {r["action_code_id"] for r in existing_actions})

    with engine.begin() as conn:
        if before_write:
            before_write(conn)
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

def _issue_ancestry(conn, taxonomy_by_code: dict[str, dict]) -> dict[str, str | None]:
    """
    Map every accepted issue code to its level-1 root: rule_registry stores a
    rule's issue as (issue_type_l1 = root, issue_type_l2 = the node itself).
    Parents may be accepted proposals or codes already in the live taxonomy.
    Unresolvable ancestry maps to None.
    """
    existing = {
        r["issue_code"]: r for r in conn.execute(text("""
            SELECT c.issue_code, c.level, p.issue_code AS parent_code
            FROM kirana_kart.issue_taxonomy c
            LEFT JOIN kirana_kart.issue_taxonomy p ON p.id = c.parent_id
            WHERE c.is_active = TRUE
        """)).mappings().all()
    }

    def root(code: str, depth: int = 0) -> str | None:
        node = taxonomy_by_code.get(code) or existing.get(code)
        if not node or depth > 4:
            return None
        if node["level"] == 1:
            return code
        return root(node["parent_code"], depth + 1) if node.get("parent_code") else None

    return {code: root(code) for code in taxonomy_by_code}


def taxonomy_problems(conn, kb_id: str, entity_id: str) -> list[str]:
    """
    Accepted categories that cannot be stored: issue_taxonomy requires every
    level 2-4 node to have a resolvable parent (chk_parent_level). Found here,
    before approval, rather than as a failed activation.
    """
    taxonomy = {t["issue_code"]: t for t in _get_accepted_taxonomy(conn, kb_id, entity_id)}
    ancestry = _issue_ancestry(conn, taxonomy)
    return [
        f"{code} has no accepted or existing parent category"
        for code, node in taxonomy.items()
        if node["level"] > 1 and ancestry.get(code) is None
    ]


def _rule_id(issue_code: str, action_code: str) -> str:
    """Deterministic and collision-free: truncated readable prefix + digest."""
    import hashlib
    digest = hashlib.sha1(f"{issue_code}|{action_code}".encode()).hexdigest()[:8].upper()
    return f"R-{issue_code[:24]}-{action_code[:24]}-{digest}"


def generate_rules(engine: Engine, kb_id: str, entity_id: str, conn=None) -> dict:
    """
    Stage 3: Deterministic join of accepted taxonomy × accepted action proposals.
    For each (issue_code, action_code_id) pair where the issue is in the action's
    parent_issue_codes, generate one rule in rule_registry.

    Accepted actions that are new to master_action_codes are registered here:
    a rule must reference a real action id, and dropping them (the previous
    behaviour) silently discarded every reviewed response the SOP introduced.
    A new code is inert until a live policy's rules reference it; publication
    later applies the reviewer's final wording (commit_proposals_to_registry).

    Returns {"rules": [...], "skipped": [...]} — skipped explains every
    accepted pairing that could not become a rule.
    """
    if conn is None:
        with engine.begin() as own:
            return generate_rules(engine, kb_id, entity_id, conn=own)

    taxonomy = _get_accepted_taxonomy(conn, kb_id, entity_id)
    actions = [_effective(dict(r)) for r in conn.execute(text("""
        SELECT action_code_id, action_name, action_description, exact_action,
               parent_issue_codes, requires_refund, requires_escalation,
               automation_eligible, user_output
        FROM kirana_kart.draft_action_proposals
        WHERE kb_id = :kb_id AND entity_id = :eid
          AND status IN ('accepted', 'edited')
        ORDER BY action_code_id
    """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()]

    action_id_map: dict[str, int] = {}
    for a in actions:
        conn.execute(text("""
            INSERT INTO kirana_kart.master_action_codes
                (action_key, action_code_id, action_name, action_description, exact_action,
                 parent_issue_codes, requires_refund, requires_escalation, automation_eligible)
            VALUES (:code, :code, :name, :desc, :exact, :parents, :refund, :esc, :auto)
            ON CONFLICT (action_code_id) DO NOTHING
        """), {
            "code": a["action_code_id"], "name": a["action_name"],
            "desc": a.get("action_description"), "exact": a.get("exact_action"),
            "parents": list(a.get("parent_issue_codes") or []),
            "refund": bool(a.get("requires_refund")), "esc": bool(a.get("requires_escalation")),
            "auto": bool(a.get("automation_eligible", True)),
        })
        action_id_map[a["action_code_id"]] = conn.execute(text("""
            SELECT id FROM kirana_kart.master_action_codes WHERE action_code_id = :code
        """), {"code": a["action_code_id"]}).scalar()

    conn.execute(text("""
        DELETE FROM kirana_kart.rule_registry
        WHERE kb_id = :kb_id AND policy_version = :eid
    """), {"kb_id": kb_id, "eid": entity_id})

    taxonomy_by_code = {t["issue_code"]: t for t in taxonomy}
    ancestry = _issue_ancestry(conn, taxonomy_by_code)
    generated: list[dict] = []
    skipped: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for action in actions:
        for issue_code in sorted(set(action.get("parent_issue_codes") or [])):
            pair = (issue_code, action["action_code_id"])
            tax_node = taxonomy_by_code.get(issue_code)
            if not tax_node:
                skipped.append({"issue_code": issue_code, "action_code_id": pair[1],
                                "reason": "Customer problem was not accepted in this proposal"})
                continue
            root = ancestry.get(issue_code)
            if root is None:
                skipped.append({"issue_code": issue_code, "action_code_id": pair[1],
                                "reason": "Customer problem has no accepted or existing parent category"})
                continue
            if pair in seen:
                continue
            seen.add(pair)

            level = tax_node["level"]
            issue_l2 = issue_code if level >= 2 else None
            # First-match evaluation is priority ASC (lower wins). A more
            # specific situation must outrank its general category.
            priority = 500 - 100 * (level - 1)
            rule_id = _rule_id(issue_code, action["action_code_id"])

            conn.execute(text("""
                INSERT INTO kirana_kart.rule_registry
                    (kb_id, rule_id, policy_version, module_name, rule_type,
                     priority, issue_type_l1, issue_type_l2, action_id,
                     deterministic, overrideable, conditions, flags)
                VALUES
                    (:kb_id, :rule_id, :version, 'default', 'issue_resolution',
                     :priority, :l1, :l2, :action_id,
                     :auto, FALSE, '{}', '{}')
            """), {
                "kb_id": kb_id,
                "rule_id": rule_id,
                "version": entity_id,
                "priority": priority,
                "l1": root,
                "l2": issue_l2,
                "action_id": action_id_map[action["action_code_id"]],
                "auto": bool(action.get("automation_eligible", True)),
            })

            r = {
                "rule_id": rule_id,
                "issue_type_l1": root,
                "issue_type_l2": issue_l2,
                "action_code_id": action["action_code_id"],
                "action_name": action["action_name"],
                "exact_action": action.get("exact_action"),
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

    logger.info(
        "Stage 3 complete: %d rules generated, %d pairings skipped for entity_id=%s",
        len(generated), len(skipped), entity_id,
    )
    return {"rules": generated, "skipped": skipped}


# ─────────────────────────────────────────────────────────────────────────────
# On-Publish: Update Extraction Standards + commit proposals to global registries
# ─────────────────────────────────────────────────────────────────────────────

def commit_proposals_to_registry(
    engine: Engine, kb_id: str, entity_id: str, actor_id: int | None = None, conn=None,
) -> None:
    """
    Called on publish. Promotes accepted draft proposals to the global registries:
    - draft_taxonomy_proposals (accepted/edited) → issue_taxonomy
    - draft_action_proposals (accepted/edited) → master_action_codes
    Then regenerates extraction_standards.md for this KB.

    With `conn`, runs in the caller's transaction so a failed activation also
    leaves the registries untouched.
    """
    if conn is None:
        with engine.begin() as own:
            return commit_proposals_to_registry(engine, kb_id, entity_id, actor_id, conn=own)

    # Parents first: a new L2 may hang off a new L1 in the same proposal.
    tax_rows = conn.execute(text("""
        SELECT * FROM kirana_kart.draft_taxonomy_proposals
        WHERE kb_id = :kb_id AND entity_id = :eid
          AND status IN ('accepted', 'edited') AND proposal_type = 'new'
        ORDER BY level, issue_code
    """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()

    for row in tax_rows:
        effective = _effective(dict(row))

        parent_id = None
        if row["parent_code"]:
            parent_id = conn.execute(text("""
                SELECT id FROM kirana_kart.issue_taxonomy WHERE issue_code = :code
            """), {"code": row["parent_code"]}).scalar()
        if row["level"] > 1 and parent_id is None:
            raise ValueError(
                f"Category {row['issue_code']} has no parent category in the registry"
            )

        # issue_code is globally unique. A code owned by another KB is left
        # untouched rather than relabelled from this KB's SOP.
        conn.execute(text("""
            INSERT INTO kirana_kart.issue_taxonomy
                (kb_id, issue_code, label, description, parent_id, level, is_active)
            VALUES (:kb_id, :code, :label, :desc, :parent, :level, TRUE)
            ON CONFLICT (issue_code) DO UPDATE
                SET label = EXCLUDED.label,
                    description = EXCLUDED.description,
                    updated_at = NOW()
                WHERE kirana_kart.issue_taxonomy.kb_id = EXCLUDED.kb_id
        """), {
            "kb_id": kb_id,
            "code": row["issue_code"],
            "label": effective.get("label", row["label"]),
            "desc": effective.get("description", row["description"]),
            "parent": parent_id,
            "level": row["level"],
        })

    act_rows = conn.execute(text("""
        SELECT * FROM kirana_kart.draft_action_proposals
        WHERE kb_id = :kb_id AND entity_id = :eid
          AND status IN ('accepted', 'edited') AND proposal_type = 'new'
    """), {"kb_id": kb_id, "eid": entity_id}).mappings().all()

    for row in act_rows:
        effective = _effective(dict(row))
        conn.execute(text("""
            INSERT INTO kirana_kart.master_action_codes
                (action_key, action_code_id, action_name, action_description, exact_action,
                 parent_issue_codes, requires_refund, requires_escalation, automation_eligible)
            VALUES
                (:code, :code, :name, :desc, :exact, :parents, :refund, :esc, :auto)
            ON CONFLICT (action_code_id) DO UPDATE
                SET action_name        = EXCLUDED.action_name,
                    action_description = EXCLUDED.action_description,
                    exact_action       = EXCLUDED.exact_action,
                    parent_issue_codes = EXCLUDED.parent_issue_codes
        """), {
            "code": row["action_code_id"],
            "name": effective.get("action_name"),
            "desc": effective.get("action_description"),
            "exact": effective.get("exact_action"),
            "parents": list(effective.get("parent_issue_codes") or []),
            "refund": effective.get("requires_refund"),
            "esc": effective.get("requires_escalation"),
            "auto": effective.get("automation_eligible"),
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
