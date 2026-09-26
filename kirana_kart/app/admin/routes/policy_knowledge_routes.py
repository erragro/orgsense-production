"""
app/admin/routes/policy_knowledge_routes.py
===========================================
Policy Studio endpoints for what a proposal knows beyond its rules.

  Taxonomy gaps (problems the live taxonomy has no code for):
    GET  /bpm/kb/{kb_id}/live-taxonomy                 → codes a proposal may map onto
    GET  /bpm/kb/{kb_id}/taxonomy-gaps                 → ?entity_id= &status=
    POST /bpm/kb/{kb_id}/taxonomy-gaps/{gap_id}        → map | dismiss | reopen

  Knowledge passages (versioned with the proposal):
    POST   /bpm/kb/{kb_id}/extract-knowledge
    GET    /bpm/kb/{kb_id}/knowledge?entity_id=
    POST   /bpm/kb/{kb_id}/knowledge                   → add a passage by hand
    PUT    /bpm/kb/{kb_id}/knowledge/{chunk_id}        → accept | edit | reject
    GET    /bpm/kb/{kb_id}/knowledge/{chunk_id}/preview → rendered with sample values

  Bulk review:
    POST /bpm/kb/{kb_id}/proposals/{entity_id}/accept-all

  Variables (tenant settings passages embed as {{name}}):
    GET    /bpm/kb/{kb_id}/variables
    PUT    /bpm/kb/{kb_id}/variables
    DELETE /bpm/kb/{kb_id}/variables/{variable_id}

  Use case and learning:
    GET /bpm/kb/{kb_id}/business-lines
    PUT /bpm/kb/{kb_id}/proposals/{entity_id}/business-line
    GET /bpm/kb/{kb_id}/lessons?business_line=
"""
from __future__ import annotations

import json
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.admin.db import engine
from app.admin.routes.auth import UserContext
from app.admin.routes.bpm_routes import (
    LifecycleError, _entity_id, _kb_edit, _kb_view, _lifecycle_txn,
    _require_kb_access, _require_reason, _run_analysis,
)
from app.admin.services import policy_knowledge_service as knowledge
from app.admin.services import policy_lifecycle as lifecycle
from app.l4_agents import policy_knowledge as pk

router = APIRouter(prefix="/bpm", tags=["BPM"])


def _proposal(conn, kb_id: str, entity_id: str, u: UserContext, change: str) -> dict:
    instance = lifecycle.load_proposal(conn, kb_id, entity_id, lock=True)
    lifecycle.open_for_editing(conn, instance, u, change)
    return instance


def _accepted_codes(conn, kb_id: str, entity_id: str) -> set[str]:
    return set(conn.execute(text("""
        SELECT issue_code FROM kirana_kart.draft_taxonomy_proposals
        WHERE kb_id = :kb AND entity_id = :eid AND status IN ('accepted', 'edited')
    """), {"kb": kb_id, "eid": entity_id}).scalars().all())


# ============================================================
# TAXONOMY GAPS
# ============================================================

@router.get("/kb/{kb_id}/live-taxonomy")
def live_taxonomy_codes(kb_id: str, u: UserContext = Depends(_kb_view)):
    """The problems a proposal may be mapped onto (this KB's active codes)."""
    from app.l45_ml_platform.compiler.sop_extractor import live_taxonomy

    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        return jsonable_encoder(list(live_taxonomy(conn, kb_id).values()))


@router.get("/kb/{kb_id}/taxonomy-gaps")
def list_taxonomy_gaps(
    kb_id: str,
    entity_id: Optional[str] = Query(default=None),
    status: Optional[Literal["open", "mapped", "dismissed"]] = Query(default=None),
    u: UserContext = Depends(_kb_view),
):
    """
    Without entity_id: the knowledge base's queue for its taxonomy admins —
    every problem an SOP described that the taxonomy has no code for.
    """
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, entity_id, business_line, label, description, suggested_code,
                   suggested_parent_code, source_excerpt, extraction_confidence, status,
                   mapped_issue_code, resolution_note, resolved_at, created_at
            FROM kirana_kart.policy_taxonomy_gaps
            WHERE kb_id = :kb
              AND (CAST(:eid AS text) IS NULL OR entity_id = :eid)
              AND (CAST(:status AS text) IS NULL OR status = :status)
            ORDER BY created_at DESC, id
        """), {"kb": kb_id, "eid": entity_id, "status": status}).mappings().all()
    return jsonable_encoder([dict(r) for r in rows])


class GapDecision(BaseModel):
    action: Literal["map", "dismiss", "reopen"]
    issue_code: Optional[str] = Field(default=None, max_length=80)
    note: Optional[str] = Field(default=None, max_length=2000)


@router.post("/kb/{kb_id}/taxonomy-gaps/{gap_id}")
def resolve_taxonomy_gap(kb_id: str, gap_id: int, body: GapDecision,
                         u: UserContext = Depends(_kb_edit)):
    """
    map: the problem is covered by a live code (often one a taxonomy admin
    has just added) — it becomes an accepted mapping of the proposal.
    dismiss: the SOP does not need it. Either way the reason is kept.
    """
    from app.l45_ml_platform.compiler.sop_extractor import live_taxonomy

    _require_kb_access(u, kb_id, "edit")
    if body.action != "reopen":
        _require_reason("edited", body.note)
    with _lifecycle_txn() as conn:
        gap = conn.execute(text("""
            SELECT * FROM kirana_kart.policy_taxonomy_gaps WHERE id = :id AND kb_id = :kb FOR UPDATE
        """), {"id": gap_id, "kb": kb_id}).mappings().first()
        if not gap:
            raise LifecycleError(404, "Gap not found")
        _proposal(conn, kb_id, gap["entity_id"], u, f"Taxonomy gap '{gap['label']}' resolved")
        ai = {k: gap[k] for k in ("label", "description", "suggested_code", "suggested_parent_code")}
        code = None

        if body.action == "map":
            code = (body.issue_code or "").strip().upper()
            node = live_taxonomy(conn, kb_id).get(code)
            if node is None:
                raise LifecycleError(400, f"{code or 'That code'} is not in this knowledge base's live "
                                          "issue taxonomy. A taxonomy admin must add it first.")
            existing = conn.execute(text("""
                SELECT id FROM kirana_kart.draft_taxonomy_proposals
                WHERE kb_id = :kb AND entity_id = :eid AND issue_code = :code
            """), {"kb": kb_id, "eid": gap["entity_id"], "code": code}).scalar()
            if existing:
                conn.execute(text("""
                    UPDATE kirana_kart.draft_taxonomy_proposals
                    SET status = 'accepted', edited_at = NOW(), edited_by = :uid
                    WHERE id = :id
                """), {"id": existing, "uid": u.id})
            else:
                conn.execute(text("""
                    INSERT INTO kirana_kart.draft_taxonomy_proposals
                        (kb_id, entity_id, issue_code, label, description, parent_code, level,
                         proposal_type, status, llm_output, user_output, edit_reason,
                         extraction_confidence, source_excerpt, edited_at, edited_by)
                    VALUES (:kb, :eid, :code, :label, :desc, :parent, :level,
                            'existing', 'edited', CAST(:llm AS jsonb), CAST(:usr AS jsonb), :reason,
                            :conf, :src, NOW(), :uid)
                """), {
                    "kb": kb_id, "eid": gap["entity_id"], "code": code, "label": node["label"],
                    "desc": node.get("description"), "parent": node.get("parent_code"),
                    "level": node["level"], "llm": json.dumps(ai), "usr": json.dumps({"issue_code": code}),
                    "reason": body.note, "conf": gap["extraction_confidence"],
                    "src": gap["source_excerpt"], "uid": u.id,
                })
            status = "mapped"
        else:
            status = "dismissed" if body.action == "dismiss" else "open"

        conn.execute(text("""
            UPDATE kirana_kart.policy_taxonomy_gaps
            SET status = :status, mapped_issue_code = :code, resolution_note = :note,
                resolved_by = :uid, resolved_at = CASE WHEN :status = 'open' THEN NULL ELSE NOW() END
            WHERE id = :id
        """), {"status": status, "code": code, "note": body.note, "uid": u.id, "id": gap_id})
        if body.action != "reopen":
            knowledge.log_edit(
                conn, kb_id=kb_id, entity_id=gap["entity_id"], stage="gap",
                item_ref=gap["suggested_code"] or gap["label"],
                edit_type="edited" if status == "mapped" else "rejected",
                business_line=gap["business_line"], llm_output=ai,
                user_output={"issue_code": code} if code else None, reason=body.note, actor_id=u.id,
                changes={"issue_code": {"ai": gap["suggested_code"], "human": code}} if code else None,
            )
    return {"id": gap_id, "status": status, "mapped_issue_code": code}


# ============================================================
# KNOWLEDGE PASSAGES
# ============================================================

@router.post("/kb/{kb_id}/extract-knowledge")
def extract_knowledge_stage(kb_id: str, body: dict, u: UserContext = Depends(_kb_edit)):
    """Split the SOP into passages for review. Passages people added are kept."""
    from app.l45_ml_platform.compiler.sop_extractor import extract_knowledge

    entity_id = _entity_id(body)
    _require_kb_access(u, kb_id, "edit")
    return jsonable_encoder(_run_analysis(kb_id, entity_id, u, extract_knowledge, "Knowledge"))


@router.get("/kb/{kb_id}/knowledge")
def list_knowledge(kb_id: str, entity_id: str = Query(...), u: UserContext = Depends(_kb_view)):
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        line = knowledge.business_line_of(conn, kb_id, entity_id)
        chunks = knowledge.list_chunks(conn, kb_id, entity_id)
        defined = knowledge.static_variables(conn, kb_id, line)
    for chunk in chunks:
        chunk["variables"] = pk.placeholders(chunk["body"])
        chunk["undefined_variables"] = pk.undefined_variables([chunk["body"]], defined)
    return jsonable_encoder({
        "business_line": line,
        "chunks": chunks,
        "undefined_variables": pk.undefined_variables(
            [c["body"] for c in chunks if c["status"] != "rejected"], defined,
        ),
    })


class ChunkCreate(BaseModel):
    entity_id: str = Field(..., max_length=50)
    title: str = Field(..., max_length=knowledge.MAX_TITLE)
    body: str = Field(..., max_length=knowledge.MAX_BODY)
    issue_codes: list[str] = Field(default_factory=list)
    purpose: Literal["decision", "response", "both"] = "both"
    source_excerpt: Optional[str] = Field(default=None, max_length=1000)
    edit_reason: Optional[str] = Field(default=None, max_length=2000)


@router.post("/kb/{kb_id}/knowledge", status_code=201)
def add_knowledge(kb_id: str, body: ChunkCreate, u: UserContext = Depends(_kb_edit)):
    """A passage the AI missed. Recorded as a manual addition for the next extraction."""
    _require_kb_access(u, kb_id, "edit")
    with _lifecycle_txn() as conn:
        _proposal(conn, kb_id, body.entity_id, u, "Knowledge passage added")
        try:
            clean = knowledge.clean_chunk_fields(body.model_dump(), _accepted_codes(conn, kb_id, body.entity_id))
        except ValueError as exc:
            raise LifecycleError(400, str(exc))
        line = knowledge.business_line_of(conn, kb_id, body.entity_id)
        position = conn.execute(text("""
            SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kirana_kart.policy_knowledge_chunks
            WHERE kb_id = :kb AND entity_id = :eid
        """), {"kb": kb_id, "eid": body.entity_id}).scalar() or 0
        key = knowledge.chunk_key(body.entity_id, position, clean["title"])
        row = conn.execute(text("""
            INSERT INTO kirana_kart.policy_knowledge_chunks
                (kb_id, entity_id, chunk_key, business_line, title, body, issue_codes, purpose,
                 source_excerpt, origin, status, edit_reason, edited_by, edited_at, sort_order)
            VALUES (:kb, :eid, :key, :bl, :title, :body, :codes, :purpose,
                    :src, 'human', 'accepted', :reason, :uid, NOW(), :sort)
            RETURNING id, chunk_key
        """), {"kb": kb_id, "eid": body.entity_id, "key": key, "bl": line, **clean,
               "codes": clean["issue_codes"], "src": body.source_excerpt, "reason": body.edit_reason,
               "uid": u.id, "sort": position}).mappings().first()
        knowledge.log_edit(conn, kb_id=kb_id, entity_id=body.entity_id, stage="chunk",
                           item_ref=key, edit_type="manual_add", business_line=line,
                           user_output=clean, reason=body.edit_reason, actor_id=u.id)
    return dict(row)


class ChunkReview(BaseModel):
    status: Literal["accepted", "edited", "rejected"]
    edit_reason: Optional[str] = Field(default=None, max_length=2000)
    title: Optional[str] = Field(default=None, max_length=knowledge.MAX_TITLE)
    body: Optional[str] = Field(default=None, max_length=knowledge.MAX_BODY)
    issue_codes: Optional[list[str]] = None
    purpose: Optional[Literal["decision", "response", "both"]] = None


@router.put("/kb/{kb_id}/knowledge/{chunk_id}")
def review_knowledge(kb_id: str, chunk_id: int, body: ChunkReview, u: UserContext = Depends(_kb_edit)):
    """
    Accept, edit or remove a passage. The AI's original stays in llm_output
    and every correction is logged against it, with the reviewer's reason.
    """
    _require_kb_access(u, kb_id, "edit")
    _require_reason(body.status, body.edit_reason)
    with _lifecycle_txn() as conn:
        row = conn.execute(text("""
            SELECT * FROM kirana_kart.policy_knowledge_chunks WHERE id = :id AND kb_id = :kb FOR UPDATE
        """), {"id": chunk_id, "kb": kb_id}).mappings().first()
        if not row:
            raise LifecycleError(404, "Passage not found")
        _proposal(conn, kb_id, row["entity_id"], u, f"Knowledge passage {row['chunk_key']} reviewed")
        edits = {}
        if body.status == "edited":
            submitted = {k: v for k, v in body.model_dump().items()
                         if k in knowledge.CHUNK_EDIT_FIELDS and v is not None}
            try:
                edits = knowledge.clean_chunk_fields(submitted, _accepted_codes(conn, kb_id, row["entity_id"]))
            except ValueError as exc:
                raise LifecycleError(400, str(exc))
            if not edits:
                raise LifecycleError(400, "Nothing was changed")
        current = {k: row[k] for k in knowledge.CHUNK_EDIT_FIELDS}
        after = {**current, **edits}
        conn.execute(text("""
            UPDATE kirana_kart.policy_knowledge_chunks
            SET status = :status, title = :title, body = :body, issue_codes = :codes,
                purpose = :purpose, edit_reason = :reason, edited_by = :uid, edited_at = NOW()
            WHERE id = :id
        """), {"status": body.status, "title": after["title"], "body": after["body"],
               "codes": after["issue_codes"], "purpose": after["purpose"],
               "reason": (body.edit_reason or "").strip() or None, "uid": u.id, "id": chunk_id})
        ai = row["llm_output"] or current
        if isinstance(ai, str):
            ai = json.loads(ai)
        knowledge.log_edit(
            conn, kb_id=kb_id, entity_id=row["entity_id"], stage="chunk", item_ref=row["chunk_key"],
            edit_type=body.status, business_line=row["business_line"], llm_output=ai,
            user_output=edits or None, reason=(body.edit_reason or "").strip() or None, actor_id=u.id,
            changes=knowledge.field_changes(ai, edits, knowledge.CHUNK_EDIT_FIELDS) if edits else None,
        )
    return {"id": chunk_id, "status": body.status}


@router.get("/kb/{kb_id}/knowledge/{chunk_id}/preview")
def preview_knowledge(kb_id: str, chunk_id: int, u: UserContext = Depends(_kb_view)):
    """The passage as Stage 1/Stage 3 would see it, with sample ticket values."""
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT entity_id, title, body, business_line FROM kirana_kart.policy_knowledge_chunks
            WHERE id = :id AND kb_id = :kb
        """), {"id": chunk_id, "kb": kb_id}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Passage not found")
        values = knowledge.static_variables(conn, kb_id, row["business_line"])
    sample = pk.ticket_values(
        {"order_context": {"order_value": 849, "order_id": "ORD-1042"},
         "risk_context": {"refunds_last_30_days": 1, "complaints_last_30_days": 2},
         "customer_profile": {"membership_tier": "GOLD"}},
        {"issue_label": "Item missing from order"},
        {"final_refund_amount": 249}, "We have approved a partial refund of ₹249.00.",
    )
    return {"title": row["title"], "text": pk.render(row["body"], {**values, **sample}),
            "sample_values": sample}


class AcceptAll(BaseModel):
    kind: Literal["taxonomy", "actions", "knowledge"]
    min_confidence: Optional[float] = Field(default=None, ge=0, le=1)


_BULK = {
    "taxonomy": ("draft_taxonomy_proposals", "taxonomy", "issue_code"),
    "actions": ("draft_action_proposals", "action", "action_code_id"),
    "knowledge": ("policy_knowledge_chunks", "chunk", "chunk_key"),
}


@router.post("/kb/{kb_id}/proposals/{entity_id}/accept-all")
def accept_all(kb_id: str, entity_id: str, body: AcceptAll, u: UserContext = Depends(_kb_edit)):
    """
    Accept every pending item of one kind (optionally only those the AI was
    at least `min_confidence` sure of). Nothing the AI proposed is accepted
    until a person does this or reviews the item.
    """
    table, stage, ref = _BULK[body.kind]
    _require_kb_access(u, kb_id, "edit")
    confidence = ("AND COALESCE(extraction_confidence, 0) >= :conf"
                  if body.min_confidence is not None and body.kind != "knowledge" else "")
    with _lifecycle_txn() as conn:
        _proposal(conn, kb_id, entity_id, u, f"Pending {body.kind} accepted")
        line = knowledge.business_line_of(conn, kb_id, entity_id)
        refs = conn.execute(text(f"""
            UPDATE kirana_kart.{table}
            SET status = 'accepted', edited_by = :uid, edited_at = NOW()
            WHERE kb_id = :kb AND entity_id = :eid AND status = 'pending' {confidence}
            RETURNING {ref}
        """), {"uid": u.id, "kb": kb_id, "eid": entity_id, "conf": body.min_confidence}).scalars().all()
        for item in refs:
            knowledge.log_edit(conn, kb_id=kb_id, entity_id=entity_id, stage=stage, item_ref=item,
                               edit_type="accepted", business_line=line, actor_id=u.id)
    return {"accepted": len(refs)}


# ============================================================
# VARIABLES
# ============================================================

@router.get("/kb/{kb_id}/variables")
def list_variables(kb_id: str, u: UserContext = Depends(_kb_view)):
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        rows = knowledge.list_variables(conn, kb_id)
    return jsonable_encoder({
        "variables": rows,
        "suggested": [{"name": n, "description": d} for n, d in pk.SUGGESTED_STATIC_VARIABLES.items()],
        "ticket_variables": [{"name": n, "description": d} for n, d in pk.DYNAMIC_VARIABLES.items()],
    })


class VariableSet(BaseModel):
    name: str = Field(..., max_length=50)
    value: str = Field(..., min_length=1, max_length=2000)
    business_line: Optional[str] = Field(default=None, max_length=60)
    description: Optional[str] = Field(default=None, max_length=500)
    reason: Optional[str] = Field(default=None, max_length=2000)


@router.put("/kb/{kb_id}/variables")
def set_variable(kb_id: str, body: VariableSet, u: UserContext = Depends(_kb_edit)):
    """
    Tenant values reach live replies as soon as they are saved (passages are
    approved; values are settings), so every change is logged with who made it.
    """
    _require_kb_access(u, kb_id, "edit")
    try:
        line = knowledge.normalise_business_line(body.business_line)
        with engine.begin() as conn:
            row = knowledge.set_variable(conn, kb_id, line, body.name, body.value.strip(),
                                         body.description, u.id, body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _clear_runtime_cache()
    return jsonable_encoder(row)


@router.delete("/kb/{kb_id}/variables/{variable_id}")
def delete_variable(kb_id: str, variable_id: int, u: UserContext = Depends(_kb_edit)):
    _require_kb_access(u, kb_id, "edit")
    with engine.begin() as conn:
        if not knowledge.delete_variable(conn, kb_id, variable_id, u.id):
            raise HTTPException(status_code=404, detail="Variable not found")
    _clear_runtime_cache()
    return {"deleted": variable_id}


def _clear_runtime_cache() -> None:
    # Only this process's cache; workers refresh within CACHE_SECONDS.
    pk.clear_cache()


# ============================================================
# USE CASE AND LEARNING
# ============================================================

@router.get("/kb/{kb_id}/business-lines")
def business_lines(kb_id: str, u: UserContext = Depends(_kb_view)):
    _require_kb_access(u, kb_id, "view")
    with engine.connect() as conn:
        return {"business_lines": knowledge.known_business_lines(conn, kb_id)}


class BusinessLineSet(BaseModel):
    business_line: Optional[str] = Field(default=None, max_length=60)


@router.put("/kb/{kb_id}/proposals/{entity_id}/business-line")
def set_business_line(kb_id: str, entity_id: str, body: BusinessLineSet, u: UserContext = Depends(_kb_edit)):
    """Change the use case; the proposal's rules and passages follow it."""
    _require_kb_access(u, kb_id, "edit")
    try:
        line = knowledge.normalise_business_line(body.business_line)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    with _lifecycle_txn() as conn:
        instance = _proposal(conn, kb_id, entity_id, u, f"Business line set to {line or 'all'}")
        conn.execute(text("""
            UPDATE kirana_kart.bpm_process_instances
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{business_line}', CAST(:bl AS jsonb))
            WHERE id = :id
        """), {"bl": json.dumps(line), "id": instance["id"]})
        for table, column in (("rule_registry", "policy_version"), ("policy_knowledge_chunks", "entity_id")):
            conn.execute(text(f"""
                UPDATE kirana_kart.{table} SET business_line = :bl
                WHERE kb_id = :kb AND {column} = :eid
            """), {"bl": line, "kb": kb_id, "eid": entity_id})
    return {"entity_id": entity_id, "business_line": line}


@router.get("/kb/{kb_id}/lessons")
def lessons(kb_id: str, business_line: Optional[str] = Query(default=None, max_length=60),
            u: UserContext = Depends(_kb_view)):
    """The corrections the next extraction is given, in the order it is given them."""
    _require_kb_access(u, kb_id, "view")
    try:
        line = knowledge.normalise_business_line(business_line)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    with engine.connect() as conn:
        return jsonable_encoder({"business_line": line, "lessons": knowledge.lesson_list(conn, kb_id, line)})

