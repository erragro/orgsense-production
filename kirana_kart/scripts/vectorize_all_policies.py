"""
Re-vectorize all existing policy versions into pgvector.
Runs each version through VectorService (same as trigger-on-policy-publish flow).
"""
from __future__ import annotations

import os
import sys
import psycopg2
from psycopg2.extras import RealDictCursor

sys.path.insert(0, "/app")

from app.l45_ml_platform.vectorization.vector_service import VectorService


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def main():
    conn = get_connection()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT policy_version FROM kirana_kart.policy_versions
            ORDER BY policy_version
        """)
        versions = [row["policy_version"] for row in cur.fetchall()]
    conn.close()

    print(f"Found {len(versions)} policy versions: {versions}")

    svc = VectorService()

    for version in versions:
        try:
            print(f"\n--- Vectorizing {version} ---")
            svc.vectorize_specific_version(version)
            print(f"✓ {version} done")
        except Exception as e:
            print(f"✗ {version} failed: {e}")


if __name__ == "__main__":
    main()
