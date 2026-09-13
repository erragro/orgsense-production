#!/usr/bin/env python3
"""
Kirana Kart Synthetic Data Simulation
======================================
Creates:
  - 100 synthetic customers (varied platforms, risk profiles, LTV tiers)
  - 500 tickets via Cardinal ingest API (all issue types, varied routing outcomes)
  - Assigns HITL/MANUAL_REVIEW queue entries to the 3 CRM groups

Prerequisites:
  kubectl port-forward -n auralis svc/postgres 5432:5432 &

Usage:
  cd /Users/apple/Documents/kirana_kart_final
  python simulation/run_simulation.py

Cost note:
  500 tickets × ~3 LLM calls each ≈ 1500 GPT API calls.
  Most are gpt-4o-mini (cheap); complex cases use gpt-4.1.
  Estimated: ~$4–8 total.
"""

from __future__ import annotations

import json
import logging
import random
import sys
import time
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kirana_kart"))
from datetime import datetime, timedelta, timezone

import psycopg2
import requests
from psycopg2.extras import execute_values

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("simulation")

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

import os

DB_CONFIG = dict(
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", "5432")),
    dbname=os.getenv("DB_NAME", "orgintelligence"),
    user=os.getenv("DB_USER", "orguser"),
    password=os.getenv("DB_PASSWORD", "REDACTED"),
)
DB_SCHEMA = "kirana_kart"

# Inside GKE pods use internal service URL; from laptop use public URL
INGEST_URL = os.getenv(
    "INGEST_URL",
    "http://ingest:8000/cardinal/ingest",
)
CALL_DELAY = 0.4          # seconds between ingest API calls (avoid rate-limit)
BATCH_SIZE  = 50          # log progress every N tickets

random.seed(42)            # reproducible run


# ─────────────────────────────────────────────────────────────────────────────
# CUSTOMER DATA DEFINITIONS
# ─────────────────────────────────────────────────────────────────────────────

PLATFORMS = ["swiggy", "zomato", "blinkit", "zepto", "instamart", "dunzo"]

# (order_count_min, max), (igcc_rate_min, max), (churn_prob_min, max), is_active, count
PROFILES: dict[str, tuple] = {
    "vip":     ((80,  250), (0.00, 0.04), (0.03, 0.18), True,  10),
    "gold":    ((25,   80), (0.03, 0.12), (0.10, 0.30), True,  20),
    "silver":  ((8,    25), (0.08, 0.22), (0.20, 0.45), True,  32),
    "bronze":  ((1,     8), (0.02, 0.10), (0.30, 0.60), True,  20),
    "fraud":   ((10,   60), (0.38, 0.68), (0.40, 0.72), True,  12),
    "churned": ((5,    20), (0.10, 0.28), (0.72, 0.95), True,   3),
    "blocked": ((3,    15), (0.52, 0.92), (0.80, 1.00), False,  3),
}
# total: 10+20+32+20+12+3+3 = 100

FIRST_NAMES = [
    "Aditya","Priya","Rahul","Kavya","Nikhil","Sneha","Arjun","Pooja","Vijay","Meera",
    "Rohan","Divya","Kiran","Nisha","Suresh","Anita","Manish","Rekha","Deepak","Sonia",
    "Amit","Neha","Sanjay","Poornima","Harish","Madhuri","Girish","Lakshmi","Satish","Indira",
    "Ravi","Sunita","Manoj","Champa","Sunil","Geeta","Vinod","Leela","Umesh","Shobha",
    "Prakash","Savita","Ramesh","Kumari","Naveen","Saroja","Mohan","Vimala","Ganesh","Parvati",
]
LAST_NAMES = [
    "Kumar","Sharma","Patel","Reddy","Gupta","Singh","Verma","Rao","Joshi","Nair",
    "Mehta","Agarwal","Pillai","Iyer","Desai","Shah","Kaur","Bose","Das","Mishra",
]


def _rand_email(name: str, cid: str) -> str:
    domain = random.choice(["gmail.com", "yahoo.co.in", "outlook.com", "rediffmail.com"])
    slug = name.lower().replace(" ", ".") + str(random.randint(10, 99))
    return f"{slug}@{domain}"


def _rand_phone() -> str:
    return "9" + "".join(str(random.randint(0, 9)) for _ in range(9))


def _rand_date(start_years_ago: int, end_years_ago: int) -> str:
    start = datetime.now(timezone.utc) - timedelta(days=start_years_ago * 365)
    end   = datetime.now(timezone.utc) - timedelta(days=end_years_ago * 365)
    delta = int((end - start).total_seconds())
    return (start + timedelta(seconds=random.randint(0, max(0, delta)))).strftime("%Y-%m-%d")


def generate_customers() -> list[dict]:
    customers = []
    idx = 0
    for profile, (order_range, igcc_range, churn_range, is_active, count) in PROFILES.items():
        for _ in range(count):
            idx += 1
            fn = FIRST_NAMES[idx % len(FIRST_NAMES)]
            ln = LAST_NAMES[idx % len(LAST_NAMES)]
            name = f"{fn} {ln}"
            cid  = f"CUST-SIM-{idx:04d}"
            platform = PLATFORMS[(idx - 1) % len(PLATFORMS)]

            customers.append({
                "customer_id":              cid,
                "email":                    _rand_email(name, cid),
                "phone":                    _rand_phone(),
                "date_of_birth":            _rand_date(50, 18),
                "signup_date":              _rand_date(4, 0),
                "is_active":                is_active,
                "lifetime_order_count":     random.randint(*order_range),
                "lifetime_igcc_rate":       round(random.uniform(*igcc_range), 4),
                "segment":                  platform,
                "customer_churn_probability": round(random.uniform(*churn_range), 4),
                "churn_model_version":      "v1.2",
                "churn_last_updated":       datetime.now(timezone.utc).isoformat(),
                # --- extra context used at ticket-generation time ---
                "_profile":                 profile,
                "_name":                    name,
            })
    random.shuffle(customers)
    return customers


def insert_customers(conn, customers: list[dict]) -> None:
    from app.utils.customer_pii import protect_customer
    customers = [protect_customer(c) for c in customers]
    rows = [
        (
            c["customer_id"], c["email"], c["phone"],
            c["date_of_birth"], c["signup_date"], c["email_blind_index"],
            c["is_active"],
            c["lifetime_order_count"], c["lifetime_igcc_rate"],
            c["segment"],
            c["customer_churn_probability"],
            c["churn_model_version"], c["churn_last_updated"],
        )
        for c in customers
    ]
    sql = f"""
        INSERT INTO {DB_SCHEMA}.customers (
            customer_id, email, phone, date_of_birth, signup_date, email_blind_index,
            is_active, lifetime_order_count, lifetime_igcc_rate, segment,
            customer_churn_probability, churn_model_version, churn_last_updated
        ) VALUES %s
        ON CONFLICT (customer_id) DO UPDATE SET
            email                    = EXCLUDED.email,
            email_blind_index         = EXCLUDED.email_blind_index,
            date_of_birth             = EXCLUDED.date_of_birth,
            phone                    = EXCLUDED.phone,
            is_active                = EXCLUDED.is_active,
            lifetime_order_count     = EXCLUDED.lifetime_order_count,
            lifetime_igcc_rate       = EXCLUDED.lifetime_igcc_rate,
            segment                  = EXCLUDED.segment,
            customer_churn_probability = EXCLUDED.customer_churn_probability,
            churn_model_version      = EXCLUDED.churn_model_version,
            churn_last_updated       = EXCLUDED.churn_last_updated
    """
    with conn.cursor() as cur:
        execute_values(cur, sql, rows)
    conn.commit()
    log.info("Inserted / upserted %d customers", len(rows))


def get_crm_groups(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, name, group_type FROM {DB_SCHEMA}.crm_groups WHERE is_active = TRUE ORDER BY id"
        )
        rows = cur.fetchall()
    groups = [{"id": r[0], "name": r[1], "group_type": r[2]} for r in rows]
    log.info("Found %d active CRM groups: %s", len(groups), [g["name"] for g in groups])
    return groups


def _pick_group(groups: list[dict], queue_type: str) -> int | None:
    """Map queue_type to the best matching CRM group."""
    if not groups:
        return None

    queue_upper = queue_type.upper()

    # Priority order: exact type match → partial name match → first group
    type_map = {
        "ESCALATION_QUEUE":   ["ESCALATION", "FRAUD"],
        "SENIOR_REVIEW":      ["SENIOR", "ESCALATION"],
        "SLA_BREACH_REVIEW":  ["SENIOR", "ESCALATION"],
        "MANUAL_REVIEW":      ["FRAUD", "MANUAL", "REVIEW"],
        "STANDARD_REVIEW":    ["SUPPORT", "STANDARD"],
    }
    keywords = type_map.get(queue_upper, ["SUPPORT"])

    for kw in keywords:
        for g in groups:
            if kw in g["name"].upper() or kw in g["group_type"].upper():
                return g["id"]

    # Fallback: round-robin across available groups
    return random.choice(groups)["id"]


# ─────────────────────────────────────────────────────────────────────────────
# TICKET SCENARIO LIBRARY
# ─────────────────────────────────────────────────────────────────────────────

# Each entry: (module, subject_template, description_template, weight)
# {name} → customer name, {platform} → delivery app
SCENARIOS = [
    # ── DELIVERY ISSUES (30%) ──
    ("delivery",
     "Order not delivered – requesting refund",
     "Hi, I placed an order on {platform} about 2 hours ago and it has not been delivered. "
     "The delivery partner's app shows delivered but I have not received anything. "
     "My address is correct and I was home the entire time. Please initiate a full refund.",
     30),

    ("delivery",
     "Order arrived 2 hours late – food completely ruined",
     "My order was placed at 7 PM and was promised by 7:45 PM. It arrived at 9:30 PM. "
     "All the food was cold and inedible. I am extremely disappointed and would like a refund "
     "as the food was completely ruined due to the late delivery.",
     22),

    ("delivery",
     "Wrong delivery address – package delivered to neighbour",
     "The delivery partner delivered my order to the wrong flat. I could see on the live tracking "
     "that they stopped two floors below mine. By the time I retrieved the food it was cold. "
     "Requesting partial compensation.",
     14),

    ("delivery",
     "Delivery partner cancelled after 45 min wait",
     "I waited for 45 minutes and then the delivery partner unilaterally cancelled my order. "
     "I had already paid online. Please refund the full amount including delivery charges.",
     18),

    ("delivery",
     "Order shows delivered but never received",
     "My order status shows delivered since 1 hour but I have not received it. "
     "Called delivery partner number – it's switched off. This is the third time this "
     "has happened with this partner. Please escalate and refund.",
     16),

    # ── FOOD QUALITY (22%) ──
    ("quality",
     "Food was spoiled / had foul smell on arrival",
     "I received my order and the food had a distinctly sour/off smell. "
     "I could not eat it and had to throw it away. This is a serious food safety issue. "
     "Requesting full refund and please flag the restaurant.",
     28),

    ("food_safety",
     "Found foreign object in food – hair/insect",
     "I found what appears to be a hair/insect in my biryani. This is completely unacceptable "
     "from a food safety standpoint. I have photos. I want a full refund and an explanation "
     "from the restaurant.",
     18),

    ("quality",
     "Food was severely undercooked – safety concern",
     "The chicken in my order was clearly undercooked and raw in the centre. "
     "I am very concerned about food safety. Please issue an immediate refund and "
     "take action against the restaurant.",
     15),

    ("quality",
     "Items tasted nothing like described – misleading menu",
     "The dish I ordered was described as 'mildly spiced' but it was extremely spicy "
     "and I could not eat it. My child also ate a bit and was in discomfort. "
     "Requesting refund for the inedible items.",
     19),

    ("quality",
     "Portion size drastically smaller than advertised",
     "The portion I received was barely 30% of what the menu photo showed. "
     "This is misleading advertising. I paid premium price for a full meal and received "
     "a starter-sized portion. Requesting partial refund.",
     20),

    # ── MISSING ITEMS (15%) ──
    ("delivery",
     "Multiple items missing from order",
     "I ordered a family meal deal (6 items) but received only 3. "
     "The missing items are: 2 portions of fries and 1 dessert. "
     "Requesting refund for the 3 missing items worth approximately ₹340.",
     35),

    ("delivery",
     "Entire side dish missing – only main course received",
     "I ordered dal makhani (₹180) and butter naan (₹80) but only the dal arrived. "
     "The delivery bag was sealed so the naan was never packed. "
     "Please refund ₹80 for the missing item.",
     30),

    ("delivery",
     "Drink missing from order – restaurant confirmed packing error",
     "My mango lassi (₹120) was missing from the order. I called the restaurant directly "
     "and they confirmed it was accidentally left out. Please process refund for the missing drink.",
     25),

    ("delivery",
     "Half the order items substituted without consent",
     "I ordered specific items but the restaurant substituted 2 of them without asking. "
     "I did not want the substitutes and they are now wasted. "
     "I want a refund for the original items.",
     10),

    # ── WRONG ITEMS (12%) ──
    ("quality",
     "Received completely wrong order",
     "I received someone else's order entirely. The items have different names printed "
     "on the stickers. I have a vegetarian diet and the items I received contain meat. "
     "This is very serious. Requesting immediate full refund.",
     30),

    ("quality",
     "Wrong variant delivered – ordered veg, received non-veg",
     "I clearly ordered the vegetarian version of the burger but received the chicken version. "
     "I am a strict vegetarian and could not eat this. Please refund and ensure this "
     "does not happen again.",
     35),

    ("quality",
     "Wrong size/quantity received",
     "I ordered the large combo (₹450) and received the regular size (₹280). "
     "I was charged for the large. Please either send the correct size or refund the difference.",
     20),

    ("quality",
     "Wrong restaurant's food delivered",
     "The food I received is from a completely different restaurant than what I ordered from. "
     "The bag even has another restaurant's logo. Please escalate to your delivery team and "
     "process a full refund.",
     15),

    # ── PAYMENT ISSUES (12%) ──
    ("payment",
     "Double charged for single order",
     "I was charged twice for my order #placeholder. My bank statement shows two deductions "
     "of the same amount within 2 minutes. The order was placed only once. "
     "Please refund the duplicate charge immediately.",
     28),

    ("payment",
     "Payment deducted but order not placed",
     "I paid ₹380 via UPI but the app showed an error. The money was deducted from my account "
     "but no order was created. This has been 3 days and the amount has not been refunded. "
     "Please investigate urgently.",
     30),

    ("payment",
     "Refund not received after 10 business days",
     "My previous order was cancelled and I was told the refund would arrive in 5-7 business days. "
     "It has now been 12 business days and nothing has been credited. "
     "Please expedite and share the transaction reference.",
     22),

    ("payment",
     "Promo code discount not applied at checkout",
     "I had a valid coupon code for 20% off but the discount was not applied at the time "
     "of payment even though the app accepted the code. I was charged the full amount. "
     "Please credit the discount amount.",
     12),

    ("payment",
     "Charged for cancelled order",
     "I cancelled my order within 2 minutes of placing it (before restaurant acceptance) "
     "but was still charged the full amount. The app says 'no charge for cancellation' "
     "but my account was debited. Please refund.",
     8),

    # ── RESTAURANT ISSUES (6%) ──
    ("quality",
     "Restaurant prepared hygiene complaint – found cockroach",
     "I found a cockroach in my food packaging. I have video evidence. "
     "This is a serious hygiene violation. I want a full refund, an apology, "
     "and I want to know what action you will take against this restaurant.",
     30),

    ("quality",
     "Restaurant repeatedly rejects orders without reason",
     "This is the 4th time in 2 weeks that this particular restaurant has accepted my order "
     "and then rejected it 20-30 minutes later. I waste time and sometimes the items "
     "are no longer available elsewhere. Please address this.",
     25),

    ("quality",
     "Restaurant substituted expensive item with cheaper one",
     "I ordered premium butter chicken (₹420) but received the economy version (₹220) "
     "without any notification. I was charged the premium price. "
     "Requesting refund of the ₹200 difference.",
     25),

    ("quality",
     "Restaurant sent stale/day-old food",
     "The food I received was clearly not freshly prepared. The bread was hard and stale, "
     "the curry had a skin on top suggesting it was reheated. I have photos. "
     "Full refund requested along with restaurant flagging.",
     20),

    # ── PLATFORM/ACCOUNT ISSUES (3%) ──
    ("operations",
     "App showing incorrect order history",
     "My order history is showing duplicate entries and some orders from months ago "
     "are showing as 'pending'. This is causing confusion with my refund tracking. "
     "Please fix the account data.",
     35),

    ("compliance",
     "Account hacked – unauthorized orders placed",
     "Someone has placed 3 orders from my account that I did not authorize. "
     "I have changed my password but the charges are still showing. "
     "Please reverse all 3 unauthorized transactions totalling ₹1,240.",
     35),

    ("operations",
     "Subscription/Gold membership auto-renewed without consent",
     "I did not consent to the auto-renewal of my premium membership. "
     "The ₹299 was deducted from my account without any prior notification. "
     "I want this cancelled and refunded.",
     30),
]

# Normalise scenario weights
_total_weight = sum(s[3] for s in SCENARIOS)
_CUM_WEIGHTS  = []
_cum = 0
for s in SCENARIOS:
    _cum += s[3] / _total_weight
    _CUM_WEIGHTS.append(_cum)


def _pick_scenario() -> tuple:
    r = random.random()
    for i, cw in enumerate(_CUM_WEIGHTS):
        if r <= cw:
            return SCENARIOS[i]
    return SCENARIOS[-1]


# ─────────────────────────────────────────────────────────────────────────────
# TICKET BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def _build_payload(customer: dict, module: str, subject_tpl: str, desc_tpl: str) -> dict:
    platform_display = {
        "swiggy": "Swiggy", "zomato": "Zomato", "blinkit": "Blinkit",
        "zepto": "Zepto", "instamart": "Instamart", "dunzo": "Dunzo",
    }.get(customer["segment"], customer["segment"].title())

    name = customer["_name"]
    profile = customer["_profile"]

    subject = subject_tpl
    desc    = desc_tpl.format(name=name, platform=platform_display)

    # Fraud-risk customers: embellish with suspicious patterns
    if profile == "fraud" and random.random() < 0.65:
        desc += (
            " Note: I have raised similar complaints before and they were resolved promptly. "
            "I expect the same treatment. Please process immediately without delay."
        )

    # VIP customers: assert priority
    if profile == "vip" and random.random() < 0.5:
        desc += (
            f" I am a long-standing premium customer who has been ordering on {platform_display} "
            "for over 3 years. I expect this to be handled as a priority."
        )

    # Churned customers: express frustration
    if profile == "churned" and random.random() < 0.7:
        desc += (
            " This is the last straw. If this is not resolved promptly I will be deleting "
            "my account and moving to a competitor permanently."
        )

    return {
        "channel":       "email",
        "source":        "gmail",
        "org":           "kirana_kart",
        "business_line": "ecommerce",
        "module":        module,
        "payload": {
            "customer_id": customer["customer_id"],
            "cx_email":    customer["email"],
            "subject":     subject,
            "description": desc,
            # Unique per submission — ensures each ticket gets a distinct
            # payload hash so Phase 2 dedup never collapses simulation tickets.
            "thread_id":   str(uuid.uuid4()),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# INGEST API CALLS
# ─────────────────────────────────────────────────────────────────────────────

def post_tickets(
    active_customers: list[dict],
    total: int = 500,
) -> dict[str, int]:
    """
    POST `total` tickets to the Cardinal ingest API.
    Returns counts of HTTP status codes.
    """
    stats: dict[str, int] = {}
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    log.info("Starting ticket ingestion — %d tickets to post", total)

    for i in range(1, total + 1):
        customer = random.choice(active_customers)
        module, subject_tpl, desc_tpl, _ = _pick_scenario()
        payload = _build_payload(customer, module, subject_tpl, desc_tpl)

        try:
            resp = session.post(INGEST_URL, json=payload, timeout=30)
            code = str(resp.status_code)
            stats[code] = stats.get(code, 0) + 1

            if i % BATCH_SIZE == 0 or i == total:
                log.info(
                    "  Progress: %d/%d  |  stats so far: %s",
                    i, total, stats,
                )

            if resp.status_code not in (200, 202, 202):
                log.warning(
                    "  Ticket %d — HTTP %s: %s (customer=%s)",
                    i, resp.status_code,
                    resp.text[:200],
                    customer["customer_id"],
                )

        except requests.RequestException as exc:
            log.error("  Ticket %d — network error: %s", i, exc)
            stats["network_error"] = stats.get("network_error", 0) + 1

        time.sleep(CALL_DELAY)

    return stats


# ─────────────────────────────────────────────────────────────────────────────
# CRM GROUP ASSIGNMENT
# ─────────────────────────────────────────────────────────────────────────────

def assign_crm_groups(conn, groups: list[dict]) -> int:
    """
    Assign all unassigned hitl_queue entries to CRM groups based on queue_type.
    Returns number of rows updated.
    """
    if not groups:
        log.warning("No CRM groups found — skipping group assignment")
        return 0

    with conn.cursor() as cur:
        # Fetch all unassigned queue entries
        cur.execute(
            f"""
            SELECT id, queue_type, automation_pathway
            FROM {DB_SCHEMA}.hitl_queue
            WHERE group_id IS NULL
              AND customer_id LIKE 'CUST-SIM-%'
            ORDER BY id
            """
        )
        rows = cur.fetchall()

    log.info("Assigning CRM groups to %d unassigned queue entries", len(rows))
    updated = 0

    with conn.cursor() as cur:
        for (qid, queue_type, pathway) in rows:
            gid = _pick_group(groups, queue_type or "STANDARD_REVIEW")
            if gid:
                cur.execute(
                    f"""
                    UPDATE {DB_SCHEMA}.hitl_queue
                    SET group_id = %s, updated_at = NOW()
                    WHERE id = %s
                    """,
                    (gid, qid),
                )
                updated += 1

    conn.commit()
    log.info("CRM group assignment complete — %d rows updated", updated)
    return updated


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    log.info("=" * 60)
    log.info("Kirana Kart Synthetic Data Simulation")
    log.info("=" * 60)

    # ── Step 1: Connect to DB ─────────────────────────────────
    log.info("Connecting to PostgreSQL at %s:%s …", DB_CONFIG["host"], DB_CONFIG["port"])
    try:
        conn = psycopg2.connect(**DB_CONFIG)
    except Exception as exc:
        log.error(
            "Cannot connect to DB: %s\n"
            "Run: kubectl port-forward -n auralis svc/postgres 5432:5432",
            exc,
        )
        sys.exit(1)
    log.info("DB connection OK")

    # ── Step 2: Generate + insert customers ──────────────────
    log.info("Generating 100 synthetic customers …")
    customers = generate_customers()
    log.info("Profile breakdown: %s",
             {p: sum(1 for c in customers if c["_profile"] == p) for p in PROFILES})
    insert_customers(conn, customers)

    # Active customers only for ticket submission
    active = [c for c in customers if c["is_active"]]
    log.info("%d active customers available for ticket submission", len(active))

    # ── Step 3: Fetch CRM groups ──────────────────────────────
    groups = get_crm_groups(conn)
    if not groups:
        log.warning("No CRM groups found. Tickets will still be posted but group_id will remain NULL.")

    # ── Step 4: Post 500 tickets ──────────────────────────────
    log.info("Starting ticket ingestion via %s", INGEST_URL)
    t_start = time.time()
    ingest_stats = post_tickets(active, total=500)
    elapsed = time.time() - t_start
    log.info("Ingestion complete in %.1fs — HTTP stats: %s", elapsed, ingest_stats)

    # ── Step 5: Wait for pipeline to process, then assign groups ─
    log.info("Waiting 15s for Cardinal pipeline to process queue entries …")
    time.sleep(15)

    assigned = assign_crm_groups(conn, groups)

    # ── Step 6: Summary ───────────────────────────────────────
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT
                automation_pathway,
                COUNT(*) AS count,
                AVG(priority) AS avg_priority
            FROM {DB_SCHEMA}.hitl_queue
            WHERE customer_id LIKE 'CUST-SIM-%'
            GROUP BY automation_pathway
            ORDER BY automation_pathway
        """)
        pathway_rows = cur.fetchall()

        cur.execute(f"""
            SELECT COUNT(*)
            FROM {DB_SCHEMA}.hitl_queue
            WHERE customer_id LIKE 'CUST-SIM-%'
              AND group_id IS NOT NULL
        """)
        grouped_count = cur.fetchone()[0]

    conn.close()

    log.info("")
    log.info("=" * 60)
    log.info("SIMULATION COMPLETE")
    log.info("=" * 60)
    log.info("Customers inserted : 100")
    log.info("Tickets submitted  : 500")
    log.info("HTTP 202 Accepted  : %s", ingest_stats.get("202", 0))
    log.info("HTTP 200 Duplicate : %s", ingest_stats.get("200", 0))
    log.info("HTTP errors        : %s", {k: v for k, v in ingest_stats.items() if k not in ("200", "202")})
    log.info("")
    log.info("Queue pathway breakdown (CUST-SIM-* only):")
    for row in pathway_rows:
        log.info("  %-20s  count=%-5d  avg_priority=%.1f", row[0] or "AUTO_RESOLVED", row[1], row[2] or 0)
    log.info("Queue entries with group assigned: %d", grouped_count)
    log.info("=" * 60)


if __name__ == "__main__":
    main()
