"""
simulate_100_tickets.py
=======================
Generates 100 realistic support tickets from the orders + customers tables
and submits them through the Cardinal pipeline via POST /cardinal/ingest.

Run inside the governance container:
    docker exec kirana_kart_final-governance-1 python3 /app/scripts/simulate_100_tickets.py
"""

import os
import random
import time
import requests
import psycopg2

# ── Config ────────────────────────────────────────────────────────────────────
DB_DSN = (
    f"host={os.getenv('DB_HOST','postgres')} "
    f"port={os.getenv('DB_PORT','5432')} "
    f"dbname={os.getenv('DB_NAME','orgintelligence')} "
    f"user={os.getenv('DB_USER','orguser')} "
    f"password={os.getenv('DB_PASSWORD','REDACTED')}"
)
INGEST_URL = os.getenv("INGEST_URL", "http://ingest:8000/cardinal/ingest")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "local_admin_token")
TICKET_COUNT = 100

# ── Ticket templates keyed by module ─────────────────────────────────────────
TICKET_TEMPLATES = [
    {
        "module": "delivery",
        "subjects": [
            "Order not delivered but marked as delivered",
            "Delivery delayed beyond estimated time",
            "Wrong delivery address — order sent elsewhere",
            "Partial delivery — some items missing from order",
            "Delivery partner unreachable and order not delivered",
        ],
        "descriptions": [
            "My order {order_id} worth ₹{value} was marked delivered on the app but I never received it. "
            "I was home all day. Please investigate and arrange a redeliver or full refund.",
            "Order {order_id} (₹{value}) was estimated to arrive by {eta} but is still not here. "
            "The delivery partner is unreachable. This is causing significant inconvenience.",
            "My order {order_id} was sent to the wrong address. The tracking shows delivered but "
            "I never received it. Please initiate a refund of ₹{value} immediately.",
            "I received order {order_id} but {num_missing} item(s) were missing from the sealed package. "
            "Please refund ₹{value} or reship the missing items.",
        ],
    },
    {
        "module": "quality",
        "subjects": [
            "Received damaged or spoiled items",
            "Items arrived with broken packaging",
            "Food quality extremely poor — not fresh",
            "Wrong items delivered in my order",
            "Item expired — past best before date",
        ],
        "descriptions": [
            "The items in order {order_id} arrived completely damaged. "
            "The packaging was torn and the product was unusable. Requesting full refund of ₹{value}.",
            "I received the wrong items in order {order_id} worth ₹{value}. "
            "I ordered groceries but received entirely different products. Please refund or resend.",
            "The food items in order {order_id} were clearly not fresh — foul smell and discoloured. "
            "This is a serious health concern. I want a full refund of ₹{value} immediately.",
            "Several items in order {order_id} had expired best-before dates. "
            "Selling expired products is unacceptable. Complete refund of ₹{value} required.",
        ],
    },
    {
        "module": "payment",
        "subjects": [
            "Charged twice for a single order",
            "Refund not received after cancellation",
            "Amount debited but order was not placed",
            "Incorrect amount charged for my order",
            "Cashback not credited to account",
        ],
        "descriptions": [
            "I was charged twice for order {order_id}. Both deductions of ₹{value} show on my bank statement. "
            "Please reverse the duplicate charge immediately.",
            "I cancelled order {order_id} on {date} and was promised a refund of ₹{value} within 5-7 days. "
            "Over 10 days have passed and I still have not received it.",
            "₹{value} was debited from my account but order {order_id} was never confirmed. "
            "Please refund this amount to my original payment method.",
            "I was charged ₹{value} for order {order_id} but the actual total after discount should have been lower. "
            "Please correct the billing and refund the difference.",
        ],
    },
    {
        "module": "operations",
        "subjects": [
            "Unable to cancel order through the app",
            "Order cancelled by platform without consent",
            "Cancellation fee charged unfairly",
            "Want to return a defective product",
            "Return amount not refunded after pickup",
        ],
        "descriptions": [
            "I need to cancel order {order_id} (₹{value}) but the app shows an error every time. "
            "The order hasn't been dispatched yet. Please cancel and refund.",
            "My order {order_id} was cancelled by the platform with no explanation. "
            "I needed it urgently. Either redeliver immediately or provide full compensation.",
            "An unfair cancellation fee was charged for order {order_id}. "
            "I cancelled within the allowed window. Please reverse the ₹50 fee.",
            "The product received in order {order_id} is defective — it stopped working within 24 hours. "
            "Requesting return and full refund of ₹{value}.",
            "The return for order {order_id} was picked up on {date} but the refund of ₹{value} "
            "has not arrived. It has been over 7 business days.",
        ],
    },
    {
        "module": "compliance",
        "subjects": [
            "My account was wrongly flagged and order blocked",
            "False fraud alert raised on my account",
            "Platform policy applied incorrectly to my case",
            "Complaint about unfair deduction from wallet",
            "Request for refund under consumer protection policy",
        ],
        "descriptions": [
            "My order {order_id} was blocked due to what appears to be a false fraud flag on my account. "
            "I am a genuine customer. Please review and unblock my order worth ₹{value}.",
            "I received an alert that my account is under review for unusual activity on order {order_id}. "
            "This is incorrect — I placed this order legitimately from my usual device and location.",
            "The refund policy was not applied correctly to my order {order_id}. "
            "According to the consumer protection policy, I am entitled to a full refund of ₹{value}.",
            "₹{value} was wrongly deducted from my wallet for order {order_id} without proper explanation. "
            "Please reverse this deduction and provide a detailed billing statement.",
        ],
    },
]

CHANNELS = ["email", "chat", "voice", "api"]


def fetch_orders(conn, count: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT o.order_id, o.customer_id, o.order_value, o.sla_breach,
                   c.email, c.segment,
                   o.delivery_estimated, o.delivery_actual
            FROM kirana_kart.orders o
            JOIN kirana_kart.customers c ON c.customer_id = o.customer_id
            WHERE c.email IS NOT NULL AND c.is_active = true
            ORDER BY RANDOM()
            LIMIT %s
        """, (count,))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def build_payload(order: dict) -> dict:
    template = random.choice(TICKET_TEMPLATES)
    subject = random.choice(template["subjects"])
    desc_tpl = random.choice(template["descriptions"])

    eta = str(order["delivery_estimated"])[:16] if order["delivery_estimated"] else "the estimated time"
    date_str = str(order["delivery_actual"])[:10] if order["delivery_actual"] else "recently"

    description = desc_tpl.format(
        order_id=order["order_id"],
        value=f"{order['order_value']:.2f}",
        eta=eta,
        date=date_str,
        num_missing=random.randint(1, 3),
    )

    segment = (order["segment"] or "").lower()
    org = segment if segment in ("zomato", "blinkit", "zepto", "swiggy") else "blinkit"

    return {
        "channel": random.choice(CHANNELS),
        "source": "freshdesk",
        "org": org,
        "business_line": "ecommerce",
        "module": template["module"],
        "payload": {
            "ticket_id":   random.randint(100000, 999999),
            "group_id":    "1",
            "cx_email":    order["email"],
            "customer_id": order["customer_id"],
            "order_id":    order["order_id"],
            "subject":     subject,
            "description": description,
            "img_flg":     0,
            "attachment":  0,
        },
        "metadata": {
            "environment": "production",
            "test_mode":   False,
            "called_by":   "simulate_100_tickets",
        },
    }, template["module"], subject


def submit(payload: dict, headers: dict, idx: int) -> tuple[bool, int]:
    try:
        resp = requests.post(INGEST_URL, json=payload, headers=headers, timeout=15)
        if resp.status_code in (200, 201, 202):
            data = resp.json()
            tid = data.get("ticket_id") or data.get("id") or "?"
            return True, tid
        print(f"    ✗ [{idx}] HTTP {resp.status_code}: {resp.text[:120]}")
        return False, 0
    except Exception as e:
        print(f"    ✗ [{idx}] Error: {e}")
        return False, 0


def main():
    print(f"Connecting to DB...")
    conn = psycopg2.connect(DB_DSN)
    print(f"Fetching {TICKET_COUNT} random orders from customers + orders tables...")
    orders = fetch_orders(conn, TICKET_COUNT)
    conn.close()
    print(f"  Got {len(orders)} orders\n")

    headers = {
        "X-Admin-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
    }

    print(f"Submitting to {INGEST_URL}")
    print("=" * 65)

    success = 0
    for i, order in enumerate(orders, 1):
        body, module, subject = build_payload(order)
        ok, tid = submit(body, headers, i)
        if ok:
            success += 1
            print(f"  ✓ [{i:3d}/100] #{tid:<6} {module:12s} {subject[:40]}")
        time.sleep(0.1)  # gentle pacing

    print("=" * 65)
    print(f"\n{success}/100 tickets submitted successfully.")
    if success > 0:
        print(f"\nThe Cardinal Celery workers are now processing them (2 concurrent).")
        print(f"Monitor progress:")
        print(f"  docker compose logs -f worker-celery")
        print(f"  docker compose logs -f worker-poll")
        print(f"\nExpect ~{success // 2}–{success} minutes to fully complete.")
        print(f"Once done, all {success} tickets will appear in the QA Agent ticket list.")


if __name__ == "__main__":
    main()
