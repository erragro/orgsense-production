"""Resumable customer PII cutover. Run with traffic/writers paused for final cutover.

PYTHONPATH=. python scripts/customer_pii_backfill.py encrypt|decrypt|verify
Uses MIGRATION_DATABASE_URL and PII_ENCRYPTION_KEY; never prints identity values.
Decrypt is an explicit rollback and must run with application writers paused.
"""
import argparse
import os
from sqlalchemy import create_engine, text
from app.utils.customer_pii import protect_customer, reveal_customer, PREFIX


def migrate(engine, direction: str, batch_size: int = 500) -> int:
    if direction not in {'encrypt', 'decrypt'} or not 1 <= batch_size <= 5000:
        raise ValueError('Invalid migration direction or batch size')
    predicate = (
        " OR ".join(f"({f} IS NOT NULL AND {f} NOT LIKE 'pii:v1:%')" for f in ('email','phone','date_of_birth'))
        + " OR (email IS NOT NULL AND email_blind_index IS NULL)"
        if direction == 'encrypt' else
        " OR ".join(f"{f} LIKE 'pii:v1:%'" for f in ('email','phone','date_of_birth'))
    )
    total = 0
    while True:
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            rows = conn.execute(text(f"""SELECT customer_id,email,phone,date_of_birth
                FROM kirana_kart.customers WHERE {predicate}
                ORDER BY customer_id LIMIT :limit FOR UPDATE"""), {'limit': batch_size}).mappings().all()
            if not rows:
                return total
            for row in rows:
                plain = reveal_customer(row)
                updated = protect_customer(plain) if direction == 'encrypt' else {**plain, 'email_blind_index': None}
                if direction == 'encrypt':
                    # Check every round trip before committing its batch.
                    assert reveal_customer(updated) == plain
                conn.execute(text('''UPDATE kirana_kart.customers SET email=:email,
                    phone=:phone,date_of_birth=:date_of_birth,email_blind_index=:email_blind_index
                    WHERE customer_id=:customer_id'''), updated)
            total += len(rows)


def verify(engine) -> int:
    """Decrypt and validate blind indexes in a streaming read without logging PII."""
    from app.utils.customer_pii import email_index
    count = 0
    with engine.connect() as conn:
        rows = conn.execution_options(stream_results=True).execute(text(
            'SELECT customer_id,email,phone,date_of_birth,email_blind_index FROM kirana_kart.customers'))
        for row in rows.mappings():
            for field in ('email','phone','date_of_birth'):
                if row[field] is not None and not row[field].startswith(PREFIX):
                    raise ValueError('Unencrypted customer fields remain')
            plain = reveal_customer(row)
            if row['email_blind_index'] != email_index(plain['email']):
                raise ValueError('Customer blind index mismatch')
            count += 1
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('direction', choices=['encrypt','decrypt','verify'])
    parser.add_argument('--batch-size', type=int, default=500)
    args = parser.parse_args()
    engine = create_engine(os.environ['MIGRATION_DATABASE_URL'], hide_parameters=True)
    count = verify(engine) if args.direction == 'verify' else migrate(engine, args.direction, args.batch_size)
    print(f'{args.direction}: {count} rows processed')
    engine.dispose()
