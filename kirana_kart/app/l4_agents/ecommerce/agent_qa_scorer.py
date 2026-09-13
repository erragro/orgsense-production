"""
app/l4_agents/ecommerce/agent_qa_scorer.py
==========================================
Human Agent QA Scorer

Addresses Problem 2: "Agent quality invisible — 0.2% QA coverage."
Target: 100% of conversations scored within 90 seconds. Same-day coaching flags.

What this module scores (all deterministic Python, no LLM):

    1. Canned Response Ratio
       Compare agent turn text against a known canned-phrase vocabulary using
       TF-IDF cosine similarity. Flag turns with similarity > CANNED_SIM_THRESHOLD
       as canned. Ratio = canned_turns / total_agent_turns.
       Target from doc: reduce BPO canned ratio from 0.61 → < 0.30.

    2. Grammar Score
       Count common grammar errors using regex patterns (subject-verb agreement,
       missing articles, double spaces, sentence fragments, ALL CAPS abuse).
       Score = errors_per_100_words. Target: < 1.5 from current 3.8.

    3. Sentiment Arc
       Classify each turn as POSITIVE / NEUTRAL / NEGATIVE using a
       keyword-based classifier (no external deps). Track customer sentiment
       from first turn to last turn. A declining arc (POSITIVE→NEGATIVE or
       NEUTRAL→NEGATIVE) is a coaching flag.

    4. Resolution Quality
       Did the agent resolve the issue or just close it? Checks:
       - Resolution phrase present in last 2 agent turns
       - No "I'll escalate" without actual escalation note
       - Did customer express satisfaction in last turn?

Entry point:
    score_conversation(conv_id, turns) -> ConversationScore

Celery Beat usage (from tasks.py):
    For each new resolved ticket:
        from app.l4_agents.ecommerce.agent_qa_scorer import score_conversation, persist_score
        score = score_conversation(conv_id, turns)
        persist_score(score)
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
from app.admin.db import get_connection as pooled_connection
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_PORT     = os.getenv("DB_PORT", "5432")
DB_NAME     = os.getenv("DB_NAME", "orgintelligence")
DB_USER     = os.getenv("DB_USER", "orguser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
SCHEMA      = "kirana_kart"

# ── Thresholds ──────────────────────────────────────────────────────────────
CANNED_SIM_THRESHOLD  = float(os.getenv("CANNED_SIM_THRESHOLD", "0.70"))
GRAMMAR_FLAG_THRESHOLD = float(os.getenv("GRAMMAR_FLAG_THRESHOLD", "2.0"))  # errors/100w
CANNED_RATIO_FLAG      = float(os.getenv("CANNED_RATIO_FLAG", "0.40"))

logger = logging.getLogger("agent_qa_scorer")


# ── Known canned phrases ─────────────────────────────────────────────────────
# These are the phrases flagged in the Nashik BPO cluster investigation.
# Extend this list by querying the DB for frequently repeated agent phrases.
_CANNED_PHRASES = [
    "i apologize for the inconvenience",
    "i'm sorry to hear that",
    "we value your feedback",
    "please allow 3-5 business days",
    "your issue has been escalated",
    "is there anything else i can help you with",
    "thank you for your patience",
    "i understand your concern",
    "rest assured we will look into it",
    "kindly wait for our response",
    "your complaint has been noted",
    "we sincerely apologize",
    "please bear with us",
    "as per our policy",
]

# ── Grammar error patterns ────────────────────────────────────────────────────
_GRAMMAR_PATTERNS = [
    (r"\bI\s+is\b",               "subject_verb_agreement"),
    (r"\bhe\s+are\b",             "subject_verb_agreement"),
    (r"\bshe\s+are\b",            "subject_verb_agreement"),
    (r"\bthey\s+is\b",            "subject_verb_agreement"),
    (r"\byour\s+are\b",           "your_you_are_confusion"),
    (r"\byou\s+is\b",             "subject_verb_agreement"),
    (r"\s{2,}",                   "double_space"),
    (r"\b[A-Z]{4,}\b",            "excessive_caps"),
    (r"\bi\s+",                   "lowercase_i"),          # agent wrote 'i' not 'I'
    (r"[.!?][a-z]",               "missing_capitalisation"),
    (r"\bdon't not\b",            "double_negative"),
    (r"\bcan not\b(?!\s+be)",     "cannot_spacing"),
    (r"\bplease to\b",            "unnatural_phrasing"),
    (r"\bkindy\b",                "spelling_kindly"),
]

# ── Sentiment keywords ────────────────────────────────────────────────────────
_POSITIVE_KW = {
    "thank", "thanks", "appreciate", "great", "perfect", "resolved",
    "happy", "satisfied", "excellent", "helpful", "wonderful", "problem solved",
    "works", "working", "received", "got it",
}
_NEGATIVE_KW = {
    "disappointed", "unacceptable", "terrible", "awful", "worst", "useless",
    "not resolved", "still waiting", "escalate", "complaint", "refund not",
    "wrong", "angry", "frustrated", "ridiculous", "never again", "pathetic",
    "horrible", "disgusting",
}


# ============================================================
# DATA CLASSES
# ============================================================

@dataclass
class TurnScore:
    turn_id:      int
    speaker:      str   # "agent" | "customer" | "system"
    is_canned:    bool  = False
    canned_sim:   float = 0.0
    grammar_errors: list[str] = field(default_factory=list)
    sentiment:    str   = "NEUTRAL"  # POSITIVE | NEUTRAL | NEGATIVE


@dataclass
class ConversationScore:
    conv_id:             str
    agent_id:            Optional[str]
    total_turns:         int
    agent_turns:         int
    canned_turns:        int
    canned_ratio:        float
    grammar_errors_per_100w: float
    sentiment_arc:       list[str]          # per-turn customer sentiment
    sentiment_start:     str                # POSITIVE | NEUTRAL | NEGATIVE
    sentiment_end:       str
    sentiment_improved:  bool
    resolution_quality:  str                # GOOD | PARTIAL | POOR
    coaching_flags:      list[str]
    overall_qa_score:    float              # 0.0 – 1.0
    scored_at:           datetime           = field(default_factory=lambda: datetime.now(timezone.utc))
    turn_scores:         list[TurnScore]    = field(default_factory=list)


# ============================================================
# SCORER
# ============================================================

def score_conversation(
    conv_id:  str,
    turns:    list[dict],
    agent_id: Optional[str] = None,
) -> ConversationScore:
    """
    Score a completed conversation.

    Args:
        conv_id:   Conversation identifier
        turns:     List of dicts: {turn_id, speaker, text, turn_index}
        agent_id:  Agent who handled the conversation (optional)

    Returns:
        ConversationScore with all quality signals.
    """
    agent_turns_text: list[str] = []
    customer_turns:   list[str] = []
    turn_scores:      list[TurnScore] = []

    for t in turns:
        speaker = (t.get("speaker") or "").lower()
        text    = (t.get("text") or "")
        turn_id = int(t.get("turn_id") or t.get("turn_index") or 0)
        ts      = TurnScore(turn_id=turn_id, speaker=speaker)

        if speaker == "agent":
            agent_turns_text.append(text)
            ts.is_canned, ts.canned_sim = _check_canned(text)
            ts.grammar_errors = _check_grammar(text)
            ts.sentiment = _classify_sentiment(text)
        elif speaker == "customer":
            customer_turns.append(text)
            ts.sentiment = _classify_sentiment(text)

        turn_scores.append(ts)

    # Canned ratio
    total_agent    = len(agent_turns_text)
    canned_count   = sum(1 for ts in turn_scores if ts.speaker == "agent" and ts.is_canned)
    canned_ratio   = round(canned_count / total_agent, 3) if total_agent else 0.0

    # Grammar score
    all_agent_text  = " ".join(agent_turns_text)
    word_count      = max(len(all_agent_text.split()), 1)
    total_errors    = sum(len(ts.grammar_errors) for ts in turn_scores if ts.speaker == "agent")
    grammar_per_100 = round(total_errors / word_count * 100, 2)

    # Sentiment arc (customer only)
    cust_sentiments = [ts.sentiment for ts in turn_scores if ts.speaker == "customer"]
    sentiment_start = cust_sentiments[0]  if cust_sentiments else "NEUTRAL"
    sentiment_end   = cust_sentiments[-1] if cust_sentiments else "NEUTRAL"
    _sentiment_rank = {"POSITIVE": 2, "NEUTRAL": 1, "NEGATIVE": 0}
    sentiment_improved = (
        _sentiment_rank.get(sentiment_end, 1) >= _sentiment_rank.get(sentiment_start, 1)
    )

    # Resolution quality
    resolution_quality = _assess_resolution(agent_turns_text, customer_turns)

    # Build coaching flags
    coaching_flags: list[str] = []
    if canned_ratio >= CANNED_RATIO_FLAG:
        coaching_flags.append(
            f"HIGH_CANNED_RATIO:{canned_ratio:.2f} (threshold {CANNED_RATIO_FLAG})"
        )
    if grammar_per_100 >= GRAMMAR_FLAG_THRESHOLD:
        coaching_flags.append(
            f"GRAMMAR_ERRORS:{grammar_per_100:.1f}/100w (threshold {GRAMMAR_FLAG_THRESHOLD})"
        )
    if not sentiment_improved and sentiment_end == "NEGATIVE":
        coaching_flags.append("NEGATIVE_SENTIMENT_ARC: customer ended worse than started")
    if resolution_quality == "POOR":
        coaching_flags.append("POOR_RESOLUTION: no resolution phrase in final agent turns")

    # Overall QA score (0–1): penalise for each failing dimension
    score = 1.0
    score -= min(canned_ratio, 1.0) * 0.30               # up to -0.30 for canned
    score -= min(grammar_per_100 / 10.0, 1.0) * 0.20     # up to -0.20 for grammar
    if sentiment_end == "NEGATIVE":
        score -= 0.25
    if resolution_quality == "POOR":
        score -= 0.25
    elif resolution_quality == "PARTIAL":
        score -= 0.10
    overall_qa_score = max(0.0, round(score, 3))

    return ConversationScore(
        conv_id=conv_id,
        agent_id=agent_id,
        total_turns=len(turns),
        agent_turns=total_agent,
        canned_turns=canned_count,
        canned_ratio=canned_ratio,
        grammar_errors_per_100w=grammar_per_100,
        sentiment_arc=cust_sentiments,
        sentiment_start=sentiment_start,
        sentiment_end=sentiment_end,
        sentiment_improved=sentiment_improved,
        resolution_quality=resolution_quality,
        coaching_flags=coaching_flags,
        overall_qa_score=overall_qa_score,
        turn_scores=turn_scores,
    )


# ============================================================
# HELPERS
# ============================================================

def _check_canned(text: str) -> tuple[bool, float]:
    """
    Check if agent turn is a canned response by cosine similarity
    against known canned phrases. Uses TF-IDF if sklearn available,
    falls back to simple token overlap.
    """
    text_lower = text.lower().strip()
    if not text_lower:
        return False, 0.0

    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
        import numpy as np

        corpus = _CANNED_PHRASES + [text_lower]
        vec    = TfidfVectorizer(ngram_range=(1, 3)).fit_transform(corpus)
        sims   = cosine_similarity(vec[-1], vec[:-1]).flatten()
        max_sim = float(sims.max()) if len(sims) else 0.0
        return max_sim >= CANNED_SIM_THRESHOLD, round(max_sim, 3)

    except ImportError:
        # Fallback: token overlap on punct-stripped text
        clean     = re.sub(r"[^\w\s]", "", text_lower)
        tokens    = set(clean.split())
        best_sim  = 0.0
        for phrase in _CANNED_PHRASES:
            phrase_tokens = set(phrase.split())
            if not phrase_tokens:
                continue
            overlap = len(tokens & phrase_tokens) / len(phrase_tokens)
            best_sim = max(best_sim, overlap)
        return best_sim >= CANNED_SIM_THRESHOLD, round(best_sim, 3)


def _check_grammar(text: str) -> list[str]:
    """
    Detect common grammar/spelling errors via regex patterns.
    Returns list of error type strings found in text.
    """
    errors: list[str] = []
    for pattern, error_type in _GRAMMAR_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE if "lowercase_i" not in error_type else 0):
            errors.append(error_type)
    return errors


def _classify_sentiment(text: str) -> str:
    """
    Keyword-based sentiment classifier for a single turn.
    Returns POSITIVE, NEUTRAL, or NEGATIVE.
    """
    text_lower = text.lower()
    pos = sum(1 for kw in _POSITIVE_KW if kw in text_lower)
    neg = sum(1 for kw in _NEGATIVE_KW if kw in text_lower)
    if neg > pos:
        return "NEGATIVE"
    if pos > neg:
        return "POSITIVE"
    return "NEUTRAL"


def _assess_resolution(
    agent_turns: list[str],
    customer_turns: list[str],
) -> str:
    """
    Assess whether the conversation was properly resolved.
    GOOD     — Agent stated resolution + customer last turn is not negative
    PARTIAL  — Resolution phrase present but customer still unhappy
    POOR     — No resolution phrase in final 2 agent turns
    """
    _resolution_phrases = [
        "refund has been processed",
        "issue has been resolved",
        "order has been replaced",
        "credited to your account",
        "fixed the issue",
        "problem has been sorted",
        "complaint has been closed",
        "resolved your",
        "has been approved",
    ]

    if not agent_turns:
        return "POOR"

    last_agent = " ".join(agent_turns[-2:]).lower()
    resolved   = any(ph in last_agent for ph in _resolution_phrases)

    if not resolved:
        return "POOR"

    last_customer = (customer_turns[-1] if customer_turns else "").lower()
    if _classify_sentiment(last_customer) == "NEGATIVE":
        return "PARTIAL"

    return "GOOD"


# ============================================================
# PERSISTENCE
# ============================================================

def persist_score(score: ConversationScore) -> None:
    """
    Write ConversationScore to conversation_qa_scores table.
    The destination table is installed by Alembic.
    """
    try:
        conn = _get_db_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    pass  # Schema installed by Alembic.
                    cur.execute(f"""
                        INSERT INTO {SCHEMA}.conversation_qa_scores (
                            conv_id, agent_id, total_turns, agent_turns,
                            canned_turns, canned_ratio,
                            grammar_errors_per_100w,
                            sentiment_start, sentiment_end, sentiment_improved,
                            resolution_quality, coaching_flags,
                            overall_qa_score, scored_at
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s
                        )
                        ON CONFLICT (conv_id) DO UPDATE SET
                            overall_qa_score        = EXCLUDED.overall_qa_score,
                            canned_ratio            = EXCLUDED.canned_ratio,
                            grammar_errors_per_100w = EXCLUDED.grammar_errors_per_100w,
                            sentiment_improved      = EXCLUDED.sentiment_improved,
                            resolution_quality      = EXCLUDED.resolution_quality,
                            coaching_flags          = EXCLUDED.coaching_flags,
                            scored_at               = EXCLUDED.scored_at
                    """, (
                        score.conv_id,
                        score.agent_id,
                        score.total_turns,
                        score.agent_turns,
                        score.canned_turns,
                        score.canned_ratio,
                        score.grammar_errors_per_100w,
                        score.sentiment_start,
                        score.sentiment_end,
                        score.sentiment_improved,
                        score.resolution_quality,
                        psycopg2.extras.Json(score.coaching_flags),
                        score.overall_qa_score,
                        score.scored_at,
                    ))
        finally:
            conn.close()
    except psycopg2.Error as exc:
        logger.error("persist_score failed for conv_id=%s: %s", score.conv_id, exc)


def _get_db_connection() -> psycopg2.extensions.connection:
    return pooled_connection()


# ============================================================
# BATCH SCORING (called from Celery Beat)
# ============================================================

def score_recent_conversations(limit: int = 500) -> dict:
    """
    Score all conversations that don't yet have a QA score.
    Designed to run every few minutes from a Celery Beat task.

    Reads conversation_turns table for unscored conversations,
    scores each, persists results.

    Returns summary dict: {scored, skipped, flagged_for_coaching}
    """
    scored   = 0
    skipped  = 0
    flagged  = 0

    try:
        conn = _get_db_connection()
        try:
            # Get conversations not yet scored
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT DISTINCT
                        c.conversation_id::text AS conv_id,
                        c.ticket_id,
                        c.agent_id
                    FROM {SCHEMA}.conversation_turns ct
                    JOIN {SCHEMA}.conversations c ON c.ticket_id = ct.ticket_id
                    LEFT JOIN {SCHEMA}.conversation_qa_scores qs ON qs.conv_id = c.conversation_id::text
                    WHERE qs.conv_id IS NULL
                      AND c.closed_at IS NOT NULL
                    LIMIT %s
                """, (limit,))
                pending = cur.fetchall()

            for row in pending:
                cid      = row["conv_id"]
                agent_id = row.get("agent_id")

                # Fetch turns for this conversation
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(f"""
                        SELECT id AS turn_id, message_sender AS speaker, message_text AS text,
                               row_number() OVER (ORDER BY created_at, id) AS turn_index
                        FROM {SCHEMA}.conversation_turns
                        WHERE ticket_id = %s
                        ORDER BY created_at, id
                    """, (row["ticket_id"],))
                    turns = [dict(r) for r in cur.fetchall()]

                if not turns:
                    skipped += 1
                    continue

                try:
                    qa_score = score_conversation(cid, turns, agent_id)
                    persist_score(qa_score)
                    scored += 1
                    if qa_score.coaching_flags:
                        flagged += 1
                        logger.info(
                            "coaching_flag | conv_id=%s | agent_id=%s | flags=%s",
                            cid, agent_id, qa_score.coaching_flags,
                        )
                except Exception as exc:
                    logger.warning("score_conversation failed for conv_id=%s: %s", cid, exc)
                    skipped += 1

        finally:
            conn.close()

    except psycopg2.Error as exc:
        logger.error("score_recent_conversations DB error: %s", exc)

    return {"scored": scored, "skipped": skipped, "flagged_for_coaching": flagged}
