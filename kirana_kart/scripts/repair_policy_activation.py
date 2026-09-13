#!/usr/bin/env python3
"""
scripts/repair_policy_activation.py
===================================
One-off repair for databases written before policy activation was fixed.

Background
----------
Nothing in the codebase ever set policy_versions.is_active = TRUE:
compiler_service inserted the row with is_active = FALSE, and no publish path
flipped it. phase4_enricher refuses to enrich any ticket unless it is TRUE:

    "Policy version '<v>' exists but is_active=False."

So on an existing database kb_runtime_config.active_version points at a
version that policy_versions still marks inactive, and every ticket fails at
enrichment. KBRegistryService._activate_version now writes both tables
together, but that only helps versions published from here on.

This script brings an existing database into the consistent state: it takes
whatever kb_runtime_config already points at and marks that version active.

Usage
-----
    python -m scripts.repair_policy_activation            # report only
    python -m scripts.repair_policy_activation --apply    # write the fix

Safe to re-run; it is idempotent and makes no change when already consistent.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import text

from app.admin.db import engine


def _report(conn) -> tuple[str | None, list[dict]]:
    active_version = conn.execute(text("""
        SELECT active_version FROM kirana_kart.kb_runtime_config
        ORDER BY id DESC LIMIT 1
    """)).scalar()

    versions = [
        dict(r) for r in conn.execute(text("""
            SELECT policy_version, is_active, activated_at, vector_status
            FROM kirana_kart.policy_versions
            ORDER BY created_at
        """)).mappings().all()
    ]
    return active_version, versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true",
        help="Write the change. Without it the script only reports.",
    )
    parser.add_argument(
        "--version", default=None,
        help="Activate this version instead of whatever kb_runtime_config names.",
    )
    args = parser.parse_args()

    with engine.connect() as conn:
        runtime_version, versions = _report(conn)

    if not versions:
        print("No rows in policy_versions — nothing to repair.")
        return 0

    target = args.version or runtime_version

    print(f"kb_runtime_config.active_version : {runtime_version or '(unset)'}")
    print(f"policy_versions rows             : {len(versions)}")
    for v in versions:
        mark = "ACTIVE" if v["is_active"] else "      "
        print(f"  [{mark}] {v['policy_version']:<24} vector={v['vector_status']}")

    if not target:
        print(
            "\nkb_runtime_config names no version and --version was not given. "
            "Publish a version through the UI, or re-run with "
            "--version <label>."
        )
        return 1

    match = next((v for v in versions if v["policy_version"] == target), None)
    if not match:
        print(f"\nERROR: '{target}' has no policy_versions row. It must be compiled first.")
        return 1

    already_correct = match["is_active"] and not any(
        v["is_active"] and v["policy_version"] != target for v in versions
    )
    if already_correct:
        print(f"\nAlready consistent — '{target}' is the only active version. No change needed.")
        return 0

    print(f"\nWould activate: {target}")
    if match["vector_status"] != "completed":
        print(
            f"  WARNING: vector_status is '{match['vector_status']}', not 'completed'. "
            "The runtime expects a vectorised policy; activating anyway may "
            "produce poor retrieval."
        )

    if not args.apply:
        print("\nDry run. Re-run with --apply to write the change.")
        return 0

    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE kirana_kart.policy_versions
            SET is_active = FALSE
            WHERE is_active = TRUE AND policy_version <> :v
        """), {"v": target})
        conn.execute(text("""
            UPDATE kirana_kart.policy_versions
            SET is_active = TRUE,
                activated_at = COALESCE(activated_at, NOW())
            WHERE policy_version = :v
        """), {"v": target})
        conn.execute(text("""
            UPDATE kirana_kart.kb_runtime_config
            SET active_version = :v,
                activated_at = COALESCE(activated_at, NOW())
            WHERE id = (SELECT id FROM kirana_kart.kb_runtime_config
                        ORDER BY id DESC LIMIT 1)
        """), {"v": target})

    print(f"Done. '{target}' is now the active policy version.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
