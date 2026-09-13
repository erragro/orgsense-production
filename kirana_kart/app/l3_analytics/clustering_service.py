"""
app/l3_analytics/clustering_service.py
=======================================
Ticket Spike Detection & Root Cause Clustering

Addresses Problem 3: Volume doubled last Tuesday. Root cause identified in 3 days.
Target: Spike detected in <2 hours; named cluster + percentage breakdown produced.

Architecture:
    SpikeDetector   — Computes 15-minute ticket volume windows against a rolling
                      baseline. Flags anomalies (>2σ from mean) as spikes.

    RootCauseClustering — On detected spike, fetches recent ticket embeddings
                          from llm_output_1 (issue_type_l1/l2 + reasoning) and
                          runs cosine-distance clustering via scikit-learn's
                          AgglomerativeClustering (hierarchical, no HDBSCAN dep).
                          Falls back to groupby on issue_type_l1/l2 if embeddings
                          not available.

    SpikeSummary    — Dataclass output: spike_id, window_start, total_volume,
                      baseline_volume, clusters (name, count, pct, sample_tickets)

Usage (from Celery task or route):
    from app.l3_analytics.clustering_service import SpikeDetector, RootCauseClustering

    detector = SpikeDetector()
    spike = detector.check_current_window()
    if spike:
        clustering = RootCauseClustering()
        summary = clustering.analyse(spike)
        # summary.clusters → [{name, count, pct, sample_tickets}]
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME", "orgintelligence")
DB_USER     = os.getenv("DB_USER", "orguser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
SCHEMA      = "kirana_kart"

# Spike thresholds
SPIKE_SIGMA_THRESHOLD    = float(os.getenv("SPIKE_SIGMA_THRESHOLD", "2.0"))
SPIKE_MIN_VOLUME         = int(os.getenv("SPIKE_MIN_VOLUME", "50"))     # min tickets in window
SPIKE_WINDOW_MINUTES     = int(os.getenv("SPIKE_WINDOW_MINUTES", "15"))
SPIKE_BASELINE_HOURS     = int(os.getenv("SPIKE_BASELINE_HOURS", "72"))  # 3-day rolling mean
CLUSTER_TOP_N            = int(os.getenv("CLUSTER_TOP_N", "5"))

logger = logging.getLogger("l3_analytics.clustering")


# ============================================================
# DATA CLASSES
# ============================================================

@dataclass
class ClusterResult:
    name:           str
    count:          int
    percentage:     float
    sample_tickets: list[int] = field(default_factory=list)
    top_issue_l1:   Optional[str] = None
    top_issue_l2:   Optional[str] = None


@dataclass
class SpikeSummary:
    spike_id:         str
    window_start:     datetime
    window_end:       datetime
    current_volume:   int
    baseline_mean:    float
    baseline_std:     float
    sigma_above:      float
    clusters:         list[ClusterResult] = field(default_factory=list)
    cluster_method:   str = "groupby"   # "groupby" or "hierarchical"
    produced_at:      Optional[datetime] = None


@dataclass
class SpikeWindow:
    window_start:   datetime
    window_end:     datetime
    ticket_count:   int
    baseline_mean:  float
    baseline_std:   float
    sigma_above:    float


# ============================================================
# DB CONNECTION
# ============================================================

def _get_connection() -> psycopg2.extensions.connection:
    return pooled_connection()


# ============================================================
# SPIKE DETECTOR
# ============================================================

class SpikeDetector:
    """
    Detects volume spikes in the most recent SPIKE_WINDOW_MINUTES window
    by comparing against a rolling baseline from the last SPIKE_BASELINE_HOURS.
    """

    def check_current_window(self) -> Optional[SpikeWindow]:
        """
        Check if the current 15-minute window is a spike.
        Returns SpikeWindow if spike detected, None otherwise.
        """
        now          = datetime.now(timezone.utc)
        window_start = now - timedelta(minutes=SPIKE_WINDOW_MINUTES)
        baseline_start = now - timedelta(hours=SPIKE_BASELINE_HOURS)

        try:
            conn = _get_connection()
            try:
                current_count, baseline_stats = self._fetch_volume_stats(
                    conn, window_start, now, baseline_start, window_start
                )
            finally:
                conn.close()
        except psycopg2.Error as exc:
            logger.error("SpikeDetector DB error: %s", exc)
            return None

        if current_count < SPIKE_MIN_VOLUME:
            return None  # not enough volume to be meaningful

        mean = baseline_stats.get("mean", 0.0) or 0.0
        std  = baseline_stats.get("std", 0.0) or 0.0

        if std == 0:
            return None  # can't compute sigma without variance

        sigma_above = (current_count - mean) / std
        if sigma_above < SPIKE_SIGMA_THRESHOLD:
            return None  # within normal range

        logger.warning(
            "SPIKE DETECTED | window=%s→%s | count=%d | "
            "baseline_mean=%.1f | sigma=%.2f",
            window_start.isoformat(), now.isoformat(),
            current_count, mean, sigma_above,
        )
        return SpikeWindow(
            window_start=window_start,
            window_end=now,
            ticket_count=current_count,
            baseline_mean=round(mean, 2),
            baseline_std=round(std, 2),
            sigma_above=round(sigma_above, 2),
        )

    def _fetch_volume_stats(
        self,
        conn,
        window_start: datetime,
        window_end:   datetime,
        baseline_start: datetime,
        baseline_end:   datetime,
    ) -> tuple[int, dict]:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Current window count
            cur.execute(f"""
                SELECT COUNT(*) AS cnt
                FROM {SCHEMA}.fdraw
                WHERE created_at BETWEEN %s AND %s
            """, (window_start, window_end))
            current_count = int(cur.fetchone()["cnt"] or 0)

            # Baseline: compute per-15-min bucket counts over last N hours
            cur.execute(f"""
                SELECT
                    AVG(bucket_count) AS mean,
                    STDDEV(bucket_count) AS std
                FROM (
                    SELECT
                        date_trunc('minute', created_at) -
                            INTERVAL '1 minute' *
                            (EXTRACT(minute FROM created_at)::int %% {SPIKE_WINDOW_MINUTES})
                            AS bucket,
                        COUNT(*) AS bucket_count
                    FROM {SCHEMA}.fdraw
                    WHERE created_at BETWEEN %s AND %s
                    GROUP BY bucket
                ) buckets
            """, (baseline_start, baseline_end))
            stats = dict(cur.fetchone() or {})
            stats["mean"] = float(stats.get("mean") or 0)
            stats["std"]  = float(stats.get("std")  or 1)

        return current_count, stats


# ============================================================
# ROOT CAUSE CLUSTERING
# ============================================================

class RootCauseClustering:
    """
    Identifies root causes within a spike window.

    Primary method: group by issue_type_l1 / issue_type_l2 from llm_output_1
    (fast, no extra dependencies).

    Secondary method: hierarchical clustering on issue_type text vectors if
    scikit-learn is available — produces more semantic clusters.
    """

    def analyse(self, spike: SpikeWindow) -> SpikeSummary:
        """
        Produce a SpikeSummary with cluster breakdown for the spike window.
        """
        import uuid
        spike_id = f"spike_{int(spike.window_start.timestamp())}_{uuid.uuid4().hex[:6]}"

        raw_tickets = self._fetch_spike_tickets(spike.window_start, spike.window_end)
        if not raw_tickets:
            return SpikeSummary(
                spike_id=spike_id,
                window_start=spike.window_start,
                window_end=spike.window_end,
                current_volume=spike.ticket_count,
                baseline_mean=spike.baseline_mean,
                baseline_std=spike.baseline_std,
                sigma_above=spike.sigma_above,
                produced_at=datetime.now(timezone.utc),
            )

        clusters = self._cluster_groupby(raw_tickets)
        method   = "groupby"

        # Attempt hierarchical clustering if scikit-learn available and enough tickets
        if len(raw_tickets) >= 20:
            try:
                clusters = self._cluster_hierarchical(raw_tickets)
                method = "hierarchical"
            except Exception as exc:
                logger.debug("Hierarchical clustering unavailable, using groupby: %s", exc)

        summary = SpikeSummary(
            spike_id=spike_id,
            window_start=spike.window_start,
            window_end=spike.window_end,
            current_volume=spike.ticket_count,
            baseline_mean=spike.baseline_mean,
            baseline_std=spike.baseline_std,
            sigma_above=spike.sigma_above,
            clusters=clusters[:CLUSTER_TOP_N],
            cluster_method=method,
            produced_at=datetime.now(timezone.utc),
        )

        self._persist_summary(summary)
        return summary

    def _fetch_spike_tickets(
        self,
        window_start: datetime,
        window_end:   datetime,
    ) -> list[dict]:
        """
        Fetch issue classifications for tickets in the spike window.
        Joins fdraw → llm_output_1 to get issue_type_l1/l2.
        Falls back to just fdraw ticket_ids if llm_output_1 is empty.
        """
        try:
            conn = _get_connection()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(f"""
                        SELECT
                            f.ticket_id,
                            COALESCE(lo.issue_type_l1, 'unknown')  AS issue_l1,
                            COALESCE(lo.issue_type_l2, 'unknown')  AS issue_l2,
                            lo.confidence
                        FROM {SCHEMA}.fdraw f
                        LEFT JOIN {SCHEMA}.llm_output_1 lo ON lo.ticket_id = f.ticket_id
                        WHERE f.created_at BETWEEN %s AND %s
                        ORDER BY f.ticket_id
                        LIMIT 2000
                    """, (window_start, window_end))
                    return [dict(r) for r in cur.fetchall()]
            finally:
                conn.close()
        except psycopg2.Error as exc:
            logger.error("_fetch_spike_tickets failed: %s", exc)
            return []

    def _cluster_groupby(self, tickets: list[dict]) -> list[ClusterResult]:
        """
        Fast clustering: group by (issue_l1, issue_l2) combination.
        Returns clusters sorted by ticket count descending.
        """
        from collections import defaultdict
        groups: dict[tuple, list[int]] = defaultdict(list)
        for t in tickets:
            key = (t.get("issue_l1", "unknown"), t.get("issue_l2", "unknown"))
            groups[key].append(t["ticket_id"])

        total = len(tickets)
        clusters = []
        for (l1, l2), ticket_ids in sorted(
            groups.items(), key=lambda x: len(x[1]), reverse=True
        ):
            count = len(ticket_ids)
            clusters.append(ClusterResult(
                name=f"{l1} / {l2}",
                count=count,
                percentage=round(count / total * 100, 1),
                sample_tickets=ticket_ids[:5],
                top_issue_l1=l1,
                top_issue_l2=l2,
            ))
        return clusters

    def _cluster_hierarchical(self, tickets: list[dict]) -> list[ClusterResult]:
        """
        Hierarchical clustering on TF-IDF of "issue_l1 issue_l2" text.
        Requires scikit-learn (available in the container).
        Produces semantically merged clusters (e.g. "delivery delay" and
        "late delivery" collapse into one cluster).
        """
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.cluster import AgglomerativeClustering
        import numpy as np

        texts = [
            f"{t.get('issue_l1', '')} {t.get('issue_l2', '')}".strip()
            for t in tickets
        ]
        ticket_ids = [t["ticket_id"] for t in tickets]

        if len(set(texts)) < 3:
            return self._cluster_groupby(tickets)

        vectorizer = TfidfVectorizer(max_features=200, ngram_range=(1, 2))
        X = vectorizer.fit_transform(texts).toarray()

        n_clusters = min(CLUSTER_TOP_N, len(set(texts)))
        model = AgglomerativeClustering(n_clusters=n_clusters, metric="euclidean", linkage="ward")
        labels = model.fit_predict(X)

        # Map labels → cluster members
        from collections import defaultdict
        groups: dict[int, list] = defaultdict(list)
        for idx, label in enumerate(labels):
            groups[int(label)].append(idx)

        total = len(tickets)
        clusters = []
        for label, indices in sorted(
            groups.items(), key=lambda x: len(x[1]), reverse=True
        ):
            # Find the most frequent issue pair in this cluster
            l1_counts: dict = defaultdict(int)
            l2_counts: dict = defaultdict(int)
            ids_in_cluster = []
            for i in indices:
                l1_counts[tickets[i].get("issue_l1", "unknown")] += 1
                l2_counts[tickets[i].get("issue_l2", "unknown")] += 1
                ids_in_cluster.append(ticket_ids[i])

            top_l1 = max(l1_counts, key=l1_counts.get)
            top_l2 = max(l2_counts, key=l2_counts.get)
            count  = len(indices)
            clusters.append(ClusterResult(
                name=f"{top_l1} / {top_l2}",
                count=count,
                percentage=round(count / total * 100, 1),
                sample_tickets=ids_in_cluster[:5],
                top_issue_l1=top_l1,
                top_issue_l2=top_l2,
            ))
        return clusters

    def _persist_summary(self, summary: SpikeSummary) -> None:
        """
        Write spike summary to spike_reports table for BI agent queries.
        Creates the table if it doesn't exist.
        """
        try:
            conn = _get_connection()
            try:
                with conn:
                    with conn.cursor() as cur:
                        pass  # Schema installed by Alembic.
                        clusters_json = [
                            {
                                "name":          c.name,
                                "count":         c.count,
                                "percentage":    c.percentage,
                                "top_issue_l1":  c.top_issue_l1,
                                "top_issue_l2":  c.top_issue_l2,
                                "sample_tickets": c.sample_tickets,
                            }
                            for c in summary.clusters
                        ]
                        cur.execute(f"""
                            INSERT INTO {SCHEMA}.spike_reports (
                                spike_id, window_start, window_end,
                                current_volume, baseline_mean, baseline_std,
                                sigma_above, cluster_method, clusters_json, produced_at
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (spike_id) DO NOTHING
                        """, (
                            summary.spike_id,
                            summary.window_start,
                            summary.window_end,
                            summary.current_volume,
                            summary.baseline_mean,
                            summary.baseline_std,
                            summary.sigma_above,
                            summary.cluster_method,
                            psycopg2.extras.Json(clusters_json),
                            summary.produced_at or datetime.now(timezone.utc),
                        ))
            finally:
                conn.close()
            logger.info(
                "spike_report persisted | spike_id=%s | clusters=%d",
                summary.spike_id, len(summary.clusters),
            )
        except psycopg2.Error as exc:
            logger.error("spike_report persist failed: %s", exc)
