"""
app/l45_ml_platform/compiler/sop_extractor.py
===============================================
SOP extraction pipeline. Any SOP is read in full: documents longer than one
prompt are analysed in consecutive windows and the results merged.

Stage 1 — extract_taxonomy(kb_id, entity_id, sop_text)
    Maps the SOP onto the knowledge base's LIVE issue taxonomy. Policy Studio
    never creates issue codes: a problem the SOP describes that the taxonomy
    has no code for is recorded as a gap (policy_taxonomy_gaps) for a
    taxonomy admin, and no rule can be written for it until it is mapped.
    Writes draft_taxonomy_proposals (all 'existing') and gaps.

Stage 2 — extract_actions(kb_id, entity_id, sop_text)
    For the accepted problems, extracts every distinct action.
    Writes draft_action_proposals rows.

Knowledge — extract_knowledge(kb_id, entity_id, sop_text)
    Splits the SOP into reviewable passages, each citing the text it came
    from and embedding tenant variables as {{name}}. Accepted passages are
    Stage 1 decision context and Stage 3 reply text for the version.

Stage 3 — generate_rules(kb_id, entity_id)
    Deterministic. Accepted problems × accepted actions → rule_registry
    (version = entity_id), for the proposal's business line. No LLM call.

Every AI proposal is logged as 'proposed'; reviewers' decisions are logged
with an AI-vs-human diff, and recent corrections for this knowledge base
and business line are part of every extraction prompt (lessons_for).
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

from app.admin.services import policy_knowledge_service as knowledge
from app.l4_agents import policy_knowledge as pk

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

def live_taxonomy(conn, kb_id: str) -> dict[str, dict]:
    """The knowledge base's active issue codes, with each node's parent code."""
    rows = conn.execute(text("""
        SELECT c.issue_code, c.label, c.description, c.level, p.issue_code AS parent_code
        FROM kirana_kart.issue_taxonomy c
        LEFT JOIN kirana_kart.issue_taxonomy p ON p.id = c.parent_id
        WHERE c.kb_id = :kb_id AND c.is_active = TRUE
        ORDER BY c.level, c.issue_code
    """), {"kb_id": kb_id}).mappings().all()
    return {r["issue_code"]: dict(r) for r in rows}


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


def _guidance(conn, kb_id: str, business_line: str | None, stages: tuple[str, ...]) -> str:
    """Published standards plus reviewers' latest corrections, for a prompt."""
    parts = []
    standards = _get_extraction_standards(conn, kb_id)
    if standards:
        parts.append(f"EXTRACTION STANDARDS (from published policies):\n{standards[:6000]}")
    lessons = knowledge.lessons_for(conn, kb_id, business_line, stages)
    if lessons:
        parts.append(lessons)
    return ("\n\n" + "\n\n".join(parts)) if parts else ""


# One prompt carries at most this much SOP text. Longer documents are read in
# consecutive windows, up to MAX_SOP_WINDOWS; only text beyond that is
# reported as not analysed.
SOP_CHAR_LIMIT = 12000
MAX_SOP_WINDOWS = 8
SOP_ANALYSED_LIMIT = SOP_CHAR_LIMIT * MAX_SOP_WINDOWS
AUTO_ACCEPT_CONFIDENCE = 0.75

_PROPOSAL_TYPES = {"new", "update", "existing"}


def sop_windows(sop_text: str) -> list[tuple[int, str]]:
    """(offset, text) windows, cut at a heading or paragraph where possible."""
    doc = sop_text or ""
    windows: list[tuple[int, str]] = []
    start = 0
    while start < len(doc) and len(windows) < MAX_SOP_WINDOWS:
        end = min(start + SOP_CHAR_LIMIT, len(doc))
        if end < len(doc):
            floor = start + SOP_CHAR_LIMIT // 2
            cut = doc.rfind("\n#", floor, end)
            if cut <= floor:
                cut = doc.rfind("\n\n", floor, end)
            if cut > floor:
                end = cut + 1
        windows.append((start, doc[start:end]))
        start = end
    return windows


def analysed_characters(sop_text: str) -> int:
    windows = sop_windows(sop_text)
    return windows[-1][0] + len(windows[-1][1]) if windows else 0


def sop_truncated(sop_text: str) -> bool:
    return analysed_characters(sop_text) < len(sop_text or "")


def _document_block(window: tuple[int, str], index: int, total: int) -> str:
    part = f" (part {index + 1} of {total}; other parts are analysed separately)" if total > 1 else ""
    return f"SOP DOCUMENT{part}:\n{window[1]}"


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


def _quote(value: Any) -> str | None:
    quote = str(value or "").strip()
    return quote[:1000] or None


def _clean_mappings(result: dict, taxonomy: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """
    Split a model answer into mappings onto live codes and gaps. A mapping to
    a code the taxonomy does not have is a gap, whatever the model called it:
    the taxonomy is closed, so Policy Studio can only point at it.
    """
    by_label = {pk._label_key(n.get("label")): code for code, n in taxonomy.items()}
    mappings: dict[str, dict] = {}
    gaps: dict[str, dict] = {}

    def add_gap(item: dict) -> None:
        label = str(item.get("label") or item.get("issue_code") or item.get("suggested_code") or "").strip()[:255]
        if not label:
            return
        key = pk._label_key(label)
        if key in by_label:           # the "gap" names a live problem after all
            add_mapping({**item, "issue_code": by_label[key]})
            return
        suggested = _code(item.get("suggested_code") or item.get("issue_code"), 80) or None
        gaps.setdefault(key, {
            "label": label,
            "description": str(item.get("description") or "").strip()[:2000],
            "suggested_code": suggested,
            "suggested_parent_code": _code(item.get("suggested_parent_code") or item.get("parent_code"), 80) or None,
            "source_excerpt": _quote(item.get("source_quote")),
            "extraction_confidence": _confidence(item.get("extraction_confidence")),
        })

    def add_mapping(item: dict) -> None:
        code = _code(item.get("issue_code"), 80)
        if code not in taxonomy:
            add_gap(item)
            return
        confidence = _confidence(item.get("extraction_confidence"))
        current = mappings.get(code)
        if current and (current["extraction_confidence"] or 0) >= (confidence or 0):
            return
        mappings[code] = {
            "issue_code": code,
            "extraction_confidence": confidence,
            "source_excerpt": _quote(item.get("source_quote")) or (current or {}).get("source_excerpt"),
            "reason": str(item.get("reason") or "").strip()[:500],
        }

    for item in result.get("mappings") or []:
        if isinstance(item, dict):
            add_mapping(item)
    for item in result.get("gaps") or []:
        if isinstance(item, dict):
            add_gap(item)
    # Older answer shape: one list, codes either known or not.
    for item in result.get("taxonomy") or []:
        if isinstance(item, dict):
            add_mapping(item)
    return list(mappings.values()), list(gaps.values())


def _clean_actions(raw: Any, known_codes: set[str]) -> list[dict]:
    cleaned: dict[str, dict] = {}
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict):
            continue
        code = _code(p.get("action_code_id"), 100)
        name = str(p.get("action_name") or "").strip()[:255]
        if not code or not name:
            continue
        parents = p.get("parent_issue_codes") or []
        parents = sorted({_code(c, 80) for c in parents if _code(c, 80)}) if isinstance(parents, list) else []
        if code in cleaned:
            # The same action found in another part of the document.
            merged = cleaned[code]
            merged["parent_issue_codes"] = sorted(set(merged["parent_issue_codes"]) | set(parents))
            merged["extraction_confidence"] = max(
                merged["extraction_confidence"] or 0, _confidence(p.get("extraction_confidence")) or 0,
            ) or None
            continue
        ptype = p.get("proposal_type") if p.get("proposal_type") in _PROPOSAL_TYPES else "new"
        if ptype == "existing" and code not in known_codes:
            ptype = "new"
        if code in known_codes:
            ptype = "existing"
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
            "source_excerpt": _quote(p.get("source_quote")),
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


def _each_window(sop_text: str, prompt) -> list[dict]:
    """Run `prompt(document_block)` over every window of the SOP."""
    windows = sop_windows(sop_text)
    return [_call_llm(*prompt(_document_block(w, i, len(windows)))) for i, w in enumerate(windows)]


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Map the SOP onto the live taxonomy
# ─────────────────────────────────────────────────────────────────────────────

_TAXONOMY_SYSTEM = """\
You are a Lean Six Sigma policy analyst. Map an uploaded Standard Operating
Procedure (SOP) onto an EXISTING, CLOSED issue taxonomy.

STRICT RULES:
1. For each customer problem the SOP handles, find the most specific issue in
   the taxonomy provided that it covers, and return it under "mappings" with
   its issue_code copied exactly.
2. You may NOT create issue codes. A problem the SOP handles that no issue in
   the taxonomy fits goes under "gaps" with a label, a one-sentence
   description, and a suggested_code/suggested_parent_code for a taxonomy
   administrator to consider.
3. Quote the SOP sentence that shows each mapping or gap in source_quote,
   copied verbatim (at most 300 characters).
4. Set extraction_confidence (0.0–1.0). Use < 0.75 when the fit is uncertain.
5. Do not map issues the SOP does not handle. Do not invent problems.

Return strict JSON only. No markdown.
"""


def extract_taxonomy(engine: Engine, kb_id: str, entity_id: str, sop_text: str,
                     before_write=None) -> list[dict]:
    """
    Stage 1: map the SOP onto the KB's live taxonomy. Writes mapping
    proposals (pending review) and the gaps it found. Returns the proposals;
    `.gaps` of the result list carries the gaps for the caller.
    """
    with engine.begin() as conn:
        taxonomy = live_taxonomy(conn, kb_id)
        business_line = knowledge.business_line_of(conn, kb_id, entity_id)
        guidance = _guidance(conn, kb_id, business_line, ("taxonomy", "gap"))

    taxonomy_block = "\n".join(
        f"  {'  ' * ((r['level'] or 1) - 1)}{code} (L{r['level']}): {r['label']}"
        + (f" — {r['description'][:160]}" if r.get("description") else "")
        for code, r in taxonomy.items()
    ) or "  (the taxonomy is empty — every problem is a gap)"
    scope = f"BUSINESS LINE: {business_line}\n" if business_line else ""

    def prompt(document: str) -> tuple[str, str]:
        return _TAXONOMY_SYSTEM, f"""{scope}LIVE ISSUE TAXONOMY (the only codes you may use):
{taxonomy_block}
{guidance}

{document}

Return JSON:
{{
  "mappings": [
    {{"issue_code": "CODE_FROM_TAXONOMY", "source_quote": "verbatim SOP text",
      "reason": "why this SOP covers it", "extraction_confidence": 0.9}}
  ],
  "gaps": [
    {{"label": "Problem the taxonomy lacks", "description": "One sentence",
      "suggested_code": "SCREAMING_SNAKE_CASE", "suggested_parent_code": "CODE_OR_NULL",
      "source_quote": "verbatim SOP text", "extraction_confidence": 0.8}}
  ]
}}"""

    merged: dict = {"mappings": [], "gaps": [], "taxonomy": []}
    for answer in _each_window(sop_text, prompt):
        for key in merged:
            merged[key] += answer.get(key) or []
    mappings, gaps = _clean_mappings(merged, taxonomy)

    proposals = []
    for m in mappings:
        node = taxonomy[m["issue_code"]]
        proposals.append({
            **m,
            "label": node["label"], "description": node.get("description") or "",
            "parent_code": node.get("parent_code"), "level": node["level"],
            "proposal_type": "existing",
        })

    with engine.begin() as conn:
        # The LLM calls ran outside any lock; the caller re-checks that the
        # proposal may still change before its proposals are replaced.
        if before_write:
            before_write(conn)
        conn.execute(text("""
            DELETE FROM kirana_kart.draft_taxonomy_proposals
            WHERE kb_id = :kb_id AND entity_id = :eid
        """), {"kb_id": kb_id, "eid": entity_id})
        conn.execute(text("""
            DELETE FROM kirana_kart.policy_taxonomy_gaps
            WHERE kb_id = :kb_id AND entity_id = :eid
        """), {"kb_id": kb_id, "eid": entity_id})

        for p in proposals:
            conn.execute(text("""
                INSERT INTO kirana_kart.draft_taxonomy_proposals
                    (kb_id, entity_id, issue_code, label, description, parent_code, level,
                     proposal_type, llm_output, extraction_confidence, source_excerpt)
                VALUES (:kb_id, :eid, :code, :label, :desc, :parent, :level,
                        'existing', CAST(:llm AS jsonb), :conf, :src)
            """), {
                "kb_id": kb_id, "eid": entity_id, "code": p["issue_code"], "label": p["label"],
                "desc": p["description"], "parent": p["parent_code"], "level": p["level"],
                "llm": json.dumps(p), "conf": p["extraction_confidence"], "src": p["source_excerpt"],
            })
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage="taxonomy",
                               item_ref=p["issue_code"], edit_type="proposed", business_line=business_line,
                               llm_output=p, confidence=p["extraction_confidence"])

        for g in gaps:
            g["id"] = conn.execute(text("""
                INSERT INTO kirana_kart.policy_taxonomy_gaps
                    (kb_id, entity_id, business_line, label, description, suggested_code,
                     suggested_parent_code, source_excerpt, extraction_confidence)
                VALUES (:kb_id, :eid, :bl, :label, :desc, :code, :parent, :src, :conf)
                RETURNING id
            """), {
                "kb_id": kb_id, "eid": entity_id, "bl": business_line, "label": g["label"],
                "desc": g["description"], "code": g["suggested_code"],
                "parent": g["suggested_parent_code"], "src": g["source_excerpt"],
                "conf": g["extraction_confidence"],
            }).scalar()
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage="gap",
                               item_ref=g["suggested_code"] or g["label"], edit_type="proposed",
                               business_line=business_line, llm_output=g,
                               confidence=g["extraction_confidence"])

    logger.info("Stage 1 complete: %d mappings, %d gaps for entity_id=%s",
                len(proposals), len(gaps), entity_id)
    result = _Proposals(proposals)
    result.gaps = gaps
    return result


class _Proposals(list):
    """A list of proposals that also carries the gaps / variable suggestions found."""
    gaps: list[dict]
    suggested_variables: list[dict]


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
5. parent_issue_codes: list of issue_code values (only from the taxonomy provided)
   that trigger this action. An action can serve multiple issue types.
6. If an action already exists in the existing registry, reuse the exact action_code_id
   and set proposal_type = "existing". Update exact_action if the SOP is more specific.
7. Do NOT invent actions. Only extract what is explicitly in the SOP.
8. Quote the SOP text that prescribes the action in source_quote (verbatim, ≤ 300 chars).
9. Set extraction_confidence per action.

Return strict JSON only. No markdown.
"""


def extract_actions(engine: Engine, kb_id: str, entity_id: str, sop_text: str,
                     before_write=None) -> list[dict]:
    """
    Stage 2: LLM reads SOP + accepted problems → proposes action codes.
    Writes to draft_action_proposals (pending review). Returns the proposals.
    """
    with engine.begin() as conn:
        accepted_taxonomy = _get_accepted_taxonomy(conn, kb_id, entity_id)
        existing_actions = _get_existing_action_codes(conn)
        business_line = knowledge.business_line_of(conn, kb_id, entity_id)
        guidance = _guidance(conn, kb_id, business_line, ("action", "rule"))

    taxonomy_block = "\n".join(
        f"  {'  ' * (r['level'] - 1)}{r['issue_code']} (L{r['level']}): {r['label']}"
        for r in accepted_taxonomy
    ) or "  (no taxonomy accepted yet)"

    existing_block = "\n".join(
        f"  {r['action_code_id']}: {r['action_name']} — {r['action_description'] or ''}"
        for r in existing_actions
    ) or "  (none yet)"
    scope = f"BUSINESS LINE: {business_line}\n" if business_line else ""

    def prompt(document: str) -> tuple[str, str]:
        return _ACTION_SYSTEM, f"""{scope}ACCEPTED ISSUE TAXONOMY (from Stage 1):
{taxonomy_block}

EXISTING ACTION REGISTRY:
{existing_block}
{guidance}

{document}

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
      "source_quote": "verbatim SOP text",
      "extraction_confidence": 0.92
    }}
  ]
}}"""

    raw: list = []
    for answer in _each_window(sop_text, prompt):
        raw += answer.get("actions") or []
    accepted_codes = {r["issue_code"] for r in accepted_taxonomy}
    proposals = _clean_actions(raw, {r["action_code_id"] for r in existing_actions})
    for p in proposals:
        # Only problems accepted in this proposal can be served by an action.
        p["parent_issue_codes"] = [c for c in p["parent_issue_codes"] if c in accepted_codes]

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
                     automation_eligible, proposal_type, llm_output, extraction_confidence,
                     source_excerpt)
                VALUES
                    (:kb_id, :eid, :code, :name, :desc,
                     :exact, :parents, :refund, :esc,
                     :auto, :ptype, CAST(:llm AS jsonb), :conf, :src)
            """), {
                "kb_id": kb_id,
                "eid": entity_id,
                "code": p["action_code_id"],
                "name": p["action_name"],
                "desc": p["action_description"],
                "exact": p["exact_action"],
                "parents": p["parent_issue_codes"],
                "refund": p["requires_refund"],
                "esc": p["requires_escalation"],
                "auto": p["automation_eligible"],
                "ptype": p["proposal_type"],
                "llm": json.dumps(p),
                "conf": p["extraction_confidence"],
                "src": p["source_excerpt"],
            })
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage="action",
                               item_ref=p["action_code_id"], edit_type="proposed",
                               business_line=business_line, llm_output=p,
                               confidence=p["extraction_confidence"])

    logger.info("Stage 2 complete: %d action proposals for entity_id=%s", len(proposals), entity_id)
    return proposals


# ─────────────────────────────────────────────────────────────────────────────
# Knowledge passages
# ─────────────────────────────────────────────────────────────────────────────

_KNOWLEDGE_SYSTEM = """\
You are a policy editor. Split an SOP into short, self-contained passages that
a support decision model and a support agent will read.

STRICT RULES:
1. Each passage covers one idea: an eligibility condition, an evidence
   requirement, an exception, an escalation path, or how to word a reply.
2. purpose: "decision" (guides what to decide), "response" (text for the reply
   to the customer, written to the customer), or "both".
3. issue_codes: the problems (only from the list provided) the passage applies
   to; [] when it applies to every problem.
4. Where the SOP states a tenant-specific value that belongs in a variable
   (support hours, escalation contact, business name, tone, refund cap), write
   the placeholder instead, e.g. {{support_hours}}, and report the value found
   under "variables". Use the ticket placeholders listed when the text refers
   to the customer's tier, order or refund.
5. source_quote: the SOP text the passage is based on, copied verbatim
   (at most 400 characters).
6. Do not add policy the SOP does not state.

Return strict JSON only. No markdown.
"""


def extract_knowledge(engine: Engine, kb_id: str, entity_id: str, sop_text: str,
                      before_write=None) -> list[dict]:
    """
    Split the SOP into reviewable passages (pending review). Replaces this
    proposal's AI passages; passages people added are kept. Variables the
    SOP states are returned as suggestions; nothing is set on the tenant.
    """
    with engine.begin() as conn:
        accepted = _get_accepted_taxonomy(conn, kb_id, entity_id)
        business_line = knowledge.business_line_of(conn, kb_id, entity_id)
        defined = knowledge.static_variables(conn, kb_id, business_line)
        guidance = _guidance(conn, kb_id, business_line, ("chunk",))

    issues_block = "\n".join(f"  {r['issue_code']}: {r['label']}" for r in accepted) or "  (none accepted yet)"
    static_names = sorted(set(defined) | set(pk.SUGGESTED_STATIC_VARIABLES))
    variables_block = "\n".join(
        f"  {{{{{n}}}}} — {pk.SUGGESTED_STATIC_VARIABLES.get(n, 'tenant setting')}"
        + (f" (currently: {defined[n][:80]})" if n in defined else "")
        for n in static_names
    )
    ticket_block = "\n".join(f"  {{{{{n}}}}} — {d}" for n, d in pk.DYNAMIC_VARIABLES.items())
    scope = f"BUSINESS LINE: {business_line}\n" if business_line else ""

    def prompt(document: str) -> tuple[str, str]:
        return _KNOWLEDGE_SYSTEM, f"""{scope}CUSTOMER PROBLEMS IN THIS POLICY:
{issues_block}

TENANT VARIABLES:
{variables_block}

TICKET PLACEHOLDERS (filled per ticket):
{ticket_block}
{guidance}

{document}

Return JSON:
{{
  "passages": [
    {{"title": "Short title", "body": "Passage text with {{{{placeholders}}}}",
      "issue_codes": ["CODE"], "purpose": "decision", "source_quote": "verbatim SOP text"}}
  ],
  "variables": [{{"name": "support_hours", "value": "Mon–Sat 9am–9pm"}}]
}}"""

    known_codes = {r["issue_code"] for r in accepted}
    passages: list[dict] = []
    suggested: dict[str, str] = {}
    for answer in _each_window(sop_text, prompt):
        for item in answer.get("passages") or []:
            if not isinstance(item, dict):
                continue
            raw_codes = item.get("issue_codes") if isinstance(item.get("issue_codes"), list) else []
            codes = [c for c in (_code(c, 80) for c in raw_codes) if c in known_codes]
            try:
                clean = knowledge.clean_chunk_fields({
                    "title": item.get("title"), "body": str(item.get("body") or "")[:knowledge.MAX_BODY],
                    "purpose": item.get("purpose") if item.get("purpose") in pk.PURPOSES else "both",
                    "issue_codes": codes,
                }, known_codes)
            except ValueError:
                continue
            quote = _quote(item.get("source_quote"))
            located = knowledge.locate_quote(sop_text, quote)
            passages.append({**clean, "source_excerpt": quote,
                             "source_start": located[0] if located else None,
                             "source_end": located[1] if located else None})
        for var in answer.get("variables") or []:
            if isinstance(var, dict):
                try:
                    name = knowledge.validate_variable_name(str(var.get("name") or ""))
                except ValueError:
                    continue
                value = str(var.get("value") or "").strip()[:500]
                if value:
                    suggested.setdefault(name, value)

    with engine.begin() as conn:
        if before_write:
            before_write(conn)
        conn.execute(text("""
            DELETE FROM kirana_kart.policy_knowledge_chunks
            WHERE kb_id = :kb_id AND entity_id = :eid AND origin = 'ai'
        """), {"kb_id": kb_id, "eid": entity_id})
        start = conn.execute(text("""
            SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kirana_kart.policy_knowledge_chunks
            WHERE kb_id = :kb_id AND entity_id = :eid
        """), {"kb_id": kb_id, "eid": entity_id}).scalar() or 0
        for offset, p in enumerate(passages):
            position = start + offset
            p["chunk_key"] = knowledge.chunk_key(entity_id, position, p["title"])
            p["sort_order"] = position
            p["id"] = conn.execute(text("""
                INSERT INTO kirana_kart.policy_knowledge_chunks
                    (kb_id, entity_id, chunk_key, business_line, title, body, issue_codes, purpose,
                     source_excerpt, source_start, source_end, origin, status, llm_output, sort_order)
                VALUES (:kb_id, :eid, :key, :bl, :title, :body, :codes, :purpose,
                        :src, :s, :e, 'ai', 'pending', CAST(:llm AS jsonb), :sort)
                RETURNING id
            """), {
                "kb_id": kb_id, "eid": entity_id, "key": p["chunk_key"], "bl": business_line,
                "title": p["title"], "body": p["body"], "codes": p["issue_codes"], "purpose": p["purpose"],
                "src": p["source_excerpt"], "s": p["source_start"], "e": p["source_end"],
                "llm": json.dumps(p), "sort": position,
            }).scalar()
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage="chunk",
                               item_ref=p["chunk_key"], edit_type="proposed",
                               business_line=business_line, llm_output=p)

    logger.info("Knowledge extraction: %d passages for entity_id=%s", len(passages), entity_id)
    result = _Proposals(passages)
    result.suggested_variables = [
        {"name": n, "value": v, "defined": n in defined} for n, v in sorted(suggested.items())
    ]
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Rule Generation (deterministic, no LLM)
# ─────────────────────────────────────────────────────────────────────────────

def _issue_ancestry(conn, taxonomy_by_code: dict[str, dict], kb_id: str | None = None) -> dict[str, str | None]:
    """
    Map every accepted issue code to its level-1 root: rule_registry stores a
    rule's issue as (issue_type_l1 = root, issue_type_l2 = the node itself).
    Ancestry comes from the live taxonomy (the KB's, when kb_id is given).
    Unresolvable ancestry maps to None.
    """
    existing = {
        r["issue_code"]: r for r in conn.execute(text("""
            SELECT c.issue_code, c.level, p.issue_code AS parent_code
            FROM kirana_kart.issue_taxonomy c
            LEFT JOIN kirana_kart.issue_taxonomy p ON p.id = c.parent_id
            WHERE c.is_active = TRUE AND (CAST(:kb AS text) IS NULL OR c.kb_id = :kb)
        """), {"kb": kb_id}).mappings().all()
    }

    def root(code: str, depth: int = 0) -> str | None:
        node = existing.get(code) or taxonomy_by_code.get(code)
        if not node or depth > 4:
            return None
        if node["level"] == 1:
            return code
        return root(node["parent_code"], depth + 1) if node.get("parent_code") else None

    return {code: root(code) for code in taxonomy_by_code}


def taxonomy_problems(conn, kb_id: str, entity_id: str) -> list[str]:
    """
    Accepted problems a rule cannot be written for: every one must be a live
    code of this knowledge base's taxonomy, with a resolvable root. Found
    here, before approval, rather than as rules that never match.
    """
    taxonomy = {t["issue_code"]: t for t in _get_accepted_taxonomy(conn, kb_id, entity_id)}
    live = live_taxonomy(conn, kb_id)
    ancestry = _issue_ancestry(conn, taxonomy, kb_id)
    problems = []
    for code in taxonomy:
        if code not in live:
            problems.append(
                f"{code} is not in the live issue taxonomy — map it to an existing problem, "
                "or ask a taxonomy admin to add it"
            )
        elif ancestry.get(code) is None:
            problems.append(f"{code} has no active parent category in the live taxonomy")
    return problems


def _rule_id(issue_code: str, action_code: str) -> str:
    """Deterministic and collision-free: truncated readable prefix + digest."""
    import hashlib
    digest = hashlib.sha1(f"{issue_code}|{action_code}".encode()).hexdigest()[:8].upper()
    return f"R-{issue_code[:24]}-{action_code[:24]}-{digest}"


def generate_rules(engine: Engine, kb_id: str, entity_id: str, conn=None) -> dict:
    """
    Stage 3: Deterministic join of accepted problems × accepted action proposals.
    For each (issue_code, action_code_id) pair where the issue is in the action's
    parent_issue_codes, generate one rule in rule_registry, for the proposal's
    business line (NULL: every line).

    Accepted actions that are new to master_action_codes are registered here:
    a rule must reference a real action id. A new code is inert until a live
    policy's rules reference it; publication later applies the reviewer's
    final wording (commit_proposals_to_registry).

    Returns {"rules": [...], "skipped": [...]} — skipped explains every
    accepted pairing that could not become a rule.
    """
    if conn is None:
        with engine.begin() as own:
            return generate_rules(engine, kb_id, entity_id, conn=own)

    business_line = knowledge.business_line_of(conn, kb_id, entity_id)
    taxonomy = _get_accepted_taxonomy(conn, kb_id, entity_id)
    live = live_taxonomy(conn, kb_id)
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
    ancestry = _issue_ancestry(conn, taxonomy_by_code, kb_id)
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
            if issue_code not in live:
                skipped.append({"issue_code": issue_code, "action_code_id": pair[1],
                                "reason": "Customer problem is not in the live issue taxonomy"})
                continue
            root = ancestry.get(issue_code)
            if root is None:
                skipped.append({"issue_code": issue_code, "action_code_id": pair[1],
                                "reason": "Customer problem has no active parent category"})
                continue
            if pair in seen:
                continue
            seen.add(pair)

            level = live[issue_code]["level"]
            issue_l2 = issue_code if level >= 2 else None
            # First-match evaluation is priority ASC (lower wins). A more
            # specific situation must outrank its general category.
            priority = 500 - 100 * (level - 1)
            rule_id = _rule_id(issue_code, action["action_code_id"])
            deterministic = bool(action.get("automation_eligible", True))

            conn.execute(text("""
                INSERT INTO kirana_kart.rule_registry
                    (kb_id, rule_id, policy_version, module_name, rule_type,
                     priority, issue_type_l1, issue_type_l2, business_line, action_id,
                     deterministic, overrideable, conditions, flags)
                VALUES
                    (:kb_id, :rule_id, :version, 'default', 'issue_resolution',
                     :priority, :l1, :l2, :bl, :action_id,
                     :auto, FALSE, '{}', '{}')
            """), {
                "kb_id": kb_id,
                "rule_id": rule_id,
                "version": entity_id,
                "priority": priority,
                "l1": root,
                "l2": issue_l2,
                "bl": business_line,
                "action_id": action_id_map[action["action_code_id"]],
                "auto": deterministic,
            })

            r = {
                "rule_id": rule_id,
                "issue_type_l1": root,
                "issue_type_l2": issue_l2,
                "business_line": business_line,
                "action_code_id": action["action_code_id"],
                "action_name": action["action_name"],
                "exact_action": action.get("exact_action"),
            }
            generated.append(r)
            # What the generator wrote, so a later human edit is diffed
            # against the machine's version of this rule.
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage="rule", item_ref=rule_id,
                               edit_type="proposed", business_line=business_line, llm_output={
                                   **r, "priority": priority, "deterministic": deterministic,
                                   "conditions": {}, "action_payload": None,
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
    Called on publish. Promotes accepted new actions to master_action_codes
    with the reviewer's final wording (issue codes are owned by the taxonomy
    lifecycle, not by Policy Studio).
    Then regenerates extraction_standards.md for this KB.

    With `conn`, runs in the caller's transaction so a failed activation also
    leaves the registries untouched.
    """
    if conn is None:
        with engine.begin() as own:
            return commit_proposals_to_registry(engine, kb_id, entity_id, actor_id, conn=own)

    # Issue codes are not created here: Policy Studio maps SOPs onto the live
    # taxonomy (taxonomy_problems refuses anything else before approval).
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
