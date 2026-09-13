# app/admin/services/vector_service.py
#
# Taxonomy vectorization — pgvector backend (Weaviate removed).
# Stores issue taxonomy embeddings into kirana_kart.issue_type_vectors.
#
# Used by: app/admin/routes/taxonomy.py
# Imported functions: vectorize_active, vectorize_version, vector_status

import os
import traceback
from typing import Dict, List, Any

from app.admin.services.taxonomy_service import (
    fetch_all_issues,
    get_active_version,
    get_version_snapshot,
    mark_vector_job_completed,
)
from app.admin.db import get_connection
from app.l45_ml_platform.vectorization.pgvector_client import PostgresVectorClient
from app.l45_ml_platform.vectorization.embedding_service import EmbeddingService

CORPUS_VERSION = os.getenv("TAXONOMY_CORPUS_VERSION", "v1")


# ============================================================
# INDEX DATASET → issue_type_vectors
# ============================================================

def _index_dataset(version_label: str, dataset: List[Dict[str, Any]]) -> Dict:
    if not dataset:
        return {"version": version_label, "count": 0, "indexed": 0, "errors": 0}

    indexed = 0
    errors = 0

    try:
        embedder = EmbeddingService()
        pvc = PostgresVectorClient()

        texts = [
            f"{item['label']}. {item.get('description') or ''}"
            for item in dataset
        ]

        vectors = embedder.create_embeddings_batch(texts)

        objects = []
        for item, vector, text in zip(dataset, vectors, texts):
            try:
                objects.append({
                    "issue_code": str(item["issue_code"]),
                    "label": str(item.get("label", "")),
                    "description": str(item.get("description") or ""),
                    "level": int(item.get("level", 0)),
                    "is_active": bool(item.get("is_active", True)),
                    "corpus_version": version_label,
                    "semantic_text": text,
                    "vector": vector,
                })
                indexed += 1
            except Exception as e:
                print(f"Error building object: {e}")
                errors += 1

        # Delete old vectors for this version then upsert fresh
        pvc._upsert_issue_types(objects)

        print(f"Indexed {indexed} issue types into issue_type_vectors (version={version_label})")

    except Exception as e:
        print("Vectorization error:", e)
        print(traceback.format_exc())
        errors += len(dataset) - indexed

    return {
        "version": version_label,
        "count": len(dataset),
        "indexed": indexed,
        "errors": errors,
    }


# ============================================================
# VECTORIZE ACTIVE VERSION
# ============================================================

def vectorize_active() -> Dict:
    active_version = get_active_version()
    if not active_version:
        raise ValueError("No active version set")

    rows = fetch_all_issues(include_inactive=False)
    dataset = [
        {
            "issue_code": r[1],
            "label": r[2],
            "description": r[3],
            "level": r[5],
            "is_active": True,
        }
        for r in rows
    ]

    result = _index_dataset(active_version, dataset)
    result["status"] = "success"
    return result


# ============================================================
# VECTORIZE SPECIFIC VERSION
# ============================================================

def vectorize_version(version_label: str) -> Dict:
    snapshot = get_version_snapshot(version_label)
    if not snapshot:
        raise ValueError(f"Version {version_label} not found")

    dataset = [
        {
            "issue_code": item.get("issue_code"),
            "label": item.get("label"),
            "description": item.get("description"),
            "level": item.get("level"),
            "is_active": item.get("is_active", True),
        }
        for item in snapshot
    ]

    result = _index_dataset(version_label, dataset)
    result["status"] = "success"
    return result


# ============================================================
# VECTOR STATUS
# ============================================================

def vector_status() -> Dict:
    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM kirana_kart.issue_type_vectors")
                total = cur.fetchone()[0]
        finally:
            conn.close()

        return {"total_vectors": total, "status": "healthy"}

    except Exception as e:
        print("Vector status error:", e)
        return {"total_vectors": 0, "status": "error", "error": str(e)}


# ============================================================
# BACKGROUND WORKER (process_single_vector_job)
# ============================================================

def process_single_vector_job() -> bool:
    conn = None
    cur = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT id, version_label
            FROM kirana_kart.kb_vector_jobs
            WHERE status='pending'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """)
        job = cur.fetchone()
        if not job:
            return False

        job_id, version_label = job
        cur.execute("""
            UPDATE kirana_kart.kb_vector_jobs
            SET status='running', started_at=CURRENT_TIMESTAMP
            WHERE id=%s
        """, (job_id,))
        conn.commit()

    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()

    try:
        result = vectorize_version(version_label)
        mark_vector_job_completed(job_id)
        print(f"Vector job completed: {result}")
        return True
    except Exception as e:
        _mark_job_failed(job_id, str(e))
        return True


def _mark_job_failed(job_id: int, error: str):
    conn = None
    cur = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            UPDATE kirana_kart.kb_vector_jobs
            SET status='failed', completed_at=CURRENT_TIMESTAMP, error=%s
            WHERE id=%s
        """, (error[:500], job_id))
        conn.commit()
    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()
