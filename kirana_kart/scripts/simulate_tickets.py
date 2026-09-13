from __future__ import annotations

import argparse
import json
import os
import random
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor
import requests


ISSUES = [
    ("WISMO", "delivery", "Order delayed", "My order is delayed. Please help."),
    ("Missing Item", "quality", "Missing item in delivery", "One item is missing from my order."),
    ("Wrong Item", "quality", "Wrong item delivered", "I received the wrong item."),
    ("Damaged Item", "quality", "Items arrived damaged", "The items were damaged on arrival."),
    ("Refund Status", "payment", "Refund status update", "Please update me on my refund status."),
    ("Late Delivery", "delivery", "Order delivered late", "The order was delivered late."),
]

SEGMENT_BUSINESS_LINE = {
    "swiggy": "ecommerce",
    "zomato": "ecommerce",
    "blinkit": "fmcg",
    "zepto": "ecommerce",
    "instamart": "fmcg",
    "dunzo": "ecommerce",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Simulate 100 tickets via /cardinal/ingest.")
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--unknown-cases", type=int, default=2)
    parser.add_argument("--seed", type=int, default=7)
    return parser.parse_args()


def _get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "orgintelligence"),
        user=os.getenv("DB_USER", "orguser"),
        password=os.getenv("DB_PASSWORD", "REDACTED"),
    )


def _fetch_orders(conn, count: int):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT o.order_id, o.customer_id, o.order_value, c.email, c.segment
            FROM kirana_kart.orders o
            JOIN kirana_kart.customers c ON c.customer_id = o.customer_id
            ORDER BY random()
            LIMIT %s
            """,
            (count,),
        )
        return list(cur.fetchall())


def main() -> None:
    args = parse_args()
    random.seed(args.seed)

    ingest_url = os.getenv("INGEST_BASE_URL", "http://ingest:8000").rstrip("/")
    token = os.getenv("ADMIN_TOKEN", "local_admin_token")

    conn = _get_connection()
    try:
        orders = _fetch_orders(conn, max(1, args.count - args.unknown_cases))
    finally:
        conn.close()

    payloads = []
    issue_cycle = [ISSUES[i % len(ISSUES)] for i in range(len(orders))]
    for row, issue in zip(orders, issue_cycle):
        issue_name, module, subject, description = issue
        business_line = SEGMENT_BUSINESS_LINE.get(row["segment"], "ecommerce")
        payloads.append(
            {
                "channel": "api",
                "source": "api",
                "org": "KiranaKart",
                "business_line": business_line,
                "module": module,
                "payload": {
                    "cx_email": row["email"],
                    "customer_id": row["customer_id"],
                    "order_id": row["order_id"],
                    "subject": f"{subject} ({issue_name})",
                    "description": f"{description} Order ID: {row['order_id']}",
                },
            }
        )

    # Unknown order_id case (valid customer)
    if args.unknown_cases >= 1 and orders:
        row = orders[0]
        payloads.append(
            {
                "channel": "api",
                "source": "api",
                "org": "KiranaKart",
                "business_line": SEGMENT_BUSINESS_LINE.get(row["segment"], "ecommerce"),
                "module": "delivery",
                "payload": {
                    "cx_email": row["email"],
                    "customer_id": row["customer_id"],
                    "order_id": "ORDUNKNOWN000000",
                    "subject": "Unknown order id",
                    "description": "Order ID not found in system.",
                },
            }
        )

    # Unknown customer_id case (valid order)
    if args.unknown_cases >= 2 and orders:
        row = orders[1]
        payloads.append(
            {
                "channel": "api",
                "source": "api",
                "org": "KiranaKart",
                "business_line": SEGMENT_BUSINESS_LINE.get(row["segment"], "ecommerce"),
                "module": "delivery",
                "payload": {
                    "cx_email": "unknown.customer@example.com",
                    "customer_id": "CUST999999",
                    "order_id": row["order_id"],
                    "subject": "Unknown customer id",
                    "description": f"Customer ID not found. Order ID: {row['order_id']}",
                },
            }
        )

    headers = {"Authorization": f"Bearer {token}"}
    results = []

    for payload in payloads:
        resp = requests.post(f"{ingest_url}/cardinal/ingest", json=payload, headers=headers, timeout=30)
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text}
        results.append(
            {
                "status": resp.status_code,
                "payload": payload,
                "response": body,
            }
        )

    logs_dir = Path(__file__).resolve().parents[1] / "logs"
    logs_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"sim_ticket_run_{ts}.json"
    log_latest = logs_dir / "sim_ticket_run_latest.json"
    log_path.write_text(json.dumps(results, indent=2))
    log_latest.write_text(json.dumps(results, indent=2))

    print(f"Submitted {len(results)} tickets.")
    print(f"Log: {log_path}")


if __name__ == "__main__":
    main()
