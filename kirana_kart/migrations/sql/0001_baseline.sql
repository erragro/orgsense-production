--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Debian 16.15-1.pgdg12+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: kirana_kart; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA kirana_kart;


--
-- Name: SCHEMA kirana_kart; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA kirana_kart IS 'Domain schema for Kirana Kart quick commerce module';


--
-- Name: audit_issue_taxonomy(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.audit_issue_taxonomy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF TG_OP = 'INSERT' THEN
        INSERT INTO kirana_kart.issue_taxonomy_audit
        (issue_id, issue_code, action_type, new_data, changed_by)
        VALUES
        (NEW.id, NEW.issue_code, 'CREATE', to_jsonb(NEW), current_user);

        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO kirana_kart.issue_taxonomy_audit
        (issue_id, issue_code, action_type, old_data, new_data, changed_by)
        VALUES
        (NEW.id, NEW.issue_code, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), current_user);

        RETURN NEW;

    END IF;

    RETURN NULL;
END;
$$;


--
-- Name: create_taxonomy_snapshot(character varying); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.create_taxonomy_snapshot(p_label character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    existing_count INT;
BEGIN
    SELECT COUNT(*) INTO existing_count
    FROM kirana_kart.issue_taxonomy_versions
    WHERE version_label = p_label;

    IF existing_count > 0 THEN
        RAISE EXCEPTION 'Snapshot version already exists: %', p_label;
    END IF;

    INSERT INTO kirana_kart.issue_taxonomy_versions
    (version_label, created_by, snapshot_data)
    VALUES
    (
        p_label,
        current_user,
        (SELECT jsonb_agg(t) FROM kirana_kart.issue_taxonomy t)
    );
END;
$$;


--
-- Name: fn_get_active_kb(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.fn_get_active_kb() RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_active VARCHAR;
    v_snapshot JSONB;
BEGIN
    SELECT active_version
    INTO v_active
    FROM kirana_kart.kb_runtime_config
    ORDER BY activated_at DESC
    LIMIT 1;

    SELECT snapshot_data
    INTO v_snapshot
    FROM kirana_kart.knowledge_base_versions
    WHERE version_label = v_active;

    RETURN v_snapshot;
END;
$$;


--
-- Name: fn_insert_kb_draft(jsonb, jsonb, character varying); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.fn_insert_kb_draft(p_document jsonb, p_chunks jsonb, p_user character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_document_id VARCHAR;
    v_version VARCHAR;
BEGIN
    v_document_id := p_document->>'document_id';
    v_version := p_document->>'version';

    -- Insert draft document
    INSERT INTO kirana_kart.knowledge_base_drafts (
        document_id,
        title,
        domain,
        category,
        subcategory,
        content,
        risk_level,
        auto_resolution_allowed,
        escalation_required,
        linked_issue_codes,
        version_label,
        created_at,
        updated_at
    )
    VALUES (
        v_document_id,
        p_document->>'title',
        p_document->>'domain',
        p_document->>'category',
        p_document->>'subcategory',
        p_document::TEXT,
        p_document->>'risk_level',
        (p_document->>'auto_resolution_allowed')::BOOLEAN,
        (p_document->>'escalation_required')::BOOLEAN,
        ARRAY(SELECT jsonb_array_elements_text(p_document->'linked_issue_codes')),
        v_version,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    );

    -- Insert chunks
    INSERT INTO kirana_kart.knowledge_base_chunks_drafts (
        document_id,
        chunk_id,
        title,
        content,
        domain,
        category,
        subcategory,
        risk_level,
        auto_resolution_allowed,
        escalation_required,
        linked_issue_codes,
        version_label
    )
    SELECT
        v_document_id,
        chunk->>'chunk_id',
        chunk->>'title',
        chunk->>'content',
        p_document->>'domain',
        p_document->>'category',
        p_document->>'subcategory',
        p_document->>'risk_level',
        (p_document->>'auto_resolution_allowed')::BOOLEAN,
        (p_document->>'escalation_required')::BOOLEAN,
        ARRAY(SELECT jsonb_array_elements_text(p_document->'linked_issue_codes')),
        v_version
    FROM jsonb_array_elements(p_chunks) AS chunk;

    -- Audit log
    INSERT INTO kirana_kart.knowledge_base_audit (
        action_type,
        document_id,
        version_label,
        changed_by,
        old_value,
        new_value
    )
    VALUES (
        'add',
        v_document_id,
        v_version,
        p_user,
        NULL,
        p_document
    );

END;
$$;


--
-- Name: fn_publish_kb_version(character varying, character varying); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.fn_publish_kb_version(p_version_label character varying, p_user character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_snapshot JSONB;
BEGIN
    -- Collect full snapshot of this version
    SELECT jsonb_agg(to_jsonb(d))
    INTO v_snapshot
    FROM kirana_kart.knowledge_base_drafts d
    WHERE d.version_label = p_version_label;

    IF v_snapshot IS NULL THEN
        RAISE EXCEPTION 'No drafts found for version %', p_version_label;
    END IF;

    -- Insert immutable snapshot
    INSERT INTO kirana_kart.knowledge_base_versions (
        version_label,
        status,
        created_by,
        snapshot_data
    )
    VALUES (
        p_version_label,
        'published',
        p_user,
        v_snapshot
    );

    -- Update runtime active version
    INSERT INTO kirana_kart.kb_runtime_config (
        active_version,
        activated_at
    )
    VALUES (
        p_version_label,
        CURRENT_TIMESTAMP
    );

    -- Create vector job
    INSERT INTO kirana_kart.kb_vector_jobs (
        version_label,
        status
    )
    VALUES (
        p_version_label,
        'pending'
    );

    -- Audit
    INSERT INTO kirana_kart.knowledge_base_audit (
        action_type,
        version_label,
        changed_by,
        old_value,
        new_value
    )
    VALUES (
        'publish',
        p_version_label,
        p_user,
        NULL,
        v_snapshot
    );

END;
$$;


--
-- Name: fn_rollback_kb_version(character varying, character varying); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.fn_rollback_kb_version(p_target_version character varying, p_user character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Ensure version exists
    IF NOT EXISTS (
        SELECT 1 FROM kirana_kart.knowledge_base_versions
        WHERE version_label = p_target_version
    ) THEN
        RAISE EXCEPTION 'Version % does not exist', p_target_version;
    END IF;

    -- Activate target version
    INSERT INTO kirana_kart.kb_runtime_config (
        active_version,
        activated_at
    )
    VALUES (
        p_target_version,
        CURRENT_TIMESTAMP
    );

    -- Audit
    INSERT INTO kirana_kart.knowledge_base_audit (
        action_type,
        version_label,
        changed_by
    )
    VALUES (
        'rollback',
        p_target_version,
        p_user
    );

END;
$$;


--
-- Name: fn_update_vector_job_status(character varying, character varying, text); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.fn_update_vector_job_status(p_version character varying, p_status character varying, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE kirana_kart.kb_vector_jobs
    SET
        status = p_status,
        started_at = CASE WHEN p_status = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END,
        completed_at = CASE WHEN p_status IN ('completed','failed') THEN CURRENT_TIMESTAMP ELSE completed_at END,
        error = p_error
    WHERE version_label = p_version;
END;
$$;


--
-- Name: prevent_active_policy_delete(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.prevent_active_policy_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.is_active = TRUE THEN
        RAISE EXCEPTION 'Cannot delete active policy.';
    END IF;
    RETURN OLD;
END;
$$;


--
-- Name: prevent_canonical_update(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.prevent_canonical_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.processed = 1 THEN
        IF NEW.canonical_payload IS DISTINCT FROM OLD.canonical_payload
           OR NEW.preprocessing_hash IS DISTINCT FROM OLD.preprocessing_hash
           OR NEW.preprocessed_text IS DISTINCT FROM OLD.preprocessed_text THEN
            RAISE EXCEPTION 'Canonical payload is immutable after processing.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: prevent_delete(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.prevent_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Allow delete only if override flag is enabled
    IF current_setting('kirana_kart.allow_internal_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Hard delete not allowed. Use deactivation.';
END;
$$;


--
-- Name: prevent_issue_code_update(); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.prevent_issue_code_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.issue_code <> OLD.issue_code THEN
        RAISE EXCEPTION 'issue_code is immutable and cannot be modified';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: rollback_taxonomy(character varying); Type: FUNCTION; Schema: kirana_kart; Owner: -
--

CREATE FUNCTION kirana_kart.rollback_taxonomy(p_label character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    snapshot JSONB;
BEGIN

    SELECT snapshot_data INTO snapshot
    FROM kirana_kart.issue_taxonomy_versions
    WHERE version_label = p_label;

    IF snapshot IS NULL THEN
        RAISE EXCEPTION 'Version not found';
    END IF;

    -- Enable controlled internal delete
    PERFORM set_config('kirana_kart.allow_internal_delete', 'on', true);

    DELETE FROM kirana_kart.issue_taxonomy;

    INSERT INTO kirana_kart.issue_taxonomy
    SELECT *
    FROM jsonb_populate_recordset(NULL::kirana_kart.issue_taxonomy, snapshot);

    -- Disable override
    PERFORM set_config('kirana_kart.allow_internal_delete', 'off', true);

END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: action_registry_vectors; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.action_registry_vectors (
    action_code_id text NOT NULL,
    corpus_version text NOT NULL,
    embedding public.vector(3072) NOT NULL,
    semantic_text text DEFAULT ''::text NOT NULL,
    action_key text,
    action_name text,
    action_description text,
    requires_refund boolean,
    requires_escalation boolean,
    automation_eligible boolean
);


--
-- Name: admin_users; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.admin_users (
    id integer NOT NULL,
    api_token text,
    role character varying(20),
    CONSTRAINT admin_users_role_check CHECK (((role)::text = ANY (ARRAY[('viewer'::character varying)::text, ('editor'::character varying)::text, ('publisher'::character varying)::text])))
);


--
-- Name: admin_users_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.admin_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_users_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.admin_users_id_seq OWNED BY kirana_kart.admin_users.id;


--
-- Name: agent_decision_feedback; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.agent_decision_feedback (
    id integer NOT NULL,
    ticket_id text NOT NULL,
    ai_action_code text NOT NULL,
    agent_action text NOT NULL,
    outcome text,
    agent_notes text,
    agent_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_decision_feedback_outcome_check CHECK ((outcome = ANY (ARRAY['accepted'::text, 'modified'::text, 'rejected'::text, 'escalated'::text])))
);


--
-- Name: agent_decision_feedback_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.agent_decision_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_decision_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.agent_decision_feedback_id_seq OWNED BY kirana_kart.agent_decision_feedback.id;


--
-- Name: bi_chat_messages; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bi_chat_messages (
    id integer NOT NULL,
    session_id integer NOT NULL,
    role character varying(20) NOT NULL,
    content text NOT NULL,
    sql_query text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bi_chat_messages_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bi_chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bi_chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bi_chat_messages_id_seq OWNED BY kirana_kart.bi_chat_messages.id;


--
-- Name: bi_chat_sessions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bi_chat_sessions (
    id integer NOT NULL,
    label character varying(200) DEFAULT 'New Chat'::character varying NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bi_chat_sessions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bi_chat_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bi_chat_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bi_chat_sessions_id_seq OWNED BY kirana_kart.bi_chat_sessions.id;


--
-- Name: bpm_approvals; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bpm_approvals (
    id integer NOT NULL,
    instance_id integer NOT NULL,
    stage text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by_id integer,
    requested_by text,
    reviewer_id integer,
    reviewer_name text,
    review_notes text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT bpm_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: bpm_approvals_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bpm_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bpm_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bpm_approvals_id_seq OWNED BY kirana_kart.bpm_approvals.id;


--
-- Name: bpm_gate_results; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bpm_gate_results (
    id integer NOT NULL,
    instance_id integer NOT NULL,
    gate_type text NOT NULL,
    passed boolean NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    ml_prediction jsonb,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bpm_gate_results_gate_type_check CHECK ((gate_type = ANY (ARRAY['simulation'::text, 'shadow'::text, 'diff_review'::text])))
);


--
-- Name: bpm_gate_results_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bpm_gate_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bpm_gate_results_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bpm_gate_results_id_seq OWNED BY kirana_kart.bpm_gate_results.id;


--
-- Name: bpm_process_definitions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bpm_process_definitions (
    id integer NOT NULL,
    process_name text NOT NULL,
    kb_id text,
    stages jsonb DEFAULT '[]'::jsonb NOT NULL,
    gate_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    ml_thresholds jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bpm_process_definitions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bpm_process_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bpm_process_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bpm_process_definitions_id_seq OWNED BY kirana_kart.bpm_process_definitions.id;


--
-- Name: bpm_process_instances; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bpm_process_instances (
    id integer NOT NULL,
    kb_id text NOT NULL,
    process_name text NOT NULL,
    entity_id text NOT NULL,
    entity_type text NOT NULL,
    current_stage text DEFAULT 'DRAFT'::text NOT NULL,
    created_by_id integer,
    created_by_name text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    ml_predictions jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT bpm_process_instances_entity_type_check CHECK ((entity_type = ANY (ARRAY['kb_version'::text, 'taxonomy_version'::text])))
);


--
-- Name: bpm_process_instances_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bpm_process_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bpm_process_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bpm_process_instances_id_seq OWNED BY kirana_kart.bpm_process_instances.id;


--
-- Name: bpm_stage_transitions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.bpm_stage_transitions (
    id integer NOT NULL,
    instance_id integer NOT NULL,
    from_stage text NOT NULL,
    to_stage text NOT NULL,
    actor_id integer,
    actor_name text,
    notes text,
    transition_data jsonb DEFAULT '{}'::jsonb,
    transitioned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bpm_stage_transitions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.bpm_stage_transitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bpm_stage_transitions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.bpm_stage_transitions_id_seq OWNED BY kirana_kart.bpm_stage_transitions.id;


--
-- Name: cardinal_beat_schedule; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.cardinal_beat_schedule (
    id integer NOT NULL,
    task_key character varying(100) NOT NULL,
    task_name character varying(200) NOT NULL,
    display_name character varying(200) NOT NULL,
    description text,
    schedule_type character varying(20) DEFAULT 'interval'::character varying NOT NULL,
    interval_seconds integer,
    cron_expression character varying(100),
    enabled boolean DEFAULT true NOT NULL,
    last_triggered_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by character varying(200)
);


--
-- Name: cardinal_beat_schedule_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.cardinal_beat_schedule_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cardinal_beat_schedule_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.cardinal_beat_schedule_id_seq OWNED BY kirana_kart.cardinal_beat_schedule.id;


--
-- Name: cardinal_execution_plans; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.cardinal_execution_plans (
    id bigint NOT NULL,
    execution_id character varying(100) NOT NULL,
    execution_mode character varying(20) NOT NULL,
    org character varying(100),
    business_line character varying(100),
    module character varying(100),
    total_tickets integer,
    worker_count integer,
    current_stage integer DEFAULT 0,
    status character varying(50) DEFAULT 'queued'::character varying,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


--
-- Name: cardinal_execution_plans_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.cardinal_execution_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cardinal_execution_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.cardinal_execution_plans_id_seq OWNED BY kirana_kart.cardinal_execution_plans.id;


--
-- Name: consent_records; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.consent_records (
    id integer NOT NULL,
    data_principal_id integer,
    principal_type character varying(30) DEFAULT 'user'::character varying NOT NULL,
    purpose character varying(200) NOT NULL,
    consent_given boolean NOT NULL,
    consent_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    withdrawal_timestamp timestamp with time zone,
    ip_address inet,
    version character varying(20) DEFAULT '1.0'::character varying NOT NULL
);


--
-- Name: consent_records_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.consent_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consent_records_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.consent_records_id_seq OWNED BY kirana_kart.consent_records.id;


--
-- Name: conversation_turns; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.conversation_turns (
    id bigint NOT NULL,
    ticket_id integer NOT NULL,
    message_sender character varying(50),
    message_text text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: conversation_turns_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.conversation_turns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_turns_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.conversation_turns_id_seq OWNED BY kirana_kart.conversation_turns.id;


--
-- Name: conversations; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.conversations (
    conversation_id bigint NOT NULL,
    ticket_id integer NOT NULL,
    order_id text,
    customer_id text,
    channel character varying(50),
    agent_id text,
    opened_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    closed_at timestamp with time zone,
    fcr boolean,
    resolution_code character varying(50)
);


--
-- Name: conversations_conversation_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.conversations_conversation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversations_conversation_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.conversations_conversation_id_seq OWNED BY kirana_kart.conversations.conversation_id;


--
-- Name: crm_agent_actions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_agent_actions (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    queue_id integer,
    actor_id integer NOT NULL,
    action_type character varying(40) NOT NULL,
    before_value jsonb,
    after_value jsonb,
    reason text,
    refund_amount_before numeric(12,2),
    refund_amount_after numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_agent_actions_action_type_check CHECK (((action_type)::text = ANY ((ARRAY['APPROVE_AI_REC'::character varying, 'REJECT_AI_REC'::character varying, 'MODIFY_REFUND'::character varying, 'ESCALATE'::character varying, 'SELF_ASSIGN'::character varying, 'REASSIGN'::character varying, 'ADD_NOTE'::character varying, 'REPLY_CUSTOMER'::character varying, 'RESOLVE'::character varying, 'REOPEN'::character varying, 'CLOSE'::character varying, 'CHANGE_PRIORITY'::character varying, 'CHANGE_STATUS'::character varying, 'CHANGE_TYPE'::character varying, 'CHANGE_QUEUE'::character varying, 'ADD_TAG'::character varying, 'REMOVE_TAG'::character varying, 'ADD_WATCHER'::character varying, 'REMOVE_WATCHER'::character varying, 'MERGE'::character varying, 'BULK_ASSIGN'::character varying, 'BULK_ESCALATE'::character varying, 'BULK_CLOSE'::character varying, 'BULK_STATUS'::character varying])::text[])))
);


--
-- Name: crm_agent_actions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_agent_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_agent_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_agent_actions_id_seq OWNED BY kirana_kart.crm_agent_actions.id;


--
-- Name: crm_automation_rules; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_automation_rules (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    trigger_event character varying(40) NOT NULL,
    condition_logic character varying(3) DEFAULT 'AND'::character varying NOT NULL,
    conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_run_at timestamp with time zone,
    is_seeded boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_automation_rules_condition_logic_check CHECK (((condition_logic)::text = ANY ((ARRAY['AND'::character varying, 'OR'::character varying])::text[]))),
    CONSTRAINT crm_automation_rules_trigger_event_check CHECK (((trigger_event)::text = ANY ((ARRAY['TICKET_CREATED'::character varying, 'TICKET_UPDATED'::character varying, 'SLA_WARNING'::character varying, 'SLA_BREACHED'::character varying, 'TIME_BASED'::character varying])::text[])))
);


--
-- Name: crm_automation_rules_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_automation_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_automation_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_automation_rules_id_seq OWNED BY kirana_kart.crm_automation_rules.id;


--
-- Name: crm_group_integrations; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_group_integrations (
    id integer NOT NULL,
    group_id integer NOT NULL,
    type character varying(30) NOT NULL,
    name character varying(100) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    api_key character varying(100),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_group_integrations_type_check CHECK (((type)::text = ANY ((ARRAY['SMTP_INBOUND'::character varying, 'API_KEY'::character varying, 'WEBHOOK'::character varying, 'CARDINAL_RULE'::character varying])::text[])))
);


--
-- Name: crm_group_integrations_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_group_integrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_group_integrations_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_group_integrations_id_seq OWNED BY kirana_kart.crm_group_integrations.id;


--
-- Name: crm_group_members; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_group_members (
    group_id integer NOT NULL,
    user_id integer NOT NULL,
    role character varying(20) DEFAULT 'AGENT'::character varying NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_group_members_role_check CHECK (((role)::text = ANY ((ARRAY['AGENT'::character varying, 'LEAD'::character varying, 'MANAGER'::character varying])::text[])))
);


--
-- Name: crm_groups; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_groups (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    group_type character varying(30) DEFAULT 'SUPPORT'::character varying NOT NULL,
    routing_strategy character varying(20) DEFAULT 'ROUND_ROBIN'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_groups_group_type_check CHECK (((group_type)::text = ANY ((ARRAY['SUPPORT'::character varying, 'FRAUD_REVIEW'::character varying, 'ESCALATION'::character varying, 'SENIOR_REVIEW'::character varying, 'CUSTOM'::character varying])::text[]))),
    CONSTRAINT crm_groups_routing_strategy_check CHECK (((routing_strategy)::text = ANY ((ARRAY['ROUND_ROBIN'::character varying, 'LEAST_BUSY'::character varying, 'MANUAL'::character varying])::text[])))
);


--
-- Name: crm_groups_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_groups_id_seq OWNED BY kirana_kart.crm_groups.id;


--
-- Name: crm_merge_log; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_merge_log (
    id integer NOT NULL,
    source_ticket integer NOT NULL,
    target_ticket integer NOT NULL,
    merged_by integer NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_merge_log_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_merge_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_merge_log_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_merge_log_id_seq OWNED BY kirana_kart.crm_merge_log.id;


--
-- Name: crm_notes; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_notes (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    queue_id integer,
    author_id integer NOT NULL,
    note_type character varying(20) DEFAULT 'INTERNAL'::character varying NOT NULL,
    body text NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_notes_note_type_check CHECK (((note_type)::text = ANY ((ARRAY['INTERNAL'::character varying, 'CUSTOMER_REPLY'::character varying, 'ESCALATION'::character varying, 'SYSTEM'::character varying])::text[])))
);


--
-- Name: crm_notes_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_notes_id_seq OWNED BY kirana_kart.crm_notes.id;


--
-- Name: crm_notifications; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_notifications (
    id integer NOT NULL,
    recipient_id integer NOT NULL,
    ticket_id integer,
    queue_id integer,
    type character varying(40) NOT NULL,
    title character varying(200) NOT NULL,
    body text,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_notifications_type_check CHECK (((type)::text = ANY ((ARRAY['ASSIGNED'::character varying, 'UNASSIGNED'::character varying, 'SLA_WARNING'::character varying, 'SLA_BREACHED'::character varying, 'FIRST_RESPONSE_BREACH'::character varying, 'NOTE_ADDED'::character varying, 'REPLY_SENT'::character varying, 'STATUS_CHANGED'::character varying, 'ESCALATED'::character varying, 'MENTIONED'::character varying, 'WATCHER_UPDATE'::character varying, 'MERGE'::character varying, 'BULK_ACTION'::character varying])::text[])))
);


--
-- Name: crm_notifications_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_notifications_id_seq OWNED BY kirana_kart.crm_notifications.id;


--
-- Name: crm_saved_views; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_saved_views (
    id integer NOT NULL,
    owner_id integer NOT NULL,
    name character varying(100) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_by character varying(40) DEFAULT 'sla_due_at'::character varying,
    sort_dir character varying(4) DEFAULT 'asc'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_saved_views_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_saved_views_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_saved_views_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_saved_views_id_seq OWNED BY kirana_kart.crm_saved_views.id;


--
-- Name: crm_sla_policies; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_sla_policies (
    id integer NOT NULL,
    queue_type character varying(40) NOT NULL,
    resolution_minutes integer NOT NULL,
    first_response_minutes integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_sla_policies_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_sla_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_sla_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_sla_policies_id_seq OWNED BY kirana_kart.crm_sla_policies.id;


--
-- Name: crm_tags; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_tags (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    color character varying(7) DEFAULT '#6B7280'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_tags_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.crm_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.crm_tags_id_seq OWNED BY kirana_kart.crm_tags.id;


--
-- Name: crm_ticket_tags; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_ticket_tags (
    ticket_id integer NOT NULL,
    tag_id integer NOT NULL,
    added_by integer,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_watchers; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.crm_watchers (
    ticket_id integer NOT NULL,
    user_id integer NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: csat_responses; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.csat_responses (
    id bigint NOT NULL,
    ticket_id integer NOT NULL,
    rating smallint,
    feedback text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT csat_responses_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: csat_responses_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.csat_responses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: csat_responses_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.csat_responses_id_seq OWNED BY kirana_kart.csat_responses.id;


--
-- Name: customers; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.customers (
    customer_id text NOT NULL,
    email text,
    phone text,
    date_of_birth date,
    signup_date timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    lifetime_order_count integer DEFAULT 0 NOT NULL,
    lifetime_igcc_rate numeric(5,2) DEFAULT 0.00 NOT NULL,
    segment character varying(50) DEFAULT 'unknown'::character varying NOT NULL,
    customer_churn_probability numeric,
    churn_model_version character varying,
    churn_last_updated timestamp with time zone
);


--
-- Name: delivery_events; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.delivery_events (
    id bigint NOT NULL,
    order_id text NOT NULL,
    event_time timestamp with time zone NOT NULL,
    event_type character varying(100),
    details jsonb
);


--
-- Name: delivery_events_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.delivery_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_events_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.delivery_events_id_seq OWNED BY kirana_kart.delivery_events.id;


--
-- Name: dm_ticket_execution_summary; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.dm_ticket_execution_summary (
    ticket_id integer NOT NULL,
    order_id character varying,
    customer_id character varying,
    execution_id character varying,
    execution_mode character varying,
    final_issue_type_l1 character varying,
    final_issue_type_l2 character varying,
    final_action_code character varying,
    final_refund_amount numeric,
    fcr_flag boolean,
    sla_breach_flag boolean,
    csat_rating smallint,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: draft_action_proposals; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.draft_action_proposals (
    id integer NOT NULL,
    kb_id text NOT NULL,
    entity_id text NOT NULL,
    action_code_id character varying(100) NOT NULL,
    action_name character varying(255) NOT NULL,
    action_description text,
    exact_action text,
    parent_issue_codes text[] DEFAULT '{}'::text[] NOT NULL,
    requires_refund boolean DEFAULT false NOT NULL,
    requires_escalation boolean DEFAULT false NOT NULL,
    automation_eligible boolean DEFAULT true NOT NULL,
    proposal_type text DEFAULT 'new'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    llm_output jsonb,
    user_output jsonb,
    edit_reason text,
    extraction_confidence double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    edited_by integer,
    CONSTRAINT draft_action_proposals_proposal_type_check CHECK ((proposal_type = ANY (ARRAY['new'::text, 'update'::text, 'existing'::text]))),
    CONSTRAINT draft_action_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'edited'::text])))
);


--
-- Name: draft_action_proposals_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.draft_action_proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_action_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.draft_action_proposals_id_seq OWNED BY kirana_kart.draft_action_proposals.id;


--
-- Name: draft_taxonomy_proposals; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.draft_taxonomy_proposals (
    id integer NOT NULL,
    kb_id text NOT NULL,
    entity_id text NOT NULL,
    issue_code character varying(80) NOT NULL,
    label character varying(255) NOT NULL,
    description text,
    parent_code character varying(80),
    level integer NOT NULL,
    proposal_type text DEFAULT 'new'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    llm_output jsonb,
    user_output jsonb,
    edit_reason text,
    extraction_confidence double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    edited_by integer,
    CONSTRAINT draft_taxonomy_proposals_level_check CHECK (((level >= 1) AND (level <= 4))),
    CONSTRAINT draft_taxonomy_proposals_proposal_type_check CHECK ((proposal_type = ANY (ARRAY['new'::text, 'update'::text, 'existing'::text]))),
    CONSTRAINT draft_taxonomy_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'edited'::text])))
);


--
-- Name: draft_taxonomy_proposals_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.draft_taxonomy_proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_taxonomy_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.draft_taxonomy_proposals_id_seq OWNED BY kirana_kart.draft_taxonomy_proposals.id;


--
-- Name: entity_tags; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.entity_tags (
    id bigint NOT NULL,
    entity_type character varying,
    entity_id character varying,
    tag_key character varying,
    tag_value character varying,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: entity_tags_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.entity_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.entity_tags_id_seq OWNED BY kirana_kart.entity_tags.id;


--
-- Name: execution_audit_log; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.execution_audit_log (
    id bigint NOT NULL,
    execution_id character varying,
    ticket_id integer,
    stage_name character varying,
    event_time timestamp with time zone DEFAULT now(),
    event_type character varying,
    message text,
    metadata jsonb
);


--
-- Name: execution_audit_log_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.execution_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: execution_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.execution_audit_log_id_seq OWNED BY kirana_kart.execution_audit_log.id;


--
-- Name: execution_metrics; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.execution_metrics (
    id bigint NOT NULL,
    execution_id character varying,
    ticket_id integer,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    duration_ms integer,
    llm_1_tokens integer,
    llm_2_tokens integer,
    llm_3_tokens integer,
    total_tokens integer,
    overall_status character varying,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: execution_metrics_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.execution_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: execution_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.execution_metrics_id_seq OWNED BY kirana_kart.execution_metrics.id;


--
-- Name: extraction_standards; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.extraction_standards (
    id integer NOT NULL,
    kb_id text NOT NULL,
    standards_md text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);


--
-- Name: extraction_standards_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.extraction_standards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: extraction_standards_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.extraction_standards_id_seq OWNED BY kirana_kart.extraction_standards.id;


--
-- Name: fdraw; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.fdraw (
    sl integer NOT NULL,
    ticket_id integer NOT NULL,
    group_id character varying(25) NOT NULL,
    group_name character varying(25),
    cx_email character varying(255),
    status integer DEFAULT 0,
    subject text,
    description text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    tags text,
    code character varying(25),
    img_flg integer DEFAULT 0,
    attachment bigint DEFAULT 0,
    processed integer DEFAULT 0,
    ts timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    pipeline_stage character varying(50) DEFAULT 'NEW'::character varying,
    source character varying(50) DEFAULT 'api'::character varying,
    connector_id integer,
    thread_id character varying(255),
    message_count integer DEFAULT 1,
    module character varying(100),
    canonical_payload jsonb,
    detected_language character varying(20),
    preprocessing_version character varying,
    preprocessed_text text,
    preprocessing_hash character varying
);


--
-- Name: fdraw_sl_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.fdraw_sl_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fdraw_sl_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.fdraw_sl_seq OWNED BY kirana_kart.fdraw.sl;


--
-- Name: grievances; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.grievances (
    id integer NOT NULL,
    user_id integer,
    grievance_type character varying(100) NOT NULL,
    description text NOT NULL,
    contact_email character varying(255) NOT NULL,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution text
);


--
-- Name: grievances_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.grievances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grievances_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.grievances_id_seq OWNED BY kirana_kart.grievances.id;


--
-- Name: hitl_queue; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.hitl_queue (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    automation_pathway character varying(30) NOT NULL,
    queue_type character varying(40) DEFAULT 'STANDARD_REVIEW'::character varying NOT NULL,
    status character varying(30) DEFAULT 'OPEN'::character varying NOT NULL,
    priority smallint DEFAULT 3 NOT NULL,
    ticket_type character varying(30) DEFAULT 'INCIDENT'::character varying,
    assigned_to integer,
    assigned_at timestamp with time zone,
    sla_due_at timestamp with time zone NOT NULL,
    sla_breached boolean DEFAULT false NOT NULL,
    sla_breach_notified boolean DEFAULT false NOT NULL,
    first_response_due_at timestamp with time zone NOT NULL,
    first_response_at timestamp with time zone,
    first_response_breached boolean DEFAULT false NOT NULL,
    ai_action_code character varying(50),
    ai_refund_amount numeric(12,2),
    ai_reasoning text,
    ai_confidence numeric(5,4),
    ai_discrepancy_details text,
    ai_fraud_segment character varying(30),
    final_action_code character varying(50),
    final_refund_amount numeric(12,2),
    resolution_note text,
    resolved_by integer,
    resolved_at timestamp with time zone,
    customer_id character varying(50),
    order_id character varying(50),
    cx_email character varying(255),
    customer_segment character varying(20),
    subject text,
    viewing_agent_id integer,
    viewing_since timestamp with time zone,
    escalated_from integer,
    escalation_reason text,
    auto_assigned boolean DEFAULT false NOT NULL,
    csat_requested_at timestamp with time zone,
    merged_into integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id integer,
    CONSTRAINT hitl_queue_automation_pathway_check CHECK (((automation_pathway)::text = ANY ((ARRAY['HITL'::character varying, 'MANUAL_REVIEW'::character varying])::text[]))),
    CONSTRAINT hitl_queue_priority_check CHECK (((priority >= 1) AND (priority <= 4))),
    CONSTRAINT hitl_queue_queue_type_check CHECK (((queue_type)::text = ANY ((ARRAY['STANDARD_REVIEW'::character varying, 'SENIOR_REVIEW'::character varying, 'SLA_BREACH_REVIEW'::character varying, 'ESCALATION_QUEUE'::character varying, 'MANUAL_REVIEW'::character varying])::text[]))),
    CONSTRAINT hitl_queue_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'IN_PROGRESS'::character varying, 'PENDING_CUSTOMER'::character varying, 'ESCALATED'::character varying, 'RESOLVED'::character varying, 'CLOSED'::character varying])::text[]))),
    CONSTRAINT hitl_queue_ticket_type_check CHECK (((ticket_type)::text = ANY ((ARRAY['INCIDENT'::character varying, 'SERVICE_REQUEST'::character varying, 'QUESTION'::character varying, 'PROBLEM'::character varying])::text[])))
);


--
-- Name: hitl_queue_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.hitl_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hitl_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.hitl_queue_id_seq OWNED BY kirana_kart.hitl_queue.id;


--
-- Name: integrations; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.integrations (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    type character varying(20) NOT NULL,
    org character varying(100) DEFAULT 'default'::character varying NOT NULL,
    business_line character varying(50) DEFAULT 'ecommerce'::character varying NOT NULL,
    module character varying(50) DEFAULT 'delivery'::character varying NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_synced_at timestamp with time zone,
    sync_status character varying(20) DEFAULT 'idle'::character varying NOT NULL,
    sync_error text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT integrations_sync_status_check CHECK (((sync_status)::text = ANY ((ARRAY['idle'::character varying, 'running'::character varying, 'ok'::character varying, 'error'::character varying])::text[]))),
    CONSTRAINT integrations_type_check CHECK (((type)::text = ANY ((ARRAY['gmail'::character varying, 'outlook'::character varying, 'smtp'::character varying, 'api'::character varying])::text[])))
);


--
-- Name: integrations_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.integrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integrations_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.integrations_id_seq OWNED BY kirana_kart.integrations.id;


--
-- Name: issue_keywords; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.issue_keywords (
    id integer NOT NULL,
    issue_id integer NOT NULL,
    keyword character varying(255) NOT NULL,
    weight numeric(3,2) DEFAULT 1.0
);


--
-- Name: issue_keywords_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.issue_keywords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: issue_keywords_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.issue_keywords_id_seq OWNED BY kirana_kart.issue_keywords.id;


--
-- Name: issue_taxonomy; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.issue_taxonomy (
    id integer NOT NULL,
    issue_code character varying(80) NOT NULL,
    label character varying(255) NOT NULL,
    description text,
    parent_id integer,
    level integer NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    kb_id text DEFAULT 'default'::text NOT NULL,
    CONSTRAINT chk_parent_level CHECK ((((parent_id IS NULL) AND (level = 1)) OR ((parent_id IS NOT NULL) AND (level > 1)))),
    CONSTRAINT issue_taxonomy_level_check CHECK (((level >= 1) AND (level <= 4)))
);


--
-- Name: issue_taxonomy_audit; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.issue_taxonomy_audit (
    id integer NOT NULL,
    issue_id integer,
    issue_code character varying(80),
    action_type character varying(20) NOT NULL,
    old_data jsonb,
    new_data jsonb,
    changed_by character varying(255) NOT NULL,
    change_reason text,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: issue_taxonomy_audit_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.issue_taxonomy_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: issue_taxonomy_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.issue_taxonomy_audit_id_seq OWNED BY kirana_kart.issue_taxonomy_audit.id;


--
-- Name: issue_taxonomy_flat; Type: VIEW; Schema: kirana_kart; Owner: -
--

CREATE VIEW kirana_kart.issue_taxonomy_flat AS
 WITH RECURSIVE tree AS (
         SELECT issue_taxonomy.id,
            issue_taxonomy.issue_code,
            issue_taxonomy.label,
            issue_taxonomy.description,
            issue_taxonomy.parent_id,
            issue_taxonomy.level,
            (issue_taxonomy.label)::text AS full_path
           FROM kirana_kart.issue_taxonomy
          WHERE (issue_taxonomy.parent_id IS NULL)
        UNION ALL
         SELECT c.id,
            c.issue_code,
            c.label,
            c.description,
            c.parent_id,
            c.level,
            ((t.full_path || ' > '::text) || (c.label)::text)
           FROM (kirana_kart.issue_taxonomy c
             JOIN tree t ON ((c.parent_id = t.id)))
        )
 SELECT id,
    issue_code,
    label,
    description,
    parent_id,
    level,
    full_path
   FROM tree
  WHERE (level >= 2);


--
-- Name: issue_taxonomy_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.issue_taxonomy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: issue_taxonomy_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.issue_taxonomy_id_seq OWNED BY kirana_kart.issue_taxonomy.id;


--
-- Name: issue_taxonomy_versions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.issue_taxonomy_versions (
    version_id integer NOT NULL,
    version_label character varying(50) NOT NULL,
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    snapshot_data jsonb NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: issue_taxonomy_versions_version_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.issue_taxonomy_versions_version_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: issue_taxonomy_versions_version_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.issue_taxonomy_versions_version_id_seq OWNED BY kirana_kart.issue_taxonomy_versions.version_id;


--
-- Name: issue_type_vectors; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.issue_type_vectors (
    issue_code text NOT NULL,
    corpus_version text NOT NULL,
    embedding public.vector(3072) NOT NULL,
    semantic_text text DEFAULT ''::text NOT NULL,
    label text,
    description text,
    level integer,
    is_active boolean
);


--
-- Name: kb_rule_vectors; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.kb_rule_vectors (
    rule_id text NOT NULL,
    policy_version text NOT NULL,
    embedding public.vector(3072) NOT NULL,
    semantic_text text DEFAULT ''::text NOT NULL,
    module_name text,
    rule_type text,
    action_code_id text,
    action_name text
);


--
-- Name: kb_runtime_config; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.kb_runtime_config (
    id integer NOT NULL,
    active_version character varying(50) NOT NULL,
    activated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    shadow_version character varying,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: kb_runtime_config_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.kb_runtime_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kb_runtime_config_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.kb_runtime_config_id_seq OWNED BY kirana_kart.kb_runtime_config.id;


--
-- Name: kb_user_access; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.kb_user_access (
    id integer NOT NULL,
    kb_id text NOT NULL,
    user_id integer NOT NULL,
    role text NOT NULL,
    granted_by integer,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_user_access_role_check CHECK ((role = ANY (ARRAY['view'::text, 'edit'::text, 'admin'::text])))
);


--
-- Name: kb_user_access_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.kb_user_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kb_user_access_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.kb_user_access_id_seq OWNED BY kirana_kart.kb_user_access.id;


--
-- Name: kb_vector_jobs; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.kb_vector_jobs (
    id integer NOT NULL,
    version_label character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    error text,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: kb_vector_jobs_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.kb_vector_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kb_vector_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.kb_vector_jobs_id_seq OWNED BY kirana_kart.kb_vector_jobs.id;


--
-- Name: knowledge_base_audit; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_base_audit (
    id integer NOT NULL,
    action_type character varying(50),
    document_id character varying(100),
    version_label character varying(50),
    changed_by character varying(100),
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    old_value jsonb,
    new_value jsonb
);


--
-- Name: knowledge_base_audit_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_base_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_base_audit_id_seq OWNED BY kirana_kart.knowledge_base_audit.id;


--
-- Name: knowledge_base_chunks_drafts; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_base_chunks_drafts (
    id integer NOT NULL,
    document_id character varying(100) NOT NULL,
    chunk_id character varying(150) NOT NULL,
    title text,
    content text NOT NULL,
    domain character varying(50),
    category character varying(100),
    subcategory character varying(100),
    risk_level character varying(20),
    auto_resolution_allowed boolean,
    escalation_required boolean,
    linked_issue_codes text[],
    version_label character varying(50) DEFAULT 'draft'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: knowledge_base_chunks_drafts_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_base_chunks_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_chunks_drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_base_chunks_drafts_id_seq OWNED BY kirana_kart.knowledge_base_chunks_drafts.id;


--
-- Name: knowledge_base_drafts; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_base_drafts (
    id integer NOT NULL,
    document_id character varying(100) NOT NULL,
    title text NOT NULL,
    domain character varying(50) NOT NULL,
    category character varying(100) NOT NULL,
    subcategory character varying(100),
    content text NOT NULL,
    risk_level character varying(20) DEFAULT 'low'::character varying,
    auto_resolution_allowed boolean DEFAULT false,
    escalation_required boolean DEFAULT false,
    linked_issue_codes text[],
    version_label character varying(50) DEFAULT 'draft'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: knowledge_base_drafts_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_base_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_base_drafts_id_seq OWNED BY kirana_kart.knowledge_base_drafts.id;


--
-- Name: knowledge_base_raw_uploads; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_base_raw_uploads (
    id integer NOT NULL,
    document_id character varying(100) NOT NULL,
    original_filename text NOT NULL,
    original_format character varying(20) NOT NULL,
    raw_content text NOT NULL,
    upload_status character varying(20) DEFAULT 'uploaded'::character varying,
    uploaded_by character varying(100),
    uploaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    compile_errors jsonb,
    compiled_hash text,
    markdown_content text,
    version_label character varying(50) DEFAULT 'draft'::character varying,
    is_active boolean DEFAULT true,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deactivated_at timestamp without time zone,
    supersedes_document_id character varying(100),
    registry_status character varying(50) DEFAULT 'draft'::character varying,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: knowledge_base_raw_uploads_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_base_raw_uploads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_raw_uploads_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_base_raw_uploads_id_seq OWNED BY kirana_kart.knowledge_base_raw_uploads.id;


--
-- Name: knowledge_base_versions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_base_versions (
    id integer NOT NULL,
    version_label character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying,
    created_by character varying(100),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    snapshot_data jsonb NOT NULL,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: knowledge_base_versions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_base_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_base_versions_id_seq OWNED BY kirana_kart.knowledge_base_versions.id;


--
-- Name: knowledge_bases; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.knowledge_bases (
    id integer NOT NULL,
    kb_id text NOT NULL,
    kb_name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_bases_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.knowledge_bases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_bases_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.knowledge_bases_id_seq OWNED BY kirana_kart.knowledge_bases.id;


--
-- Name: llm_output_1; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.llm_output_1 (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    order_id character varying(100),
    issue_type_l1 character varying(100),
    issue_type_l2 character varying(100),
    confidence_entailment numeric(5,4),
    confidence_db_match numeric(5,4),
    image_required boolean DEFAULT false,
    image_fetched boolean DEFAULT false,
    image_url text,
    db_issue_type character varying(100),
    db_issue_match boolean DEFAULT false,
    vector_top_match_l1 character varying(100),
    vector_top_match_l2 character varying(100),
    vector_similarity_score numeric(5,4),
    reasoning text,
    raw_response text,
    status integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    execution_id character varying(100),
    execution_type character varying(50),
    is_complete boolean DEFAULT false,
    agent_id character varying(100),
    pipeline_status character varying(50) DEFAULT 'in_progress'::character varying,
    parent_llm_output_1_id integer,
    module character varying(100)
);


--
-- Name: COLUMN llm_output_1.execution_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.execution_id IS 'Links to cardinal_execution_plans';


--
-- Name: COLUMN llm_output_1.execution_type; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.execution_type IS 'full_pipeline | stage_test | manual | reprocess';


--
-- Name: COLUMN llm_output_1.is_complete; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.is_complete IS 'True if full pipeline (Stage 0→1→2→3) completed';


--
-- Name: COLUMN llm_output_1.agent_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.agent_id IS 'Agent/Worker ID that processed this';


--
-- Name: COLUMN llm_output_1.pipeline_status; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.pipeline_status IS 'in_progress | completed | failed | testing';


--
-- Name: COLUMN llm_output_1.parent_llm_output_1_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_1.parent_llm_output_1_id IS 'If reprocess, links to original record';


--
-- Name: llm_output_1_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.llm_output_1_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_output_1_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.llm_output_1_id_seq OWNED BY kirana_kart.llm_output_1.id;


--
-- Name: llm_output_2; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.llm_output_2 (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    order_id character varying(100),
    llm_output_1_id integer,
    issue_type_l1_original character varying(100),
    issue_type_l2_original character varying(100),
    issue_type_l1_verified character varying(100),
    issue_type_l2_verified character varying(100),
    issue_changed boolean DEFAULT false,
    issue_change_reason text,
    issue_verification_confidence numeric(5,4),
    image_required boolean DEFAULT false,
    image_provided boolean DEFAULT false,
    image_valid boolean,
    image_validation_confidence numeric(5,4),
    image_validation_reason text,
    fraud_segment character varying(50),
    value_segment character varying(50),
    standard_logic_passed boolean,
    lifetime_igcc_check boolean,
    exceptions_60d_check boolean,
    igcc_history_check boolean,
    same_issue_check boolean,
    aon_bod_eligible boolean DEFAULT false,
    super_subscriber boolean DEFAULT false,
    hrx_applicable boolean DEFAULT false,
    hrx_passed boolean,
    restaurant_igcc_rate numeric(5,2),
    greedy_check_applicable boolean DEFAULT false,
    greedy_signals_count integer DEFAULT 0,
    greedy_classification character varying(50) DEFAULT 'NORMAL'::character varying,
    sla_check_applicable boolean DEFAULT false,
    sla_breach boolean,
    delivery_delay_minutes integer,
    call_verification_required boolean DEFAULT false,
    call_verified boolean,
    multiplier numeric(5,2),
    order_value numeric(10,2),
    calculated_gratification numeric(10,2),
    capped_gratification numeric(10,2),
    cap_applied character varying(50),
    action_code character varying(50),
    action_code_id character varying(50),
    action_description text,
    freshdesk_status integer,
    freshdesk_status_name character varying(100),
    overall_confidence numeric(5,4),
    issue_confidence numeric(5,4),
    evaluation_confidence numeric(5,4),
    action_confidence numeric(5,4),
    model_used character varying(100),
    decision_reasoning text,
    raw_response_step1 text,
    raw_response_step2 text,
    status integer DEFAULT 0,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    execution_id character varying(100),
    execution_type character varying(50),
    is_complete boolean DEFAULT false,
    agent_id character varying(100),
    pipeline_status character varying(50) DEFAULT 'in_progress'::character varying,
    parent_llm_output_2_id integer,
    module character varying(100),
    model_version character varying
);


--
-- Name: COLUMN llm_output_2.execution_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.execution_id IS 'Links to cardinal_execution_plans';


--
-- Name: COLUMN llm_output_2.execution_type; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.execution_type IS 'full_pipeline | stage_test | manual | reprocess';


--
-- Name: COLUMN llm_output_2.is_complete; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.is_complete IS 'True if full pipeline (Stage 0→1→2→3) completed';


--
-- Name: COLUMN llm_output_2.agent_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.agent_id IS 'Agent/Worker ID that processed this';


--
-- Name: COLUMN llm_output_2.pipeline_status; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.pipeline_status IS 'in_progress | completed | failed | testing';


--
-- Name: COLUMN llm_output_2.parent_llm_output_2_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_2.parent_llm_output_2_id IS 'If reprocess, links to original record';


--
-- Name: llm_output_2_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.llm_output_2_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_output_2_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.llm_output_2_id_seq OWNED BY kirana_kart.llm_output_2.id;


--
-- Name: llm_output_3; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.llm_output_3 (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    order_id character varying(100),
    llm_output_2_id integer,
    final_action_code character varying(50),
    final_action_name character varying(255),
    final_refund_amount numeric(10,2),
    logic_validation_status character varying(50),
    automation_pathway character varying(50),
    cap_applied_flag boolean DEFAULT false,
    history_check_flag boolean DEFAULT false,
    validation_standard_logic boolean,
    validation_lifetime_igcc boolean,
    validation_exceptions_60d boolean,
    validation_igcc_history boolean,
    validation_same_issue boolean,
    validation_aon_bod boolean,
    validation_greedy_check boolean,
    validation_hrx_check boolean,
    validation_multiplier boolean,
    validation_cap boolean,
    validation_image boolean,
    validated_multiplier numeric(5,2),
    validated_calculated_gratification numeric(10,2),
    validated_capped_gratification numeric(10,2),
    validated_cap_applied character varying(50),
    validated_greedy_signals integer,
    validated_greedy_classification character varying(50),
    llm_standard_logic_match boolean,
    llm_greedy_match boolean,
    llm_multiplier_match boolean,
    llm_gratification_match boolean,
    llm_overall_accuracy numeric(5,4),
    discrepancy_detected boolean DEFAULT false,
    discrepancy_count integer DEFAULT 0,
    discrepancy_details text,
    discrepancy_severity character varying(50),
    override_applied boolean DEFAULT false,
    override_reason text,
    override_type character varying(50),
    detailed_reasoning text,
    audit_log text,
    freshdesk_status integer,
    freshdesk_code character varying(50),
    is_synced integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    execution_id character varying(100),
    execution_type character varying(50),
    is_complete boolean DEFAULT false,
    agent_id character varying(100),
    pipeline_status character varying(50) DEFAULT 'completed'::character varying,
    parent_llm_output_3_id integer,
    module character varying(100),
    policy_version character varying,
    policy_artifact_hash character varying,
    decision_trace jsonb
);


--
-- Name: COLUMN llm_output_3.execution_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.execution_id IS 'Links to cardinal_execution_plans';


--
-- Name: COLUMN llm_output_3.execution_type; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.execution_type IS 'full_pipeline | stage_test | manual | reprocess';


--
-- Name: COLUMN llm_output_3.is_complete; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.is_complete IS 'True if full pipeline (Stage 0→1→2→3) completed';


--
-- Name: COLUMN llm_output_3.agent_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.agent_id IS 'Agent/Worker ID that processed this';


--
-- Name: COLUMN llm_output_3.pipeline_status; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.pipeline_status IS 'in_progress | completed | failed | testing';


--
-- Name: COLUMN llm_output_3.parent_llm_output_3_id; Type: COMMENT; Schema: kirana_kart; Owner: -
--

COMMENT ON COLUMN kirana_kart.llm_output_3.parent_llm_output_3_id IS 'If reprocess, links to original record';


--
-- Name: llm_output_3_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.llm_output_3_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_output_3_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.llm_output_3_id_seq OWNED BY kirana_kart.llm_output_3.id;


--
-- Name: master_action_codes; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.master_action_codes (
    id integer NOT NULL,
    action_key character varying(100) NOT NULL,
    action_code_id character varying(100) NOT NULL,
    action_name character varying(255),
    action_description text,
    freshdesk_status integer,
    freshdesk_status_name character varying(100),
    requires_refund boolean DEFAULT false,
    requires_escalation boolean DEFAULT false,
    automation_eligible boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    exact_action text,
    parent_issue_codes text[] DEFAULT '{}'::text[]
);


--
-- Name: master_action_codes_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.master_action_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: master_action_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.master_action_codes_id_seq OWNED BY kirana_kart.master_action_codes.id;


--
-- Name: ml_model_registry; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.ml_model_registry (
    id integer NOT NULL,
    kb_id text DEFAULT 'default'::text NOT NULL,
    model_name text NOT NULL,
    model_version text NOT NULL,
    accuracy double precision,
    f1_score double precision,
    training_sample_count integer,
    model_path text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    trained_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ml_model_registry_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.ml_model_registry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ml_model_registry_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.ml_model_registry_id_seq OWNED BY kirana_kart.ml_model_registry.id;


--
-- Name: ml_training_samples; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.ml_training_samples (
    id integer NOT NULL,
    kb_id text DEFAULT 'default'::text NOT NULL,
    model_name text NOT NULL,
    input_data jsonb NOT NULL,
    llm_output jsonb,
    corrected_output jsonb,
    correction_type text,
    confidence_at_inference double precision,
    model_was_used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ml_training_samples_correction_type_check CHECK ((correction_type = ANY (ARRAY['accept'::text, 'edit'::text, 'delete'::text, 'manual_add'::text])))
);


--
-- Name: ml_training_samples_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.ml_training_samples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ml_training_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.ml_training_samples_id_seq OWNED BY kirana_kart.ml_training_samples.id;


--
-- Name: model_registry; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.model_registry (
    model_name character varying NOT NULL,
    model_version character varying NOT NULL,
    deployed_at timestamp with time zone,
    is_active boolean
);


--
-- Name: orders; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.orders (
    order_id text NOT NULL,
    customer_id text NOT NULL,
    order_value numeric(12,2) NOT NULL,
    delivery_estimated timestamp with time zone,
    delivery_actual timestamp with time zone,
    sla_breach boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pii_access_log; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.pii_access_log (
    id bigint NOT NULL,
    accessed_by integer,
    entity_type character varying(30) NOT NULL,
    entity_id character varying(100) NOT NULL,
    fields_accessed text[] NOT NULL,
    endpoint character varying(300),
    ip_address inet,
    accessed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pii_access_log_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.pii_access_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pii_access_log_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.pii_access_log_id_seq OWNED BY kirana_kart.pii_access_log.id;


--
-- Name: policy_shadow_results; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.policy_shadow_results (
    id integer NOT NULL,
    ticket_id character varying,
    active_policy_version character varying,
    candidate_policy_version character varying,
    active_action_code character varying,
    shadow_action_code character varying,
    decision_changed boolean,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: policy_shadow_results_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.policy_shadow_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_shadow_results_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.policy_shadow_results_id_seq OWNED BY kirana_kart.policy_shadow_results.id;


--
-- Name: policy_simulation_results; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.policy_simulation_results (
    id integer NOT NULL,
    run_id integer,
    ticket_id character varying,
    baseline_action character varying,
    candidate_action character varying,
    changed boolean
);


--
-- Name: policy_simulation_results_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.policy_simulation_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_simulation_results_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.policy_simulation_results_id_seq OWNED BY kirana_kart.policy_simulation_results.id;


--
-- Name: policy_simulation_runs; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.policy_simulation_runs (
    id integer NOT NULL,
    policy_version character varying,
    baseline_version character varying,
    tickets_processed integer,
    differences_found integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: policy_simulation_runs_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.policy_simulation_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_simulation_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.policy_simulation_runs_id_seq OWNED BY kirana_kart.policy_simulation_runs.id;


--
-- Name: policy_versions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.policy_versions (
    policy_version character varying NOT NULL,
    description text,
    activated_at timestamp with time zone,
    is_active boolean DEFAULT false,
    artifact_hash character varying,
    vector_collection character varying,
    created_at timestamp with time zone DEFAULT now(),
    vector_status text DEFAULT 'pending'::text,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: qa_evaluations; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.qa_evaluations (
    id integer NOT NULL,
    session_id integer NOT NULL,
    ticket_id integer NOT NULL,
    execution_id character varying(100),
    classification_score numeric(5,4),
    policy_compliance_score numeric(5,4),
    confidence_score numeric(5,4),
    gratification_score numeric(5,4),
    sla_score numeric(5,4),
    discrepancy_score numeric(5,4),
    response_quality_score numeric(5,4),
    kb_alignment_score numeric(5,4),
    override_score numeric(5,4),
    fraud_score numeric(5,4),
    overall_score numeric(5,4),
    grade character varying(2),
    findings jsonb,
    kb_evidence jsonb,
    ticket_subject text,
    ticket_module character varying(100),
    issue_type_l1 character varying(100),
    issue_type_l2 character varying(100),
    action_code character varying(100),
    overall_confidence numeric(5,4),
    status character varying(20) DEFAULT 'pending'::character varying,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    python_qa_score numeric(5,4),
    python_findings jsonb
);


--
-- Name: qa_evaluations_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.qa_evaluations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qa_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.qa_evaluations_id_seq OWNED BY kirana_kart.qa_evaluations.id;


--
-- Name: qa_flag_overrides; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.qa_flag_overrides (
    id integer NOT NULL,
    qa_evaluation_id integer NOT NULL,
    parameter_name text NOT NULL,
    original_score numeric(5,4),
    override_by integer,
    override_reason text,
    overridden_at timestamp without time zone DEFAULT now()
);


--
-- Name: qa_flag_overrides_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.qa_flag_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qa_flag_overrides_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.qa_flag_overrides_id_seq OWNED BY kirana_kart.qa_flag_overrides.id;


--
-- Name: qa_sessions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.qa_sessions (
    id integer NOT NULL,
    label character varying(200) DEFAULT 'New QA Session'::character varying NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: qa_sessions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.qa_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qa_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.qa_sessions_id_seq OWNED BY kirana_kart.qa_sessions.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.refresh_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.refresh_tokens_id_seq OWNED BY kirana_kart.refresh_tokens.id;


--
-- Name: refunds; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.refunds (
    refund_id bigint NOT NULL,
    ticket_id integer NOT NULL,
    order_id text NOT NULL,
    refund_amount numeric(12,2) NOT NULL,
    applied_action_code character varying(50) NOT NULL,
    refund_reason text,
    refund_source character varying(50),
    processed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: refunds_refund_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.refunds_refund_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refunds_refund_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.refunds_refund_id_seq OWNED BY kirana_kart.refunds.refund_id;


--
-- Name: response_templates; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.response_templates (
    id integer NOT NULL,
    template_ref character varying(100) NOT NULL,
    action_code_id character varying(100),
    issue_l1 character varying(100),
    issue_l2 character varying(100),
    template_v1 text,
    template_v2 text,
    template_v3 text,
    template_v4 text,
    template_v5 text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: response_templates_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.response_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: response_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.response_templates_id_seq OWNED BY kirana_kart.response_templates.id;


--
-- Name: retention_policies; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.retention_policies (
    data_category character varying(50) NOT NULL,
    retention_days integer NOT NULL,
    action_on_expiry character varying(20) DEFAULT 'anonymize'::character varying NOT NULL,
    description text
);


--
-- Name: rule_edit_log; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.rule_edit_log (
    id integer NOT NULL,
    kb_id text DEFAULT 'default'::text NOT NULL,
    entity_id text,
    stage text NOT NULL,
    item_ref text,
    edit_type text NOT NULL,
    llm_output jsonb,
    user_output jsonb,
    edit_reason text,
    extraction_confidence double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    CONSTRAINT rule_edit_log_edit_type_check CHECK ((edit_type = ANY (ARRAY['accepted'::text, 'edited'::text, 'rejected'::text, 'manual_add'::text]))),
    CONSTRAINT rule_edit_log_stage_check CHECK ((stage = ANY (ARRAY['taxonomy'::text, 'action'::text, 'rule'::text])))
);


--
-- Name: rule_edit_log_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.rule_edit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rule_edit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.rule_edit_log_id_seq OWNED BY kirana_kart.rule_edit_log.id;


--
-- Name: rule_registry; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.rule_registry (
    id integer NOT NULL,
    rule_id text NOT NULL,
    policy_version text NOT NULL,
    module_name text NOT NULL,
    rule_type text NOT NULL,
    priority integer DEFAULT 100,
    rule_scope text DEFAULT 'ticket'::text,
    filters jsonb DEFAULT '{}'::jsonb,
    numeric_constraints jsonb DEFAULT '{}'::jsonb,
    flags jsonb DEFAULT '{}'::jsonb,
    conditions jsonb DEFAULT '{}'::jsonb,
    action_id integer NOT NULL,
    action_payload jsonb DEFAULT '{}'::jsonb,
    overrideable boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    issue_type_l1 text,
    issue_type_l2 text,
    business_line text,
    customer_segment text,
    fraud_segment text,
    min_order_value numeric,
    max_order_value numeric,
    min_repeat_count integer,
    max_repeat_count integer,
    sla_breach_required boolean DEFAULT false,
    evidence_required boolean DEFAULT false,
    deterministic boolean DEFAULT true,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: rule_registry_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.rule_registry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rule_registry_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.rule_registry_id_seq OWNED BY kirana_kart.rule_registry.id;


--
-- Name: sandbox_run; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.sandbox_run (
    id bigint NOT NULL,
    original_execution_id character varying,
    scenario_name character varying,
    overrides jsonb,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: sandbox_run_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.sandbox_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sandbox_run_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.sandbox_run_id_seq OWNED BY kirana_kart.sandbox_run.id;


--
-- Name: simulation_tickets; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.simulation_tickets (
    ticket_id text NOT NULL,
    issue_type text,
    order_value numeric,
    fraud_score numeric,
    customer_tier text,
    business_line text
);


--
-- Name: taxonomy_drafts; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.taxonomy_drafts (
    id integer NOT NULL,
    issue_code character varying(100),
    label text,
    description text,
    parent_id integer,
    level integer,
    is_active boolean DEFAULT true,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: taxonomy_drafts_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.taxonomy_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: taxonomy_drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.taxonomy_drafts_id_seq OWNED BY kirana_kart.taxonomy_drafts.id;


--
-- Name: taxonomy_runtime_config; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.taxonomy_runtime_config (
    id integer NOT NULL,
    active_version character varying(50) NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    kb_id text DEFAULT 'default'::text NOT NULL
);


--
-- Name: taxonomy_runtime_config_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.taxonomy_runtime_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: taxonomy_runtime_config_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.taxonomy_runtime_config_id_seq OWNED BY kirana_kart.taxonomy_runtime_config.id;


--
-- Name: ticket_execution_summary; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.ticket_execution_summary (
    ticket_id integer NOT NULL,
    order_id text,
    customer_id text,
    issue_l1 character varying(100),
    issue_l2 character varying(100),
    applied_action_code character varying(50),
    action_category character varying(50),
    final_refund_amount numeric(12,2),
    fcr boolean,
    sla_breach boolean,
    csat_rating smallint,
    processed_at timestamp with time zone,
    policy_version character varying,
    policy_artifact_hash character varying
);


--
-- Name: ticket_processing_state; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.ticket_processing_state (
    id bigint NOT NULL,
    ticket_id integer NOT NULL,
    execution_id character varying(100),
    current_stage integer DEFAULT 0,
    stage_0_status character varying(20) DEFAULT 'pending'::character varying,
    stage_1_status character varying(20) DEFAULT 'pending'::character varying,
    stage_2_status character varying(20) DEFAULT 'pending'::character varying,
    stage_3_status character varying(20) DEFAULT 'pending'::character varying,
    stage_0_completed_at timestamp without time zone,
    stage_1_completed_at timestamp without time zone,
    stage_2_completed_at timestamp without time zone,
    stage_3_completed_at timestamp without time zone,
    claimed_by character varying(100),
    claimed_at timestamp without time zone,
    processing_started_at timestamp without time zone,
    processing_completed_at timestamp without time zone,
    error_message text,
    retry_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    module character varying(100)
);


--
-- Name: ticket_processing_state_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.ticket_processing_state_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ticket_processing_state_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.ticket_processing_state_id_seq OWNED BY kirana_kart.ticket_processing_state.id;


--
-- Name: user_permissions; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.user_permissions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    module character varying(50) NOT NULL,
    can_view boolean DEFAULT false NOT NULL,
    can_edit boolean DEFAULT false NOT NULL,
    can_admin boolean DEFAULT false NOT NULL
);


--
-- Name: user_permissions_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.user_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.user_permissions_id_seq OWNED BY kirana_kart.user_permissions.id;


--
-- Name: users; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    full_name character varying(255) DEFAULT ''::character varying NOT NULL,
    password_hash character varying(255),
    is_active boolean DEFAULT true NOT NULL,
    oauth_provider character varying(50),
    oauth_id character varying(255),
    avatar_url text,
    is_super_admin boolean DEFAULT false NOT NULL,
    date_of_birth date,
    guardian_consent_given boolean,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    crm_availability character varying(20) DEFAULT 'ONLINE'::character varying,
    CONSTRAINT users_crm_availability_check CHECK (((crm_availability)::text = ANY ((ARRAY['ONLINE'::character varying, 'BUSY'::character varying, 'AWAY'::character varying, 'OFFLINE'::character varying])::text[])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.users_id_seq OWNED BY kirana_kart.users.id;


--
-- Name: vector_jobs; Type: TABLE; Schema: kirana_kart; Owner: -
--

CREATE TABLE kirana_kart.vector_jobs (
    id integer NOT NULL,
    version_label character varying(50),
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    error text
);


--
-- Name: vector_jobs_id_seq; Type: SEQUENCE; Schema: kirana_kart; Owner: -
--

CREATE SEQUENCE kirana_kart.vector_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vector_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: kirana_kart; Owner: -
--

ALTER SEQUENCE kirana_kart.vector_jobs_id_seq OWNED BY kirana_kart.vector_jobs.id;


--
-- Name: admin_users id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.admin_users ALTER COLUMN id SET DEFAULT nextval('kirana_kart.admin_users_id_seq'::regclass);


--
-- Name: agent_decision_feedback id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.agent_decision_feedback ALTER COLUMN id SET DEFAULT nextval('kirana_kart.agent_decision_feedback_id_seq'::regclass);


--
-- Name: bi_chat_messages id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bi_chat_messages ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bi_chat_messages_id_seq'::regclass);


--
-- Name: bi_chat_sessions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bi_chat_sessions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bi_chat_sessions_id_seq'::regclass);


--
-- Name: bpm_approvals id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_approvals ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bpm_approvals_id_seq'::regclass);


--
-- Name: bpm_gate_results id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_gate_results ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bpm_gate_results_id_seq'::regclass);


--
-- Name: bpm_process_definitions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_definitions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bpm_process_definitions_id_seq'::regclass);


--
-- Name: bpm_process_instances id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_instances ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bpm_process_instances_id_seq'::regclass);


--
-- Name: bpm_stage_transitions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_stage_transitions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.bpm_stage_transitions_id_seq'::regclass);


--
-- Name: cardinal_beat_schedule id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_beat_schedule ALTER COLUMN id SET DEFAULT nextval('kirana_kart.cardinal_beat_schedule_id_seq'::regclass);


--
-- Name: cardinal_execution_plans id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_execution_plans ALTER COLUMN id SET DEFAULT nextval('kirana_kart.cardinal_execution_plans_id_seq'::regclass);


--
-- Name: consent_records id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.consent_records ALTER COLUMN id SET DEFAULT nextval('kirana_kart.consent_records_id_seq'::regclass);


--
-- Name: conversation_turns id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversation_turns ALTER COLUMN id SET DEFAULT nextval('kirana_kart.conversation_turns_id_seq'::regclass);


--
-- Name: conversations conversation_id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversations ALTER COLUMN conversation_id SET DEFAULT nextval('kirana_kart.conversations_conversation_id_seq'::regclass);


--
-- Name: crm_agent_actions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_agent_actions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_agent_actions_id_seq'::regclass);


--
-- Name: crm_automation_rules id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_automation_rules ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_automation_rules_id_seq'::regclass);


--
-- Name: crm_group_integrations id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_integrations ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_group_integrations_id_seq'::regclass);


--
-- Name: crm_groups id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_groups ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_groups_id_seq'::regclass);


--
-- Name: crm_merge_log id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_merge_log ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_merge_log_id_seq'::regclass);


--
-- Name: crm_notes id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notes ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_notes_id_seq'::regclass);


--
-- Name: crm_notifications id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notifications ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_notifications_id_seq'::regclass);


--
-- Name: crm_saved_views id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_saved_views ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_saved_views_id_seq'::regclass);


--
-- Name: crm_sla_policies id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_sla_policies ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_sla_policies_id_seq'::regclass);


--
-- Name: crm_tags id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_tags ALTER COLUMN id SET DEFAULT nextval('kirana_kart.crm_tags_id_seq'::regclass);


--
-- Name: csat_responses id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.csat_responses ALTER COLUMN id SET DEFAULT nextval('kirana_kart.csat_responses_id_seq'::regclass);


--
-- Name: delivery_events id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.delivery_events ALTER COLUMN id SET DEFAULT nextval('kirana_kart.delivery_events_id_seq'::regclass);


--
-- Name: draft_action_proposals id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_action_proposals ALTER COLUMN id SET DEFAULT nextval('kirana_kart.draft_action_proposals_id_seq'::regclass);


--
-- Name: draft_taxonomy_proposals id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_taxonomy_proposals ALTER COLUMN id SET DEFAULT nextval('kirana_kart.draft_taxonomy_proposals_id_seq'::regclass);


--
-- Name: entity_tags id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.entity_tags ALTER COLUMN id SET DEFAULT nextval('kirana_kart.entity_tags_id_seq'::regclass);


--
-- Name: execution_audit_log id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.execution_audit_log ALTER COLUMN id SET DEFAULT nextval('kirana_kart.execution_audit_log_id_seq'::regclass);


--
-- Name: execution_metrics id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.execution_metrics ALTER COLUMN id SET DEFAULT nextval('kirana_kart.execution_metrics_id_seq'::regclass);


--
-- Name: extraction_standards id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.extraction_standards ALTER COLUMN id SET DEFAULT nextval('kirana_kart.extraction_standards_id_seq'::regclass);


--
-- Name: fdraw sl; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.fdraw ALTER COLUMN sl SET DEFAULT nextval('kirana_kart.fdraw_sl_seq'::regclass);


--
-- Name: grievances id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.grievances ALTER COLUMN id SET DEFAULT nextval('kirana_kart.grievances_id_seq'::regclass);


--
-- Name: hitl_queue id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue ALTER COLUMN id SET DEFAULT nextval('kirana_kart.hitl_queue_id_seq'::regclass);


--
-- Name: integrations id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.integrations ALTER COLUMN id SET DEFAULT nextval('kirana_kart.integrations_id_seq'::regclass);


--
-- Name: issue_keywords id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_keywords ALTER COLUMN id SET DEFAULT nextval('kirana_kart.issue_keywords_id_seq'::regclass);


--
-- Name: issue_taxonomy id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy ALTER COLUMN id SET DEFAULT nextval('kirana_kart.issue_taxonomy_id_seq'::regclass);


--
-- Name: issue_taxonomy_audit id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_audit ALTER COLUMN id SET DEFAULT nextval('kirana_kart.issue_taxonomy_audit_id_seq'::regclass);


--
-- Name: issue_taxonomy_versions version_id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_versions ALTER COLUMN version_id SET DEFAULT nextval('kirana_kart.issue_taxonomy_versions_version_id_seq'::regclass);


--
-- Name: kb_runtime_config id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_runtime_config ALTER COLUMN id SET DEFAULT nextval('kirana_kart.kb_runtime_config_id_seq'::regclass);


--
-- Name: kb_user_access id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access ALTER COLUMN id SET DEFAULT nextval('kirana_kart.kb_user_access_id_seq'::regclass);


--
-- Name: kb_vector_jobs id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_vector_jobs ALTER COLUMN id SET DEFAULT nextval('kirana_kart.kb_vector_jobs_id_seq'::regclass);


--
-- Name: knowledge_base_audit id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_audit ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_base_audit_id_seq'::regclass);


--
-- Name: knowledge_base_chunks_drafts id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_chunks_drafts ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_base_chunks_drafts_id_seq'::regclass);


--
-- Name: knowledge_base_drafts id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_drafts ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_base_drafts_id_seq'::regclass);


--
-- Name: knowledge_base_raw_uploads id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_raw_uploads ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_base_raw_uploads_id_seq'::regclass);


--
-- Name: knowledge_base_versions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_versions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_base_versions_id_seq'::regclass);


--
-- Name: knowledge_bases id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_bases ALTER COLUMN id SET DEFAULT nextval('kirana_kart.knowledge_bases_id_seq'::regclass);


--
-- Name: llm_output_1 id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_1 ALTER COLUMN id SET DEFAULT nextval('kirana_kart.llm_output_1_id_seq'::regclass);


--
-- Name: llm_output_2 id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_2 ALTER COLUMN id SET DEFAULT nextval('kirana_kart.llm_output_2_id_seq'::regclass);


--
-- Name: llm_output_3 id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_3 ALTER COLUMN id SET DEFAULT nextval('kirana_kart.llm_output_3_id_seq'::regclass);


--
-- Name: master_action_codes id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.master_action_codes ALTER COLUMN id SET DEFAULT nextval('kirana_kart.master_action_codes_id_seq'::regclass);


--
-- Name: ml_model_registry id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_model_registry ALTER COLUMN id SET DEFAULT nextval('kirana_kart.ml_model_registry_id_seq'::regclass);


--
-- Name: ml_training_samples id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_training_samples ALTER COLUMN id SET DEFAULT nextval('kirana_kart.ml_training_samples_id_seq'::regclass);


--
-- Name: pii_access_log id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.pii_access_log ALTER COLUMN id SET DEFAULT nextval('kirana_kart.pii_access_log_id_seq'::regclass);


--
-- Name: policy_shadow_results id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_shadow_results ALTER COLUMN id SET DEFAULT nextval('kirana_kart.policy_shadow_results_id_seq'::regclass);


--
-- Name: policy_simulation_results id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_simulation_results ALTER COLUMN id SET DEFAULT nextval('kirana_kart.policy_simulation_results_id_seq'::regclass);


--
-- Name: policy_simulation_runs id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_simulation_runs ALTER COLUMN id SET DEFAULT nextval('kirana_kart.policy_simulation_runs_id_seq'::regclass);


--
-- Name: qa_evaluations id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_evaluations ALTER COLUMN id SET DEFAULT nextval('kirana_kart.qa_evaluations_id_seq'::regclass);


--
-- Name: qa_flag_overrides id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_flag_overrides ALTER COLUMN id SET DEFAULT nextval('kirana_kart.qa_flag_overrides_id_seq'::regclass);


--
-- Name: qa_sessions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_sessions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.qa_sessions_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('kirana_kart.refresh_tokens_id_seq'::regclass);


--
-- Name: refunds refund_id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refunds ALTER COLUMN refund_id SET DEFAULT nextval('kirana_kart.refunds_refund_id_seq'::regclass);


--
-- Name: response_templates id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.response_templates ALTER COLUMN id SET DEFAULT nextval('kirana_kart.response_templates_id_seq'::regclass);


--
-- Name: rule_edit_log id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_edit_log ALTER COLUMN id SET DEFAULT nextval('kirana_kart.rule_edit_log_id_seq'::regclass);


--
-- Name: rule_registry id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_registry ALTER COLUMN id SET DEFAULT nextval('kirana_kart.rule_registry_id_seq'::regclass);


--
-- Name: sandbox_run id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.sandbox_run ALTER COLUMN id SET DEFAULT nextval('kirana_kart.sandbox_run_id_seq'::regclass);


--
-- Name: taxonomy_drafts id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.taxonomy_drafts ALTER COLUMN id SET DEFAULT nextval('kirana_kart.taxonomy_drafts_id_seq'::regclass);


--
-- Name: taxonomy_runtime_config id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.taxonomy_runtime_config ALTER COLUMN id SET DEFAULT nextval('kirana_kart.taxonomy_runtime_config_id_seq'::regclass);


--
-- Name: ticket_processing_state id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_processing_state ALTER COLUMN id SET DEFAULT nextval('kirana_kart.ticket_processing_state_id_seq'::regclass);


--
-- Name: user_permissions id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.user_permissions ALTER COLUMN id SET DEFAULT nextval('kirana_kart.user_permissions_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.users ALTER COLUMN id SET DEFAULT nextval('kirana_kart.users_id_seq'::regclass);


--
-- Name: vector_jobs id; Type: DEFAULT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.vector_jobs ALTER COLUMN id SET DEFAULT nextval('kirana_kart.vector_jobs_id_seq'::regclass);


--
-- Name: action_registry_vectors action_registry_vectors_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.action_registry_vectors
    ADD CONSTRAINT action_registry_vectors_pkey PRIMARY KEY (action_code_id, corpus_version);


--
-- Name: admin_users admin_users_api_token_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.admin_users
    ADD CONSTRAINT admin_users_api_token_key UNIQUE (api_token);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: agent_decision_feedback agent_decision_feedback_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.agent_decision_feedback
    ADD CONSTRAINT agent_decision_feedback_pkey PRIMARY KEY (id);


--
-- Name: bi_chat_messages bi_chat_messages_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bi_chat_messages
    ADD CONSTRAINT bi_chat_messages_pkey PRIMARY KEY (id);


--
-- Name: bi_chat_sessions bi_chat_sessions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bi_chat_sessions
    ADD CONSTRAINT bi_chat_sessions_pkey PRIMARY KEY (id);


--
-- Name: bpm_approvals bpm_approvals_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_approvals
    ADD CONSTRAINT bpm_approvals_pkey PRIMARY KEY (id);


--
-- Name: bpm_gate_results bpm_gate_results_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_gate_results
    ADD CONSTRAINT bpm_gate_results_pkey PRIMARY KEY (id);


--
-- Name: bpm_process_definitions bpm_process_definitions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_definitions
    ADD CONSTRAINT bpm_process_definitions_pkey PRIMARY KEY (id);


--
-- Name: bpm_process_definitions bpm_process_definitions_process_name_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_definitions
    ADD CONSTRAINT bpm_process_definitions_process_name_key UNIQUE (process_name);


--
-- Name: bpm_process_instances bpm_process_instances_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_instances
    ADD CONSTRAINT bpm_process_instances_pkey PRIMARY KEY (id);


--
-- Name: bpm_stage_transitions bpm_stage_transitions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_stage_transitions
    ADD CONSTRAINT bpm_stage_transitions_pkey PRIMARY KEY (id);


--
-- Name: cardinal_beat_schedule cardinal_beat_schedule_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_beat_schedule
    ADD CONSTRAINT cardinal_beat_schedule_pkey PRIMARY KEY (id);


--
-- Name: cardinal_beat_schedule cardinal_beat_schedule_task_key_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_beat_schedule
    ADD CONSTRAINT cardinal_beat_schedule_task_key_key UNIQUE (task_key);


--
-- Name: cardinal_execution_plans cardinal_execution_plans_execution_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_execution_plans
    ADD CONSTRAINT cardinal_execution_plans_execution_id_key UNIQUE (execution_id);


--
-- Name: cardinal_execution_plans cardinal_execution_plans_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.cardinal_execution_plans
    ADD CONSTRAINT cardinal_execution_plans_pkey PRIMARY KEY (id);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: conversation_turns conversation_turns_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversation_turns
    ADD CONSTRAINT conversation_turns_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (conversation_id);


--
-- Name: conversations conversations_ticket_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversations
    ADD CONSTRAINT conversations_ticket_id_key UNIQUE (ticket_id);


--
-- Name: crm_agent_actions crm_agent_actions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_agent_actions
    ADD CONSTRAINT crm_agent_actions_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_rules crm_automation_rules_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_automation_rules
    ADD CONSTRAINT crm_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: crm_group_integrations crm_group_integrations_api_key_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_integrations
    ADD CONSTRAINT crm_group_integrations_api_key_key UNIQUE (api_key);


--
-- Name: crm_group_integrations crm_group_integrations_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_integrations
    ADD CONSTRAINT crm_group_integrations_pkey PRIMARY KEY (id);


--
-- Name: crm_group_members crm_group_members_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_members
    ADD CONSTRAINT crm_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: crm_groups crm_groups_name_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_groups
    ADD CONSTRAINT crm_groups_name_key UNIQUE (name);


--
-- Name: crm_groups crm_groups_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_groups
    ADD CONSTRAINT crm_groups_pkey PRIMARY KEY (id);


--
-- Name: crm_merge_log crm_merge_log_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_merge_log
    ADD CONSTRAINT crm_merge_log_pkey PRIMARY KEY (id);


--
-- Name: crm_notes crm_notes_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notes
    ADD CONSTRAINT crm_notes_pkey PRIMARY KEY (id);


--
-- Name: crm_notifications crm_notifications_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notifications
    ADD CONSTRAINT crm_notifications_pkey PRIMARY KEY (id);


--
-- Name: crm_saved_views crm_saved_views_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_saved_views
    ADD CONSTRAINT crm_saved_views_pkey PRIMARY KEY (id);


--
-- Name: crm_sla_policies crm_sla_policies_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_sla_policies
    ADD CONSTRAINT crm_sla_policies_pkey PRIMARY KEY (id);


--
-- Name: crm_sla_policies crm_sla_policies_queue_type_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_sla_policies
    ADD CONSTRAINT crm_sla_policies_queue_type_key UNIQUE (queue_type);


--
-- Name: crm_tags crm_tags_name_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_tags
    ADD CONSTRAINT crm_tags_name_key UNIQUE (name);


--
-- Name: crm_tags crm_tags_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_tags
    ADD CONSTRAINT crm_tags_pkey PRIMARY KEY (id);


--
-- Name: crm_ticket_tags crm_ticket_tags_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_ticket_tags
    ADD CONSTRAINT crm_ticket_tags_pkey PRIMARY KEY (ticket_id, tag_id);


--
-- Name: crm_watchers crm_watchers_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_watchers
    ADD CONSTRAINT crm_watchers_pkey PRIMARY KEY (ticket_id, user_id);


--
-- Name: csat_responses csat_responses_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.csat_responses
    ADD CONSTRAINT csat_responses_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (customer_id);


--
-- Name: delivery_events delivery_events_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.delivery_events
    ADD CONSTRAINT delivery_events_pkey PRIMARY KEY (id);


--
-- Name: dm_ticket_execution_summary dm_ticket_execution_summary_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.dm_ticket_execution_summary
    ADD CONSTRAINT dm_ticket_execution_summary_pkey PRIMARY KEY (ticket_id);


--
-- Name: draft_action_proposals draft_action_proposals_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_action_proposals
    ADD CONSTRAINT draft_action_proposals_pkey PRIMARY KEY (id);


--
-- Name: draft_taxonomy_proposals draft_taxonomy_proposals_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_taxonomy_proposals
    ADD CONSTRAINT draft_taxonomy_proposals_pkey PRIMARY KEY (id);


--
-- Name: entity_tags entity_tags_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.entity_tags
    ADD CONSTRAINT entity_tags_pkey PRIMARY KEY (id);


--
-- Name: execution_audit_log execution_audit_log_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.execution_audit_log
    ADD CONSTRAINT execution_audit_log_pkey PRIMARY KEY (id);


--
-- Name: execution_metrics execution_metrics_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.execution_metrics
    ADD CONSTRAINT execution_metrics_pkey PRIMARY KEY (id);


--
-- Name: extraction_standards extraction_standards_kb_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.extraction_standards
    ADD CONSTRAINT extraction_standards_kb_id_key UNIQUE (kb_id);


--
-- Name: extraction_standards extraction_standards_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.extraction_standards
    ADD CONSTRAINT extraction_standards_pkey PRIMARY KEY (id);


--
-- Name: fdraw fdraw_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.fdraw
    ADD CONSTRAINT fdraw_pkey PRIMARY KEY (sl);


--
-- Name: grievances grievances_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.grievances
    ADD CONSTRAINT grievances_pkey PRIMARY KEY (id);


--
-- Name: hitl_queue hitl_queue_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_pkey PRIMARY KEY (id);


--
-- Name: hitl_queue hitl_queue_ticket_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_ticket_id_key UNIQUE (ticket_id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: issue_keywords issue_keywords_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_keywords
    ADD CONSTRAINT issue_keywords_pkey PRIMARY KEY (id);


--
-- Name: issue_taxonomy_audit issue_taxonomy_audit_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_audit
    ADD CONSTRAINT issue_taxonomy_audit_pkey PRIMARY KEY (id);


--
-- Name: issue_taxonomy issue_taxonomy_issue_code_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy
    ADD CONSTRAINT issue_taxonomy_issue_code_key UNIQUE (issue_code);


--
-- Name: issue_taxonomy issue_taxonomy_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy
    ADD CONSTRAINT issue_taxonomy_pkey PRIMARY KEY (id);


--
-- Name: issue_taxonomy_versions issue_taxonomy_versions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_versions
    ADD CONSTRAINT issue_taxonomy_versions_pkey PRIMARY KEY (version_id);


--
-- Name: issue_taxonomy_versions issue_taxonomy_versions_version_label_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_versions
    ADD CONSTRAINT issue_taxonomy_versions_version_label_key UNIQUE (version_label);


--
-- Name: issue_type_vectors issue_type_vectors_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_type_vectors
    ADD CONSTRAINT issue_type_vectors_pkey PRIMARY KEY (issue_code, corpus_version);


--
-- Name: kb_rule_vectors kb_rule_vectors_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_rule_vectors
    ADD CONSTRAINT kb_rule_vectors_pkey PRIMARY KEY (rule_id, policy_version);


--
-- Name: kb_runtime_config kb_runtime_config_kb_id_unique; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_runtime_config
    ADD CONSTRAINT kb_runtime_config_kb_id_unique UNIQUE (kb_id);


--
-- Name: kb_runtime_config kb_runtime_config_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_runtime_config
    ADD CONSTRAINT kb_runtime_config_pkey PRIMARY KEY (id);


--
-- Name: kb_user_access kb_user_access_kb_id_user_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access
    ADD CONSTRAINT kb_user_access_kb_id_user_id_key UNIQUE (kb_id, user_id);


--
-- Name: kb_user_access kb_user_access_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access
    ADD CONSTRAINT kb_user_access_pkey PRIMARY KEY (id);


--
-- Name: kb_vector_jobs kb_vector_jobs_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_vector_jobs
    ADD CONSTRAINT kb_vector_jobs_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_audit knowledge_base_audit_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_audit
    ADD CONSTRAINT knowledge_base_audit_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_chunks_drafts knowledge_base_chunks_drafts_chunk_id_version_label_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_chunks_drafts
    ADD CONSTRAINT knowledge_base_chunks_drafts_chunk_id_version_label_key UNIQUE (chunk_id, version_label);


--
-- Name: knowledge_base_chunks_drafts knowledge_base_chunks_drafts_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_chunks_drafts
    ADD CONSTRAINT knowledge_base_chunks_drafts_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_drafts knowledge_base_drafts_document_id_version_label_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_drafts
    ADD CONSTRAINT knowledge_base_drafts_document_id_version_label_key UNIQUE (document_id, version_label);


--
-- Name: knowledge_base_drafts knowledge_base_drafts_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_drafts
    ADD CONSTRAINT knowledge_base_drafts_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_raw_uploads knowledge_base_raw_uploads_document_id_uploaded_at_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_raw_uploads
    ADD CONSTRAINT knowledge_base_raw_uploads_document_id_uploaded_at_key UNIQUE (document_id, uploaded_at);


--
-- Name: knowledge_base_raw_uploads knowledge_base_raw_uploads_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_raw_uploads
    ADD CONSTRAINT knowledge_base_raw_uploads_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_versions knowledge_base_versions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_versions
    ADD CONSTRAINT knowledge_base_versions_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base_versions knowledge_base_versions_version_label_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_versions
    ADD CONSTRAINT knowledge_base_versions_version_label_key UNIQUE (version_label);


--
-- Name: knowledge_bases knowledge_bases_kb_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_bases
    ADD CONSTRAINT knowledge_bases_kb_id_key UNIQUE (kb_id);


--
-- Name: knowledge_bases knowledge_bases_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_bases
    ADD CONSTRAINT knowledge_bases_pkey PRIMARY KEY (id);


--
-- Name: llm_output_1 llm_output_1_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_1
    ADD CONSTRAINT llm_output_1_pkey PRIMARY KEY (id);


--
-- Name: llm_output_2 llm_output_2_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_2
    ADD CONSTRAINT llm_output_2_pkey PRIMARY KEY (id);


--
-- Name: llm_output_3 llm_output_3_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_3
    ADD CONSTRAINT llm_output_3_pkey PRIMARY KEY (id);


--
-- Name: master_action_codes master_action_codes_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.master_action_codes
    ADD CONSTRAINT master_action_codes_pkey PRIMARY KEY (id);


--
-- Name: ml_model_registry ml_model_registry_kb_id_model_name_model_version_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_model_registry
    ADD CONSTRAINT ml_model_registry_kb_id_model_name_model_version_key UNIQUE (kb_id, model_name, model_version);


--
-- Name: ml_model_registry ml_model_registry_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_model_registry
    ADD CONSTRAINT ml_model_registry_pkey PRIMARY KEY (id);


--
-- Name: ml_training_samples ml_training_samples_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_training_samples
    ADD CONSTRAINT ml_training_samples_pkey PRIMARY KEY (id);


--
-- Name: model_registry model_registry_pk; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.model_registry
    ADD CONSTRAINT model_registry_pk PRIMARY KEY (model_name, model_version);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id);


--
-- Name: pii_access_log pii_access_log_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.pii_access_log
    ADD CONSTRAINT pii_access_log_pkey PRIMARY KEY (id);


--
-- Name: policy_shadow_results policy_shadow_results_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_shadow_results
    ADD CONSTRAINT policy_shadow_results_pkey PRIMARY KEY (id);


--
-- Name: policy_simulation_results policy_simulation_results_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_simulation_results
    ADD CONSTRAINT policy_simulation_results_pkey PRIMARY KEY (id);


--
-- Name: policy_simulation_runs policy_simulation_runs_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_simulation_runs
    ADD CONSTRAINT policy_simulation_runs_pkey PRIMARY KEY (id);


--
-- Name: policy_versions policy_version_hash_unique; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_versions
    ADD CONSTRAINT policy_version_hash_unique UNIQUE (policy_version, artifact_hash);


--
-- Name: policy_versions policy_versions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_versions
    ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (policy_version);


--
-- Name: qa_evaluations qa_evaluations_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_evaluations
    ADD CONSTRAINT qa_evaluations_pkey PRIMARY KEY (id);


--
-- Name: qa_flag_overrides qa_flag_overrides_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_flag_overrides
    ADD CONSTRAINT qa_flag_overrides_pkey PRIMARY KEY (id);


--
-- Name: qa_sessions qa_sessions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_sessions
    ADD CONSTRAINT qa_sessions_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (refund_id);


--
-- Name: response_templates response_templates_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.response_templates
    ADD CONSTRAINT response_templates_pkey PRIMARY KEY (id);


--
-- Name: retention_policies retention_policies_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.retention_policies
    ADD CONSTRAINT retention_policies_pkey PRIMARY KEY (data_category);


--
-- Name: rule_edit_log rule_edit_log_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_edit_log
    ADD CONSTRAINT rule_edit_log_pkey PRIMARY KEY (id);


--
-- Name: rule_registry rule_registry_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_registry
    ADD CONSTRAINT rule_registry_pkey PRIMARY KEY (id);


--
-- Name: sandbox_run sandbox_run_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.sandbox_run
    ADD CONSTRAINT sandbox_run_pkey PRIMARY KEY (id);


--
-- Name: simulation_tickets simulation_tickets_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.simulation_tickets
    ADD CONSTRAINT simulation_tickets_pkey PRIMARY KEY (ticket_id);


--
-- Name: taxonomy_drafts taxonomy_drafts_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.taxonomy_drafts
    ADD CONSTRAINT taxonomy_drafts_pkey PRIMARY KEY (id);


--
-- Name: taxonomy_runtime_config taxonomy_runtime_config_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.taxonomy_runtime_config
    ADD CONSTRAINT taxonomy_runtime_config_pkey PRIMARY KEY (id);


--
-- Name: ticket_execution_summary ticket_execution_summary_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_execution_summary
    ADD CONSTRAINT ticket_execution_summary_pkey PRIMARY KEY (ticket_id);


--
-- Name: ticket_processing_state ticket_processing_state_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_processing_state
    ADD CONSTRAINT ticket_processing_state_pkey PRIMARY KEY (id);


--
-- Name: ticket_processing_state ticket_processing_state_ticket_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_processing_state
    ADD CONSTRAINT ticket_processing_state_ticket_id_key UNIQUE (ticket_id);


--
-- Name: llm_output_1 unique_ticket_execution_llm1; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_1
    ADD CONSTRAINT unique_ticket_execution_llm1 UNIQUE (ticket_id, execution_id);


--
-- Name: llm_output_2 unique_ticket_execution_llm2; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_2
    ADD CONSTRAINT unique_ticket_execution_llm2 UNIQUE (ticket_id, execution_id);


--
-- Name: llm_output_3 unique_ticket_execution_llm3; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_3
    ADD CONSTRAINT unique_ticket_execution_llm3 UNIQUE (ticket_id, execution_id);


--
-- Name: fdraw unique_ticket_id; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.fdraw
    ADD CONSTRAINT unique_ticket_id UNIQUE (ticket_id);


--
-- Name: master_action_codes uq_master_action_codes_action_code_id; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.master_action_codes
    ADD CONSTRAINT uq_master_action_codes_action_code_id UNIQUE (action_code_id);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_module_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.user_permissions
    ADD CONSTRAINT user_permissions_user_id_module_key UNIQUE (user_id, module);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_oauth_provider_oauth_id_key; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.users
    ADD CONSTRAINT users_oauth_provider_oauth_id_key UNIQUE (oauth_provider, oauth_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vector_jobs vector_jobs_pkey; Type: CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.vector_jobs
    ADD CONSTRAINT vector_jobs_pkey PRIMARY KEY (id);


--
-- Name: idx_adf_created; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_adf_created ON kirana_kart.agent_decision_feedback USING btree (created_at DESC);


--
-- Name: idx_adf_outcome; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_adf_outcome ON kirana_kart.agent_decision_feedback USING btree (outcome);


--
-- Name: idx_adf_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_adf_ticket ON kirana_kart.agent_decision_feedback USING btree (ticket_id);


--
-- Name: idx_bpm_approvals_instance; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_approvals_instance ON kirana_kart.bpm_approvals USING btree (instance_id);


--
-- Name: idx_bpm_approvals_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_approvals_status ON kirana_kart.bpm_approvals USING btree (status);


--
-- Name: idx_bpm_gate_results_instance; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_gate_results_instance ON kirana_kart.bpm_gate_results USING btree (instance_id);


--
-- Name: idx_bpm_gate_results_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_gate_results_type ON kirana_kart.bpm_gate_results USING btree (gate_type);


--
-- Name: idx_bpm_instances_entity; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_instances_entity ON kirana_kart.bpm_process_instances USING btree (entity_id, entity_type);


--
-- Name: idx_bpm_instances_kb; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_instances_kb ON kirana_kart.bpm_process_instances USING btree (kb_id);


--
-- Name: idx_bpm_instances_stage; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_instances_stage ON kirana_kart.bpm_process_instances USING btree (current_stage);


--
-- Name: idx_bpm_transitions_at; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_transitions_at ON kirana_kart.bpm_stage_transitions USING btree (transitioned_at DESC);


--
-- Name: idx_bpm_transitions_instance; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_bpm_transitions_instance ON kirana_kart.bpm_stage_transitions USING btree (instance_id);


--
-- Name: idx_consent_principal; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_consent_principal ON kirana_kart.consent_records USING btree (data_principal_id, principal_type);


--
-- Name: idx_conv_turns_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_conv_turns_ticket ON kirana_kart.conversation_turns USING btree (ticket_id);


--
-- Name: idx_conversations_customer; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_conversations_customer ON kirana_kart.conversations USING btree (customer_id);


--
-- Name: idx_conversations_order; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_conversations_order ON kirana_kart.conversations USING btree (order_id);


--
-- Name: idx_crm_actions_actor; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_actions_actor ON kirana_kart.crm_agent_actions USING btree (actor_id);


--
-- Name: idx_crm_actions_created; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_actions_created ON kirana_kart.crm_agent_actions USING btree (created_at DESC);


--
-- Name: idx_crm_actions_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_actions_ticket ON kirana_kart.crm_agent_actions USING btree (ticket_id);


--
-- Name: idx_crm_auto_rules_trigger; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_auto_rules_trigger ON kirana_kart.crm_automation_rules USING btree (trigger_event, is_active);


--
-- Name: idx_crm_group_members_user; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_group_members_user ON kirana_kart.crm_group_members USING btree (user_id);


--
-- Name: idx_crm_integrations_apikey; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_integrations_apikey ON kirana_kart.crm_group_integrations USING btree (api_key) WHERE (api_key IS NOT NULL);


--
-- Name: idx_crm_integrations_group; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_integrations_group ON kirana_kart.crm_group_integrations USING btree (group_id);


--
-- Name: idx_crm_notes_created; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_notes_created ON kirana_kart.crm_notes USING btree (created_at DESC);


--
-- Name: idx_crm_notes_queue; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_notes_queue ON kirana_kart.crm_notes USING btree (queue_id);


--
-- Name: idx_crm_notes_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_notes_ticket ON kirana_kart.crm_notes USING btree (ticket_id);


--
-- Name: idx_crm_notif_recipient; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_notif_recipient ON kirana_kart.crm_notifications USING btree (recipient_id, is_read, created_at DESC);


--
-- Name: idx_crm_notif_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_crm_notif_ticket ON kirana_kart.crm_notifications USING btree (ticket_id);


--
-- Name: idx_csat_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_csat_ticket ON kirana_kart.csat_responses USING btree (ticket_id);


--
-- Name: idx_customers_churn_prob; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_customers_churn_prob ON kirana_kart.customers USING btree (customer_churn_probability);


--
-- Name: idx_customers_igcc_rate; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_customers_igcc_rate ON kirana_kart.customers USING btree (lifetime_igcc_rate);


--
-- Name: idx_customers_segment; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_customers_segment ON kirana_kart.customers USING btree (segment);


--
-- Name: idx_delivery_events_order; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_delivery_events_order ON kirana_kart.delivery_events USING btree (order_id);


--
-- Name: idx_dm_ticket_execution_summary_customer_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_dm_ticket_execution_summary_customer_id ON kirana_kart.dm_ticket_execution_summary USING btree (customer_id);


--
-- Name: idx_dm_ticket_execution_summary_order_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_dm_ticket_execution_summary_order_id ON kirana_kart.dm_ticket_execution_summary USING btree (order_id);


--
-- Name: idx_draft_act_kb_entity; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_draft_act_kb_entity ON kirana_kart.draft_action_proposals USING btree (kb_id, entity_id);


--
-- Name: idx_draft_act_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_draft_act_status ON kirana_kart.draft_action_proposals USING btree (status);


--
-- Name: idx_draft_tax_kb_entity; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_draft_tax_kb_entity ON kirana_kart.draft_taxonomy_proposals USING btree (kb_id, entity_id);


--
-- Name: idx_draft_tax_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_draft_tax_status ON kirana_kart.draft_taxonomy_proposals USING btree (status);


--
-- Name: idx_execution_audit_log_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_audit_log_execution_id ON kirana_kart.execution_audit_log USING btree (execution_id);


--
-- Name: idx_execution_audit_log_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_audit_log_ticket_id ON kirana_kart.execution_audit_log USING btree (ticket_id);


--
-- Name: idx_execution_metrics_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_metrics_execution_id ON kirana_kart.execution_metrics USING btree (execution_id);


--
-- Name: idx_execution_metrics_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_metrics_ticket_id ON kirana_kart.execution_metrics USING btree (ticket_id);


--
-- Name: idx_execution_plans_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_plans_execution_id ON kirana_kart.cardinal_execution_plans USING btree (execution_id);


--
-- Name: idx_execution_plans_org; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_plans_org ON kirana_kart.cardinal_execution_plans USING btree (org, business_line, module);


--
-- Name: idx_execution_plans_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_execution_plans_status ON kirana_kart.cardinal_execution_plans USING btree (status);


--
-- Name: idx_fdraw_created_at; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_created_at ON kirana_kart.fdraw USING btree (created_at);


--
-- Name: idx_fdraw_detected_language; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_detected_language ON kirana_kart.fdraw USING btree (detected_language);


--
-- Name: idx_fdraw_module; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_module ON kirana_kart.fdraw USING btree (module);


--
-- Name: idx_fdraw_source; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_source ON kirana_kart.fdraw USING btree (source);


--
-- Name: idx_fdraw_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_status ON kirana_kart.fdraw USING btree (status);


--
-- Name: idx_fdraw_thread_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_thread_id ON kirana_kart.fdraw USING btree (thread_id);


--
-- Name: idx_fdraw_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_fdraw_ticket_id ON kirana_kart.fdraw USING btree (ticket_id);


--
-- Name: idx_hitl_assigned_to; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_assigned_to ON kirana_kart.hitl_queue USING btree (assigned_to);


--
-- Name: idx_hitl_created_at; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_created_at ON kirana_kart.hitl_queue USING btree (created_at DESC);


--
-- Name: idx_hitl_customer_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_customer_id ON kirana_kart.hitl_queue USING btree (customer_id);


--
-- Name: idx_hitl_group_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_group_id ON kirana_kart.hitl_queue USING btree (group_id);


--
-- Name: idx_hitl_priority_sla; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_priority_sla ON kirana_kart.hitl_queue USING btree (priority, sla_due_at);


--
-- Name: idx_hitl_queue_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_queue_type ON kirana_kart.hitl_queue USING btree (queue_type);


--
-- Name: idx_hitl_sla_due; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_sla_due ON kirana_kart.hitl_queue USING btree (sla_due_at);


--
-- Name: idx_hitl_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_hitl_status ON kirana_kart.hitl_queue USING btree (status);


--
-- Name: idx_issue_keywords_issue; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_issue_keywords_issue ON kirana_kart.issue_keywords USING btree (issue_id);


--
-- Name: idx_issue_taxonomy_active; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_issue_taxonomy_active ON kirana_kart.issue_taxonomy USING btree (is_active);


--
-- Name: idx_issue_taxonomy_level; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_issue_taxonomy_level ON kirana_kart.issue_taxonomy USING btree (level);


--
-- Name: idx_issue_taxonomy_parent; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_issue_taxonomy_parent ON kirana_kart.issue_taxonomy USING btree (parent_id);


--
-- Name: idx_kb_chunks_domain; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_chunks_domain ON kirana_kart.knowledge_base_chunks_drafts USING btree (domain);


--
-- Name: idx_kb_chunks_issue_codes; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_chunks_issue_codes ON kirana_kart.knowledge_base_chunks_drafts USING gin (linked_issue_codes);


--
-- Name: idx_kb_drafts_category; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_drafts_category ON kirana_kart.knowledge_base_drafts USING btree (category);


--
-- Name: idx_kb_drafts_domain; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_drafts_domain ON kirana_kart.knowledge_base_drafts USING btree (domain);


--
-- Name: idx_kb_single_active; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE UNIQUE INDEX idx_kb_single_active ON kirana_kart.kb_runtime_config USING btree (id) WHERE (id = 1);


--
-- Name: idx_kb_user_access_kb; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_user_access_kb ON kirana_kart.kb_user_access USING btree (kb_id);


--
-- Name: idx_kb_user_access_user; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_kb_user_access_user ON kirana_kart.kb_user_access USING btree (user_id);


--
-- Name: idx_llm1_agent_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm1_agent_id ON kirana_kart.llm_output_1 USING btree (agent_id);


--
-- Name: idx_llm1_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm1_execution_id ON kirana_kart.llm_output_1 USING btree (execution_id);


--
-- Name: idx_llm1_execution_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm1_execution_type ON kirana_kart.llm_output_1 USING btree (execution_type);


--
-- Name: idx_llm1_is_complete; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm1_is_complete ON kirana_kart.llm_output_1 USING btree (is_complete);


--
-- Name: idx_llm1_pipeline_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm1_pipeline_status ON kirana_kart.llm_output_1 USING btree (pipeline_status);


--
-- Name: idx_llm2_agent_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm2_agent_id ON kirana_kart.llm_output_2 USING btree (agent_id);


--
-- Name: idx_llm2_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm2_execution_id ON kirana_kart.llm_output_2 USING btree (execution_id);


--
-- Name: idx_llm2_execution_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm2_execution_type ON kirana_kart.llm_output_2 USING btree (execution_type);


--
-- Name: idx_llm2_is_complete; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm2_is_complete ON kirana_kart.llm_output_2 USING btree (is_complete);


--
-- Name: idx_llm3_agent_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm3_agent_id ON kirana_kart.llm_output_3 USING btree (agent_id);


--
-- Name: idx_llm3_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm3_execution_id ON kirana_kart.llm_output_3 USING btree (execution_id);


--
-- Name: idx_llm3_execution_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm3_execution_type ON kirana_kart.llm_output_3 USING btree (execution_type);


--
-- Name: idx_llm3_is_complete; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm3_is_complete ON kirana_kart.llm_output_3 USING btree (is_complete);


--
-- Name: idx_llm_output_1_module; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_1_module ON kirana_kart.llm_output_1 USING btree (module);


--
-- Name: idx_llm_output_1_order_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_1_order_id ON kirana_kart.llm_output_1 USING btree (order_id);


--
-- Name: idx_llm_output_1_status; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_1_status ON kirana_kart.llm_output_1 USING btree (status);


--
-- Name: idx_llm_output_1_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_1_ticket_id ON kirana_kart.llm_output_1 USING btree (ticket_id);


--
-- Name: idx_llm_output_2_llm_output_1_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_2_llm_output_1_id ON kirana_kart.llm_output_2 USING btree (llm_output_1_id);


--
-- Name: idx_llm_output_2_module; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_2_module ON kirana_kart.llm_output_2 USING btree (module);


--
-- Name: idx_llm_output_2_order_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_2_order_id ON kirana_kart.llm_output_2 USING btree (order_id);


--
-- Name: idx_llm_output_2_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_2_ticket_id ON kirana_kart.llm_output_2 USING btree (ticket_id);


--
-- Name: idx_llm_output_3_llm_output_2_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_3_llm_output_2_id ON kirana_kart.llm_output_3 USING btree (llm_output_2_id);


--
-- Name: idx_llm_output_3_module; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_3_module ON kirana_kart.llm_output_3 USING btree (module);


--
-- Name: idx_llm_output_3_order_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_3_order_id ON kirana_kart.llm_output_3 USING btree (order_id);


--
-- Name: idx_llm_output_3_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_llm_output_3_ticket_id ON kirana_kart.llm_output_3 USING btree (ticket_id);


--
-- Name: idx_master_action_codes_action_code_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_master_action_codes_action_code_id ON kirana_kart.master_action_codes USING btree (action_code_id);


--
-- Name: idx_master_action_codes_action_key; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_master_action_codes_action_key ON kirana_kart.master_action_codes USING btree (action_key);


--
-- Name: idx_ml_registry_active; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ml_registry_active ON kirana_kart.ml_model_registry USING btree (is_active);


--
-- Name: idx_ml_registry_kb_model; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ml_registry_kb_model ON kirana_kart.ml_model_registry USING btree (kb_id, model_name);


--
-- Name: idx_ml_samples_kb; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ml_samples_kb ON kirana_kart.ml_training_samples USING btree (kb_id);


--
-- Name: idx_ml_samples_model; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ml_samples_model ON kirana_kart.ml_training_samples USING btree (model_name);


--
-- Name: idx_ml_samples_type; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ml_samples_type ON kirana_kart.ml_training_samples USING btree (correction_type);


--
-- Name: idx_one_active_policy; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE UNIQUE INDEX idx_one_active_policy ON kirana_kart.policy_versions USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_orders_customer_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_orders_customer_id ON kirana_kart.orders USING btree (customer_id);


--
-- Name: idx_orders_sla_breach; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_orders_sla_breach ON kirana_kart.orders USING btree (sla_breach);


--
-- Name: idx_pii_audit_accessor; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_pii_audit_accessor ON kirana_kart.pii_access_log USING btree (accessed_by, accessed_at DESC);


--
-- Name: idx_pii_audit_entity; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_pii_audit_entity ON kirana_kart.pii_access_log USING btree (entity_type, entity_id);


--
-- Name: idx_qa_evaluations_session; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_qa_evaluations_session ON kirana_kart.qa_evaluations USING btree (session_id);


--
-- Name: idx_qa_evaluations_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_qa_evaluations_ticket ON kirana_kart.qa_evaluations USING btree (ticket_id);


--
-- Name: idx_qa_flag_overrides_eval; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_qa_flag_overrides_eval ON kirana_kart.qa_flag_overrides USING btree (qa_evaluation_id);


--
-- Name: idx_refunds_order; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_refunds_order ON kirana_kart.refunds USING btree (order_id);


--
-- Name: idx_refunds_ticket; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_refunds_ticket ON kirana_kart.refunds USING btree (ticket_id);


--
-- Name: idx_response_templates_action_code_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_response_templates_action_code_id ON kirana_kart.response_templates USING btree (action_code_id);


--
-- Name: idx_response_templates_issue_l1; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_response_templates_issue_l1 ON kirana_kart.response_templates USING btree (issue_l1);


--
-- Name: idx_response_templates_template_ref; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_response_templates_template_ref ON kirana_kart.response_templates USING btree (template_ref);


--
-- Name: idx_rule_edit_log_entity; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_rule_edit_log_entity ON kirana_kart.rule_edit_log USING btree (entity_id);


--
-- Name: idx_rule_edit_log_kb; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_rule_edit_log_kb ON kirana_kart.rule_edit_log USING btree (kb_id);


--
-- Name: idx_rule_edit_log_stage; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_rule_edit_log_stage ON kirana_kart.rule_edit_log USING btree (stage);


--
-- Name: idx_summary_action_code; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_summary_action_code ON kirana_kart.ticket_execution_summary USING btree (applied_action_code);


--
-- Name: idx_summary_issue_l1; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_summary_issue_l1 ON kirana_kart.ticket_execution_summary USING btree (issue_l1);


--
-- Name: idx_ticket_processing_module; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ticket_processing_module ON kirana_kart.ticket_processing_state USING btree (module);


--
-- Name: idx_ticket_state_claimed; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ticket_state_claimed ON kirana_kart.ticket_processing_state USING btree (claimed_by, claimed_at);


--
-- Name: idx_ticket_state_current_stage; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ticket_state_current_stage ON kirana_kart.ticket_processing_state USING btree (current_stage);


--
-- Name: idx_ticket_state_execution_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ticket_state_execution_id ON kirana_kart.ticket_processing_state USING btree (execution_id);


--
-- Name: idx_ticket_state_ticket_id; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE INDEX idx_ticket_state_ticket_id ON kirana_kart.ticket_processing_state USING btree (ticket_id);


--
-- Name: uniq_active_kb_raw; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE UNIQUE INDEX uniq_active_kb_raw ON kirana_kart.knowledge_base_raw_uploads USING btree (document_id) WHERE ((is_active = true) AND ((registry_status)::text = 'draft'::text));


--
-- Name: uniq_doc_version_raw; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE UNIQUE INDEX uniq_doc_version_raw ON kirana_kart.knowledge_base_raw_uploads USING btree (document_id, version_label);


--
-- Name: unique_active_vector_job; Type: INDEX; Schema: kirana_kart; Owner: -
--

CREATE UNIQUE INDEX unique_active_vector_job ON kirana_kart.vector_jobs USING btree (version_label) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text]));


--
-- Name: issue_taxonomy trg_audit_issue_taxonomy; Type: TRIGGER; Schema: kirana_kart; Owner: -
--

CREATE TRIGGER trg_audit_issue_taxonomy AFTER INSERT OR UPDATE ON kirana_kart.issue_taxonomy FOR EACH ROW EXECUTE FUNCTION kirana_kart.audit_issue_taxonomy();


--
-- Name: policy_versions trg_prevent_active_policy_delete; Type: TRIGGER; Schema: kirana_kart; Owner: -
--

CREATE TRIGGER trg_prevent_active_policy_delete BEFORE DELETE ON kirana_kart.policy_versions FOR EACH ROW EXECUTE FUNCTION kirana_kart.prevent_active_policy_delete();


--
-- Name: fdraw trg_prevent_canonical_update; Type: TRIGGER; Schema: kirana_kart; Owner: -
--

CREATE TRIGGER trg_prevent_canonical_update BEFORE UPDATE ON kirana_kart.fdraw FOR EACH ROW EXECUTE FUNCTION kirana_kart.prevent_canonical_update();


--
-- Name: issue_taxonomy trg_prevent_delete; Type: TRIGGER; Schema: kirana_kart; Owner: -
--

CREATE TRIGGER trg_prevent_delete BEFORE DELETE ON kirana_kart.issue_taxonomy FOR EACH ROW EXECUTE FUNCTION kirana_kart.prevent_delete();


--
-- Name: issue_taxonomy trg_prevent_issue_code_update; Type: TRIGGER; Schema: kirana_kart; Owner: -
--

CREATE TRIGGER trg_prevent_issue_code_update BEFORE UPDATE ON kirana_kart.issue_taxonomy FOR EACH ROW EXECUTE FUNCTION kirana_kart.prevent_issue_code_update();


--
-- Name: agent_decision_feedback agent_decision_feedback_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.agent_decision_feedback
    ADD CONSTRAINT agent_decision_feedback_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: bi_chat_messages bi_chat_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bi_chat_messages
    ADD CONSTRAINT bi_chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES kirana_kart.bi_chat_sessions(id) ON DELETE CASCADE;


--
-- Name: bpm_approvals bpm_approvals_instance_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_approvals
    ADD CONSTRAINT bpm_approvals_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE;


--
-- Name: bpm_approvals bpm_approvals_requested_by_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_approvals
    ADD CONSTRAINT bpm_approvals_requested_by_id_fkey FOREIGN KEY (requested_by_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: bpm_approvals bpm_approvals_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_approvals
    ADD CONSTRAINT bpm_approvals_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: bpm_gate_results bpm_gate_results_instance_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_gate_results
    ADD CONSTRAINT bpm_gate_results_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE;


--
-- Name: bpm_process_definitions bpm_process_definitions_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_definitions
    ADD CONSTRAINT bpm_process_definitions_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: bpm_process_instances bpm_process_instances_created_by_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_instances
    ADD CONSTRAINT bpm_process_instances_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: bpm_process_instances bpm_process_instances_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_instances
    ADD CONSTRAINT bpm_process_instances_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: bpm_process_instances bpm_process_instances_process_name_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_process_instances
    ADD CONSTRAINT bpm_process_instances_process_name_fkey FOREIGN KEY (process_name) REFERENCES kirana_kart.bpm_process_definitions(process_name);


--
-- Name: bpm_stage_transitions bpm_stage_transitions_actor_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_stage_transitions
    ADD CONSTRAINT bpm_stage_transitions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: bpm_stage_transitions bpm_stage_transitions_instance_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.bpm_stage_transitions
    ADD CONSTRAINT bpm_stage_transitions_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES kirana_kart.bpm_process_instances(id) ON DELETE CASCADE;


--
-- Name: crm_agent_actions crm_agent_actions_actor_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_agent_actions
    ADD CONSTRAINT crm_agent_actions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: crm_agent_actions crm_agent_actions_queue_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_agent_actions
    ADD CONSTRAINT crm_agent_actions_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL;


--
-- Name: crm_agent_actions crm_agent_actions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_agent_actions
    ADD CONSTRAINT crm_agent_actions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: crm_automation_rules crm_automation_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_automation_rules
    ADD CONSTRAINT crm_automation_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_group_integrations crm_group_integrations_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_integrations
    ADD CONSTRAINT crm_group_integrations_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_group_integrations crm_group_integrations_group_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_integrations
    ADD CONSTRAINT crm_group_integrations_group_id_fkey FOREIGN KEY (group_id) REFERENCES kirana_kart.crm_groups(id) ON DELETE CASCADE;


--
-- Name: crm_group_members crm_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_members
    ADD CONSTRAINT crm_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES kirana_kart.crm_groups(id) ON DELETE CASCADE;


--
-- Name: crm_group_members crm_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_group_members
    ADD CONSTRAINT crm_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: crm_groups crm_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_groups
    ADD CONSTRAINT crm_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_merge_log crm_merge_log_merged_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_merge_log
    ADD CONSTRAINT crm_merge_log_merged_by_fkey FOREIGN KEY (merged_by) REFERENCES kirana_kart.users(id);


--
-- Name: crm_merge_log crm_merge_log_source_ticket_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_merge_log
    ADD CONSTRAINT crm_merge_log_source_ticket_fkey FOREIGN KEY (source_ticket) REFERENCES kirana_kart.fdraw(ticket_id);


--
-- Name: crm_merge_log crm_merge_log_target_ticket_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_merge_log
    ADD CONSTRAINT crm_merge_log_target_ticket_fkey FOREIGN KEY (target_ticket) REFERENCES kirana_kart.fdraw(ticket_id);


--
-- Name: crm_notes crm_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notes
    ADD CONSTRAINT crm_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: crm_notes crm_notes_queue_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notes
    ADD CONSTRAINT crm_notes_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL;


--
-- Name: crm_notes crm_notes_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notes
    ADD CONSTRAINT crm_notes_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: crm_notifications crm_notifications_queue_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notifications
    ADD CONSTRAINT crm_notifications_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL;


--
-- Name: crm_notifications crm_notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notifications
    ADD CONSTRAINT crm_notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: crm_notifications crm_notifications_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_notifications
    ADD CONSTRAINT crm_notifications_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: crm_saved_views crm_saved_views_owner_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_saved_views
    ADD CONSTRAINT crm_saved_views_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: crm_sla_policies crm_sla_policies_updated_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_sla_policies
    ADD CONSTRAINT crm_sla_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_tags crm_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_tags
    ADD CONSTRAINT crm_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_ticket_tags crm_ticket_tags_added_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_ticket_tags
    ADD CONSTRAINT crm_ticket_tags_added_by_fkey FOREIGN KEY (added_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: crm_ticket_tags crm_ticket_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_ticket_tags
    ADD CONSTRAINT crm_ticket_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES kirana_kart.crm_tags(id) ON DELETE CASCADE;


--
-- Name: crm_ticket_tags crm_ticket_tags_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_ticket_tags
    ADD CONSTRAINT crm_ticket_tags_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: crm_watchers crm_watchers_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_watchers
    ADD CONSTRAINT crm_watchers_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: crm_watchers crm_watchers_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.crm_watchers
    ADD CONSTRAINT crm_watchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: draft_action_proposals draft_action_proposals_edited_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_action_proposals
    ADD CONSTRAINT draft_action_proposals_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: draft_action_proposals draft_action_proposals_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_action_proposals
    ADD CONSTRAINT draft_action_proposals_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: draft_taxonomy_proposals draft_taxonomy_proposals_edited_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_taxonomy_proposals
    ADD CONSTRAINT draft_taxonomy_proposals_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: draft_taxonomy_proposals draft_taxonomy_proposals_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.draft_taxonomy_proposals
    ADD CONSTRAINT draft_taxonomy_proposals_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: extraction_standards extraction_standards_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.extraction_standards
    ADD CONSTRAINT extraction_standards_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: extraction_standards extraction_standards_updated_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.extraction_standards
    ADD CONSTRAINT extraction_standards_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: conversations fk_convo_customers; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversations
    ADD CONSTRAINT fk_convo_customers FOREIGN KEY (customer_id) REFERENCES kirana_kart.customers(customer_id);


--
-- Name: conversations fk_convo_orders; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.conversations
    ADD CONSTRAINT fk_convo_orders FOREIGN KEY (order_id) REFERENCES kirana_kart.orders(order_id);


--
-- Name: csat_responses fk_csat_conversations; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.csat_responses
    ADD CONSTRAINT fk_csat_conversations FOREIGN KEY (ticket_id) REFERENCES kirana_kart.conversations(ticket_id);


--
-- Name: delivery_events fk_delivery_events_orders; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.delivery_events
    ADD CONSTRAINT fk_delivery_events_orders FOREIGN KEY (order_id) REFERENCES kirana_kart.orders(order_id);


--
-- Name: issue_taxonomy fk_issue_taxonomy_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy
    ADD CONSTRAINT fk_issue_taxonomy_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: issue_taxonomy_versions fk_issue_taxonomy_versions_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy_versions
    ADD CONSTRAINT fk_issue_taxonomy_versions_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: kb_vector_jobs fk_kb_vector_jobs_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_vector_jobs
    ADD CONSTRAINT fk_kb_vector_jobs_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: knowledge_base_raw_uploads fk_knowledge_base_raw_uploads_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_raw_uploads
    ADD CONSTRAINT fk_knowledge_base_raw_uploads_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: knowledge_base_versions fk_knowledge_base_versions_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_base_versions
    ADD CONSTRAINT fk_knowledge_base_versions_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: llm_output_3 fk_llm3_policy_version_hash; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.llm_output_3
    ADD CONSTRAINT fk_llm3_policy_version_hash FOREIGN KEY (policy_version, policy_artifact_hash) REFERENCES kirana_kart.policy_versions(policy_version, artifact_hash);


--
-- Name: orders fk_orders_customers; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.orders
    ADD CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES kirana_kart.customers(customer_id);


--
-- Name: policy_versions fk_policy_versions_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.policy_versions
    ADD CONSTRAINT fk_policy_versions_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: refunds fk_refunds_conversations; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refunds
    ADD CONSTRAINT fk_refunds_conversations FOREIGN KEY (ticket_id) REFERENCES kirana_kart.conversations(ticket_id);


--
-- Name: refunds fk_refunds_orders; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refunds
    ADD CONSTRAINT fk_refunds_orders FOREIGN KEY (order_id) REFERENCES kirana_kart.orders(order_id);


--
-- Name: rule_registry fk_rule_registry_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_registry
    ADD CONSTRAINT fk_rule_registry_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: ticket_execution_summary fk_summary_conversation; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_execution_summary
    ADD CONSTRAINT fk_summary_conversation FOREIGN KEY (ticket_id) REFERENCES kirana_kart.conversations(ticket_id);


--
-- Name: ticket_execution_summary fk_summary_customers; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_execution_summary
    ADD CONSTRAINT fk_summary_customers FOREIGN KEY (customer_id) REFERENCES kirana_kart.customers(customer_id);


--
-- Name: ticket_execution_summary fk_summary_orders; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_execution_summary
    ADD CONSTRAINT fk_summary_orders FOREIGN KEY (order_id) REFERENCES kirana_kart.orders(order_id);


--
-- Name: ticket_execution_summary fk_summary_policy_version_hash; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ticket_execution_summary
    ADD CONSTRAINT fk_summary_policy_version_hash FOREIGN KEY (policy_version, policy_artifact_hash) REFERENCES kirana_kart.policy_versions(policy_version, artifact_hash);


--
-- Name: taxonomy_runtime_config fk_taxonomy_runtime_config_kb_id; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.taxonomy_runtime_config
    ADD CONSTRAINT fk_taxonomy_runtime_config_kb_id FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE RESTRICT;


--
-- Name: hitl_queue hitl_queue_assigned_to_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: hitl_queue hitl_queue_escalated_from_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_escalated_from_fkey FOREIGN KEY (escalated_from) REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL;


--
-- Name: hitl_queue hitl_queue_group_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_group_id_fkey FOREIGN KEY (group_id) REFERENCES kirana_kart.crm_groups(id) ON DELETE SET NULL;


--
-- Name: hitl_queue hitl_queue_merged_into_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES kirana_kart.hitl_queue(id) ON DELETE SET NULL;


--
-- Name: hitl_queue hitl_queue_resolved_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: hitl_queue hitl_queue_ticket_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES kirana_kart.fdraw(ticket_id) ON DELETE CASCADE;


--
-- Name: hitl_queue hitl_queue_viewing_agent_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.hitl_queue
    ADD CONSTRAINT hitl_queue_viewing_agent_id_fkey FOREIGN KEY (viewing_agent_id) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: integrations integrations_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.integrations
    ADD CONSTRAINT integrations_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: issue_keywords issue_keywords_issue_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_keywords
    ADD CONSTRAINT issue_keywords_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES kirana_kart.issue_taxonomy(id) ON DELETE CASCADE;


--
-- Name: issue_taxonomy issue_taxonomy_parent_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.issue_taxonomy
    ADD CONSTRAINT issue_taxonomy_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES kirana_kart.issue_taxonomy(id) ON DELETE RESTRICT;


--
-- Name: kb_user_access kb_user_access_granted_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access
    ADD CONSTRAINT kb_user_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: kb_user_access kb_user_access_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access
    ADD CONSTRAINT kb_user_access_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: kb_user_access kb_user_access_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.kb_user_access
    ADD CONSTRAINT kb_user_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: knowledge_bases knowledge_bases_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.knowledge_bases
    ADD CONSTRAINT knowledge_bases_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: ml_model_registry ml_model_registry_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_model_registry
    ADD CONSTRAINT ml_model_registry_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: ml_training_samples ml_training_samples_kb_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.ml_training_samples
    ADD CONSTRAINT ml_training_samples_kb_id_fkey FOREIGN KEY (kb_id) REFERENCES kirana_kart.knowledge_bases(kb_id) ON DELETE CASCADE;


--
-- Name: qa_evaluations qa_evaluations_session_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_evaluations
    ADD CONSTRAINT qa_evaluations_session_id_fkey FOREIGN KEY (session_id) REFERENCES kirana_kart.qa_sessions(id) ON DELETE CASCADE;


--
-- Name: qa_flag_overrides qa_flag_overrides_override_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_flag_overrides
    ADD CONSTRAINT qa_flag_overrides_override_by_fkey FOREIGN KEY (override_by) REFERENCES kirana_kart.users(id);


--
-- Name: qa_flag_overrides qa_flag_overrides_qa_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.qa_flag_overrides
    ADD CONSTRAINT qa_flag_overrides_qa_evaluation_id_fkey FOREIGN KEY (qa_evaluation_id) REFERENCES kirana_kart.qa_evaluations(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- Name: rule_edit_log rule_edit_log_created_by_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.rule_edit_log
    ADD CONSTRAINT rule_edit_log_created_by_fkey FOREIGN KEY (created_by) REFERENCES kirana_kart.users(id) ON DELETE SET NULL;


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: kirana_kart; Owner: -
--

ALTER TABLE ONLY kirana_kart.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES kirana_kart.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


