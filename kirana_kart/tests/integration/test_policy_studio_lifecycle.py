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


def _taxonomy_v1():
    return {"taxonomy": [
        {"issue_code": "ITLC_MISSING_ITEM", "label": "Missing item", "level": 1,
         "parent_code": None, "proposal_type": "new", "extraction_confidence": 0.9},
        {"issue_code": "itlc missing item partial", "label": "Part of order missing", "level": 2,
         "parent_code": "ITLC_MISSING_ITEM", "proposal_type": "new"},
        # Claims to exist but does not: must not be auto-accepted.
        {"issue_code": "ITLC_FAKE_EXISTING", "label": "Invented", "level": 1,
         "proposal_type": "existing"},
        # Unstorable (level CHECK is 1-4): dropped rather than a 500.
        {"issue_code": "ITLC_TOO_DEEP", "label": "Too deep", "level": 7},
        {"issue_code": "", "label": "No code", "level": 1},
    ]}


def _actions_v1():
    return {"actions": [
        {"action_code_id": "ITLC_REFUND_MISSING", "action_name": "Refund missing item",
         "exact_action": "Refund the item value", "proposal_type": "new",
         "parent_issue_codes": ["ITLC_MISSING_ITEM", "ITLC_MISSING_ITEM_PARTIAL"],
         "requires_refund": True},
        {"action_code_id": "ITLC_ESCALATE", "action_name": "Escalate to supervisor",
         "proposal_type": "new",
         "parent_issue_codes": ["ITLC_MISSING_ITEM_PARTIAL", "ITLC_NOT_ACCEPTED"]},
    ]}


def _taxonomy_v2():
    return {"taxonomy": [
        {"issue_code": "ITLC_MISSING_ITEM", "label": "Missing item", "level": 1,
         "proposal_type": "existing"},
    ]}


def _actions_v2():
    return {"actions": [
        {"action_code_id": "ITLC_REPLACE", "action_name": "Send a replacement",
         "proposal_type": "new", "parent_issue_codes": ["ITLC_MISSING_ITEM"]},
    ]}


@pytest.fixture
def studio(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database")
    if not make_url(url).database.endswith("_test"):
        pytest.fail("Integration database name must end in _test")
    db = create_engine(url, hide_parameters=True)

    from app.admin.routes import bpm_routes, rule_routes
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

    all_perms = {m: {"view": True, "edit": True, "admin": True} for m in ("knowledgeBase", "policy")}
    users = {
        "author": UserContext(ids[0], "author@example.test", "Author", None, False, all_perms),
        "approver": UserContext(ids[1], "approver@example.test", "Approver", None, False, all_perms),
        "outsider": UserContext(ids[2], "outsider@example.test", "Outsider", None, False, all_perms),
    }
    current = {"user": users["author"]}
    llm = {"taxonomy": _taxonomy_v1, "actions": _actions_v1}

    monkeypatch.setattr(bpm_routes, "engine", db)
    monkeypatch.setattr(rule_routes, "engine", db)
    monkeypatch.setattr(bpm_routes, "_bpm_service", BPMService(db))
    monkeypatch.setattr(rule_routes, "_bpm_service", BPMService(db))
    monkeypatch.setattr(sop_extractor, "_call_llm",
                        lambda system, user: (llm["actions"] if '"actions"' in user else llm["taxonomy"])())

    app = FastAPI()
    app.include_router(bpm_routes.router)
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
                              ("rule_edit_log", "kb_id")):
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
                           files={"file": ("policy.md", b"# Missing items\nRefund them.", "text/markdown")},
                           data={"change_name": name, "business_outcome": "Consistent refunds"})
    assert response.status_code == 200, response.text
    return response.json()


def _accept_all(client, kind, entity_id, skip=()):
    rows = client.get(f"/bpm/kb/{KB}/{kind}-proposals", params={"entity_id": entity_id}).json()
    for row in rows:
        code = row.get("issue_code") or row.get("action_code_id")
        if row["status"] == "pending":
            status = "rejected" if code in skip else "accepted"
            assert client.put(f"/bpm/kb/{KB}/{kind}-proposals/{row['id']}",
                              json={"status": status}).status_code == 200
    return rows


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
    assert analysis["count"] == 3 and analysis["truncated"] is False
    taxonomy = {p["issue_code"]: p for p in client.get(
        f"/bpm/kb/{KB}/taxonomy-proposals", params={"entity_id": v1}).json()}
    assert set(taxonomy) == {"ITLC_MISSING_ITEM", "ITLC_MISSING_ITEM_PARTIAL", "ITLC_FAKE_EXISTING"}
    assert taxonomy["ITLC_FAKE_EXISTING"]["proposal_type"] == "new"
    assert taxonomy["ITLC_FAKE_EXISTING"]["status"] == "pending"
    assert _stage(studio, v1) == "AI_COMPILE_QUEUED"

    assert client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()["status"] == "unavailable"
    _accept_all(client, "taxonomy", v1, skip={"ITLC_FAKE_EXISTING"})
    edit = client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{taxonomy['ITLC_MISSING_ITEM']['id']}",
                      json={"status": "edited", "user_output": {"label": "Item missing from order"}})
    assert edit.status_code == 200
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{taxonomy['ITLC_MISSING_ITEM']['id']}",
                      json={"status": "edited", "user_output": {"issue_code": "HIJACK"}}).status_code == 400

    actions = client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": v1})
    assert actions.status_code == 200 and actions.json()["count"] == 2, actions.text
    _accept_all(client, "action", v1)

    generated = client.post(f"/bpm/kb/{KB}/generate-rules", json={"entity_id": v1}).json()
    assert generated["count"] == 3, generated
    assert [s["issue_code"] for s in generated["skipped"]] == ["ITLC_NOT_ACCEPTED"]
    assert generated["stage"] == "RULE_EDIT"
    rules = client.get(f"/rules/{KB}", params={"version": v1}).json()
    partial = [r for r in rules if r["issue_type_l2"] == "ITLC_MISSING_ITEM_PARTIAL"]
    assert {r["issue_type_l1"] for r in partial} == {"ITLC_MISSING_ITEM"}
    assert {r["priority"] for r in partial} == {400}
    assert len({r["rule_id"] for r in rules}) == 3

    assert client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1}).status_code == 409

    gate = client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()
    assert gate["status"] == "not_applicable" and gate["stage"] == "SHADOW_GATE"

    # Editing tested rules discards the evidence.
    assert client.put(f"/rules/{KB}/{rules[0]['id']}", json={"priority": 450}).status_code == 200
    assert _stage(studio, v1) == "RULE_EDIT"
    assert client.post(f"/bpm/kb/{KB}/simulate", json={"entity_id": v1}).json()["stage"] == "SHADOW_GATE"

    submitted = client.post(f"/bpm/kb/{KB}/submit", json={"entity_id": v1})
    assert submitted.status_code == 200, submitted.text
    assert _stage(studio, v1) == "PENDING_APPROVAL"

    # Frozen while under approval.
    assert client.put(f"/rules/{KB}/{rules[0]['id']}", json={"priority": 1}).status_code == 409
    assert client.put(f"/bpm/kb/{KB}/taxonomy-proposals/{taxonomy['ITLC_MISSING_ITEM']['id']}",
                      json={"status": "rejected"}).status_code == 409
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
        assert not conn.execute(text("SELECT 1 FROM kirana_kart.issue_taxonomy WHERE issue_code LIKE 'ITLC_%'")).first()
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
        categories = dict(conn.execute(text("""
            SELECT c.issue_code, COALESCE(p.issue_code, '-') FROM kirana_kart.issue_taxonomy c
            LEFT JOIN kirana_kart.issue_taxonomy p ON p.id = c.parent_id
            WHERE c.issue_code LIKE 'ITLC_%'""")).all())
        assert categories == {"ITLC_MISSING_ITEM": "-", "ITLC_MISSING_ITEM_PARTIAL": "ITLC_MISSING_ITEM"}
        assert conn.execute(text("SELECT label FROM kirana_kart.issue_taxonomy WHERE issue_code = 'ITLC_MISSING_ITEM'")
                            ).scalar() == "Item missing from order"
        assert conn.execute(text("SELECT action_key FROM kirana_kart.master_action_codes "
                                 "WHERE action_code_id = 'ITLC_REFUND_MISSING'")).scalar() == "ITLC_REFUND_MISSING"

    # ---- v2: replaces v1, larger change needs a justification --------------
    studio["as"]("author")
    with db.begin() as conn:
        for n in range(10):
            conn.execute(text("""INSERT INTO kirana_kart.simulation_tickets (ticket_id, issue_type, order_value)
                                 VALUES (:id, 'ITLC_MISSING_ITEM', 100)"""), {"id": f"itlc-{n}"})
    studio["llm"].update(taxonomy=_taxonomy_v2, actions=_actions_v2)
    upload2 = _upload(client, "Replacements instead of refunds")
    v2 = upload2["entity_id"]
    client.post(f"/bpm/kb/{KB}/extract-taxonomy", json={"entity_id": v2})
    # Genuinely existing now, so accepted without review.
    assert [p["status"] for p in client.get(f"/bpm/kb/{KB}/taxonomy-proposals",
                                            params={"entity_id": v2}).json()] == ["accepted"]
    client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": v2})
    _accept_all(client, "action", v2)
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
    _accept_all(client, "taxonomy", entity_id, skip={"ITLC_FAKE_EXISTING"})
    client.post(f"/bpm/kb/{KB}/extract-actions", json={"entity_id": entity_id})
    _accept_all(client, "action", entity_id)
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
