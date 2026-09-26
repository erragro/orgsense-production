"""
app/l4_agents/policy_knowledge.py
=================================
What the live policy knows beyond its rules, for the Cardinal pipeline:

* the KB's live issue taxonomy — Stage 0 may only classify into it, so every
  issue a rule is written for is one the runtime can actually emit;
* the policy version's reviewed SOP passages (policy_knowledge_chunks) —
  Stage 1 decision context and Stage 3 reply text;
* the tenant's variables, embedded in passages as {{name}}.

Pure helpers (rendering, selection, issue resolution) take plain data so
Policy Studio, the simulator and tests use exactly what the worker uses.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

logger = logging.getLogger("kirana_kart.policy_knowledge")

SCHEMA = "kirana_kart"

VARIABLE_NAME = re.compile(r"^[a-z][a-z0-9_]{1,49}$")
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}")

# Values that come from the ticket being decided, not from tenant settings.
# Name → what a reviewer sees in the wizard.
DYNAMIC_VARIABLES: dict[str, str] = {
    "customer_tier": "The customer's membership tier",
    "order_id": "The order the ticket is about",
    "order_value": "The order value, in rupees",
    "order_history_summary": "Refunds and complaints in the last 30 days",
    "issue_label": "The customer problem, as named in the taxonomy",
    "refund_amount": "The refund decided for this ticket (reply drafts only)",
    "resolution_summary": "The decided resolution, in customer words (reply drafts only)",
}

# Suggested tenant settings. Any snake_case name can be defined; these are
# offered first in the wizard and in the extraction prompt.
SUGGESTED_STATIC_VARIABLES: dict[str, str] = {
    "business_name": "How the business names itself to customers",
    "support_tone": "Tone replies should take, e.g. warm and brief",
    "support_hours": "When human support is available",
    "escalation_contact": "Where escalations go",
    "refund_cap_default": "Default refund ceiling, in rupees",
}

UNCLASSIFIED = "UNCLASSIFIED"
PURPOSES = ("decision", "response", "both")

STAGE1_CHUNK_LIMIT = 6
STAGE1_CHAR_BUDGET = 4000
STAGE3_CHUNK_LIMIT = 3


# ============================================================
# VARIABLES
# ============================================================

def placeholders(text: str) -> list[str]:
    """Variable names a passage embeds, in first-use order."""
    seen: dict[str, None] = {}
    for match in _PLACEHOLDER.finditer(text or ""):
        seen.setdefault(match.group(1).lower(), None)
    return list(seen)


def undefined_variables(texts: Iterable[str], static_names: Iterable[str]) -> list[str]:
    """Names embedded in `texts` that neither the tenant nor the ticket supplies."""
    known = set(static_names) | set(DYNAMIC_VARIABLES)
    missing: dict[str, None] = {}
    for body in texts:
        for name in placeholders(body):
            if name not in known:
                missing.setdefault(name, None)
    return list(missing)


def render(text: str, values: dict[str, Any]) -> str:
    """
    Fill {{name}} from `values`. A value that is unknown here stays visible
    as [name not set] rather than vanishing: these texts reach a model or a
    reviewing agent, and a silent blank reads as policy.
    """
    def fill(match: re.Match) -> str:
        name = match.group(1).lower()
        value = values.get(name)
        if value is None or value == "":
            return f"[{name} not set]"
        return str(value)
    return _PLACEHOLDER.sub(fill, text or "")


def _money(value: Any) -> Optional[str]:
    try:
        return f"₹{float(value):,.2f}"
    except (TypeError, ValueError):
        return None


def ticket_values(fields: dict, stage0: Optional[dict] = None,
                  stage2: Optional[dict] = None, action_summary: Optional[str] = None) -> dict:
    """The dynamic variables for one ticket; absent facts stay absent."""
    order = fields.get("order_context") or {}
    risk = fields.get("risk_context") or {}
    customer = fields.get("customer_profile") or {}
    values: dict[str, Any] = {
        "customer_tier": customer.get("membership_tier") or customer.get("tier"),
        "order_id": order.get("order_id") or fields.get("order_id"),
        "order_value": _money(order.get("order_value")) if order.get("order_value") is not None else None,
    }
    refunds, complaints = risk.get("refunds_last_30_days"), risk.get("complaints_last_30_days")
    if refunds is not None or complaints is not None:
        values["order_history_summary"] = (
            f"{int(refunds or 0)} refunds and {int(complaints or 0)} complaints in the last 30 days"
        )
    if stage0:
        values["issue_label"] = stage0.get("issue_label") or stage0.get("issue_type_l2") or stage0.get("issue_type_l1")
    if stage2:
        values["refund_amount"] = _money(stage2.get("final_refund_amount") or 0)
    if action_summary:
        values["resolution_summary"] = action_summary
    return {k: v for k, v in values.items() if v not in (None, "")}


# ============================================================
# PASSAGE SELECTION
# ============================================================

def _norm(code: Any) -> str:
    return str(code or "").strip().upper()


def select_chunks(chunks: list[dict], issue_l1: Any, issue_l2: Any, purpose: str,
                  limit: int, char_budget: Optional[int] = None) -> list[dict]:
    """
    Passages for one ticket: those written for its specific problem first,
    then its category, then passages that apply to every problem. A passage
    tagged only with other problems is never used.
    """
    l1, l2 = _norm(issue_l1), _norm(issue_l2)
    ranked = []
    for index, chunk in enumerate(chunks):
        if chunk.get("purpose", "both") not in (purpose, "both"):
            continue
        codes = {_norm(c) for c in chunk.get("issue_codes") or []}
        if not codes:
            rank = 2
        elif l2 and l2 in codes:
            rank = 0
        elif l1 and l1 in codes:
            rank = 1
        else:
            continue
        ranked.append((rank, chunk.get("sort_order", 0), index, chunk))
    chosen, used = [], 0
    for *_, chunk in sorted(ranked, key=lambda r: r[:3]):
        size = len(chunk.get("body") or "")
        if char_budget is not None and chosen and used + size > char_budget:
            break
        chosen.append(chunk)
        used += size
        if len(chosen) >= limit:
            break
    return chosen


def rendered(chunks: list[dict], values: dict) -> list[dict]:
    return [{"title": c.get("title"), "text": render(c.get("body") or "", values),
             "chunk_key": c.get("chunk_key")} for c in chunks]


# ============================================================
# ISSUE RESOLUTION (Stage 0)
# ============================================================

def _label_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


@dataclass
class Taxonomy:
    nodes: dict[str, dict] = field(default_factory=dict)      # code → node
    by_label: dict[str, str] = field(default_factory=dict)    # label key → code

    @classmethod
    def build(cls, rows: Iterable[dict]) -> "Taxonomy":
        tax = cls()
        for row in rows:
            code = _norm(row.get("issue_code"))
            if code:
                tax.nodes[code] = {**row, "issue_code": code,
                                   "parent_code": _norm(row.get("parent_code")) or None}
        for code, node in tax.nodes.items():
            tax.by_label.setdefault(_label_key(node.get("label")), code)
            tax.by_label.setdefault(_label_key(code), code)
        return tax

    def __bool__(self) -> bool:
        return bool(self.nodes)

    def root(self, code: str) -> Optional[str]:
        node, depth = self.nodes.get(code), 0
        while node and node.get("parent_code") and depth < 5:
            node, depth = self.nodes.get(node["parent_code"]), depth + 1
        return node["issue_code"] if node and (node.get("level") == 1 or not node.get("parent_code")) else None

    def find(self, value: Any) -> Optional[str]:
        code = _norm(value).replace(" ", "_").replace("-", "_")
        if code in self.nodes:
            return code
        return self.by_label.get(_label_key(value))

    def prompt_view(self, limit: int = 400) -> list[dict]:
        nodes = sorted(self.nodes.values(), key=lambda n: (n.get("level") or 1, n["issue_code"]))
        return [{"issue_code": n["issue_code"], "label": n.get("label"),
                 "parent_code": n.get("parent_code"), "level": n.get("level")} for n in nodes[:limit]]


def resolve_issue(taxonomy: Taxonomy, l1: Any, l2: Any) -> dict:
    """
    Map a model's classification onto the live taxonomy. The most specific
    recognised node wins and carries its own ancestry, so the pair always
    matches how Policy Studio writes rules: issue_type_l1 is the level-1
    root and issue_type_l2 the node itself (levels 2-4).
    """
    node = taxonomy.find(l2) if l2 else None
    if node is None and l1:
        node = taxonomy.find(l1)
    if node is None:
        return {"issue_type_l1": UNCLASSIFIED, "issue_type_l2": None,
                "issue_label": None, "taxonomy_status": "unmapped"}
    root = taxonomy.root(node)
    if root is None:
        return {"issue_type_l1": UNCLASSIFIED, "issue_type_l2": None,
                "issue_label": None, "taxonomy_status": "unmapped"}
    return {
        "issue_type_l1": root,
        "issue_type_l2": node if node != root else None,
        "issue_label": taxonomy.nodes[node].get("label"),
        "taxonomy_status": "mapped",
    }


# ============================================================
# RUNTIME LOADER (worker, psycopg2)
# ============================================================

@dataclass
class RuntimeKnowledge:
    kb_id: Optional[str]
    taxonomy: Taxonomy
    chunks: list[dict]
    variables: dict[str, str]

    def values(self, dynamic: dict) -> dict:
        # A ticket fact always wins over a tenant setting of the same name.
        return {**self.variables, **dynamic}


EMPTY = RuntimeKnowledge(None, Taxonomy(), [], {})
CACHE_SECONDS = 60
_cache: dict[tuple[str, str], tuple[float, RuntimeKnowledge]] = {}
_lock = threading.Lock()


def _default_connection():
    # The pooled connection the worker uses; importing the worker module here
    # would build its Celery app in every process that runs a stage.
    from app.admin.db import get_connection
    return get_connection()


def load_runtime(policy_version: str, business_line: str = "", connect=None) -> RuntimeKnowledge:
    """
    The live policy's taxonomy, passages and variables, cached briefly per
    (version, business line). Failure returns EMPTY: the pipeline then runs
    as it did before this existed, and Stage 0 reports 'unavailable'.
    """
    if not policy_version:
        return EMPTY
    key = (policy_version, (business_line or "").lower())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    try:
        knowledge = _query(connect or _default_connection, policy_version, key[1])
    except Exception as exc:     # noqa: BLE001 — the pipeline must keep running
        logger.warning("Policy knowledge unavailable for %s: %s", policy_version, exc)
        return EMPTY
    with _lock:
        _cache[key] = (now + CACHE_SECONDS, knowledge)
    return knowledge


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _query(connect, policy_version: str, business_line: str) -> RuntimeKnowledge:
    import psycopg2.extras
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SELECT kb_id FROM {SCHEMA}.policy_versions WHERE policy_version = %s",
                        (policy_version,))
            row = cur.fetchone()
            kb_id = row["kb_id"] if row else None
            if kb_id is None:
                return EMPTY
            cur.execute(f"""
                SELECT c.issue_code, c.label, c.description, c.level, p.issue_code AS parent_code
                FROM {SCHEMA}.issue_taxonomy c
                LEFT JOIN {SCHEMA}.issue_taxonomy p ON p.id = c.parent_id
                WHERE c.kb_id = %s AND c.is_active = TRUE
            """, (kb_id,))
            taxonomy = Taxonomy.build(dict(r) for r in cur.fetchall())
            cur.execute(f"""
                SELECT chunk_key, title, body, issue_codes, purpose, sort_order
                FROM {SCHEMA}.policy_knowledge_chunks
                WHERE kb_id = %s AND entity_id = %s AND status IN ('accepted', 'edited')
                  AND (business_line IS NULL OR LOWER(business_line) = %s)
                ORDER BY sort_order, id
            """, (kb_id, policy_version, business_line))
            chunks = [dict(r) for r in cur.fetchall()]
            cur.execute(f"""
                SELECT name, value, business_line FROM {SCHEMA}.policy_variables
                WHERE kb_id = %s AND (business_line = '' OR LOWER(business_line) = %s)
                ORDER BY (business_line <> '') ASC
            """, (kb_id, business_line))
            # Knowledge-base values first, then business-line overrides.
            variables = {r["name"]: r["value"] for r in cur.fetchall()}
        return RuntimeKnowledge(kb_id, taxonomy, chunks, variables)
    finally:
        conn.close()
