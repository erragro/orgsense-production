"""
Policy Studio end to end, over HTTP, against a migrated PostgreSQL database.

Only the LLM call is stubbed. Everything else — upload, review, rule
generation, sample replay, approval, registry commit and runtime activation —
runs the production handlers and SQL. Before these changes a proposal could
not get past its first step on a migrated database (missing process
definitions and bpm_process_instances.updated_at), and no path led to ACTIVE.
"""
import os
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

pytestmark = pytest.mark.integration

KB = "lifecycle_it"
PREFIX = "ITLC_"


# The live taxonomy the SOPs are mapped onto. Policy Studio never adds to it.
LIVE_TAXONOMY = [
    ("ITLC_MISSING_ITEM", "Missing item", None),
    ("ITLC_MISSING_ITEM_PARTIAL", "Part of order missing", "ITLC_MISSING_ITEM"),
    ("ITLC_WRONG_ITEM", "Wrong item delivered", None),
]
SOP = b"# Missing items\nRefund them within a day.\nAsk for a photo if the order was large."


def _taxonomy_v1():
    return {
        "mappings": [
            {"issue_code": "ITLC_MISSING_ITEM", "extraction_confidence": 0.9,
             "source_quote": "Refund them within a day."},
            {"issue_code": "itlc missing item partial", "extraction_confidence": 0.6},
        ],
        # Problems the taxonomy has no code for: gaps, never new codes.
        "gaps": [{"label": "Damaged packaging", "suggested_code": "ITLC_DAMAGED_PACK",
                  "source_quote": "not in the document", "extraction_confidence": 0.7}],
        # An answer in the old open shape: an unknown "new" code is a gap too.
        "taxonomy": [{"issue_code": "ITLC_INVENTED", "label": "Invented problem", "proposal_type": "new"}],
    }


def _actions_v1():
    return {"actions": [
        {"action_code_id": "ITLC_REFUND_MISSING", "action_name": "Refund missing item",
         "exact_action": "Refund the item value", "proposal_type": "new",
         "parent_issue_codes": ["ITLC_MISSING_ITEM", "ITLC_MISSING_ITEM_PARTIAL"],
         "requires_refund": True, "extraction_confidence": 0.9},
        {"action_code_id": "ITLC_ESCALATE", "action_name": "Escalate to supervisor",
         "proposal_type": "new",
         "parent_issue_codes": ["ITLC_MISSING_ITEM_PARTIAL", "ITLC_NOT_ACCEPTED"]},
    ]}


def _knowledge_v1():
    return {
        "passages": [
            {"title": "Refund window", "purpose": "decision", "issue_codes": ["ITLC_MISSING_ITEM"],
             "body": "Refund {{customer_tier}} customers within a day. Support is open {{support_hours}}.",
             "source_quote": "Refund them within a day."},
            {"title": "Apology", "purpose": "response", "issue_codes": [],
             "body": "We are sorry about your {{issue_label}}. {{resolution_summary}}",
             "source_quote": "Quoted from nowhere in the SOP"},
            {"title": "", "body": "no title"},                                   # unstorable
            {"title": "Other problem", "body": "x", "issue_codes": ["ITLC_NOT_ACCEPTED"]},  # code dropped
        ],
        "variables": [{"name": "support_hours", "value": "9am to 9pm"}, {"name": "Bad Name!", "value": "x"}],
    }


def _taxonomy_v2():
    return {"mappings": [{"issue_code": "ITLC_MISSING_ITEM", "extraction_confidence": 0.95}]}


def _actions_v2():
    return {"actions": [
        {"action_code_id": "ITLC_REPLACE", "action_name": "Send a replacement",
         "proposal_type": "new", "parent_issue_codes": ["ITLC_MISSING_ITEM"]},
    ]}


def _knowledge_v2():
    return {"passages": []}


@pytest.fixture
def studio(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database")
    if not make_url(url).database.endswith("_test"):
        pytest.fail("Integration database name must end in _test")
    db = create_engine(url, hide_parameters=True)

    from app.admin.routes import bpm_routes, policy_knowledge_routes, rule_routes
    from app.admin.services.auth_service import UserContext, get_current_user
    from app.admin.services.bpm_service import BPMService
    from app.l45_ml_platform.compiler import sop_extractor

    with db.begin() as conn:
        if conn.execute(text("SELECT COUNT(*) FROM kirana_kart.kb_runtime_config")).scalar():
            pytest.skip("Requires a database with no live policy configured")
        ids = [conn.execute(text("""
            INSERT INTO kirana_kart.users (email, full_name) VALUES (:e, :n) RETURNING id
        """), {"e": f"{name}-{uuid.uuid4().hex[:6]}@example.test", "n": name}).scalar()
            for name in ("author", "approver", "outsider")]
        conn.execute(text("INSERT INTO kirana_kart.knowledge_bases (kb_id, kb_name) VALUES (:kb, 'Lifecycle IT')"),
                     {"kb": KB})
        conn.execute(text("""
            INSERT INTO kirana_kart.kb_user_access (kb_id, user_id, role)
            VALUES (:kb, :a, 'edit'), (:kb, :b, 'admin')
        """), {"kb": KB, "a": ids[0], "b": ids[1]})
        for code, label, parent in LIVE_TAXONOMY:
            conn.execute(text("""
                INSERT INTO kirana_kart.issue_taxonomy (kb_id, issue_code, label, parent_id, level)
                VALUES (:kb, :code, :label,
                        (SELECT id FROM kirana_kart.issue_taxonomy WHERE issue_code = CAST(:parent AS varchar)),
                        CASE WHEN CAST(:parent AS varchar) IS NULL THEN 1 ELSE 2 END)
            """), {"kb": KB, "code": code, "label": label, "parent": parent})

    all_perms = {m: {"view": True, "edit": True, "admin": True} for m in ("knowledgeBase", "policy")}
    users = {
        "author": UserContext(ids[0], "author@example.test", "Author", None, False, all_perms),
        "approver": UserContext(ids[1], "approver@example.test", "Approver", None, False, all_perms),
        "outsider": UserContext(ids[2], "outsider@example.test", "Outsider", None, False, all_perms),
    }
    current = {"user": users["author"]}
    llm = {"taxonomy": _taxonomy_v1, "actions": _actions_v1, "knowledge": _knowledge_v1, "prompts": []}

    def fake_llm(system, user):
        llm["prompts"].append(user)
        kind = "knowledge" if '"passages"' in user else "actions" if '"actions"' in user else "taxonomy"
        return llm[kind]()

    monkeypatch.setattr(bpm_routes, "engine", db)
    monkeypatch.setattr(rule_routes, "engine", db)
    monkeypatch.setattr(bpm_routes, "_bpm_service", BPMService(db))
    monkeypatch.setattr(rule_routes, "_bpm_service", BPMService(db))
    monkeypatch.setattr(policy_knowledge_routes, "engine", db)
    monkeypatch.setattr(sop_extractor, "_call_llm", fake_llm)

    app = FastAPI()
    app.include_router(bpm_routes.router)
    app.include_router(policy_knowledge_routes.router)
    app.include_router(rule_routes.router)
    app.dependency_overrides[get_current_user] = lambda: current["user"]

    def as_user(name):
        current["user"] = users[name]

    yield {"client": TestClient(app), "db": db, "as": as_user, "llm": llm, "users": users}

    with db.begin() as conn:
        versions = [r[0] for r in conn.execute(text(
            "SELECT entity_id FROM kirana_kart.bpm_process_instances WHERE kb_id = :kb"), {"kb": KB})]
        conn.execute(text("DELETE FROM kirana_kart.kb_runtime_config"))
        conn.execute(text("UPDATE kirana_kart.policy_versions SET is_active = FALSE WHERE kb_id = :kb"), {"kb": KB})
        for table, column in (("policy_versions", "kb_id"), ("rule_registry", "kb_id"),
                              ("knowledge_base_raw_uploads", "kb_id"), ("kb_vector_jobs", "kb_id"),
                              ("rule_edit_log", "kb_id"), ("policy_knowledge_chunks", "kb_id"),
                              ("policy_taxonomy_gaps", "kb_id"), ("policy_variables", "kb_id"),
                              ("draft_taxonomy_proposals", "kb_id"), ("draft_action_proposals", "kb_id")):
            conn.execute(text(f"DELETE FROM kirana_kart.{table} WHERE {column} = :kb"), {"kb": KB})
        conn.execute(text("DELETE FROM kirana_kart.knowledge_base_versions WHERE version_label = ANY(:v)"),
                     {"v": versions})
        conn.execute(text("DELETE FROM kirana_kart.simulation_tickets WHERE ticket_id LIKE 'itlc-%'"))
        # issue_taxonomy forbids hard deletes (prevent_delete trigger). Test
        # cleanup only: skip triggers for this transaction.
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        for level in (4, 3, 2, 1):
            conn.execute(text("DELETE FROM kirana_kart.issue_taxonomy WHERE issue_code LIKE :p AND level = :l"),
                         {"p": PREFIX + "%", "l": level})
        conn.execute(text("DELETE FROM kirana_kart.master_action_codes WHERE action_code_id LIKE :p"),
                     {"p": PREFIX + "%"})
        conn.execute(text("DELETE FROM kirana_kart.knowledge_bases WHERE kb_id = :kb"), {"kb": KB})
        conn.execute(text("DELETE FROM kirana_kart.users WHERE id = ANY(:ids)"), {"ids": ids})
    db.dispose()


def _stage(studio, entity_id):
    with studio["db"].connect() as conn:
        return conn.execute(text("""
            SELECT current_stage FROM kirana_kart.bpm_process_instances WHERE entity_id = :e
        """), {"e": entity_id}).scalar()


def _upload(client, name):
    response = client.post(f"/bpm/kb/{KB}/upload",
                           files={"file": ("policy.md", SOP, "text/markdown")},
                           data={"change_name": name, "business_outcome": "Consistent refunds",
                                 "business_line": "Ecommerce"})
    assert response.status_code == 200, response.text
    return response.json()


def _accept_all(client, kind, entity_id):
    response = client.post(f"/bpm/kb/{KB}/proposals/{entity_id}/accept-all", json={"kind": kind})
    assert response.status_code == 200, response.text
    return response.json()["accepted"]


def _edits(studio, entity_id, stage):
    with studio["db"].connect() as conn:
        return [dict(r) for r in conn.execute(text("""
            SELECT item_ref, edit_type, field_changes, edit_reason, business_line, created_by
            FROM kirana_kart.rule_edit_log WHERE entity_id = :e AND stage = :s ORDER BY id
        """), {"e": entity_id, "s": stage}).mappings()]


def _prepared(studio, entity_id):
    """Stand in for the background vector worker (VectorService.run_pending_jobs)."""
    with studio["db"].begin() as conn:
        conn.execute(text("UPDATE kirana_kart.policy_versions SET vector_status = 'completed' WHERE policy_version = :e"),
                     {"e": entity_id})


def _approval_id(client, instance_id):
    approvals = client.get(f"/bpm/{KB}/instances/{instance_id}/approvals").json()
    assert len(approvals) == 1
    return approvals[0]["id"]


def test_proposal_reaches_live_only_through_review_test_and_separate_approval(studio, monkeypatch):
    client, db = studio["client"], studio["db"]

    # ---- v1: first policy, nothing live yet -------------------------------
    upload = _upload(client, "Missing item refunds")
    v1, instance_id = upload["entity_id"], upload["bpm_instance_id"]
    assert _stage(studio, v1) == "DRAFT"

    analysis = client.post(f"/bpm/kb/{KB}/extract-taxonomy", json={"entity_id": v1}).json()
    assert analysis["count"] == 2 and analysis["truncated"] is False
    assert sorted(g["label"] for g in analysis["gaps"]) == ["Damaged packaging", "Invented problem"]
    taxonomy = {p["issue_code"]: p for p in client.get(
        f"/bpm/kb/{KB}/taxonomy-proposals", params={"entity_id": v1}).json()}
    # Only live codes, all waiting for a person, names taken from the taxonomy.
    assert set(taxonomy) == {"ITLC_MISSING_ITEM", "ITLC_MISSING_ITEM_PARTIAL"}
    assert {p["status"] for p in taxonomy.values()} == {"pending"}
    assert {p["proposal_type"] for p in taxonomy.values()} == {"existing"}
    assert taxonomy["ITLC_MISSING_ITEM_PARTIAL"]["label"] == "Part of order missing"
    assert taxonomy["ITLC_MISSING_ITEM"]["source_excerpt"] == "Refund them within a day."
    assert {e["edit_type"] for e in _edits(studio, v1, "taxonomy")} == {"proposed"}
    assert _stage(studio, v1) == "AI_COMPILE_QUEUED"

    assert client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()["status"] == "unavailable"
    # Bulk acceptance can be limited to what the AI was sure of.
    confident = client.post(f"/bpm/kb/{KB}/proposals/{v1}/accept-all",
                            json={"kind": "taxonomy", "min_confidence": 0.75}).json()
    assert confident["accepted"] == 1
    partial_id = taxonomy["ITLC_MISSING_ITEM_PARTIAL"]["id"]
    # A mapping can only point at another live problem, with a reason.
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{partial_id}",
                      json={"status": "edited", "user_output": {"label": "Renamed"},
                            "edit_reason": "rename"}).status_code == 400
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{partial_id}",
                      json={"status": "edited", "user_output": {"issue_code": "ITLC_WRONG_ITEM"}}).status_code == 400
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{partial_id}",
                      json={"status": "edited", "user_output": {"issue_code": "HIJACK"},
                            "edit_reason": "not live"}).status_code == 400
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{partial_id}",
                      json={"status": "accepted"}).status_code == 200

    gaps = {g["label"]: g for g in client.get(f"/bpm/kb/{KB}/taxonomy-gaps", params={"entity_id": v1}).json()}
    assert gaps["Damaged packaging"]["business_line"] == "ecommerce"
    invented, damaged = gaps["Invented problem"]["id"], gaps["Damaged packaging"]["id"]
    # A gap can only be mapped onto a code a taxonomy admin has made live.
    assert client.post(f"/bpm/kb/{KB}/taxonomy-gaps/{damaged}",
                       json={"action": "map", "issue_code": "ITLC_DAMAGED_PACK",
                             "note": "admin will add it"}).status_code == 400
    assert client.post(f"/bpm/kb/{KB}/taxonomy-gaps/{damaged}", json={"action": "dismiss"}).status_code == 400
    assert client.post(f"/bpm/kb/{KB}/taxonomy-gaps/{damaged}",
                       json={"action": "dismiss", "note": "Packaging is handled by the courier SOP"}
                       ).json()["status"] == "dismissed"
    mapped = client.post(f"/bpm/kb/{KB}/taxonomy-gaps/{invented}",
                         json={"action": "map", "issue_code": "itlc_wrong_item",
                               "note": "The SOP calls wrong items 'invented problems'"})
    assert mapped.json() == {"id": invented, "status": "mapped", "mapped_issue_code": "ITLC_WRONG_ITEM"}
    taxonomy = {p["issue_code"]: p for p in client.get(
        f"/bpm/kb/{KB}/taxonomy-proposals", params={"entity_id": v1}).json()}
    assert taxonomy["ITLC_WRONG_ITEM"]["status"] == "edited"
    # The taxonomy admins' queue: only what is still open.
    assert client.get(f"/bpm/kb/{KB}/taxonomy-gaps", params={"status": "open"}).json() == []

    actions = client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": v1})
    assert actions.status_code == 200 and actions.json()["count"] == 2, actions.text
    assert _accept_all(client, "actions", v1) == 2

    generated = client.post(f"/bpm/kb/{KB}/generate-rules", json={"entity_id": v1}).json()
    assert generated["count"] == 3, generated
    # ITLC_NOT_ACCEPTED was never offered to the action as a parent.
    assert generated["skipped"] == []
    assert generated["stage"] == "RULE_EDIT"
    rules = client.get(f"/rules/{KB}", params={"version": v1}).json()
    partial = [r for r in rules if r["issue_type_l2"] == "ITLC_MISSING_ITEM_PARTIAL"]
    assert {r["issue_type_l1"] for r in partial} == {"ITLC_MISSING_ITEM"}
    assert {r["priority"] for r in partial} == {400}
    assert {r["business_line"] for r in rules} == {"ecommerce"}
    assert len({r["rule_id"] for r in rules}) == 3

    # ---- knowledge passages ----------------------------------------------
    extracted = client.post(f"/bpm/kb/{KB}/extract-knowledge", json={"entity_id": v1}).json()
    assert extracted["count"] == 3
    assert extracted["suggested_variables"] == [{"name": "support_hours", "value": "9am to 9pm", "defined": False}]
    listing = client.get(f"/bpm/kb/{KB}/knowledge", params={"entity_id": v1}).json()
    chunks = {c["title"]: c for c in listing["chunks"]}
    assert {c["status"] for c in chunks.values()} == {"pending"}
    window = chunks["Refund window"]
    assert SOP.decode()[window["source_start"]:window["source_end"]] == "Refund them within a day."
    assert chunks["Apology"]["source_start"] is None           # quote not found: shown as unverified
    assert chunks["Other problem"]["issue_codes"] == []         # unknown problem dropped
    assert listing["undefined_variables"] == ["support_hours"]
    assert client.put(f"/bpm/kb/{KB}/knowledge/{chunks['Apology']['id']}",
                      json={"status": "edited", "body": "Sorry!"}).status_code == 400
    edited = client.put(f"/bpm/kb/{KB}/knowledge/{chunks['Apology']['id']}", json={
        "status": "edited", "edit_reason": "Replies must name the business",
        "body": "We are sorry about your {{issue_label}}. {{resolution_summary}} — {{business_name}}"})
    assert edited.status_code == 200, edited.text
    assert client.put(f"/bpm/kb/{KB}/knowledge/{chunks['Other problem']['id']}",
                      json={"status": "rejected", "edit_reason": "Not policy"}).status_code == 200
    assert client.post(f"/bpm/kb/{KB}/knowledge", json={
        "entity_id": v1, "title": "x", "body": "y", "issue_codes": ["ITLC_NOPE"]}).status_code == 400
    added = client.post(f"/bpm/kb/{KB}/knowledge", json={
        "entity_id": v1, "title": "Photo evidence", "purpose": "decision",
        "issue_codes": ["ITLC_MISSING_ITEM_PARTIAL"], "edit_reason": "The AI missed it",
        "body": "Ask for a photo when the order is over {{refund_cap_default}}."})
    assert added.status_code == 201, added.text
    chunk_log = {(e["item_ref"], e["edit_type"]): e for e in _edits(studio, v1, "chunk")}
    apology = chunk_log[(chunks["Apology"]["chunk_key"], "edited")]
    assert apology["field_changes"]["body"]["ai"].startswith("We are sorry about your {{issue_label}}.")
    assert apology["edit_reason"] == "Replies must name the business"
    assert apology["business_line"] == "ecommerce" and apology["created_by"] is not None
    assert (added.json()["chunk_key"], "manual_add") in chunk_log

    assert client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1}).status_code == 409

    gate = client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()
    assert gate["status"] == "not_applicable" and gate["stage"] == "SHADOW_GATE"

    # Editing tested rules discards the evidence, and the change is kept
    # against what the generator wrote.
    assert client.put(f"/rules/{KB}/{rules[0]['id']}",
                      json={"priority": 450, "edit_reason": "Specific cases first"}).status_code == 200
    rule_edit = [e for e in _edits(studio, v1, "rule") if e["edit_type"] == "edited"]
    assert rule_edit[0]["field_changes"] == {"priority": {"ai": rules[0]["priority"], "human": 450}}
    assert rule_edit[0]["edit_reason"] == "Specific cases first"
    assert _stage(studio, v1) == "RULE_EDIT"
    assert client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()["stage"] == "SHADOW_GATE"

    # Pending passages, then undefined variables, block the request.
    blocked = client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1})
    assert blocked.status_code == 409 and "pending" in blocked.json()["detail"]
    assert _accept_all(client, "knowledge", v1) == 1
    assert client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()["stage"] == "SHADOW_GATE"
    blocked = client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1})
    assert blocked.status_code == 409
    assert "{{support_hours}}" in blocked.json()["detail"] and "{{business_name}}" in blocked.json()["detail"]
    assert client.put(f"/bpm/kb/{KB}/variables", json={"name": "customer_tier", "value": "x"}).status_code == 400
    for name, value, line in (("support_hours", "9am to 9pm", None), ("business_name", "Kirana", None),
                              ("business_name", "Kirana Express", "ecommerce"),
                              ("refund_cap_default", "₹500", None)):
        saved = client.put(f"/bpm/kb/{KB}/variables",
                           json={"name": name, "value": value, "business_line": line})
        assert saved.status_code == 200, saved.text
    preview = client.get(f"/bpm/kb/{KB}/knowledge/{chunks['Apology']['id']}/preview").json()
    assert preview["text"].endswith("— Kirana Express")       # the business line's value wins

    submitted = client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1})
    assert submitted.status_code == 200, submitted.text
    readiness = client.get(f"/bpm/kb/{KB}/proposals/{v1}/readiness").json()
    assert readiness["business_line"] == "ecommerce" and readiness["undefined_variables"] == []
    assert _stage(studio, v1) == "PENDING_APPROVAL"

    # Frozen while under approval.
    assert client.put(f"/rules/{KB}/{rules[0]['id']}", json={"priority": 1}).status_code == 409
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{taxonomy['ITLC_MISSING_ITEM']['id']}",
                      json={"status": "rejected", "edit_reason": "too late"}).status_code == 409
    assert client.put(f"/bpm/kb/{KB}/knowledge/{chunks['Apology']['id']}",
                      json={"status": "rejected", "edit_reason": "too late"}).status_code == 409
    assert client.post(f"/bpm/{KB}/instances/{instance_id}/transition",
                       json={"to_stage": "ACTIVE"}).status_code == 409

    approval_id = _approval_id(client, instance_id)
    # The submitter cannot approve their own change.
    assert client.post(f"/bpm/approvals/{approval_id}/approve", json={}).status_code == 403
    # Someone outside the KB cannot decide it.
    studio["as"]("outsider")
    assert client.post(f"/bpm/approvals/{approval_id}/approve", json={}).status_code == 403
    assert client.get(f"/bpm/{KB}/instances/{instance_id}").status_code == 403
    studio["as"]("approver")
    # Nothing to serve until runtime preparation completes.
    not_ready = client.post(f"/bpm/approvals/{approval_id}/approve", json={})
    assert not_ready.status_code == 409 and "pending" in not_ready.json()["detail"]
    _prepared(studio, v1)

    # Activation is all-or-nothing.
    from app.l1_ingestion.kb_registry.kb_registry_service import KBRegistryService

    def broken(conn, version_label):
        raise RuntimeError("runtime unavailable")

    with monkeypatch.context() as patched:
        patched.setattr(KBRegistryService, "_activate_version", staticmethod(broken))
        assert client.post(f"/bpm/approvals/{approval_id}/approve", json={}).status_code == 409
    with db.connect() as conn:
        assert not conn.execute(text("SELECT 1 FROM kirana_kart.kb_runtime_config")).first()
    assert _stage(studio, v1) == "PENDING_APPROVAL"

    live = client.post(f"/bpm/approvals/{approval_id}/approve", json={"notes": "Matches SOP"})
    assert live.status_code == 200, live.text
    assert live.json()["active_version"] == v1
    assert _stage(studio, v1) == "ACTIVE"
    with db.connect() as conn:
        assert conn.execute(text("SELECT active_version FROM kirana_kart.kb_runtime_config")).scalar() == v1
        assert conn.execute(text("SELECT is_active FROM kirana_kart.policy_versions WHERE policy_version = :v"),
                            {"v": v1}).scalar() is True
        # Publishing never changes the taxonomy: no gap became a code.
        categories = dict(conn.execute(text("""
            SELECT issue_code, label FROM kirana_kart.issue_taxonomy WHERE issue_code LIKE 'ITLC_%'""")).all())
        assert categories == {code: label for code, label, _ in LIVE_TAXONOMY}
        assert conn.execute(text("SELECT action_key FROM kirana_kart.master_action_codes "
                                 "WHERE action_code_id = 'ITLC_REFUND_MISSING'")).scalar() == "ITLC_REFUND_MISSING"

    _runtime_uses_the_live_policy(studio, v1)

    # ---- v2: replaces v1, larger change needs a justification --------------
    studio["as"]("author")
    with db.begin() as conn:
        for n in range(10):
            # Replayed against rules written for the proposal's business line.
            conn.execute(text("""INSERT INTO kirana_kart.simulation_tickets
                                     (ticket_id, issue_type, order_value, business_line)
                                 VALUES (:id, 'ITLC_MISSING_ITEM', 100, 'ecommerce')"""), {"id": f"itlc-{n}"})
    studio["llm"].update(taxonomy=_taxonomy_v2, actions=_actions_v2, knowledge=_knowledge_v2)
    upload2 = _upload(client, "Replacements instead of refunds")
    v2 = upload2["entity_id"]
    studio["llm"]["prompts"].clear()
    client.post(f"/bpm/kb/{KB}/extract-taxonomy", json={"entity_id": v2})
    client.post(f"/bpm/kb/{KB}/extract-knowledge", json={"entity_id": v2})
    # What reviewers corrected on v1 is in the very next extraction's prompt,
    # before anything was published from it.
    taxonomy_prompt, knowledge_prompt = studio["llm"]["prompts"]
    assert "Packaging is handled by the courier SOP" in taxonomy_prompt
    assert "The SOP calls wrong items 'invented problems'" in taxonomy_prompt
    assert "For ecommerce:" in taxonomy_prompt
    assert "Replies must name the business" in knowledge_prompt
    assert "Kirana Express" in knowledge_prompt           # the variables already set
    lessons = client.get(f"/bpm/kb/{KB}/lessons", params={"business_line": "ecommerce"}).json()["lessons"]
    assert {entry["stage"] for entry in lessons} >= {"gap", "chunk", "rule"}

    _accept_all(client, "taxonomy", v2)
    client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": v2})
    _accept_all(client, "actions", v2)
    client.post(f"/bpm/kb/{KB}/generate-rules", json={"entity_id": v2})

    replay = client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v2}).json()
    assert replay["status"] == "ok" and replay["passed"] is False
    assert replay["metrics"]["ticket_count"] == 10 and replay["metrics"]["baseline_version"] == v1
    assert replay["stage"] == "SIMULATION_FAILED"
    assert client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v2}).status_code == 400
    justified = client.post(f"/bpm/kb/{KB}/submit", json={
        "entity_id": v2, "justification": "Replacements are the new customer promise for missing items."})
    assert justified.status_code == 200, justified.text

    _prepared(studio, v2)
    studio["as"]("approver")
    published = client.post(f"/bpm/kb/{KB}/publish", json={"entity_id": v2})
    assert published.status_code == 200, published.text
    assert published.json()["previous_version"] == v1
    assert _stage(studio, v2) == "ACTIVE" and _stage(studio, v1) == "RETIRED"
    with db.connect() as conn:
        assert conn.execute(text("SELECT active_version FROM kirana_kart.kb_runtime_config")).scalar() == v2
        assert conn.execute(text("SELECT COUNT(*) FROM kirana_kart.policy_versions WHERE is_active")).scalar() == 1

    # A live version's rules cannot be edited behind the lifecycle's back.
    live_rule = client.get(f"/rules/{KB}", params={"version": v2}).json()[0]
    assert client.delete(f"/rules/{KB}/{live_rule['id']}").status_code == 409
    # Instances are only reachable through their own KB.
    studio["as"]("approver")
    assert client.get(f"/bpm/default/instances/{upload2['bpm_instance_id']}").status_code in (403, 404)


def test_rejection_reopens_the_proposal_for_editing(studio):
    client = studio["client"]
    upload = _upload(client, "Reject me")
    entity_id, instance_id = upload["entity_id"], upload["bpm_instance_id"]
    client.post(f"/bpm/kb/{KB}/extract-taxonomy", json={"entity_id": entity_id})
    _accept_all(client, "taxonomy", entity_id)
    client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": entity_id})
    _accept_all(client, "actions", entity_id)
    client.post(f"/bpm/kb/{KB}/generate-rules", json={"entity_id": entity_id})
    client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": entity_id})
    assert client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": entity_id}).status_code == 200

    studio["as"]("approver")
    approval_id = _approval_id(client, instance_id)
    assert client.post(f"/bpm/approvals/{approval_id}/reject", json={}).status_code == 400
    assert client.post(f"/bpm/approvals/{approval_id}/reject",
                       json={"notes": "Escalation missing a threshold"}).status_code == 200
    assert _stage(studio, entity_id) == "REJECTED"

    studio["as"]("author")
    rules = client.get(f"/rules/{KB}", params={"version": entity_id}).json()
    assert client.put(f"/rules/{KB}/{rules[0]['id']}", json={"min_order_value": 250}).status_code == 200
    assert _stage(studio, entity_id) == "RULE_EDIT"
    readiness = client.get(f"/bpm/kb/{KB}/proposals/{entity_id}/readiness").json()
    assert readiness["stage"] == "RULE_EDIT" and readiness["pending_approval"] is None


class _FakeLLM:
    answers: list = []
    prompts: list = []

    def chat_json(self, model, system, user):
        _FakeLLM.prompts.append(user)
        return _FakeLLM.answers.pop(0)


def _runtime_uses_the_live_policy(studio, version):
    """Stage 0 classifies only into the live taxonomy; Stages 1 and 3 read the passages."""
    import psycopg2
    from app.l4_agents import policy_knowledge
    from app.l4_agents.ecommerce import stage0_classifier, stage1_evaluator, stage3_responder

    url = studio["db"].url

    def connect():
        return psycopg2.connect(host=url.host, port=url.port, dbname=url.database,
                                user=url.username, password=url.password)

    policy_knowledge.clear_cache()
    knowledge = policy_knowledge.load_runtime(version, "ecommerce", connect=connect)
    assert set(knowledge.taxonomy.nodes) == {code for code, _, _ in LIVE_TAXONOMY}
    assert [c["title"] for c in knowledge.chunks] == ["Refund window", "Apology", "Photo evidence"]
    assert knowledge.variables["business_name"] == "Kirana Express"

    fields = {"active_policy": version, "business_line": "ecommerce",
              "order_context": {"order_value": 900, "order_id": "ORD-9"},
              "customer_profile": {"membership_tier": "GOLD"}}
    ticket = {"subject": "Missing items", "description": "Half my order is missing"}
    original = (stage0_classifier.LLMClient, stage1_evaluator.LLMClient, stage1_evaluator.RetrievalService,
                policy_knowledge._default_connection)
    retrieval = type("R", (), {"action_candidates": lambda *a, **k: [],
                               "policy_rule_candidates": lambda *a, **k: []})
    try:
        stage0_classifier.LLMClient = stage1_evaluator.LLMClient = _FakeLLM
        stage1_evaluator.RetrievalService = retrieval
        policy_knowledge._default_connection = connect
        _FakeLLM.answers = [{"issue_code": "ITLC_MISSING_ITEM_PARTIAL", "confidence": 0.9},
                            {"issue_code": "SOMETHING_THE_MODEL_MADE_UP", "confidence": 0.95}]
        mapped = stage0_classifier.run(1, "e1", ticket, fields)
        assert (mapped["issue_type_l1"], mapped["issue_type_l2"], mapped["taxonomy_status"]) == (
            "ITLC_MISSING_ITEM", "ITLC_MISSING_ITEM_PARTIAL", "mapped")
        assert "ITLC_WRONG_ITEM" in _FakeLLM.prompts[0]         # the model is shown the taxonomy
        invented = stage0_classifier.run(2, "e2", ticket, fields)
        assert invented["issue_type_l1"] == policy_knowledge.UNCLASSIFIED
        assert invented["taxonomy_status"] == "unmapped" and invented["confidence"] <= 0.3

        _FakeLLM.answers, _FakeLLM.prompts = [{"action_code": "ITLC_REFUND_MISSING"}], []
        stage1 = stage1_evaluator.run(1, "e1", ticket, mapped, [], fields)
        assert "Support is open 9am to 9pm" in _FakeLLM.prompts[0] and "Refund GOLD customers" in _FakeLLM.prompts[0]
        assert "Photo evidence" in _FakeLLM.prompts[0]           # written for the specific problem
        assert "We are sorry" not in _FakeLLM.prompts[0]         # reply text is not decision context
        assert len(stage1["policy_knowledge_used"]) == 2

        draft = stage3_responder.run(1, "e1", mapped, stage1,
                                     {"final_action_code": "ITLC_REFUND_MISSING", "final_refund_amount": 300},
                                     fields)
        assert "We are sorry about your Part of order missing." in draft["response_draft"]
        assert "— Kirana Express" in draft["response_draft"]
        assert "Kirana Express Support Team" in draft["response_draft"]
    finally:
        (stage0_classifier.LLMClient, stage1_evaluator.LLMClient, stage1_evaluator.RetrievalService,
         policy_knowledge._default_connection) = original
        policy_knowledge.clear_cache()
