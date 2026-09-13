"""
weaviate_client.py — compatibility shim
========================================

Weaviate has been replaced by PostgreSQL + pgvector.
This module re-exports everything from pgvector_client so that all existing
callers continue to work with zero changes to their imports.

  from app.l45_ml_platform.vectorization.weaviate_client import WeaviateClient
  from app.l45_ml_platform.vectorization.weaviate_client import ISSUE_CLASS_NAME
  ...

All of the above still work — they just resolve to pgvector_client now.
"""

from .pgvector_client import (  # noqa: F401  (re-export)
    PostgresVectorClient as WeaviateClient,
    WEAVIATE_CLASS_NAME,
    ISSUE_CLASS_NAME,
    ACTION_CLASS_NAME,
    GUIDELINE_CLASS_NAME,
    IMAGE_RULE_CLASS_NAME,
)

# Keep the class name alias so code that does
#   from ...weaviate_client import WeaviateClient
# gets the pgvector implementation.
__all__ = [
    "WeaviateClient",
    "WEAVIATE_CLASS_NAME",
    "ISSUE_CLASS_NAME",
    "ACTION_CLASS_NAME",
    "GUIDELINE_CLASS_NAME",
    "IMAGE_RULE_CLASS_NAME",
]
