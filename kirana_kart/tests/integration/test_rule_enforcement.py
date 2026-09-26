"""
Policy Studio rules in live decisions, against a migrated PostgreSQL database.

Runs the worker's own rule query, Stage 2 (with its real action-registry
lookup) and the llm_output_3 write, then the observe-mode summary endpoint.
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

pytestmark = pytest.mark.integration

VERSION = "rule-it-" + uuid.uuid4().hex[:8]
TICKETS = (987600001, 987600002, 987600003)


def raw_connection(engine):
    import psycopg2
    url = engine.url
    return psycopg2.connect(host=url.host, port=url.port, dbname=url.database,
                            user=url.username, password=url.password)


@pytest.fixture
def db(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database")
    if not make_url(url).database.endswith("_test"):
        pytest.fail("Integration database name must end in _test")
    engine = create_engine(url, hide_parameters=True)

    from app.l4_agents import worker
    from app.l4_agents.ecommerce import stage2_validator
    monkeypatch.setattr(worker, "_get_connection", lambda: raw_connection(engine))
    monkeypatch.setattr(stage2_validator, "_get_connection", lambda: raw_connection(engine))

    with engine.begin() as conn:
        ids = {}
        for code, refund in (("RULEIT_REFUND", True), ("RULEIT_REJECT", False)):
            ids[code] = conn.execute(text("""
                INSERT INTO kirana_kart.master_action_codes
                    (action_key, action_code_id, action_name, requires_refund, requires_escalation, automation_eligible)
                VALUES (:c, :c, :c, :r, FALSE, TRUE) RETURNING id
            """), {"c": code, "r": refund}).scalar()
        rules = [
            # Guidance only: lowest number, but it never decides.
            ("R-GUIDE", 10, ids["RULEIT_REFUND"], "{}", "{}", False),
            # Unreadable condition: must not take over (fail closed).
            ("R-ODD", 20, ids["RULEIT_REFUND"], '{"weird_key": 1}', "{}", True),
            ("R-GOLD", 100, ids["RULEIT_REFUND"],
             '{"type":"group","operator":"AND","conditions":['
             '{"type":"leaf","field":"order_value","op":"gte","value":500},'
             '{"type":"leaf","field":"customer_segment","op":"in","value":["Gold","Platinum"]}]}',
             '{"refund_percent": 50, "max_refund": 400}', True),
            ("R-DEFAULT", 200, ids["RULEIT_REJECT"], "{}", "{}", True),
        ]
        for rule_id, priority, action_id, conditions, payload, deterministic in rules:
            conn.execute(text("""
                INSERT INTO kirana_kart.rule_registry
                    (kb_id, rule_id, policy_version, module_name, rule_type, priority,
                     issue_type_l1, action_id, conditions, action_payload, deterministic, overrideable)
                VALUES ('default', :rid, :v, 'default', 'issue_resolution', :p,
                        'MISSING_ITEM', :a, CAST(:c AS jsonb), CAST(:pl AS jsonb), :d, FALSE)
            """), {"rid": rule_id, "v": VERSION, "p": priority, "a": action_id,
                   "c": conditions, "pl": payload, "d": deterministic})
    yield engine
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM kirana_kart.llm_output_3 WHERE ticket_id = ANY(:t)"), {"t": list(TICKETS)})
        conn.execute(text("DELETE FROM kirana_kart.rule_registry WHERE policy_version = :v"), {"v": VERSION})
        conn.execute(text("DELETE FROM kirana_kart.master_action_codes WHERE action_code_id LIKE 'RULEIT_%'"))
    engine.dispose()


def _decide(worker, ticket_id, tier, ai_action, ai_amount, mode, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "rule_enforcement", mode)
    rules = worker._fetch_rules(policy_version=VERSION, module="delivery", business_line="", fraud_segment="NORMAL")
    stage0 = {"issue_type_l1": "missing_item", "issue_type_l2": None}
    stage1 = {"action_code": ai_action, "calculated_gratification": ai_amount, "overall_confidence": 0.9,
              "greedy_classification": "NORMAL", "fraud_segment": "NORMAL", "standard_logic_passed": True}
    fields = {"order_context": {"order_value": 1000}, "risk_context": {},
              "customer_profile": {"membership_tier": tier}, "prior_complaints_30d": 1,
              "active_policy": VERSION}
    return rules, worker._run_stage_2(ticket_id, f"exec-{ticket_id}", stage0, stage1, rules, fields)


def test_rules_decide_only_when_enforced_and_every_decision_is_recorded(db, monkeypatch):
    from app.l4_agents import worker

    # The worker loads every evaluated field, in runtime precedence.
    rules, observed = _decide(worker, TICKETS[0], "GOLD", "RULEIT_REJECT", 0, "observe", monkeypatch)
    assert [r["rule_id"] for r in rules] == ["R-GUIDE", "R-ODD", "R-GOLD", "R-DEFAULT"]
    assert rules[2]["action_code_id"] == "RULEIT_REFUND" and rules[2]["action_payload"]["max_refund"] == 400

    # Observe: the AI's decision stands; the rule's is recorded next to it.
    assert observed["final_action_code"] == "RULEIT_REJECT" and observed["final_refund_amount"] == 0
    assert observed["rule_decision"]["rule_id"] == "R-GOLD" and not observed["rule_decision"]["applied"]

    # Enforce: the first deterministic, readable, matching rule decides.
    _, enforced = _decide(worker, TICKETS[1], "GOLD", "RULEIT_REJECT", 0, "enforce", monkeypatch)
    assert enforced["final_action_code"] == "RULEIT_REFUND"
    assert enforced["final_refund_amount"] == 400        # 50% of 1000, capped at 400
    assert enforced["automation_pathway"] == "HITL"

    # A standard-tier customer falls through to the default rule, which pays nothing.
    _, default = _decide(worker, TICKETS[2], "STANDARD", "RULEIT_REFUND", 300, "enforce", monkeypatch)
    assert default["final_action_code"] == "RULEIT_REJECT" and default["final_refund_amount"] == 0

    with db.connect() as conn:
        stored = dict(conn.execute(text("""
            SELECT ticket_id, rule_decision FROM kirana_kart.llm_output_3 WHERE ticket_id = ANY(:t)
        """), {"t": list(TICKETS)}).all())
    assert stored[TICKETS[0]]["mode"] == "observe" and stored[TICKETS[0]]["agrees"] is False
    assert stored[TICKETS[1]]["applied"] is True
    assert stored[TICKETS[2]]["rule_id"] == "R-DEFAULT"

    # The observe-mode evidence endpoint reads what was recorded.
    from app.admin.routes import bpm_routes
    monkeypatch.setattr(bpm_routes, "engine", db)
    summary = bpm_routes.rule_decision_summary(days=1, u=None)
    assert summary["evaluated"] >= 3 and summary["matched"] >= 3
    assert summary["applied"] >= 2 and summary["differs"] >= 3
    assert {r["rule_id"] for r in summary["by_rule"]} >= {"R-GOLD", "R-DEFAULT"}
