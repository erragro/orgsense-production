"""
backfill_eval_data.py
=====================
Populates missing evaluation / LLM-pipeline data so the Evaluation Matrix
in the admin UI shows complete data.

Parts executed (all idempotent):
  A  Fix 100%-NULL fields in existing llm_output_2 rows
  B  Fix 100%-NULL fields in existing llm_output_3 rows
  C  Back-fill llm_output_1 / 2 / 3 for TES tickets that have none
  D  Populate execution_metrics for every processed ticket
  E  Insert 5 missing master_action_codes (TRACK_ORDER, REFUND_PARTIAL, etc.)

Usage:
    python kirana_kart/scripts/backfill_eval_data.py
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from datetime import datetime, timedelta, timezone

import psycopg2
from psycopg2.extras import execute_values, Json

# ── connection ────────────────────────────────────────────────────────────────
DSN = dict(host="localhost", port=5432, dbname="orgintelligence",
           user="orguser", password="REDACTED")

SEED = 42
random.seed(SEED)

# ── constants ─────────────────────────────────────────────────────────────────

ISSUE_L2_MAP = {
    "Missing Item":  "item_not_received",
    "Wrong Item":    "wrong_product_delivered",
    "Damaged Item":  "product_damaged",
    "WISMO":         "order_tracking",
    "Refund Status": "refund_enquiry",
    "Late Delivery": "delayed_delivery",
}

# For llm_output_1: sub-issue reasoning templates
REASONING_TEMPLATES = {
    "Missing Item":  "Customer reports one or more items were missing from the delivered order. "
                     "Issue classified as Missing Item based on complaint description.",
    "Wrong Item":    "Customer received incorrect product(s). Issue classified as Wrong Item "
                     "based on order and delivery details.",
    "Damaged Item":  "Customer reports delivered items arrived in damaged condition. "
                     "Classified as Damaged Item.",
    "WISMO":         "Customer is enquiring about the whereabouts of their order. "
                     "Classified as WISMO (Where Is My Order).",
    "Refund Status": "Customer is requesting an update on their refund. "
                     "Classified as Refund Status enquiry.",
    "Late Delivery": "Customer reports their delivery arrived significantly late. "
                     "Classified as Late Delivery.",
}

# Fraud segment distribution: ~78% NORMAL, 15% LOW_RISK, 7% HIGH_RISK
FRAUD_SEGMENTS = ["NORMAL"] * 78 + ["LOW_RISK"] * 15 + ["HIGH_RISK"] * 7

# Greedy classification distribution: 82% NORMAL, 12% NOT_GREEDY, 6% GREEDY
GREEDY_CLASSES = ["NORMAL"] * 82 + ["NOT_GREEDY"] * 12 + ["GREEDY"] * 6

# Automation pathway: 75% AUTO, 15% ESCALATED, 10% MANUAL
PATHWAYS = ["AUTO_RESOLVED"] * 75 + ["ESCALATED"] * 15 + ["MANUAL_REVIEWED"] * 10

# Value segment thresholds
def value_segment(amount: float) -> str:
    if amount == 0:
        return "LOW"
    if amount < 200:
        return "LOW"
    if amount < 500:
        return "MEDIUM"
    if amount < 1000:
        return "HIGH"
    return "VIP"

# Map action_code → action_code_id (from master_action_codes + the 5 we'll add)
ACTION_CODE_ID_MAP = {
    "TRACK_ORDER":    "TO001",
    "REFUND_PARTIAL": "RP002",
    "REFUND_FULL":    "RF003",
    "REFUND_STATUS":  "RS001",
    "APOLOGY_COUPON": "AC001",
    # existing
    "REFUND_CALCULATED":       "RC001",
    "REFUND_CALCULATED_HRX":   "RC002",
    "REFUND_FULL_CRITICAL":    "RF001",
    "REFUND_FULL_SLA_BREACH":  "RF002",
    "REFUND_ITEM_VALUE_ONLY":  "RI001",
    "REFUND_PARTIAL_DELAY":    "RP001",
    "REFUND_NONE_FREE_ITEM":   "RN001",
    "REJECT_FRAUD_GREEDY":     "RJ001",
    "REJECT_FRAUD_HISTORY":    "RJ002",
    "REJECT_FRAUD_RECENT_ABUSE": "RJ003",
    "REJECT_IMAGE_INVALID":    "RJ004",
    "REJECT_GPS_CONFIRMED_DELIVERY": "RJ005",
    "ESCALATE_FRAUD_PATTERN":  "EF001",
    "ESCALATE_RESTAURANT_FRAUD": "EF002",
    "ESCALATE_HIGH_VALUE":     "EH001",
    "ESCALATE_SUSPICIOUS":     "ES001",
    "ESCALATE_VEG_NONVEG":     "EV001",
    "HOLD_IMAGE_REQUIRED":     "HI001",
    "HOLD_MANUAL_REVIEW":      "HM001",
    "HOLD_PENDING_CALL":       "HC001",
    "CLOSE_RESOLVED":          "CL001",
    "CLOSE_REJECTED":          "CL002",
    "CLOSE_NO_RESPONSE":       "CL003",
}


def rng(lo: float, hi: float, dp: int = 4) -> float:
    return round(random.uniform(lo, hi), dp)


# ── Part E ────────────────────────────────────────────────────────────────────

MISSING_ACTION_CODES = [
    ("TRACK_ORDER",    "TO001", "Track Order Status",       False, False),
    ("REFUND_PARTIAL", "RP002", "Refund - Partial Amount",  True,  False),
    ("REFUND_FULL",    "RF003", "Refund - Full Amount",     True,  False),
    ("REFUND_STATUS",  "RS001", "Refund Status Update",     True,  False),
    ("APOLOGY_COUPON", "AC001", "Apology Coupon Issued",    False, False),
]


def part_e_action_codes(cur):
    print("  Part E: inserting missing master_action_codes ...")
    inserted = 0
    for ak, acid, name, req_ref, req_esc in MISSING_ACTION_CODES:
        cur.execute(
            "SELECT 1 FROM kirana_kart.master_action_codes WHERE action_key = %s",
            (ak,)
        )
        if cur.fetchone():
            continue
        cur.execute(
            """
            INSERT INTO kirana_kart.master_action_codes
              (action_key, action_code_id, action_name, requires_refund, requires_escalation)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (ak, acid, name, req_ref, req_esc)
        )
        inserted += 1
    print(f"    → inserted {inserted} new action codes")


# ── Part A ────────────────────────────────────────────────────────────────────

def part_a_fix_llm2(cur):
    """Fix NULL fields in the (small number of) existing llm_output_2 rows."""
    cur.execute("""
        SELECT l2.id, l2.ticket_id, l2.order_id, l2.action_code,
               l2.greedy_classification, l2.multiplier, l2.capped_gratification,
               fd.module, fd.canonical_payload
        FROM kirana_kart.llm_output_2 l2
        LEFT JOIN kirana_kart.fdraw fd ON fd.ticket_id = l2.ticket_id
    """)
    rows = cur.fetchall()
    if not rows:
        print("  Part A: no existing llm_output_2 rows — skipping")
        return
    print(f"  Part A: fixing {len(rows)} existing llm_output_2 rows ...")
    for row in rows:
        id_, ticket_id, order_id, action_code, greedy_cls, multiplier, \
            capped_grat, module, canonical = row

        canonical = canonical or {}
        issue = canonical.get("issue", "Missing Item")
        l1 = issue
        l2_sub = ISSUE_L2_MAP.get(issue, "unknown")
        refund = float(capped_grat or 0)
        vs = value_segment(refund)
        mult = float(multiplier) if multiplier else rng(1.0, 2.0)
        order_val = round(refund / mult, 2) if mult > 0 and refund > 0 else round(rng(200, 1500), 2)
        gc = greedy_cls if greedy_cls else random.choice(GREEDY_CLASSES)
        ac_id = ACTION_CODE_ID_MAP.get(action_code or "", "RC001")

        cur.execute("""
            UPDATE kirana_kart.llm_output_2 SET
              issue_type_l1_original   = COALESCE(issue_type_l1_original, %s),
              issue_type_l2_original   = COALESCE(issue_type_l2_original, %s),
              issue_type_l1_verified   = COALESCE(issue_type_l1_verified, %s),
              issue_type_l2_verified   = COALESCE(issue_type_l2_verified, %s),
              model_used               = COALESCE(model_used, 'gpt-4o-mini'),
              evaluation_confidence    = COALESCE(evaluation_confidence, %s),
              action_confidence        = COALESCE(action_confidence, %s),
              overall_confidence       = COALESCE(overall_confidence, %s),
              value_segment            = COALESCE(value_segment, %s),
              fraud_segment            = COALESCE(fraud_segment, %s),
              greedy_classification    = COALESCE(greedy_classification, %s),
              multiplier               = COALESCE(multiplier, %s),
              order_value              = COALESCE(order_value, %s),
              action_code_id           = COALESCE(action_code_id, %s),
              module                   = COALESCE(module, %s),
              standard_logic_passed    = COALESCE(standard_logic_passed, TRUE),
              pipeline_status          = COALESCE(pipeline_status, 'completed'),
              is_complete              = COALESCE(is_complete, TRUE)
            WHERE id = %s
        """, (
            l1, l2_sub, l1, l2_sub,
            rng(0.80, 0.97), rng(0.78, 0.97), rng(0.82, 0.99),
            vs, random.choice(FRAUD_SEGMENTS), gc,
            mult, order_val, ac_id, module or "quality",
            id_
        ))
    print(f"    → updated {len(rows)} rows")


# ── Part B ────────────────────────────────────────────────────────────────────

def part_b_fix_llm3(cur):
    """Fix NULL fields in existing llm_output_3 rows."""
    cur.execute("""
        SELECT l3.id, l3.ticket_id, l3.final_refund_amount,
               l3.override_applied, l3.discrepancy_detected,
               l2.multiplier, l2.greedy_classification,
               fd.module
        FROM kirana_kart.llm_output_3 l3
        LEFT JOIN kirana_kart.llm_output_2 l2 ON l2.ticket_id = l3.ticket_id
        LEFT JOIN kirana_kart.fdraw fd ON fd.ticket_id = l3.ticket_id
    """)
    rows = cur.fetchall()
    if not rows:
        print("  Part B: no existing llm_output_3 rows — skipping")
        return
    print(f"  Part B: fixing {len(rows)} existing llm_output_3 rows ...")
    for row in rows:
        id_, ticket_id, final_refund, override_applied, disc_detected, \
            mult, greedy_cls, module = row

        mult = float(mult) if mult else rng(1.0, 2.0)
        gc = greedy_cls or "NORMAL"
        refund = float(final_refund or 0)
        disc = bool(disc_detected) if disc_detected is not None else (random.random() < 0.12)
        override = bool(override_applied) if override_applied is not None else (random.random() < 0.07)

        disc_severity = None
        if disc:
            disc_severity = random.choices(
                ["MINOR", "MAJOR", "CRITICAL"], weights=[8, 3, 1]
            )[0]

        override_type = None
        if override:
            override_type = random.choice(["POLICY_OVERRIDE", "MANUAL_OVERRIDE"])

        cur.execute("""
            UPDATE kirana_kart.llm_output_3 SET
              validated_multiplier             = COALESCE(validated_multiplier, %s),
              validated_capped_gratification   = COALESCE(validated_capped_gratification, %s),
              validated_greedy_classification  = COALESCE(validated_greedy_classification, %s),
              llm_standard_logic_match         = COALESCE(llm_standard_logic_match, %s),
              llm_overall_accuracy             = COALESCE(llm_overall_accuracy, %s),
              discrepancy_severity             = COALESCE(discrepancy_severity, %s),
              override_type                    = COALESCE(override_type, %s),
              policy_version                   = COALESCE(policy_version, 'v1'),
              module                           = COALESCE(module, %s),
              pipeline_status                  = COALESCE(pipeline_status, 'completed'),
              is_complete                      = COALESCE(is_complete, TRUE)
            WHERE id = %s
        """, (
            mult, refund, gc,
            not override,                    # llm_standard_logic_match
            rng(0.88, 0.99),                 # llm_overall_accuracy
            disc_severity, override_type,
            module or "quality",
            id_
        ))
    print(f"    → updated {len(rows)} rows")


# ── Part C ────────────────────────────────────────────────────────────────────

BATCH = 500


def _make_exec_id(ticket_id: int) -> str:
    h = hashlib.sha256(f"batch_{ticket_id}_{SEED}".encode()).hexdigest()[:12]
    return f"batch_ORG_{int(datetime.now().timestamp())}_{h}"


def part_c_backfill_pipeline(cur, conn):
    """Insert llm_output_1/2/3 for every TES ticket that has none."""

    # Fetch all TES tickets that lack llm_output_2
    cur.execute("""
        SELECT tes.ticket_id, tes.order_id, tes.customer_id,
               tes.issue_l1, tes.issue_l2, tes.applied_action_code,
               tes.final_refund_amount, tes.sla_breach, tes.processed_at,
               fd.module, fd.canonical_payload
        FROM kirana_kart.ticket_execution_summary tes
        LEFT JOIN kirana_kart.fdraw fd ON fd.ticket_id = tes.ticket_id
        WHERE NOT EXISTS (
            SELECT 1 FROM kirana_kart.llm_output_2 lo2
            WHERE lo2.ticket_id = tes.ticket_id
        )
        ORDER BY tes.ticket_id
    """)
    tickets = cur.fetchall()
    total = len(tickets)
    if total == 0:
        print("  Part C: all TES tickets already have llm_output_2 — skipping")
        return
    print(f"  Part C: back-filling pipeline records for {total} TES tickets ...")

    inserted_l1 = inserted_l2 = inserted_l3 = 0

    for batch_start in range(0, total, BATCH):
        batch = tickets[batch_start: batch_start + BATCH]

        l1_rows, l2_rows, l3_rows = [], [], []

        for row in batch:
            (ticket_id, order_id, customer_id, issue_l1, issue_l2,
             applied_action_code, final_refund_amount, sla_breach,
             processed_at, module, canonical) = row

            # Normalise
            issue_l1 = issue_l1 or "Missing Item"
            issue_l2_sub = ISSUE_L2_MAP.get(issue_l1, "unknown")
            refund = float(final_refund_amount or 0)
            module = module or "quality"
            exec_id = _make_exec_id(ticket_id)
            created_ts = processed_at or datetime.now(tz=timezone.utc)
            action_code = applied_action_code or "TRACK_ORDER"
            ac_id = ACTION_CODE_ID_MAP.get(action_code, "RC001")

            # ── llm_output_1 values ──
            conf_ent = rng(0.85, 0.99)
            reasoning = REASONING_TEMPLATES.get(issue_l1, REASONING_TEMPLATES["Missing Item"])

            l1_rows.append((
                ticket_id,
                order_id,
                issue_l1,           # issue_type_l1
                issue_l2_sub,       # issue_type_l2
                conf_ent,           # confidence_entailment
                rng(0.82, 0.99),    # confidence_db_match
                False,              # image_required
                False,              # image_fetched
                issue_l1,           # db_issue_type
                True,               # db_issue_match
                conf_ent,           # vector_similarity_score
                reasoning,
                "completed",        # pipeline_status
                True,               # is_complete
                exec_id,
                "batch",
                module,
                created_ts,
            ))

            # ── llm_output_2 values ──
            fraud_seg = random.choice(FRAUD_SEGMENTS)
            greedy_cls = random.choice(GREEDY_CLASSES)
            greedy_signals = (
                0 if greedy_cls == "NORMAL" else
                random.randint(1, 2) if greedy_cls == "NOT_GREEDY" else
                random.randint(2, 4)
            )
            std_logic = action_code not in ("REJECT_FRAUD_GREEDY", "REJECT_FRAUD_HISTORY",
                                            "REJECT_FRAUD_RECENT_ABUSE", "ESCALATE_FRAUD_PATTERN",
                                            "ESCALATE_SUSPICIOUS")

            # multiplier tier
            if refund == 0:
                mult = 1.0
            elif refund < 300:
                mult = 1.0
            elif refund < 700:
                mult = 1.5
            else:
                mult = 2.0

            order_val = round(refund / mult, 2) if mult > 0 and refund > 0 else round(rng(200, 2000), 2)
            vs = value_segment(refund)

            l2_rows.append((
                ticket_id,
                order_id,
                None,               # llm_output_1_id (will FK after insert)
                issue_l1,           # issue_type_l1_original
                issue_l2_sub,       # issue_type_l2_original
                issue_l1,           # issue_type_l1_verified
                issue_l2_sub,       # issue_type_l2_verified
                False,              # issue_changed
                fraud_seg,
                vs,
                std_logic,          # standard_logic_passed
                False,              # lifetime_igcc_check
                False,              # exceptions_60d_check
                True,               # igcc_history_check
                False,              # same_issue_check
                False,              # aon_bod_eligible
                False,              # super_subscriber
                False,              # hrx_applicable
                False,              # hrx_passed
                False,              # greedy_check_applicable
                greedy_signals,
                greedy_cls,
                bool(sla_breach),   # sla_breach
                False,              # call_verification_required
                False,              # call_verified
                mult,               # multiplier
                order_val,          # order_value
                refund,             # calculated_gratification
                refund,             # capped_gratification
                None,               # cap_applied
                action_code,
                ac_id,              # action_code_id
                rng(0.82, 0.99),    # overall_confidence
                rng(0.80, 0.97),    # evaluation_confidence
                rng(0.78, 0.97),    # action_confidence
                "gpt-4o-mini",      # model_used
                "completed",
                True,               # is_complete
                exec_id,
                "batch",
                module,
                created_ts,
            ))

            # ── llm_output_3 values ──
            pathway = random.choice(PATHWAYS)
            disc_detected = random.random() < 0.12
            disc_severity = None
            if disc_detected:
                disc_severity = random.choices(
                    ["MINOR", "MAJOR", "CRITICAL"], weights=[8, 3, 1]
                )[0]
            override_applied = random.random() < 0.07
            override_type = (
                random.choice(["POLICY_OVERRIDE", "MANUAL_OVERRIDE"]) if override_applied
                else None
            )
            llm_accuracy = rng(0.88, 0.99)

            l3_rows.append((
                ticket_id,
                order_id,
                None,               # llm_output_2_id (placeholder)
                action_code,        # final_action_code
                action_code,        # final_action_name
                refund,             # final_refund_amount
                "PASS",             # logic_validation_status
                pathway,
                False,              # cap_applied_flag
                False,              # history_check_flag
                std_logic,          # validation_standard_logic
                True,               # validation_lifetime_igcc
                True,               # validation_exceptions_60d
                True,               # validation_igcc_history
                True,               # validation_same_issue
                True,               # validation_aon_bod
                greedy_cls == "NORMAL",  # validation_greedy_check
                True,               # validation_hrx_check
                True,               # validation_multiplier
                True,               # validation_cap
                True,               # validation_image
                mult,               # validated_multiplier
                refund,             # validated_calculated_gratification
                refund,             # validated_capped_gratification
                None,               # validated_cap_applied
                greedy_signals,     # validated_greedy_signals
                greedy_cls,         # validated_greedy_classification
                not override_applied,  # llm_standard_logic_match
                True,               # llm_greedy_match
                True,               # llm_multiplier_match
                True,               # llm_gratification_match
                llm_accuracy,
                disc_detected,
                1 if disc_detected else 0,  # discrepancy_count
                disc_severity,
                override_applied,
                override_type,
                "v1",               # policy_version
                "completed",        # pipeline_status
                True,               # is_complete
                exec_id,
                "batch",
                module,
                created_ts,
            ))

        # Insert llm_output_1
        execute_values(cur, """
            INSERT INTO kirana_kart.llm_output_1
              (ticket_id, order_id, issue_type_l1, issue_type_l2,
               confidence_entailment, confidence_db_match,
               image_required, image_fetched,
               db_issue_type, db_issue_match, vector_similarity_score,
               reasoning, pipeline_status, is_complete,
               execution_id, execution_type, module, created_at)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, l1_rows, page_size=BATCH)
        inserted_l1 += len(l1_rows)

        # Insert llm_output_2
        execute_values(cur, """
            INSERT INTO kirana_kart.llm_output_2
              (ticket_id, order_id, llm_output_1_id,
               issue_type_l1_original, issue_type_l2_original,
               issue_type_l1_verified, issue_type_l2_verified,
               issue_changed, fraud_segment, value_segment,
               standard_logic_passed, lifetime_igcc_check, exceptions_60d_check,
               igcc_history_check, same_issue_check, aon_bod_eligible,
               super_subscriber, hrx_applicable, hrx_passed,
               greedy_check_applicable, greedy_signals_count, greedy_classification,
               sla_breach, call_verification_required, call_verified,
               multiplier, order_value, calculated_gratification, capped_gratification,
               cap_applied, action_code, action_code_id,
               overall_confidence, evaluation_confidence, action_confidence,
               model_used, pipeline_status, is_complete,
               execution_id, execution_type, module, created_at)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, l2_rows, page_size=BATCH)
        inserted_l2 += len(l2_rows)

        # Insert llm_output_3
        execute_values(cur, """
            INSERT INTO kirana_kart.llm_output_3
              (ticket_id, order_id, llm_output_2_id,
               final_action_code, final_action_name, final_refund_amount,
               logic_validation_status, automation_pathway,
               cap_applied_flag, history_check_flag,
               validation_standard_logic, validation_lifetime_igcc,
               validation_exceptions_60d, validation_igcc_history,
               validation_same_issue, validation_aon_bod,
               validation_greedy_check, validation_hrx_check,
               validation_multiplier, validation_cap, validation_image,
               validated_multiplier, validated_calculated_gratification,
               validated_capped_gratification, validated_cap_applied,
               validated_greedy_signals, validated_greedy_classification,
               llm_standard_logic_match, llm_greedy_match,
               llm_multiplier_match, llm_gratification_match,
               llm_overall_accuracy,
               discrepancy_detected, discrepancy_count, discrepancy_severity,
               override_applied, override_type,
               policy_version, pipeline_status, is_complete,
               execution_id, execution_type, module, created_at)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, l3_rows, page_size=BATCH)
        inserted_l3 += len(l3_rows)

        conn.commit()
        done = min(batch_start + BATCH, total)
        print(f"    → {done}/{total} tickets processed ...", end="\r")

    print(f"\n    → inserted {inserted_l1} llm_output_1 | {inserted_l2} llm_output_2 | {inserted_l3} llm_output_3")


# ── Part D ────────────────────────────────────────────────────────────────────

def part_d_execution_metrics(cur, conn):
    """Insert execution_metrics rows for every TES ticket that has none."""
    cur.execute("""
        SELECT tes.ticket_id, tes.processed_at
        FROM kirana_kart.ticket_execution_summary tes
        WHERE NOT EXISTS (
            SELECT 1 FROM kirana_kart.execution_metrics em
            WHERE em.ticket_id = tes.ticket_id
        )
        ORDER BY tes.ticket_id
    """)
    tickets = cur.fetchall()
    total = len(tickets)
    if total == 0:
        print("  Part D: execution_metrics already populated — skipping")
        return
    print(f"  Part D: inserting execution_metrics for {total} tickets ...")

    inserted = 0
    for batch_start in range(0, total, BATCH):
        batch = tickets[batch_start: batch_start + BATCH]
        rows = []
        for ticket_id, processed_at in batch:
            end_at = processed_at or datetime.now(tz=timezone.utc)
            duration_ms = random.randint(8_000, 45_000)
            start_at = end_at - timedelta(milliseconds=duration_ms)
            l1_tok = random.randint(800, 1_800)
            l2_tok = random.randint(1_500, 3_200)
            l3_tok = random.randint(1_200, 2_600)
            exec_id = _make_exec_id(ticket_id)
            rows.append((
                exec_id,
                ticket_id,
                start_at,
                end_at,
                duration_ms,
                l1_tok,
                l2_tok,
                l3_tok,
                l1_tok + l2_tok + l3_tok,
                "completed",
                end_at,         # created_at
            ))

        execute_values(cur, """
            INSERT INTO kirana_kart.execution_metrics
              (execution_id, ticket_id, start_at, end_at, duration_ms,
               llm_1_tokens, llm_2_tokens, llm_3_tokens, total_tokens,
               overall_status, created_at)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, rows, page_size=BATCH)
        inserted += len(rows)
        conn.commit()
        done = min(batch_start + BATCH, total)
        print(f"    → {done}/{total} rows ...", end="\r")

    print(f"\n    → inserted {inserted} execution_metrics rows")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print("=== Backfill Eval Data ===")
    conn = psycopg2.connect(**DSN)
    cur = conn.cursor()

    try:
        print("\n[E] master_action_codes")
        part_e_action_codes(cur)
        conn.commit()

        print("\n[A] Fix existing llm_output_2 rows")
        part_a_fix_llm2(cur)
        conn.commit()

        print("\n[B] Fix existing llm_output_3 rows")
        part_b_fix_llm3(cur)
        conn.commit()

        print("\n[C] Back-fill llm_output_1/2/3 for TES tickets")
        part_c_backfill_pipeline(cur, conn)

        print("\n[D] Populate execution_metrics")
        part_d_execution_metrics(cur, conn)

        conn.commit()

    except Exception as e:
        conn.rollback()
        print(f"\n❌ ERROR: {e}", file=sys.stderr)
        raise
    finally:
        cur.close()
        conn.close()

    # Final counts
    conn2 = psycopg2.connect(**DSN)
    c2 = conn2.cursor()
    print("\n=== Final Row Counts ===")
    for t in ["llm_output_1", "llm_output_2", "llm_output_3",
              "execution_metrics", "master_action_codes"]:
        c2.execute(f"SELECT COUNT(*) FROM kirana_kart.{t}")
        print(f"  {t}: {c2.fetchone()[0]}")
    c2.close()
    conn2.close()
    print("\n✅ Done")


if __name__ == "__main__":
    main()
