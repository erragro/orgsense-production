"""
app/admin/constants/bi_formulas.py
===================================
Business Intelligence formula reference and SQL table summary for the BI Agent.

The BI_FORMULAS string is injected into the LLM system prompt so the agent
can correctly interpret and compute KPIs from raw query results.

The TABLE_SUMMARY is injected into the SQL-generation prompt so the LLM
knows the exact schema to query against.
"""

# ============================================================
# BUSINESS FORMULA REFERENCE
# ============================================================

BI_FORMULAS = """
KIRANA KART — OPERATIONS CENTER BI FORMULA REFERENCE
======================================================
You are a Senior Business Analyst for Kirana Kart, a quick-commerce platform.
Use the formulas below when computing or interpreting metrics from SQL results.

1. CSAT SCORE (Customer Satisfaction Score)
   Formula : ROUND(AVG(rating) * 20, 2)
   Scale   : Input rating 1–5 → Output score 0–100
   Source  : kirana_kart.csat_responses.rating
   Notes   : Score ≥ 80 = Good | 60–79 = Acceptable | < 60 = Critical

2. AUTO-RESOLUTION RATE (FCR — First Contact Resolution at ticket level)
   Formula : ROUND((COUNT(*) FILTER (WHERE fcr = true) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2)
   Source  : kirana_kart.ticket_execution_summary.fcr
   Notes   : Industry benchmark for AI-driven CX: ≥ 60% is excellent

3. SLA BREACH RATE
   Formula : ROUND((COUNT(*) FILTER (WHERE sla_breach = true) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2)
   Source  : kirana_kart.ticket_execution_summary.sla_breach
   Notes   : Keep below 5% — anything above 10% requires escalation review

4. AVERAGE HANDLE TIME (AHT)
   Formula : ROUND(AVG(duration_ms) / 1000.0, 2)  [converts ms → seconds]
   Source  : kirana_kart.execution_metrics.duration_ms
   Notes   : Target < 30 s for automated; < 5 min for agent-assisted

5. P95 HANDLE TIME
   Formula : ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) / 1000.0, 2)
   Source  : kirana_kart.execution_metrics.duration_ms
   Notes   : Highlights worst-case latency; keep P95 < 2× AHT

6. REFUND RATE
   Formula : ROUND((COUNT(DISTINCT r.refund_id) * 100.0 / NULLIF(COUNT(DISTINCT o.order_id), 0))::numeric, 2)
   Source  : kirana_kart.refunds r JOIN kirana_kart.orders o ON r.order_id = o.order_id
   Notes   : Healthy range: < 3%; > 8% signals product or fulfilment issues

7. AVERAGE REFUND AMOUNT
   Formula : ROUND(AVG(refund_amount), 2)
   Source  : kirana_kart.refunds.refund_amount
   Notes   : Segment by refund_reason to identify high-cost categories

8. ESCALATION RATE
   Formula : ROUND((COUNT(*) FILTER (WHERE requires_escalation = true) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2)
   Source  : kirana_kart.ticket_execution_summary tes
             JOIN kirana_kart.master_action_codes mac ON tes.applied_action_code = mac.action_code_id
   Notes   : Should track alongside CSAT; high escalation + low CSAT = systemic issue

9. FIRST CONTACT RESOLUTION (FCR) RATE
   Formula : ROUND((COUNT(*) FILTER (WHERE fcr = true) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2)
   Source  : kirana_kart.ticket_execution_summary.fcr
   Notes   : FCR > 70% is industry-leading for e-commerce

10. REPEAT CONTACT RATE
    Formula : ROUND((COUNT(DISTINCT customer_id) FILTER (WHERE ticket_count > 1) * 100.0
                      / NULLIF(COUNT(DISTINCT customer_id), 0))::numeric, 2)
    Source  : Subquery on kirana_kart.conversations grouped by customer_id, counting ticket_id per customer
    Notes   : > 20% repeat contact rate indicates unresolved root causes

11. CHURN RISK — HIGH RISK PERCENTAGE
    Formula : ROUND((COUNT(*) FILTER (WHERE customer_churn_probability > 0.7) * 100.0
                      / NULLIF(COUNT(*), 0))::numeric, 2)
    Source  : kirana_kart.customers.customer_churn_probability  (ML score, range 0–1)
    Notes   : customer_churn_probability > 0.7 = high risk; trigger retention campaigns

12. LLM TOKEN EFFICIENCY
    Formula : ROUND(AVG(total_tokens), 0)
    Source  : kirana_kart.execution_metrics.total_tokens
    Notes   : Lower is better; spikes indicate prompt bloat or retries

13. ISSUE CLASSIFICATION COVERAGE
    Formula : ROUND((COUNT(*) FILTER (WHERE issue_l1 IS NOT NULL) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 2)
    Source  : kirana_kart.ticket_execution_summary.issue_l1
    Notes   : < 90% suggests gaps in the taxonomy or classification model

14. DELIVERY DEFECT RATE
    Formula : ROUND((COUNT(*) FILTER (WHERE issue_l1 = 'DELIVERY') * 100.0
                      / NULLIF(COUNT(DISTINCT order_id), 0))::numeric, 2)
    Source  : kirana_kart.ticket_execution_summary (filter issue_l1 = 'DELIVERY')
    Notes   : Target < 2%; correlated with logistics partner SLAs

15. KNOWLEDGE BASE COVERAGE RATE
    N/A — no kb_matched column available in current schema.
    Use issue classification coverage as a proxy for KB effectiveness.

GENERAL NOTES
-------------
- Present numbers rounded to 2 decimal places unless they are counts.
- Always state the time period the metric covers.
- When comparing periods, show absolute change AND percentage change.
- Flag anomalies: values that deviate > 20% from typical ranges defined above.
- Use plain English — avoid SQL jargon in the final answer.
"""

# ============================================================
# TABLE SUMMARY FOR SQL GENERATION
# ============================================================

TABLE_SUMMARY = """
KIRANA KART — DATABASE SCHEMA REFERENCE (Schema: kirana_kart)
===============================================================
Use ONLY these tables and columns. Always prefix: kirana_kart.<table>.
All date/time columns are TIMESTAMPTZ unless stated otherwise.

1. conversations
   conversation_id  BIGINT   PK
   ticket_id        INT      UNIQUE → links to ticket_execution_summary.ticket_id
   order_id         TEXT     → links to orders.order_id
   customer_id      TEXT     → links to customers.customer_id
   channel          VARCHAR  (whatsapp | app | web | api)
   agent_id         TEXT
   opened_at        TIMESTAMPTZ  ← use this for date filtering
   closed_at        TIMESTAMPTZ
   fcr              BOOLEAN  (first-contact resolution flag)
   resolution_code  VARCHAR

2. conversation_turns
   id               BIGINT   PK
   ticket_id        INT      → conversations.ticket_id
   message_sender   VARCHAR  (customer | agent | system)
   message_text     TEXT
   created_at       TIMESTAMPTZ

3. customers
   customer_id              TEXT     PK
   signup_date              TIMESTAMPTZ
   is_active                BOOLEAN
   lifetime_order_count     INT
   lifetime_igcc_rate       NUMERIC  (issue/complaint rate over lifetime)
   segment                  VARCHAR  (swiggy | blinkit | zomato | zepto | instamart | dunzo)
                                    ← delivery platform the customer belongs to; NO segment column on any other table
   customer_churn_probability NUMERIC (0.0 – 1.0; > 0.7 = high risk)
   churn_model_version      VARCHAR
   churn_last_updated       TIMESTAMPTZ

4. csat_responses
   id               BIGINT   PK
   ticket_id        INT      → conversations.ticket_id
   rating           SMALLINT (1–5; CSAT score = AVG(rating) * 20 → 0–100 scale)
   feedback         TEXT
   created_at       TIMESTAMPTZ

5. orders
   order_id            TEXT     PK
   customer_id         TEXT     → customers.customer_id
   order_value         NUMERIC
   delivery_estimated  TIMESTAMPTZ
   delivery_actual     TIMESTAMPTZ
   sla_breach          BOOLEAN
   created_at          TIMESTAMPTZ
   updated_at          TIMESTAMPTZ

6. refunds
   refund_id            BIGINT   PK
   ticket_id            INT      → conversations.ticket_id
   order_id             TEXT     → orders.order_id
   refund_amount        NUMERIC
   applied_action_code  VARCHAR  → master_action_codes.action_code_id
   refund_reason        TEXT
   refund_source        VARCHAR  (auto | manual | escalation)
   processed_at         TIMESTAMPTZ

7. delivery_events
   id          BIGINT   PK
   order_id    TEXT     → orders.order_id
   event_time  TIMESTAMPTZ  ← use this for date filtering
   event_type  VARCHAR  (assigned | picked_up | out_for_delivery | delivered | failed)
   details     JSONB

8. issue_taxonomy
   id          INT      PK
   issue_code  VARCHAR  UNIQUE
   label       VARCHAR
   level       INT      (1=root category, 2=subcategory, 3=leaf issue type)
   parent_id   INT      → issue_taxonomy.id  (NULL for level-1 root categories)
   is_active   BOOLEAN
   description TEXT

9. ticket_execution_summary
   ticket_id            INT      PK → conversations.ticket_id
   order_id             TEXT     → orders.order_id
   customer_id          TEXT     → customers.customer_id
   issue_l1             VARCHAR  (level-1 issue_code, e.g. 'DELIVERY', 'FOOD')
   issue_l2             VARCHAR  (level-2 issue_code, e.g. 'DELIVERY-TIME')
   applied_action_code  VARCHAR  → master_action_codes.action_code_id
   action_category      VARCHAR  (refund | escalation | resolution | information)
   final_refund_amount  NUMERIC
   fcr                  BOOLEAN  (first-contact resolution)
   sla_breach           BOOLEAN
   csat_rating          SMALLINT (1–5)
   processed_at         TIMESTAMPTZ  ← use this for date filtering
   policy_version       VARCHAR
   policy_artifact_hash VARCHAR
   ⚠ NO segment/module/platform column — to filter by customer segment, JOIN customers ON tes.customer_id = cu.customer_id WHERE cu.segment = '<value>'

10. execution_metrics
    id              BIGINT   PK
    execution_id    VARCHAR
    ticket_id       INT      → conversations.ticket_id
    start_at        TIMESTAMPTZ
    end_at          TIMESTAMPTZ
    duration_ms     INT
    llm_1_tokens    INT
    llm_2_tokens    INT
    llm_3_tokens    INT
    total_tokens    INT
    overall_status  VARCHAR
    created_at      TIMESTAMPTZ

11. master_action_codes
    id                    INT      PK
    action_key            VARCHAR
    action_code_id        VARCHAR  UNIQUE  ← use this for JOINs
    action_name           VARCHAR
    action_description    TEXT
    freshdesk_status      INT
    freshdesk_status_name VARCHAR
    requires_refund       BOOLEAN
    requires_escalation   BOOLEAN
    automation_eligible   BOOLEAN
    created_at            TIMESTAMP

12. ticket_processing_state
    id                      BIGINT   PK
    ticket_id               INT      → conversations.ticket_id
    execution_id            VARCHAR
    current_stage           INT
    stage_0_status          VARCHAR  (pending | processing | completed | failed)
    stage_1_status          VARCHAR
    stage_2_status          VARCHAR
    stage_3_status          VARCHAR
    overall_status          VARCHAR  (alias: derived from stage statuses)
    module                  VARCHAR  (issue category tag)
    error_message           TEXT
    retry_count             INT
    processing_started_at   TIMESTAMP
    processing_completed_at TIMESTAMP
    created_at              TIMESTAMP
"""

# ============================================================
# SQL GENERATION RULES
# ============================================================

SQL_RULES = """
SQL GENERATION RULES
--------------------
⚠ ABSOLUTE RULE — kirana_kart.customers HAS NO DATE FILTER:
   NEVER add a date condition on kirana_kart.customers (not signup_date, not churn_last_updated,
   not ANY date column). Customer queries use ONLY segment filter:
     WHERE cu.segment = '<segment>'
   This applies even when date_from/date_to are provided — those dates apply to
   transactional tables only (conversations, orders, ticket_execution_summary, etc.).
   WRONG: WHERE cu.signup_date >= '2026-01-01' AND cu.segment = 'zomato'
   RIGHT: WHERE cu.segment = 'zomato'

1. ALWAYS prefix every table: kirana_kart.<table_name>
2. ONLY write SELECT statements — no INSERT, UPDATE, DELETE, DROP, ALTER
3. Always add LIMIT 500 unless the query is an aggregation returning < 10 rows
4. For date filters, use the correct date column for each table (NEVER customers):
     conversations         → opened_at
     ticket_execution_summary → processed_at
     orders                → created_at
     csat_responses        → created_at
     execution_metrics     → created_at
     delivery_events       → event_time
   Filter syntax:
     WHERE <date_column> >= '<date_from>'::date
       AND <date_column> <  ('<date_to>'::date + INTERVAL '1 day')
5. SEGMENT FILTER — customer platform (swiggy | blinkit | zomato | zepto | instamart | dunzo).
   CRITICAL: ticket_execution_summary and orders have NO segment/module column.
   You MUST JOIN kirana_kart.customers to filter by segment. NEVER write tes.segment, tes.module,
   o.segment, or any shortcut — there is no such column.
   Correct patterns:
   a) Tickets filtered by segment:
        FROM kirana_kart.ticket_execution_summary tes
        JOIN kirana_kart.customers cu ON tes.customer_id = cu.customer_id
        WHERE cu.segment = '<segment>'
   b) Tickets + conversations filtered by segment:
        FROM kirana_kart.ticket_execution_summary tes
        JOIN kirana_kart.customers cu ON tes.customer_id = cu.customer_id
        JOIN kirana_kart.conversations c ON tes.ticket_id = c.ticket_id
        WHERE cu.segment = '<segment>'
   c) Orders filtered by segment:
        FROM kirana_kart.orders o
        JOIN kirana_kart.customers cu ON o.customer_id = cu.customer_id
        WHERE cu.segment = '<segment>'
6. ALIAS RULE — once a table is given an alias in the FROM/JOIN clause, you MUST use that
   alias (not schema.table.column) everywhere else in the query (SELECT, WHERE, GROUP BY, ORDER BY).
   WRONG: SELECT kirana_kart.conversations.channel ...  JOIN kirana_kart.conversations c ON ...
   RIGHT: SELECT c.channel ...  JOIN kirana_kart.conversations c ON ...
7. Return meaningful column aliases (e.g., AS "CSAT Score", AS "Ticket Count")
8. Cast floats: ROUND(value::numeric, 2)
9. Use COALESCE to handle NULLs in aggregations
10. When computing percentages: ROUND((numerator * 100.0 / NULLIF(denominator, 0))::numeric, 2)
11. Do NOT use subqueries in FROM if a JOIN suffices
12. CSAT join pattern:
      LEFT JOIN kirana_kart.csat_responses cr ON cr.ticket_id = tes.ticket_id
13. Refund join pattern:
      LEFT JOIN kirana_kart.refunds r ON r.ticket_id = tes.ticket_id
"""
