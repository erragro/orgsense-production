"""
Compiler Service
================

LLM-driven policy compiler.

Responsibilities:
- Fetch raw draft
- Constrain action codes
- Call LLM
- Validate schema
- Insert rule_registry
- Insert knowledge_base_versions
- Update policy_versions
- Mark raw upload compiled
"""

import os
import json
import hashlib
import logging
import psycopg2
from app.admin.db import get_connection as pooled_connection
from psycopg2.extras import Json, RealDictCursor
from dotenv import load_dotenv
from pathlib import Path
from typing import Dict, List

from openai import OpenAI


# ============================================================
# CONFIG
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

LLM_API_KEY = os.getenv("LLM_API_KEY")
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1")

DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

logger = logging.getLogger("compiler_service")
logger.setLevel(logging.INFO)

client = OpenAI(
    api_key=LLM_API_KEY,
    base_url=LLM_API_BASE_URL
)


# ============================================================
# SERVICE
# ============================================================

class CompilerService:


    # --------------------------------------------------------
    # DB CONNECTION
    # --------------------------------------------------------

    def _get_connection(self):

        return pooled_connection()


    # --------------------------------------------------------
    # PUBLIC: Compile Latest Draft
    # --------------------------------------------------------

    def compile_latest_draft(self):
        """
        Fetches the most recently uploaded draft (any version)
        and compiles it. Delegates to compile_version internally.
        """

        conn = self._get_connection()

        try:

            with conn.cursor(cursor_factory=RealDictCursor) as cur:

                cur.execute("""
                    SELECT version_label
                    FROM kirana_kart.knowledge_base_raw_uploads
                    WHERE registry_status = 'draft'
                    ORDER BY uploaded_at DESC
                    LIMIT 1
                """)

                row = cur.fetchone()

        finally:

            conn.close()

        if not row:
            raise ValueError("No draft documents found to compile")

        return self.compile_version(row["version_label"])


    # --------------------------------------------------------
    # PUBLIC: Compile Specific Version
    # --------------------------------------------------------

    def compile_version(self, version_label: str):

        conn = self._get_connection()
        conn.autocommit = False

        try:

            with conn.cursor(cursor_factory=RealDictCursor) as cur:

                cur.execute("""
                    SELECT id, markdown_content, version_label
                    FROM kirana_kart.knowledge_base_raw_uploads
                    WHERE version_label=%s
                    AND registry_status='draft'
                    FOR UPDATE
                """, (version_label,))

                raw = cur.fetchone()

                if not raw:
                    raise ValueError(
                        f"Draft version '{version_label}' not found"
                    )

                logger.info(f"Compiling version {version_label}")

            # _compile_raw executes all writes but does NOT commit.
            # Commit happens here so the entire operation is one atomic transaction.
            result = self._compile_raw(conn, raw)
            conn.commit()
            return result

        except Exception as e:

            conn.rollback()
            logger.exception("Compilation failed")
            raise

        finally:

            conn.close()


    # --------------------------------------------------------
    # INTERNAL: CORE COMPILE LOGIC
    # --------------------------------------------------------

    def _compile_raw(self, conn, raw_row):
        """
        Executes all DB writes for compilation but does NOT commit.
        Transaction ownership belongs entirely to compile_version.
        """

        raw_id = raw_row["id"]
        markdown = raw_row.get("markdown_content")
        version_label = raw_row["version_label"]

        if not markdown:
            raise ValueError("Markdown content missing")

        markdown = markdown.strip()

        if not markdown:
            raise ValueError("Markdown document empty")

        logger.info(f"Markdown length: {len(markdown)}")

        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            action_registry = self._load_action_registry(cur)

        action_map = {r["action_code_id"]: r["id"] for r in action_registry}

        structured_json = self._call_llm(markdown, action_registry)

        self._validate_structure(structured_json)

        artifact_hash = self._hash(structured_json)

        with conn.cursor() as cur:

            cur.execute("""
                DELETE FROM kirana_kart.rule_registry
                WHERE policy_version=%s
            """, (version_label,))

            rule_count = self._insert_rules(
                cur,
                structured_json,
                version_label,
                action_map
            )

            logger.info(f"{rule_count} rules inserted")

            cur.execute("""
                INSERT INTO kirana_kart.policy_versions
                (policy_version, artifact_hash, description, is_active)
                VALUES (%s,%s,%s,FALSE)
                ON CONFLICT (policy_version)
                DO UPDATE SET artifact_hash=EXCLUDED.artifact_hash
            """, (
                version_label,
                artifact_hash,
                "Compiled via CompilerService"
            ))

            cur.execute("""
                UPDATE kirana_kart.knowledge_base_raw_uploads
                SET registry_status='compiled',
                    compile_errors=NULL
                WHERE id=%s
            """, (raw_id,))

        # NOTE: No conn.commit() here. compile_version owns the transaction.

        return {
            "status": "compiled",
            "version_label": version_label,
            "artifact_hash": artifact_hash,
            "rules_created": rule_count
        }


    # --------------------------------------------------------
    # LOAD ACTION REGISTRY (full details)
    # --------------------------------------------------------

    def _load_action_registry(self, cur) -> List[dict]:
        """Return full action registry rows for LLM context and map building."""

        cur.execute("""
            SELECT id, action_code_id, action_name, action_description,
                   requires_refund, requires_escalation, automation_eligible
            FROM kirana_kart.master_action_codes
            ORDER BY action_code_id
        """)

        return cur.fetchall()


    # --------------------------------------------------------
    # LOAD ACTION MAP (id lookup — kept for insert validation)
    # --------------------------------------------------------

    def _load_action_map(self, cur) -> Dict[str, int]:
        return {r["action_code_id"]: r["id"] for r in self._load_action_registry(cur)}


    # --------------------------------------------------------
    # BUILD RICH ACTION BLOCK for LLM prompt
    # --------------------------------------------------------

    def _build_action_block(self, action_registry: List[dict]) -> str:
        """
        Formats the action registry into a human-readable table for the LLM.
        Includes code, name, description, and behavioural flags so the model
        can make semantically correct assignments without guessing.
        """

        lines = [
            "ALLOWED ACTION CODES",
            "=" * 72,
            "You MUST select action_code_id ONLY from this list.",
            "Each row: CODE | Name | Description | [flags]",
            "",
        ]

        for ac in action_registry:
            code  = ac["action_code_id"]
            name  = ac["action_name"] or "—"
            desc  = ac["action_description"] or "No description provided."

            flags = []
            if ac.get("requires_refund"):
                flags.append("issues_refund")
            if ac.get("requires_escalation"):
                flags.append("requires_human_review")
            if ac.get("automation_eligible"):
                flags.append("fully_automatable")

            flag_str = f"  [{', '.join(flags)}]" if flags else ""
            lines.append(f"  {code:<30} | {name:<30} | {desc}{flag_str}")

        lines += [
            "",
            "ASSIGNMENT RULES:",
            "  - Read the rule's intent carefully against each code's name and description.",
            "  - Prefer the most specific matching code over a generic one.",
            "  - Never assign a code whose description contradicts the rule's intent.",
            "  - If no code fits, omit the rule entirely (do NOT invent a code).",
        ]

        return "\n".join(lines)


    # --------------------------------------------------------
    # LLM CALL
    # --------------------------------------------------------

    def _call_llm(self, markdown: str, action_registry: List[dict]):

        action_block = self._build_action_block(action_registry)

        prompt = f"""
You are a deterministic policy compiler for Kirana Kart, a quick-commerce customer support platform.

Your task: parse the KB document below and extract structured policy rules in JSON.

STRICT RULES:
1. Every rule MUST contain an action_code_id chosen from the ALLOWED ACTION CODES list.
2. Use the code's Name and Description to determine the correct assignment — do NOT guess by name alone.
3. DO NOT invent action codes not in the list.
4. DO NOT return null action_code_id.
5. If a rule cannot map to any valid action_code_id, skip that rule entirely.
6. conditions must capture the factual trigger criteria from the document (e.g. order_value, issue_type, repeat_count).
7. Populate numeric fields (min_order_value, max_order_value, etc.) from explicit thresholds in the document.
8. Set deterministic=true only when the document states the outcome is automatic/unconditional.

{action_block}

Return STRICT JSON matching this schema exactly:

{{
 "modules":[
  {{
   "module_name":"",
   "rules":[
    {{
     "rule_id":"",
     "rule_type":"",
     "priority":100,
     "rule_scope":"ticket",

     "issue_type_l1":null,
     "issue_type_l2":null,
     "business_line":null,
     "customer_segment":null,
     "fraud_segment":null,

     "min_order_value":null,
     "max_order_value":null,
     "min_repeat_count":null,
     "max_repeat_count":null,

     "sla_breach_required":false,
     "evidence_required":false,

     "conditions":{{}},

     "action_code_id":"",
     "action_payload":{{}},

     "deterministic":true,
     "overrideable":false
    }}
   ]
  }}
 ]
}}

Document:
\"\"\"
{markdown}
\"\"\"
"""

        response = client.chat.completions.create(

            model="gpt-4.1",
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are a deterministic policy compiler. Return strict JSON only."},
                {"role": "user", "content": prompt}
            ]

        )

        content = response.choices[0].message.content

        logger.info("LLM response received")

        try:

            parsed = json.loads(content)

        except Exception:

            logger.error("LLM returned invalid JSON")
            logger.error(content)
            raise

        return parsed


    # --------------------------------------------------------
    # VALIDATE STRUCTURE
    # --------------------------------------------------------

    def _validate_structure(self, data: dict):

        if "modules" not in data:
            raise ValueError("Missing modules key")

        if not isinstance(data["modules"], list):
            raise ValueError("modules must be list")

        total_rules = 0

        for module in data["modules"]:

            if "rules" not in module:
                raise ValueError("module missing rules")

            if not isinstance(module["rules"], list):
                raise ValueError("rules must be list")

            for rule in module["rules"]:

                if not rule.get("action_code_id"):
                    raise ValueError(
                        "Rule missing action_code_id"
                    )

            total_rules += len(module["rules"])

        if total_rules == 0:
            raise ValueError("Compiler produced zero rules")


    # --------------------------------------------------------
    # INSERT RULES
    # --------------------------------------------------------

    def _insert_rules(self, cur, structured_json, version_label, action_map):

        inserted = 0

        for module in structured_json["modules"]:

            module_name = module.get("module_name", "default")

            for rule in module["rules"]:

                action_code = rule["action_code_id"]

                if action_code not in action_map:

                    raise ValueError(
                        f"Invalid action_code_id: {action_code}"
                    )

                action_id = action_map[action_code]

                cur.execute("""
                    INSERT INTO kirana_kart.rule_registry
                    (
                        rule_id,
                        policy_version,
                        module_name,
                        rule_type,
                        priority,
                        rule_scope,

                        issue_type_l1,
                        issue_type_l2,
                        business_line,
                        customer_segment,
                        fraud_segment,

                        min_order_value,
                        max_order_value,
                        min_repeat_count,
                        max_repeat_count,

                        sla_breach_required,
                        evidence_required,

                        conditions,

                        action_id,
                        action_payload,

                        deterministic,
                        overrideable
                    )
                    VALUES
                    (%s,%s,%s,%s,%s,%s,
                     %s,%s,%s,%s,%s,
                     %s,%s,%s,%s,
                     %s,%s,
                     %s,
                     %s,%s,
                     %s,%s)
                """, (

                    rule["rule_id"],
                    version_label,
                    module_name,
                    rule["rule_type"],
                    rule.get("priority", 100),
                    rule.get("rule_scope", "ticket"),

                    rule.get("issue_type_l1"),
                    rule.get("issue_type_l2"),
                    rule.get("business_line"),
                    rule.get("customer_segment"),
                    rule.get("fraud_segment"),

                    rule.get("min_order_value"),
                    rule.get("max_order_value"),
                    rule.get("min_repeat_count"),
                    rule.get("max_repeat_count"),

                    rule.get("sla_breach_required", False),
                    rule.get("evidence_required", False),

                    Json(rule.get("conditions") or {}),

                    action_id,
                    Json(rule.get("action_payload") or {}),

                    rule.get("deterministic", True),
                    rule.get("overrideable", False)

                ))

                inserted += 1

        return inserted


    # --------------------------------------------------------
    # HASH
    # --------------------------------------------------------

    def _hash(self, data: dict) -> str:

        encoded = json.dumps(
            data,
            sort_keys=True
        ).encode()

        return hashlib.sha256(encoded).hexdigest()


    # --------------------------------------------------------
    # PUBLIC: Extract Action Codes from Document
    # --------------------------------------------------------

    def extract_action_codes(self, version_label: str) -> dict:
        """
        LLM pass over the KB document to extract all possible policy decisions.
        Upserts discovered action codes into master_action_codes (ON CONFLICT DO NOTHING).
        Returns { extracted, inserted_count, total_count }
        """

        conn = self._get_connection()

        try:

            with conn.cursor(cursor_factory=RealDictCursor) as cur:

                cur.execute("""
                    SELECT markdown_content
                    FROM kirana_kart.knowledge_base_raw_uploads
                    WHERE version_label = %s
                    ORDER BY uploaded_at DESC
                    LIMIT 1
                """, (version_label,))

                row = cur.fetchone()

        finally:

            conn.close()

        if not row or not row.get("markdown_content"):
            raise ValueError(
                f"No document found for version '{version_label}'"
            )

        markdown = row["markdown_content"].strip()

        if not markdown:
            raise ValueError("Document content is empty")

        extracted = self._call_extract_llm(markdown)

        inserted_count = 0

        conn2 = self._get_connection()

        try:

            with conn2.cursor() as cur:

                for ac in extracted:

                    cur.execute("""
                        INSERT INTO kirana_kart.master_action_codes
                            (action_key, action_code_id, action_name,
                             action_description, requires_refund,
                             requires_escalation, automation_eligible)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (action_code_id) DO NOTHING
                    """, (
                        ac["action_code_id"].lower().replace("_", "-"),
                        ac["action_code_id"],
                        ac["action_name"],
                        ac.get("action_description"),
                        bool(ac.get("requires_refund", False)),
                        bool(ac.get("requires_escalation", False)),
                        bool(ac.get("automation_eligible", False)),
                    ))

                    if cur.rowcount > 0:
                        inserted_count += 1

                conn2.commit()

                cur.execute("""
                    SELECT COUNT(*) FROM kirana_kart.master_action_codes
                """)

                total = cur.fetchone()[0]

        except Exception:

            conn2.rollback()
            raise

        finally:

            conn2.close()

        return {
            "extracted": extracted,
            "inserted_count": inserted_count,
            "total_count": total,
        }


    # --------------------------------------------------------
    # LLM CALL: Extract Action Codes
    # --------------------------------------------------------

    def _call_extract_llm(self, markdown: str) -> List[dict]:

        prompt = f"""
You are a policy analyst. Given the following policy document, enumerate every
possible decision outcome that can result from evaluating a support ticket.

For each outcome return:
  action_code_id: SCREAMING_SNAKE_CASE identifier (e.g. REFUND_FULL, REJECT_FRAUD)
  action_name: short human-readable label (max 5 words)
  action_description: one sentence describing when this outcome applies
  requires_refund: true if a monetary refund is issued
  requires_escalation: true if human review is required
  automation_eligible: true if this action can be taken fully automatically

Return a JSON object with key "action_codes" containing an array of the above objects.
Do NOT include any other keys.

Document:
\"\"\"
{markdown}
\"\"\"
"""

        response = client.chat.completions.create(

            model="gpt-4.1",
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "Return strict JSON only."},
                {"role": "user", "content": prompt}
            ]

        )

        content = response.choices[0].message.content

        logger.info("Extract LLM response received")

        try:

            parsed = json.loads(content)

        except Exception:

            logger.error("Extract LLM returned invalid JSON")
            logger.error(content)
            raise

        action_codes = parsed.get("action_codes", [])

        if not isinstance(action_codes, list):
            raise ValueError("LLM did not return action_codes array")

        required_fields = {"action_code_id", "action_name"}

        for ac in action_codes:

            missing = required_fields - set(ac.keys())

            if missing:
                raise ValueError(f"Action code missing fields: {missing}")

        return action_codes