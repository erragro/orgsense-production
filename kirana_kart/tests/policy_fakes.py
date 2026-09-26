"""
In-memory stand-in for the SQL the Policy Studio lifecycle issues.

Unit tests use it to exercise decisions (which stage, which refusal) without a
database; tests/integration/test_policy_studio_lifecycle.py proves the same
flows against PostgreSQL.
"""
from unittest.mock import MagicMock


class FakeConn:
    def __init__(self, stage="RULE_EDIT", counts=None, runtime=None, entity_type="kb_version",
                 approval=None, version=None, fingerprint_rows=None, other_active=()):
        self.instance = {"id": 42, "kb_id": "default", "entity_id": "v_candidate",
                         "entity_type": entity_type, "current_stage": stage,
                         "process_name": "kb_policy_lifecycle", "metadata": {}}
        self.counts = {"taxonomy_pending": 0, "taxonomy_accepted": 1, "actions_pending": 0,
                       "actions_accepted": 1, "rules": 5, "knowledge_pending": 0,
                       "knowledge_accepted": 0, "gaps_open": 0, **(counts or {})}
        self.runtime = runtime            # (active_version, shadow_version) or None
        self.approval = approval          # pending approval row or None
        self.version = version            # policy_versions row or None
        self.fingerprint_rows = fingerprint_rows or []
        self.other_active = list(other_active)
        self.transitions: list[tuple[str, str]] = []
        self.stage_updates: list[tuple[int, str]] = []
        self.gates: list[dict] = []
        self.statements: list[str] = []

    @property
    def stage(self):
        return self.instance["current_stage"]

    def _result(self, first=None, rows=None, scalar=None):
        result = MagicMock()
        result.mappings.return_value.first.return_value = first
        result.mappings.return_value.all.return_value = rows or []
        result.scalar.return_value = scalar
        result.first.return_value = first
        return result

    def execute(self, stmt, params=None):
        sql, p = str(stmt), params or {}
        self.statements.append(sql)
        if "SELECT * FROM kirana_kart.bpm_process_instances" in sql:
            return self._result(first=dict(self.instance) if self.instance else None)
        if "SELECT id, current_stage, process_name" in sql:
            stage = self.stage if p["id"] == self.instance["id"] else "ACTIVE"
            return self._result(first={"id": p["id"], "current_stage": stage,
                                       "process_name": self.instance["process_name"]})
        if "UPDATE kirana_kart.bpm_process_instances" in sql:
            self.stage_updates.append((p["id"], p["to_stage"]))
            if p["id"] == self.instance["id"]:
                self.transitions.append((self.stage, p["to_stage"]))
                self.instance["current_stage"] = p["to_stage"]
            return self._result()
        if "taxonomy_pending" in sql:
            return self._result(first=dict(self.counts))
        if "FROM kirana_kart.kb_runtime_config" in sql:
            row = {"active_version": self.runtime[0], "shadow_version": self.runtime[1]} if self.runtime else None
            return self._result(first=row)
        if "FROM kirana_kart.rule_registry" in sql and "ORDER BY rule_id" in sql:
            return self._result(rows=self.fingerprint_rows)
        if "INSERT INTO kirana_kart.bpm_gate_results" in sql:
            self.gates.append(p)
            return self._result(scalar=len(self.gates))
        if "INSERT INTO kirana_kart.bpm_approvals" in sql:
            return self._result(first={"id": 99, "instance_id": p["iid"], "status": "pending",
                                       "requested_by_id": p["uid"]})
        if "FROM kirana_kart.bpm_approvals" in sql and "FOR UPDATE" in sql:
            return self._result(first=self.approval)
        if "FROM kirana_kart.policy_versions" in sql and "FOR UPDATE" in sql:
            return self._result(first=self.version)
        if "current_stage = 'ACTIVE'" in sql:
            return self._result(rows=[{"id": i, "entity_id": f"old-{i}"} for i in self.other_active])
        return self._result()


def actor(user_id=7, email="approver@example.test"):
    user = MagicMock()
    user.id, user.email = user_id, email
    user.is_super_admin = False
    return user
