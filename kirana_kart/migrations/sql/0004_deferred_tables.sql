CREATE TABLE kirana_kart.agent_quality_flags (
                        agent_id            TEXT        NOT NULL,
                        flagged_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                        window_days         INT         NOT NULL DEFAULT 7,
                        total_tickets       INT         NOT NULL DEFAULT 0,
                        refund_approvals    INT         NOT NULL DEFAULT 0,
                        refund_rate         NUMERIC(5,4) NOT NULL DEFAULT 0,
                        manual_review_count INT         NOT NULL DEFAULT 0,
                        override_count      INT         NOT NULL DEFAULT 0,
                        flag_reason         TEXT,
                        resolved            BOOLEAN     NOT NULL DEFAULT FALSE,
                        PRIMARY KEY (agent_id, flagged_at)
                    );

CREATE TABLE kirana_kart.conversation_qa_scores (
                            conv_id                  TEXT        PRIMARY KEY,
                            agent_id                 TEXT,
                            total_turns              INT,
                            agent_turns              INT,
                            canned_turns             INT,
                            canned_ratio             NUMERIC(5,3),
                            grammar_errors_per_100w  NUMERIC(6,2),
                            sentiment_start          TEXT,
                            sentiment_end            TEXT,
                            sentiment_improved       BOOLEAN,
                            resolution_quality       TEXT,
                            coaching_flags           JSONB,
                            overall_qa_score         NUMERIC(5,3),
                            scored_at                TIMESTAMPTZ NOT NULL DEFAULT now()
                        );

CREATE TABLE kirana_kart.spike_reports (
                                spike_id        TEXT        PRIMARY KEY,
                                window_start    TIMESTAMPTZ NOT NULL,
                                window_end      TIMESTAMPTZ NOT NULL,
                                current_volume  INT         NOT NULL,
                                baseline_mean   NUMERIC(10,2),
                                baseline_std    NUMERIC(10,2),
                                sigma_above     NUMERIC(6,2),
                                cluster_method  TEXT,
                                clusters_json   JSONB,
                                produced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
                            );

CREATE TABLE kirana_kart.deduplication_log (
    id BIGSERIAL PRIMARY KEY, payload_hash TEXT NOT NULL,
    original_ticket_id BIGINT, duplicate_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT, customer_id TEXT, channel TEXT, action_taken TEXT
);
CREATE INDEX ix_deduplication_log_expiry ON kirana_kart.deduplication_log(duplicate_received_at);
CREATE TABLE kirana_kart.complaints (
    ticket_id BIGINT PRIMARY KEY, execution_id UUID,
    customer_id TEXT, channel TEXT, issue_type_l1 TEXT, issue_type_l2 TEXT,
    escalation_group TEXT, action_code TEXT, refund_amount NUMERIC(12,2),
    resolution_status TEXT, fraud_segment TEXT, kb_version_used TEXT,
    raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_complaints_customer_time ON kirana_kart.complaints(customer_id,raised_at);
CREATE TABLE kirana_kart.customer_risk_profile (
    customer_id TEXT PRIMARY KEY,
    fraud_score NUMERIC NOT NULL DEFAULT 0,
    fraud_risk_classification TEXT NOT NULL DEFAULT 'NORMAL', fraud_action_recommended TEXT,
    orders_last_7_days INTEGER NOT NULL DEFAULT 0, orders_last_30_days INTEGER NOT NULL DEFAULT 0,
    orders_last_90_days INTEGER NOT NULL DEFAULT 0, refunds_last_7_days INTEGER NOT NULL DEFAULT 0,
    refunds_last_30_days INTEGER NOT NULL DEFAULT 0, refunds_last_90_days INTEGER NOT NULL DEFAULT 0,
    refund_rate_7d NUMERIC NOT NULL DEFAULT 0, refund_rate_30d NUMERIC NOT NULL DEFAULT 0,
    refund_rate_90d NUMERIC NOT NULL DEFAULT 0, complaints_last_30_days INTEGER NOT NULL DEFAULT 0,
    marked_delivered_claims_90d INTEGER NOT NULL DEFAULT 0, high_value_orders_30d INTEGER NOT NULL DEFAULT 0,
    refunds_on_high_value_30d INTEGER NOT NULL DEFAULT 0, auto_approval_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    auto_approval_limit NUMERIC NOT NULL DEFAULT 0, auto_approval_blocked_reason TEXT,
    recommended_queue TEXT NOT NULL DEFAULT 'MANUAL_REVIEW', last_computed_at TIMESTAMPTZ
);
CREATE TABLE kirana_kart.risk_profile_change_log (
    id BIGSERIAL PRIMARY KEY, customer_id TEXT NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ
);
CREATE INDEX ix_risk_changes_pending ON kirana_kart.risk_profile_change_log(customer_id) WHERE NOT processed;
CREATE FUNCTION kirana_kart.queue_risk_profile_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.customer_id IS NOT NULL THEN
        INSERT INTO kirana_kart.risk_profile_change_log(customer_id) VALUES (NEW.customer_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER orders_queue_risk_refresh AFTER INSERT OR UPDATE ON kirana_kart.orders
    FOR EACH ROW EXECUTE FUNCTION kirana_kart.queue_risk_profile_refresh();
CREATE TRIGGER complaints_queue_risk_refresh AFTER INSERT OR UPDATE ON kirana_kart.complaints
    FOR EACH ROW EXECUTE FUNCTION kirana_kart.queue_risk_profile_refresh();
