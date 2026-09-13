from __future__ import annotations

import argparse
import os
from typing import List, Dict, Any

import psycopg2
from psycopg2.extras import RealDictCursor

from app.l45_ml_platform.vectorization.embedding_service import EmbeddingService
from app.l45_ml_platform.vectorization.weaviate_client import (
    WeaviateClient,
    ISSUE_CLASS_NAME,
    ACTION_CLASS_NAME,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vectorize auxiliary corpora into Weaviate.")
    parser.add_argument("--corpus-version", default="v1")
    parser.add_argument("--issue-only", action="store_true")
    parser.add_argument("--action-only", action="store_true")
    return parser.parse_args()


def _get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "orgintelligence"),
        user=os.getenv("DB_USER", "orguser"),
        password=os.getenv("DB_PASSWORD", "REDACTED"),
    )


def _fetch_issue_types(conn) -> List[Dict[str, Any]]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, issue_code, label, description, level, is_active
            FROM kirana_kart.issue_taxonomy
            WHERE is_active = TRUE
            ORDER BY level, issue_code
            """
        )
        return list(cur.fetchall())


def _fetch_action_registry(conn) -> List[Dict[str, Any]]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, action_key, action_code_id, action_name,
                   action_description, requires_refund, requires_escalation,
                   automation_eligible
            FROM kirana_kart.master_action_codes
            ORDER BY id
            """
        )
        return list(cur.fetchall())


def main() -> None:
    args = parse_args()
    conn = _get_connection()
    embedder = EmbeddingService()
    wv = WeaviateClient()

    try:
        if not args.action_only:
            issue_rows = _fetch_issue_types(conn)
            issue_texts = [
                f"{r['issue_code']} | {r['label']} | {r.get('description') or ''}"
                for r in issue_rows
            ]
            issue_vectors = embedder.create_embeddings_batch(issue_texts)
            issue_objects = []
            for row, vector, text in zip(issue_rows, issue_vectors, issue_texts):
                issue_objects.append(
                    {
                        "issue_code": row["issue_code"],
                        "label": row["label"],
                        "description": row.get("description") or "",
                        "level": int(row["level"]),
                        "is_active": bool(row["is_active"]),
                        "corpus_version": args.corpus_version,
                        "semantic_text": text,
                        "vector": vector,
                    }
                )
            wv.upsert_corpus_objects(ISSUE_CLASS_NAME, issue_objects, "issue_code")
            print(f"Issue types vectorized: {len(issue_objects)}")

        if not args.issue_only:
            action_rows = _fetch_action_registry(conn)
            action_texts = [
                f"{r['action_key']} | {r['action_name']} | {r.get('action_description') or ''}"
                for r in action_rows
            ]
            action_vectors = embedder.create_embeddings_batch(action_texts)
            action_objects = []
            for row, vector, text in zip(action_rows, action_vectors, action_texts):
                action_objects.append(
                    {
                        "action_code_id": row["action_code_id"],
                        "action_key": row["action_key"],
                        "action_name": row.get("action_name") or "",
                        "action_description": row.get("action_description") or "",
                        "requires_refund": bool(row.get("requires_refund")),
                        "requires_escalation": bool(row.get("requires_escalation")),
                        "automation_eligible": bool(row.get("automation_eligible")),
                        "corpus_version": args.corpus_version,
                        "semantic_text": text,
                        "vector": vector,
                    }
                )
            wv.upsert_corpus_objects(ACTION_CLASS_NAME, action_objects, "action_code_id")
            print(f"Action registry vectorized: {len(action_objects)}")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
