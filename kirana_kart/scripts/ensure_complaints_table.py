from __future__ import annotations

import os

import psycopg2


SCHEMA = os.getenv("DB_SCHEMA", "kirana_kart")


def _get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "orgintelligence"),
        user=os.getenv("DB_USER", "orguser"),
        password=os.getenv("DB_PASSWORD", "REDACTED"),
    )


def main() -> None:
    ddl = f"""
    CREATE TABLE IF NOT EXISTS {SCHEMA}.complaints (
        complaint_id      BIGSERIAL PRIMARY KEY,
        ticket_id         BIGINT UNIQUE,
        execution_id      TEXT,
        customer_id       TEXT,
        channel           TEXT,
        issue_type_l1     TEXT,
        issue_type_l2     TEXT,
        escalation_group  TEXT,
        action_code       TEXT,
        refund_amount     NUMERIC(12, 2),
        resolution_status TEXT,
        fraud_segment     TEXT,
        kb_version_used   TEXT,
        raised_at         TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS complaints_customer_id_idx
        ON {SCHEMA}.complaints (customer_id);
    CREATE INDEX IF NOT EXISTS complaints_raised_at_idx
        ON {SCHEMA}.complaints (raised_at);
    CREATE INDEX IF NOT EXISTS complaints_action_code_idx
        ON {SCHEMA}.complaints (action_code);
    CREATE INDEX IF NOT EXISTS complaints_issue_type_l2_idx
        ON {SCHEMA}.complaints (issue_type_l2);
    """

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(ddl)
    finally:
        conn.close()

    print("complaints table ensured.")


if __name__ == "__main__":
    main()
