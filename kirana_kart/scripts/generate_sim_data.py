from __future__ import annotations

import argparse
import os
import random
import string
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Iterable

import psycopg2
from psycopg2.extras import execute_values, Json


SEGMENTS = [
    ("swiggy", 0.25),
    ("zomato", 0.20),
    ("blinkit", 0.20),
    ("zepto", 0.15),
    ("instamart", 0.10),
    ("dunzo", 0.10),
]

SEGMENT_ORDER_WEIGHT = {
    "swiggy": 1.6,
    "zomato": 1.1,
    "blinkit": 1.1,
    "zepto": 1.0,
    "instamart": 0.9,
    "dunzo": 0.7,
}

SEGMENT_BUSINESS_LINE = {
    "swiggy": "ecommerce",
    "zomato": "ecommerce",
    "blinkit": "fmcg",
    "zepto": "ecommerce",
    "instamart": "fmcg",
    "dunzo": "ecommerce",
}

ISSUE_TYPES = [
    ("WISMO", 0.40),
    ("Missing Item", 0.20),
    ("Damaged Item", 0.12),
    ("Wrong Item", 0.18),
    ("Refund Status", 0.10),
]

REFUND_REASONS = [
    ("missing item", 0.35),
    ("damaged item", 0.20),
    ("late delivery", 0.25),
    ("wrong item", 0.20),
]

ACTION_MAP = {
    "WISMO": ("TRACK_ORDER", "info"),
    "Missing Item": ("REFUND_PARTIAL", "refund"),
    "Damaged Item": ("REFUND_PARTIAL", "refund"),
    "Wrong Item": ("REFUND_FULL", "refund"),
    "Refund Status": ("REFUND_STATUS", "info"),
    "Late Delivery": ("APOLOGY_COUPON", "compensation"),
}

SUBJECTS = {
    "WISMO": "Where is my order?",
    "Missing Item": "Missing item in my delivery",
    "Damaged Item": "Items arrived damaged",
    "Wrong Item": "Wrong item delivered",
    "Refund Status": "Refund status update",
    "Late Delivery": "Order delivered late",
}

DESCRIPTIONS = {
    "WISMO": "My order is delayed. Please provide an update.",
    "Missing Item": "One or more items are missing from my order.",
    "Damaged Item": "The items delivered were damaged.",
    "Wrong Item": "I received the wrong item in my order.",
    "Refund Status": "I want to know the status of my refund.",
    "Late Delivery": "The order was delivered later than expected.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate synthetic Kirana Kart data.")
    parser.add_argument("--customers", type=int, default=25_000)
    parser.add_argument("--orders", type=int, default=100_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mode", choices=["reset", "append"], default="reset")
    parser.add_argument("--ticket-rate", type=float, default=0.135)
    parser.add_argument("--refund-rate", type=float, default=0.045)
    return parser.parse_args()


def db_conn():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "orgintelligence"),
        user=os.getenv("DB_USER", "orguser"),
        password=os.getenv("DB_PASSWORD", "REDACTED"),
    )


def weighted_choice(options: Iterable[tuple[str, float]]) -> str:
    labels, weights = zip(*options)
    return random.choices(labels, weights=weights, k=1)[0]


def random_phone() -> str:
    return "9" + "".join(random.choice(string.digits) for _ in range(9))


def random_email(segment: str, idx: int) -> str:
    return f"{segment}.{idx:06d}@example.com"


def random_dob() -> datetime.date:
    year = random.randint(1970, 2004)
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return datetime(year, month, day).date()


def random_signup_date(now: datetime) -> datetime:
    days_ago = random.randint(1, 730)
    return now - timedelta(days=days_ago, hours=random.randint(0, 23))


def pick_order_value() -> float:
    bucket = random.random()
    if bucket < 0.30:
        return round(random.uniform(100, 300), 2)
    if bucket < 0.75:
        return round(random.uniform(300, 700), 2)
    if bucket < 0.95:
        return round(random.uniform(700, 1500), 2)
    return round(random.uniform(1500, 3500), 2)


def pick_order_time(segment: str, now: datetime) -> datetime:
    start = now - timedelta(days=365)
    days_offset = random.randint(0, 364)
    date = start + timedelta(days=days_offset)

    weekday = date.weekday()
    weekend_boost = 1.3 if weekday >= 5 else 1.0
    if random.random() > weekend_boost:
        date += timedelta(days=random.randint(-1, 1))

    hour_weights = [1] * 24
    for h in range(18, 23):
        hour_weights[h] = 4
    for h in range(11, 14):
        hour_weights[h] = 2
    for h in range(0, 3):
        hour_weights[h] = 2
    if segment == "zepto":
        for h in range(22, 24):
            hour_weights[h] = 5
        for h in range(0, 2):
            hour_weights[h] = 5

    hour = random.choices(range(24), weights=hour_weights, k=1)[0]
    minute = random.randint(0, 59)
    second = random.randint(0, 59)
    return datetime(date.year, date.month, date.day, hour, minute, second, tzinfo=timezone.utc)


def estimate_delivery(created_at: datetime, segment: str) -> tuple[datetime, datetime, bool]:
    base_min = random.randint(18, 35) if segment in {"blinkit", "zepto"} else random.randint(22, 45)
    estimated = created_at + timedelta(minutes=base_min)

    breach_target = random.random() < random.uniform(0.08, 0.12)
    if breach_target:
        delay = random.randint(6, 30)
    else:
        delay = random.randint(-3, 3)

    actual = estimated + timedelta(minutes=delay)
    sla_breach = actual > estimated + timedelta(minutes=5)
    return estimated, actual, sla_breach


def delivery_events(order_id: str, created_at: datetime, estimated: datetime, actual: datetime) -> list[tuple]:
    events = []
    events.append(("order_created", created_at))
    events.append(("order_packed", created_at + timedelta(minutes=random.randint(4, 10))))
    events.append(("rider_assigned", created_at + timedelta(minutes=random.randint(8, 14))))
    events.append(("rider_pickup", created_at + timedelta(minutes=random.randint(12, 18))))
    events.append(("rider_arrived", max(created_at + timedelta(minutes=20), estimated - timedelta(minutes=5))))
    events.append(("delivered", actual))
    return [(order_id, ts, event, {"order_id": order_id, "event": event}) for event, ts in events]


def build_ticket(issue: str, order_value: float, sla_breach: bool) -> tuple[str, str, str, float]:
    if issue == "WISMO" and sla_breach:
        issue = "Late Delivery"
    action_code, action_category = ACTION_MAP.get(issue, ("TRACK_ORDER", "info"))
    refund_amount = 0.0
    if action_category in {"refund", "compensation"}:
        refund_amount = round(order_value * random.uniform(0.2, 1.0), 2)
    return issue, action_code, action_category, refund_amount


def main() -> None:
    args = parse_args()
    random.seed(args.seed)

    now = datetime.now(timezone.utc)

    conn = db_conn()
    conn.autocommit = False
    cur = conn.cursor()

    if args.mode == "reset":
        cur.execute(
            """
            TRUNCATE TABLE
              kirana_kart.delivery_events,
              kirana_kart.refunds,
              kirana_kart.csat_responses,
              kirana_kart.conversation_turns,
              kirana_kart.conversations,
              kirana_kart.dm_ticket_execution_summary,
              kirana_kart.ticket_execution_summary,
              kirana_kart.fdraw,
              kirana_kart.simulation_tickets,
              kirana_kart.orders,
              kirana_kart.customers
            RESTART IDENTITY CASCADE
            """
        )

    customers = []
    segment_counts = defaultdict(int)
    for idx in range(1, args.customers + 1):
        segment = weighted_choice(SEGMENTS)
        segment_counts[segment] += 1
        customer_id = f"CUST{idx:06d}"
        customers.append(
            (
                customer_id,
                random_email(segment, idx),
                random_phone(),
                random_dob(),
                random_signup_date(now),
                True,
                0,
                round(random.uniform(0.5, 5.0), 2),
                segment,
                round(random.uniform(0.02, 0.45), 3),
                "v1",
                now,
            )
        )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.customers
        (customer_id, email, phone, date_of_birth, signup_date, is_active,
         lifetime_order_count, lifetime_igcc_rate, segment, customer_churn_probability,
         churn_model_version, churn_last_updated)
        VALUES %s
        """,
        customers,
        page_size=2000,
    )

    customer_ids = [c[0] for c in customers]
    customer_segment = {c[0]: c[8] for c in customers}

    orders = []
    delivery_rows = []
    customer_order_count = defaultdict(int)

    order_id_seq = 1
    total_orders = args.orders
    base_orders = min(args.customers, total_orders)

    def pick_customer(weighted: bool) -> str:
        if not weighted:
            return customer_ids[order_id_seq % len(customer_ids)]
        weights = [SEGMENT_ORDER_WEIGHT[customer_segment[cid]] for cid in customer_ids]
        return random.choices(customer_ids, weights=weights, k=1)[0]

    for _ in range(base_orders):
        cid = pick_customer(False)
        segment = customer_segment[cid]
        created_at = pick_order_time(segment, now)
        order_value = pick_order_value()
        estimated, actual, sla_breach = estimate_delivery(created_at, segment)
        order_id = f"ORD{created_at.strftime('%Y%m')}{order_id_seq:06d}"
        order_id_seq += 1
        orders.append(
            (
                order_id,
                cid,
                order_value,
                estimated,
                actual,
                sla_breach,
                created_at,
                created_at,
            )
        )
        customer_order_count[cid] += 1
        delivery_rows.extend(delivery_events(order_id, created_at, estimated, actual))

    for _ in range(total_orders - base_orders):
        cid = pick_customer(True)
        segment = customer_segment[cid]
        created_at = pick_order_time(segment, now)
        order_value = pick_order_value()
        estimated, actual, sla_breach = estimate_delivery(created_at, segment)
        order_id = f"ORD{created_at.strftime('%Y%m')}{order_id_seq:06d}"
        order_id_seq += 1
        orders.append(
            (
                order_id,
                cid,
                order_value,
                estimated,
                actual,
                sla_breach,
                created_at,
                created_at,
            )
        )
        customer_order_count[cid] += 1
        delivery_rows.extend(delivery_events(order_id, created_at, estimated, actual))

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.orders
        (order_id, customer_id, order_value, delivery_estimated, delivery_actual,
         sla_breach, created_at, updated_at)
        VALUES %s
        """,
        orders,
        page_size=2000,
    )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.delivery_events
        (order_id, event_time, event_type, details)
        VALUES %s
        """,
        [(o_id, ts, event, Json(details)) for (o_id, ts, event, details) in delivery_rows],
        page_size=4000,
    )

    for cid, count in customer_order_count.items():
        cur.execute(
            "UPDATE kirana_kart.customers SET lifetime_order_count = %s WHERE customer_id = %s",
            (count, cid),
        )

    ticket_count = int(total_orders * args.ticket_rate)
    refund_count_target = int(total_orders * args.refund_rate)

    sampled_orders = random.sample(orders, ticket_count)

    ticket_id_start = 1
    cur.execute("SELECT COALESCE(MAX(ticket_id), 0) FROM kirana_kart.fdraw")
    ticket_id_start = (cur.fetchone()[0] or 0) + 1

    fdraw_rows = []
    conversations = []
    dm_summary = []
    ticket_summary = []
    sim_tickets = []
    refunds = []
    csat = []

    refund_issued = 0
    conversation_id = 1
    cur.execute("SELECT COALESCE(MAX(conversation_id), 0) FROM kirana_kart.conversations")
    conversation_id = (cur.fetchone()[0] or 0) + 1

    for order in sampled_orders:
        order_id, customer_id, order_value, estimated, actual, sla_breach, created_at, _ = order
        issue = weighted_choice(ISSUE_TYPES)
        issue, action_code, action_category, refund_amount = build_ticket(issue, float(order_value), sla_breach)

        ticket_id = ticket_id_start
        ticket_id_start += 1

        subject = SUBJECTS.get(issue, SUBJECTS["WISMO"])
        description = DESCRIPTIONS.get(issue, DESCRIPTIONS["WISMO"])
        module = "delivery" if issue in {"WISMO", "Late Delivery"} else "quality"

        fdraw_rows.append(
            (
                ticket_id,
                "GRP-OPS",
                "operations",
                random_email("customer", ticket_id),
                0,
                subject,
                description,
                created_at + timedelta(hours=random.randint(1, 24)),
                created_at + timedelta(hours=random.randint(1, 48)),
                "simulated",
                "SIM",
                0,
                0,
                1,
                created_at + timedelta(hours=random.randint(1, 24)),
                "NEW",
                "api",
                None,
                f"thread-{ticket_id}",
                random.randint(1, 5),
                module,
                Json({"order_id": order_id, "customer_id": customer_id, "issue": issue}),
                "en",
                "v1",
                f"{subject} {description}",
                None,
            )
        )

        conversations.append(
            (
                ticket_id,
                order_id,
                customer_id,
                random.choice(["email", "chat", "voice", "api"]),
                None,
                created_at + timedelta(hours=random.randint(1, 12)),
                None,
                random.random() < 0.6,
                action_code,
            )
        )

        dm_summary.append(
            (
                ticket_id,
                order_id,
                customer_id,
                f"exec_{ticket_id}",
                "simulation",
                issue,
                None,
                action_code,
                refund_amount,
                random.random() < 0.7,
                sla_breach,
                random.choice([3, 4, 5]),
                created_at + timedelta(hours=random.randint(2, 36)),
            )
        )

        ticket_summary.append(
            (
                ticket_id,
                order_id,
                customer_id,
                issue,
                None,
                action_code,
                action_category,
                refund_amount,
                random.random() < 0.7,
                sla_breach,
                random.choice([3, 4, 5]),
                created_at + timedelta(hours=random.randint(2, 36)),
                "v1",
                None,
            )
        )

        sim_tickets.append(
            (
                str(ticket_id),
                issue,
                float(order_value),
                round(random.uniform(0.0, 0.2), 3),
                random.choice(["bronze", "silver", "gold", "platinum"]),
                SEGMENT_BUSINESS_LINE.get(customer_segment[customer_id], "ecommerce"),
            )
        )

        if refund_amount > 0 and refund_issued < refund_count_target:
            refund_reason = weighted_choice(REFUND_REASONS)
            refunds.append(
                (
                    ticket_id,
                    order_id,
                    refund_amount,
                    action_code,
                    refund_reason,
                    "automation",
                    created_at + timedelta(hours=random.randint(6, 72)),
                )
            )
            refund_issued += 1

        if random.random() < 0.35:
            csat.append(
                (
                    ticket_id,
                    random.choice([3, 4, 5]) if refund_amount > 0 else random.choice([2, 3, 4]),
                    "Auto-generated CSAT response",
                    created_at + timedelta(hours=random.randint(24, 120)),
                )
            )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.fdraw
        (ticket_id, group_id, group_name, cx_email, status, subject, description,
         created_at, updated_at, tags, code, img_flg, attachment, processed, ts,
         pipeline_stage, source, connector_id, thread_id, message_count, module,
         canonical_payload, detected_language, preprocessing_version, preprocessed_text, preprocessing_hash)
        VALUES %s
        """,
        fdraw_rows,
        page_size=2000,
    )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.conversations
        (ticket_id, order_id, customer_id, channel, agent_id, opened_at, closed_at, fcr, resolution_code)
        VALUES %s
        """,
        conversations,
        page_size=2000,
    )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.dm_ticket_execution_summary
        (ticket_id, order_id, customer_id, execution_id, execution_mode,
         final_issue_type_l1, final_issue_type_l2, final_action_code, final_refund_amount,
         fcr_flag, sla_breach_flag, csat_rating, created_at)
        VALUES %s
        """,
        dm_summary,
        page_size=2000,
    )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.ticket_execution_summary
        (ticket_id, order_id, customer_id, issue_l1, issue_l2, applied_action_code,
         action_category, final_refund_amount, fcr, sla_breach, csat_rating, processed_at,
         policy_version, policy_artifact_hash)
        VALUES %s
        """,
        ticket_summary,
        page_size=2000,
    )

    execute_values(
        cur,
        """
        INSERT INTO kirana_kart.simulation_tickets
        (ticket_id, issue_type, order_value, fraud_score, customer_tier, business_line)
        VALUES %s
        """,
        sim_tickets,
        page_size=2000,
    )

    if refunds:
        execute_values(
            cur,
            """
            INSERT INTO kirana_kart.refunds
            (ticket_id, order_id, refund_amount, applied_action_code, refund_reason, refund_source, processed_at)
            VALUES %s
            """,
            refunds,
            page_size=2000,
        )

    if csat:
        execute_values(
            cur,
            """
            INSERT INTO kirana_kart.csat_responses
            (ticket_id, rating, feedback, created_at)
            VALUES %s
            """,
            csat,
            page_size=2000,
        )

    conn.commit()
    cur.close()
    conn.close()

    print(f"Inserted {len(customers)} customers, {len(orders)} orders.")
    print(f"Inserted {len(delivery_rows)} delivery events.")
    print(f"Inserted {len(fdraw_rows)} tickets, {len(refunds)} refunds.")


if __name__ == "__main__":
    main()
