"""
app/admin/services/policy_knowledge_service.py
===============================================
Policy Studio's record of what the AI proposed and what people changed.

* Every AI proposal is logged as 'proposed' when it is made; a reviewer's
  decision is logged separately with a field-level diff (AI value → human
  value) and the reviewer's own reason. Unreviewed AI output is no longer
  logged as 'accepted'.
* lessons_for() turns recent corrections into prompt text for the next
  extraction — immediately, not only after a publish — scoped to the
  knowledge base, with this business line's corrections first and the rest
  of the knowledge base's after them.
* Knowledge passages and tenant variables (see app/l4_agents/policy_knowledge).
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, Optional

from sqlalchemy import text

from app.l4_agents import policy_knowledge as pk

MAX_BUSINESS_LINE_LENGTH = 50
LESSON_LIMIT = 30
_LESSON_CHARS = 400


# ============================================================
# BUSINESS LINE (the proposal's use case)
# ============================================================

def normalise_business_line(value: Any) -> Optional[str]:
    """Lower-case slug as tickets carry it ('ecommerce'); empty means every line."""
    raw = re.sub(r"[^a-z0-9_]+", "_", str(value or "").strip().lower()).strip("_")
    if len(raw) > MAX_BUSINESS_LINE_LENGTH:
        raise ValueError(f"Business line must be at most {MAX_BUSINESS_LINE_LENGTH} characters")
    return raw or None


def business_line_of(conn, kb_id: str, entity_id: str) -> Optional[str]:
    return conn.execute(text("""
        SELECT NULLIF(metadata->>'business_line', '') FROM kirana_kart.bpm_process_instances
        WHERE kb_id = :kb AND entity_id = :eid AND entity_type = 'kb_version'
        ORDER BY id DESC LIMIT 1
    """), {"kb": kb_id, "eid": entity_id}).scalar()


def known_business_lines(conn, kb_id: str) -> list[str]:
    """Lines tickets arrive with (integrations) plus lines this KB already writes for."""
    rows = conn.execute(text("""
        SELECT LOWER(business_line) FROM kirana_kart.integrations WHERE business_line IS NOT NULL
        UNION
        SELECT LOWER(business_line) FROM kirana_kart.rule_registry
         WHERE kb_id = :kb AND business_line IS NOT NULL
        UNION
        SELECT LOWER(metadata->>'business_line') FROM kirana_kart.bpm_process_instances
         WHERE kb_id = :kb AND COALESCE(metadata->>'business_line', '') <> ''
    """), {"kb": kb_id}).scalars().all()
    return sorted({r for r in rows if r} | {"ecommerce"})


# ============================================================
# EDIT LOG
# ============================================================

def field_changes(before: dict, after: dict, fields: Iterable[str]) -> dict:
    """{field: {"ai": old, "human": new}} for every field whose value changed."""
    changes = {}
    for name in fields:
        if name not in after:
            continue
        old, new = before.get(name), after.get(name)
        if _comparable(old) != _comparable(new):
            changes[name] = {"ai": old, "human": new}
    return changes


def _comparable(value: Any) -> Any:
    if isinstance(value, (list, tuple, set)):
        return sorted(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, default=str)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def log_edit(conn, *, kb_id: str, entity_id: Optional[str], stage: str, item_ref: Optional[str],
             edit_type: str, business_line: Optional[str] = None, llm_output: Any = None,
             user_output: Any = None, reason: Optional[str] = None, actor_id: Optional[int] = None,
             changes: Optional[dict] = None, confidence: Optional[float] = None) -> None:
    conn.execute(text("""
        INSERT INTO kirana_kart.rule_edit_log
            (kb_id, entity_id, stage, item_ref, edit_type, business_line,
             llm_output, user_output, field_changes, edit_reason, extraction_confidence, created_by)
        VALUES (:kb, :eid, :stage, :ref, :etype, :bl,
                CAST(:llm AS jsonb), CAST(:usr AS jsonb), CAST(:chg AS jsonb), :reason, :conf, :uid)
    """), {
        "kb": kb_id, "eid": entity_id, "stage": stage, "ref": item_ref, "etype": edit_type,
        "bl": business_line,
        "llm": json.dumps(llm_output, default=str) if llm_output is not None else None,
        "usr": json.dumps(user_output, default=str) if user_output is not None else None,
        "chg": json.dumps(changes, default=str) if changes else None,
        "reason": reason, "conf": confidence, "uid": actor_id,
    })


def _clip(value: Any, limit: int = 120) -> str:
    rendered = value if isinstance(value, str) else json.dumps(value, default=str)
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"


def _describe(row: dict) -> str:
    stage, ref = row["stage"], row["item_ref"] or "?"
    changes = row.get("field_changes") or {}
    if isinstance(changes, str):
        changes = json.loads(changes)
    if row["edit_type"] == "rejected":
        what = f"reviewers rejected the AI's {stage} proposal {ref}"
    elif row["edit_type"] == "manual_add":
        what = f"reviewers added {stage} {ref} the AI missed"
    elif changes:
        parts = [f"{name}: AI {_clip(c.get('ai'))} → reviewer {_clip(c.get('human'))}"
                 for name, c in list(changes.items())[:4]]
        what = f"{stage} {ref} corrected ({'; '.join(parts)})"
    else:
        what = f"{stage} {ref} edited by a reviewer"
    reason = (row.get("edit_reason") or "").strip()
    line = f"- {what}" + (f". Why: {reason}" if reason else "")
    return line[:_LESSON_CHARS]


def lessons_for(conn, kb_id: str, business_line: Optional[str],
                stages: Iterable[str], limit: int = LESSON_LIMIT) -> str:
    """
    Recent human corrections as prompt text. This business line's lessons
    come first; lessons from the knowledge base's other lines follow as
    shared ones. Only decisions people made count.
    """
    rows = conn.execute(text("""
        SELECT stage, item_ref, edit_type, field_changes, edit_reason, business_line,
               (business_line IS NOT DISTINCT FROM :bl) AS same_line
        FROM kirana_kart.rule_edit_log
        WHERE kb_id = :kb
          AND stage = ANY(:stages)
          AND edit_type IN ('edited', 'rejected', 'manual_add')
          AND created_by IS NOT NULL
        ORDER BY (business_line IS NOT DISTINCT FROM :bl) DESC, created_at DESC, id DESC
        LIMIT :limit
    """), {"kb": kb_id, "bl": business_line, "stages": list(stages), "limit": limit}).mappings().all()
    if not rows:
        return ""
    own = [_describe(dict(r)) for r in rows if r["same_line"]]
    shared = [_describe(dict(r)) for r in rows if not r["same_line"]]
    scope = business_line or "all business lines"
    lines = ["LESSONS FROM REVIEWERS' EARLIER CORRECTIONS — do not repeat these mistakes:"]
    if own:
        lines.append(f"For {scope}:")
        lines += own
    if shared:
        lines.append("Shared across this knowledge base:")
        lines += shared
    return "\n".join(lines)


def lesson_list(conn, kb_id: str, business_line: Optional[str], limit: int = LESSON_LIMIT) -> list[dict]:
    """The same lessons for the wizard, so reviewers see what the AI is told."""
    rows = conn.execute(text("""
        SELECT id, stage, item_ref, edit_type, field_changes, edit_reason, business_line,
               entity_id, created_at, (business_line IS NOT DISTINCT FROM :bl) AS same_line
        FROM kirana_kart.rule_edit_log
        WHERE kb_id = :kb
          AND edit_type IN ('edited', 'rejected', 'manual_add')
          AND created_by IS NOT NULL
        ORDER BY (business_line IS NOT DISTINCT FROM :bl) DESC, created_at DESC, id DESC
        LIMIT :limit
    """), {"kb": kb_id, "bl": business_line, "limit": limit}).mappings().all()
    return [{**dict(r), "summary": _describe(dict(r))} for r in rows]


# ============================================================
# SOURCE CITATIONS
# ============================================================

def _squash(value: str) -> tuple[str, list[int]]:
    """Whitespace-collapsed, lower-cased text plus a map back to original offsets."""
    out, index, last_space = [], [], False
    for i, ch in enumerate(value):
        if ch.isspace():
            if last_space:
                continue
            out.append(" ")
            last_space = True
        else:
            out.append(ch.lower())
            last_space = False
        index.append(i)
    return "".join(out), index


def locate_quote(document: str, quote: Any) -> Optional[tuple[int, int]]:
    """Where a quoted passage sits in the SOP, ignoring case and whitespace."""
    quote = str(quote or "").strip()
    if len(quote) < 8 or not document:
        return None
    start = document.find(quote)
    if start >= 0:
        return start, start + len(quote)
    hay, index = _squash(document)
    needle, _ = _squash(quote)
    pos = hay.find(needle.strip())
    if pos < 0:
        return None
    end = pos + len(needle.strip()) - 1
    return index[pos], index[min(end, len(index) - 1)] + 1


# ============================================================
# VARIABLES
# ============================================================

def static_variables(conn, kb_id: str, business_line: Optional[str]) -> dict[str, str]:
    """Knowledge-base values overlaid with this business line's."""
    rows = conn.execute(text("""
        SELECT name, value FROM kirana_kart.policy_variables
        WHERE kb_id = :kb AND (business_line = '' OR business_line = :bl)
        ORDER BY (business_line <> '') ASC
    """), {"kb": kb_id, "bl": business_line or ""}).mappings().all()
    return {r["name"]: r["value"] for r in rows}


def list_variables(conn, kb_id: str) -> list[dict]:
    rows = conn.execute(text("""
        SELECT id, business_line, name, value, description, updated_at
        FROM kirana_kart.policy_variables WHERE kb_id = :kb
        ORDER BY name, business_line
    """), {"kb": kb_id}).mappings().all()
    return [dict(r) for r in rows]


def validate_variable_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not pk.VARIABLE_NAME.match(name):
        raise ValueError("Variable names are 2-50 characters: lower-case letters, digits and _, "
                         "starting with a letter")
    if name in pk.DYNAMIC_VARIABLES:
        raise ValueError(f"{{{{{name}}}}} is filled from each ticket and cannot be set")
    return name


def set_variable(conn, kb_id: str, business_line: Optional[str], name: str, value: str,
                 description: Optional[str], actor_id: Optional[int], reason: Optional[str]) -> dict:
    name = validate_variable_name(name)
    before = conn.execute(text("""
        SELECT value FROM kirana_kart.policy_variables
        WHERE kb_id = :kb AND business_line = :bl AND name = :name
    """), {"kb": kb_id, "bl": business_line or "", "name": name}).scalar()
    row = conn.execute(text("""
        INSERT INTO kirana_kart.policy_variables (kb_id, business_line, name, value, description, updated_by)
        VALUES (:kb, :bl, :name, :value, :desc, :uid)
        ON CONFLICT (kb_id, business_line, name) DO UPDATE
            SET value = EXCLUDED.value,
                description = COALESCE(EXCLUDED.description, kirana_kart.policy_variables.description),
                updated_by = EXCLUDED.updated_by, updated_at = NOW()
        RETURNING id, business_line, name, value, description, updated_at
    """), {"kb": kb_id, "bl": business_line or "", "name": name, "value": value,
           "desc": description, "uid": actor_id}).mappings().first()
    if before != value:
        log_edit(conn, kb_id=kb_id, entity_id=None, stage="variable", item_ref=name,
                 edit_type="manual_add" if before is None else "edited", business_line=business_line,
                 user_output={"value": value}, reason=reason, actor_id=actor_id,
                 changes={"value": {"ai": before, "human": value}})
    return dict(row)


def delete_variable(conn, kb_id: str, variable_id: int, actor_id: Optional[int]) -> bool:
    row = conn.execute(text("""
        DELETE FROM kirana_kart.policy_variables WHERE id = :id AND kb_id = :kb
        RETURNING name, value, business_line
    """), {"id": variable_id, "kb": kb_id}).mappings().first()
    if row:
        log_edit(conn, kb_id=kb_id, entity_id=None, stage="variable", item_ref=row["name"],
                 edit_type="rejected", business_line=row["business_line"] or None,
                 llm_output={"value": row["value"]}, actor_id=actor_id)
    return bool(row)


# ============================================================
# KNOWLEDGE PASSAGES
# ============================================================

CHUNK_EDIT_FIELDS = ("title", "body", "issue_codes", "purpose")
MAX_TITLE = 200
MAX_BODY = 4000


def list_chunks(conn, kb_id: str, entity_id: str, include_rejected: bool = True) -> list[dict]:
    rows = conn.execute(text(f"""
        SELECT id, chunk_key, business_line, title, body, issue_codes, purpose, source_excerpt,
               source_start, source_end, origin, status, llm_output, edit_reason,
               edited_by, edited_at, sort_order
        FROM kirana_kart.policy_knowledge_chunks
        WHERE kb_id = :kb AND entity_id = :eid
          {"" if include_rejected else "AND status <> 'rejected'"}
        ORDER BY sort_order, id
    """), {"kb": kb_id, "eid": entity_id}).mappings().all()
    return [dict(r) for r in rows]


def clean_chunk_fields(values: dict, known_issue_codes: set[str]) -> dict:
    """Validate a passage as a person or the AI wrote it; raises ValueError."""
    out: dict[str, Any] = {}
    if "title" in values:
        title = str(values.get("title") or "").strip()
        if not title or len(title) > MAX_TITLE:
            raise ValueError(f"A passage needs a title of at most {MAX_TITLE} characters")
        out["title"] = title
    if "body" in values:
        body = str(values.get("body") or "").strip()
        if not body or len(body) > MAX_BODY:
            raise ValueError(f"A passage needs text of at most {MAX_BODY} characters")
        out["body"] = body
    if "purpose" in values:
        if values.get("purpose") not in pk.PURPOSES:
            raise ValueError("purpose must be decision, response or both")
        out["purpose"] = values["purpose"]
    if "issue_codes" in values:
        codes = values.get("issue_codes") or []
        if not isinstance(codes, list):
            raise ValueError("issue_codes must be a list")
        codes = sorted({str(c).strip().upper() for c in codes if str(c).strip()})
        unknown = [c for c in codes if c not in known_issue_codes]
        if unknown:
            raise ValueError("Not customer problems in this proposal: " + ", ".join(unknown))
        out["issue_codes"] = codes
    return out


def chunk_key(entity_id: str, position: int, title: str) -> str:
    import hashlib
    digest = hashlib.sha1(f"{entity_id}|{position}|{title}".encode()).hexdigest()[:6].upper()
    return f"K{position:03d}-{digest}"


def undefined_in_chunks(conn, kb_id: str, entity_id: str, business_line: Optional[str]) -> list[str]:
    bodies = conn.execute(text("""
        SELECT body FROM kirana_kart.policy_knowledge_chunks
        WHERE kb_id = :kb AND entity_id = :eid AND status IN ('accepted', 'edited', 'pending')
    """), {"kb": kb_id, "eid": entity_id}).scalars().all()
    return pk.undefined_variables(bodies, static_variables(conn, kb_id, business_line))
