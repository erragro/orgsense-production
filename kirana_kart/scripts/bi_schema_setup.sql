-- ============================================================
-- bi_schema_setup.sql
-- ============================================================
-- One-time setup script for the BI read-only role.
--
-- Run as a superuser or the owning role (orguser):
--   psql -U orguser -d orgintelligence -f bi_schema_setup.sql
--
-- What this does:
--   1. Creates the bi_readonly role (idempotent — skips if exists)
--   2. Grants CONNECT + USAGE on schema
--   3. Grants SELECT on the 11 BI-allowed tables
--   4. Adds COMMENT ON COLUMN for every column with a business description
--      (read by schema_loader.py to enrich the LLM SQL-generation prompt)
-- ============================================================

-- ============================================================
-- 1. ROLE SETUP
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_readonly') THEN
        CREATE ROLE bi_readonly WITH LOGIN PASSWORD 'REDACTED' NOINHERIT;
    END IF;
END
$$;

GRANT CONNECT ON DATABASE orgintelligence TO bi_readonly;
GRANT USAGE ON SCHEMA kirana_kart TO bi_readonly;

-- ============================================================
-- 2. TABLE GRANTS
-- ============================================================

GRANT SELECT ON TABLE kirana_kart.conversations           TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.conversation_turns      TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.customers               TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.csat_responses          TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.orders                  TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.refunds                 TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.delivery_events         TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.issue_taxonomy          TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.ticket_execution_summary TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.execution_metrics       TO bi_readonly;
GRANT SELECT ON TABLE kirana_kart.master_action_codes     TO bi_readonly;

-- Also grant read on pg_description / pg_catalog so schema_loader can read column comments
GRANT SELECT ON TABLE pg_catalog.pg_description TO bi_readonly;
GRANT SELECT ON TABLE pg_catalog.pg_class        TO bi_readonly;
GRANT SELECT ON TABLE pg_catalog.pg_namespace    TO bi_readonly;
GRANT SELECT ON TABLE pg_catalog.pg_attribute    TO bi_readonly;


-- ============================================================
-- 3. COLUMN COMMENTS
-- ============================================================
-- These descriptions are injected into the BI agent SQL-generation
-- prompt by schema_loader.py so the LLM can reason about columns
-- correctly without guessing from raw names.

-- ------------------------------------------------------------
-- conversations
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.conversations.conversation_id  IS 'Auto-incremented primary key for the conversation record.';
COMMENT ON COLUMN kirana_kart.conversations.ticket_id        IS 'Unique support ticket ID; joins to ticket_execution_summary.ticket_id (1-to-1).';
COMMENT ON COLUMN kirana_kart.conversations.order_id         IS 'The customer order this conversation is about; FK → orders.order_id.';
COMMENT ON COLUMN kirana_kart.conversations.customer_id      IS 'Unique customer identifier; FK → customers.customer_id.';
COMMENT ON COLUMN kirana_kart.conversations.channel          IS 'Contact channel: chat | email | phone | app | whatsapp.';
COMMENT ON COLUMN kirana_kart.conversations.agent_id         IS 'Human agent ID if the conversation was escalated or handled by a person; NULL for fully automated.';
COMMENT ON COLUMN kirana_kart.conversations.opened_at        IS 'Timestamp when the support ticket / conversation was created.';
COMMENT ON COLUMN kirana_kart.conversations.closed_at        IS 'Timestamp when the conversation was resolved and closed; NULL if still open.';
COMMENT ON COLUMN kirana_kart.conversations.fcr              IS 'First Contact Resolution flag: true if the issue was resolved without re-contact.';
COMMENT ON COLUMN kirana_kart.conversations.resolution_code  IS 'Short code describing how the ticket was resolved (e.g. refund_issued, escalated, rejected).';

-- ------------------------------------------------------------
-- conversation_turns
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.conversation_turns.id             IS 'Auto-incremented primary key for the message turn.';
COMMENT ON COLUMN kirana_kart.conversation_turns.ticket_id      IS 'Parent ticket this message belongs to; FK → conversations.ticket_id.';
COMMENT ON COLUMN kirana_kart.conversation_turns.message_sender IS 'Who sent this message: customer | agent | bot | system.';
COMMENT ON COLUMN kirana_kart.conversation_turns.message_text   IS 'Raw text of the message. PII may be present; do NOT display in aggregate reports.';
COMMENT ON COLUMN kirana_kart.conversation_turns.created_at     IS 'Timestamp when this message was sent.';

-- ------------------------------------------------------------
-- customers
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.customers.customer_id                IS 'Primary key — unique customer identifier across all tables.';
COMMENT ON COLUMN kirana_kart.customers.email                      IS 'Customer email address. PII — do NOT expose in reports.';
COMMENT ON COLUMN kirana_kart.customers.phone                      IS 'Customer phone number. PII — do NOT expose in reports.';
COMMENT ON COLUMN kirana_kart.customers.date_of_birth              IS 'Customer date of birth. PII — used for age-band segmentation only.';
COMMENT ON COLUMN kirana_kart.customers.signup_date                IS 'Timestamp when the customer created their account.';
COMMENT ON COLUMN kirana_kart.customers.is_active                  IS 'True if the customer account is currently active; false if churned / deactivated.';
COMMENT ON COLUMN kirana_kart.customers.lifetime_order_count       IS 'Total number of orders placed by this customer across all time.';
COMMENT ON COLUMN kirana_kart.customers.lifetime_igcc_rate         IS 'Lifetime issue/grievance contact rate: (total tickets / total orders). Decimal 0–1.';
COMMENT ON COLUMN kirana_kart.customers.segment                    IS 'Delivery platform segment the customer belongs to: swiggy | blinkit | zomato | zepto | instamart | dunzo. Used to filter BI queries by platform.';
COMMENT ON COLUMN kirana_kart.customers.customer_churn_probability IS 'ML-predicted churn probability 0.0–1.0. Higher = higher churn risk. Use for churn analysis.';
COMMENT ON COLUMN kirana_kart.customers.churn_model_version        IS 'Version of the churn model that produced customer_churn_probability.';
COMMENT ON COLUMN kirana_kart.customers.churn_last_updated         IS 'When the churn probability was last recalculated by the ML pipeline.';

-- ------------------------------------------------------------
-- csat_responses
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.csat_responses.id         IS 'Auto-incremented primary key for the CSAT response record.';
COMMENT ON COLUMN kirana_kart.csat_responses.ticket_id  IS 'Ticket that triggered this CSAT survey; FK → conversations.ticket_id.';
COMMENT ON COLUMN kirana_kart.csat_responses.rating     IS 'Customer satisfaction rating on a 1–5 scale (1 = very dissatisfied, 5 = very satisfied). Multiply AVG by 20 to get a 0–100 CSAT score.';
COMMENT ON COLUMN kirana_kart.csat_responses.feedback   IS 'Free-text comment left by the customer. PII may be present.';
COMMENT ON COLUMN kirana_kart.csat_responses.created_at IS 'Timestamp when the CSAT response was submitted.';

-- ------------------------------------------------------------
-- orders
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.orders.order_id           IS 'Primary key — unique order identifier shared across conversations, refunds, and delivery_events.';
COMMENT ON COLUMN kirana_kart.orders.customer_id        IS 'Customer who placed this order; FK → customers.customer_id.';
COMMENT ON COLUMN kirana_kart.orders.order_value        IS 'Total value of the order in INR (Indian Rupees).';
COMMENT ON COLUMN kirana_kart.orders.delivery_estimated IS 'Promised delivery deadline at time of order placement.';
COMMENT ON COLUMN kirana_kart.orders.delivery_actual    IS 'Actual delivery timestamp; NULL if not yet delivered.';
COMMENT ON COLUMN kirana_kart.orders.sla_breach         IS 'True if the order was delivered after the promised delivery_estimated time.';
COMMENT ON COLUMN kirana_kart.orders.created_at         IS 'Timestamp when the order was placed.';
COMMENT ON COLUMN kirana_kart.orders.updated_at         IS 'Timestamp of the last status update to this order record.';

-- ------------------------------------------------------------
-- refunds
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.refunds.refund_id           IS 'Auto-incremented primary key for the refund record.';
COMMENT ON COLUMN kirana_kart.refunds.ticket_id           IS 'Support ticket that triggered this refund; FK → conversations.ticket_id.';
COMMENT ON COLUMN kirana_kart.refunds.order_id            IS 'Order against which the refund was applied; FK → orders.order_id.';
COMMENT ON COLUMN kirana_kart.refunds.refund_amount       IS 'Monetary amount refunded in INR.';
COMMENT ON COLUMN kirana_kart.refunds.applied_action_code IS 'The policy action code that authorised this refund (e.g. REFUND_FULL, REFUND_PARTIAL); links to master_action_codes.action_code_id.';
COMMENT ON COLUMN kirana_kart.refunds.refund_reason       IS 'Human-readable reason for the refund (e.g. item_not_delivered, wrong_item_delivered).';
COMMENT ON COLUMN kirana_kart.refunds.refund_source       IS 'System that processed the refund: ai_agent | human_agent | auto_policy.';
COMMENT ON COLUMN kirana_kart.refunds.processed_at        IS 'Timestamp when the refund was processed and issued.';

-- ------------------------------------------------------------
-- delivery_events
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.delivery_events.id         IS 'Auto-incremented primary key for the delivery event record.';
COMMENT ON COLUMN kirana_kart.delivery_events.order_id   IS 'Order this delivery event belongs to; FK → orders.order_id.';
COMMENT ON COLUMN kirana_kart.delivery_events.event_time IS 'Timestamp when the delivery event occurred.';
COMMENT ON COLUMN kirana_kart.delivery_events.event_type IS 'Type of delivery event: order_placed | picked_up | out_for_delivery | delivered | failed_attempt | returned.';
COMMENT ON COLUMN kirana_kart.delivery_events.details    IS 'JSONB blob with additional event metadata (e.g. GPS coordinates, rider_id, failure_reason).';

-- ------------------------------------------------------------
-- issue_taxonomy
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.issue_taxonomy.id          IS 'Auto-incremented primary key.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.issue_code  IS 'Unique short code identifying this issue category (e.g. DEL_LATE, ITEM_MISSING).';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.label       IS 'Human-readable name for this issue category.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.description IS 'Detailed description of when this issue code applies.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.parent_id   IS 'Parent issue ID for hierarchical taxonomy; NULL for top-level (L1) categories.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.level       IS 'Taxonomy depth: 1 = L1 (broad category), 2 = L2 (sub-category), up to 4.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.is_active   IS 'True if this issue code is currently in use; false if deprecated.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.created_at  IS 'Timestamp when this taxonomy entry was created.';
COMMENT ON COLUMN kirana_kart.issue_taxonomy.updated_at  IS 'Timestamp of the last update to this taxonomy entry.';

-- ------------------------------------------------------------
-- ticket_execution_summary
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.ticket_id            IS 'Primary key — unique ticket ID; FK → conversations.ticket_id (1-to-1).';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.order_id             IS 'Order associated with this ticket; FK → orders.order_id.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.customer_id          IS 'Customer who raised this ticket; FK → customers.customer_id. Join to customers.segment to filter by delivery platform.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.issue_l1             IS 'L1 (broad) issue category label from the taxonomy (e.g. Delivery Issue, Wrong Item). Use directly — do NOT join issue_taxonomy.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.issue_l2             IS 'L2 (specific) issue sub-category label (e.g. Late Delivery, Missing Item). Use directly — do NOT join issue_taxonomy.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.applied_action_code  IS 'Policy action code applied to resolve this ticket (e.g. REFUND_FULL, ESCALATE_FRAUD); matches master_action_codes.action_code_id.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.action_category      IS 'Broad outcome category: refund | escalation | rejection | information | auto_resolved.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.final_refund_amount  IS 'Actual refund amount issued for this ticket in INR; 0 or NULL if no refund was given.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.fcr                  IS 'First Contact Resolution: true if the ticket was resolved in one interaction without re-contact.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.sla_breach           IS 'True if the ticket''s associated order breached its delivery SLA.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.csat_rating          IS 'CSAT rating (1–5) left by the customer; NULL if no survey was completed. Multiply AVG by 20 for a 0–100 score.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.processed_at         IS 'Timestamp when the ticket was processed and the outcome recorded.';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.policy_version       IS 'Version label of the KB policy used to evaluate this ticket (e.g. draft, v1.2).';
COMMENT ON COLUMN kirana_kart.ticket_execution_summary.policy_artifact_hash IS 'SHA-256 hash of the compiled policy artifact; used for reproducibility auditing.';

-- ------------------------------------------------------------
-- execution_metrics
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.execution_metrics.id             IS 'Auto-incremented primary key for the metrics record.';
COMMENT ON COLUMN kirana_kart.execution_metrics.execution_id   IS 'Unique identifier for this pipeline execution run (UUID-style).';
COMMENT ON COLUMN kirana_kart.execution_metrics.ticket_id      IS 'Ticket processed in this execution; FK → ticket_execution_summary.ticket_id.';
COMMENT ON COLUMN kirana_kart.execution_metrics.start_at       IS 'Timestamp when this ticket evaluation pipeline started.';
COMMENT ON COLUMN kirana_kart.execution_metrics.end_at         IS 'Timestamp when this ticket evaluation pipeline completed.';
COMMENT ON COLUMN kirana_kart.execution_metrics.duration_ms    IS 'Total end-to-end processing time in milliseconds. Divide by 1000 for seconds (AHT metric).';
COMMENT ON COLUMN kirana_kart.execution_metrics.llm_1_tokens   IS 'Token count consumed by Stage 1 LLM (issue classification).';
COMMENT ON COLUMN kirana_kart.execution_metrics.llm_2_tokens   IS 'Token count consumed by Stage 2 LLM (policy evaluation).';
COMMENT ON COLUMN kirana_kart.execution_metrics.llm_3_tokens   IS 'Token count consumed by Stage 3 LLM (response generation).';
COMMENT ON COLUMN kirana_kart.execution_metrics.total_tokens   IS 'Total LLM tokens consumed across all three stages for this ticket.';
COMMENT ON COLUMN kirana_kart.execution_metrics.overall_status IS 'Final pipeline status: success | partial_failure | failed.';
COMMENT ON COLUMN kirana_kart.execution_metrics.created_at     IS 'Timestamp when this metrics record was written.';

-- ------------------------------------------------------------
-- master_action_codes
-- ------------------------------------------------------------
COMMENT ON COLUMN kirana_kart.master_action_codes.id                    IS 'Auto-incremented primary key.';
COMMENT ON COLUMN kirana_kart.master_action_codes.action_key            IS 'URL-slug form of the action code (e.g. refund-full, reject-fraud). Used for API lookups.';
COMMENT ON COLUMN kirana_kart.master_action_codes.action_code_id        IS 'Unique SCREAMING_SNAKE_CASE identifier used in policy rules and ticket outcomes (e.g. REFUND_FULL).';
COMMENT ON COLUMN kirana_kart.master_action_codes.action_name           IS 'Short human-readable name for this action (max 5 words).';
COMMENT ON COLUMN kirana_kart.master_action_codes.action_description    IS 'One-sentence description of when this action applies.';
COMMENT ON COLUMN kirana_kart.master_action_codes.freshdesk_status      IS 'Numeric Freshdesk ticket status code mapped to this action (for CRM integration).';
COMMENT ON COLUMN kirana_kart.master_action_codes.freshdesk_status_name IS 'Human-readable Freshdesk status name (e.g. Resolved, Pending, Escalated).';
COMMENT ON COLUMN kirana_kart.master_action_codes.requires_refund       IS 'True if applying this action always results in a monetary refund being issued.';
COMMENT ON COLUMN kirana_kart.master_action_codes.requires_escalation   IS 'True if applying this action requires human agent review or approval.';
COMMENT ON COLUMN kirana_kart.master_action_codes.automation_eligible   IS 'True if this action can be taken fully automatically by the AI pipeline without human intervention.';
COMMENT ON COLUMN kirana_kart.master_action_codes.created_at            IS 'Timestamp when this action code was added to the registry.';
