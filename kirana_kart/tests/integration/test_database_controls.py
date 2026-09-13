"""Real PostgreSQL tests. Only run against a disposable migrated test database."""
import os
from contextlib import contextmanager
from datetime import date
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from app.config import settings

pytestmark = pytest.mark.integration


def raw_connection(engine):
    # The production legacy helpers return psycopg2 connections. SQLAlchemy's
    # pool proxy context manager closes/rolls back rather than committing like
    # psycopg2, so use the real driver contract for these integration paths.
    import psycopg2
    url = engine.url
    return psycopg2.connect(host=url.host, port=url.port, dbname=url.database,
                            user=url.username, password=url.password)



@pytest.fixture
def db(monkeypatch):
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        pytest.skip('Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database')
    if not make_url(url).database.endswith('_test'):
        pytest.fail('Integration database name must end in _test')
    engine = create_engine(url, hide_parameters=True)
    monkeypatch.setattr(settings, 'pii_encryption_key', 'a' * 64)
    yield engine
    engine.dispose()


@contextmanager
def session_for(engine):
    with Session(engine) as session:
        with session.begin():
            yield session


def test_pii_backfill_search_and_byte_identical_rollback(db, monkeypatch):
    from app.admin.routes import customers
    from app.utils.customer_pii import reveal_customer
    from app.admin.services.auth_service import UserContext
    spec = spec_from_file_location('backfill', Path(__file__).parents[2] / 'scripts/customer_pii_backfill.py')
    backfill = module_from_spec(spec)
    spec.loader.exec_module(backfill)
    monkeypatch.setattr(customers, 'get_db_session', lambda: session_for(db))
    monkeypatch.setattr(customers, 'log_pii_access', lambda **kw: None)
    original = {'customer_id': 'integration-pii', 'email': ' Alice@Example.com ', 'phone': '+91-0000123', 'date_of_birth': '1990-01-02'}
    try:
        with db.begin() as conn:
            conn.execute(text('''INSERT INTO kirana_kart.customers(customer_id,email,phone,date_of_birth)
                VALUES (:customer_id,:email,:phone,:date_of_birth)'''), original)
        assert backfill.migrate(db, 'encrypt', 1) == 1
        assert backfill.migrate(db, 'encrypt', 1) == 0
        assert backfill.verify(db) == 1
        with db.connect() as conn:
            stored = conn.execute(text('SELECT customer_id,email,phone,date_of_birth,email_blind_index FROM kirana_kart.customers')).mappings().one()
        assert '@' not in stored['email']
        assert reveal_customer(stored) == original
        response = customers.list_customers(MagicMock(), page=1, limit=25, search='alice@example.COM', segment=None, user=MagicMock(id=1))
        assert response['total'] == 1
        assert response['items'][0]['email'] == original['email']
        assert backfill.migrate(db, 'decrypt', 1) == 1
        with db.connect() as conn:
            restored = dict(conn.execute(text('SELECT customer_id,email,phone,date_of_birth FROM kirana_kart.customers')).mappings().one())
        assert restored == original
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.customers WHERE customer_id='integration-pii'"))


def test_access_audit_is_persisted_without_personal_values(db, monkeypatch):
    from app.middleware import pii_audit_middleware as audit
    monkeypatch.setattr(audit, 'get_db_session', lambda: session_for(db))
    audit.log_pii_access(1, 'customer', 'integration-audit', ['email'], '/customers', '127.0.0.1')
    with db.begin() as conn:
        row = conn.execute(text("DELETE FROM kirana_kart.pii_access_log WHERE entity_id='integration-audit' RETURNING fields_accessed,ip_address::text")).one()
    assert row[0] == ['email']
    assert row[1] == '127.0.0.1/32'


def test_retention_anonymises_expired_customer_and_deletes_transcript(db, monkeypatch):
    from app.tasks import retention_sweep
    monkeypatch.setattr(retention_sweep, 'get_db_session', lambda: session_for(db))
    with db.begin() as conn:
        conn.execute(text("""INSERT INTO kirana_kart.customers(customer_id,email,phone,signup_date)
            VALUES ('integration-expired','old@example.com','123',NOW()-INTERVAL '4 years')"""))
        conn.execute(text("""INSERT INTO kirana_kart.conversation_turns(ticket_id,message_text,created_at)
            VALUES (-98765,'expired transcript',NOW()-INTERVAL '2 years')"""))
    try:
        summary = retention_sweep.run_retention_sweep()
        assert not any(k.endswith('_error') for k in summary), summary
        assert summary['customer_pii_anonymised'] == 1
        assert summary['conversations_deleted'] == 1
        with db.connect() as conn:
            row = conn.execute(text("SELECT email,phone,date_of_birth,email_blind_index FROM kirana_kart.customers WHERE customer_id='integration-expired'")).one()
            assert all(v is None for v in row)
        assert retention_sweep.run_retention_sweep()['customer_pii_anonymised'] == 0
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.customers WHERE customer_id='integration-expired'"))
            conn.execute(text('DELETE FROM kirana_kart.conversation_turns WHERE ticket_id=-98765'))


def test_activation_is_visible_to_enrichment_and_rolls_back_atomically(db, monkeypatch):
    from app.l1_ingestion.kb_registry.kb_registry_service import KBRegistryService
    from app.l2_cardinal import phase4_enricher
    monkeypatch.setattr(phase4_enricher, '_get_connection', lambda: raw_connection(db))
    try:
        with db.begin() as conn:
            conn.execute(text("INSERT INTO kirana_kart.policy_versions(policy_version,vector_status) VALUES ('integration-policy','ready')"))
            KBRegistryService._activate_version(conn, 'integration-policy')
        assert phase4_enricher._resolve_active_policy().active_version == 'integration-policy'
        with pytest.raises(Exception, match='must be compiled'):
            with db.begin() as conn:
                KBRegistryService._activate_version(conn, 'not-compiled')
        assert phase4_enricher._resolve_active_policy().active_version == 'integration-policy'
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.kb_runtime_config WHERE active_version='integration-policy'"))
            conn.execute(text("UPDATE kirana_kart.policy_versions SET is_active=FALSE WHERE policy_version='integration-policy'"))
            conn.execute(text("DELETE FROM kirana_kart.policy_versions WHERE policy_version='integration-policy'"))


def test_runtime_schema_check_requires_no_ddl_privileges(db, monkeypatch):
    from app import schema
    with db.begin() as conn:
        conn.execute(text('CREATE ROLE orgsense_runtime_test NOLOGIN'))
        conn.execute(text('GRANT USAGE ON SCHEMA public,kirana_kart TO orgsense_runtime_test'))
        conn.execute(text('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA kirana_kart TO orgsense_runtime_test'))
        conn.execute(text('GRANT SELECT ON public.alembic_version TO orgsense_runtime_test'))
    try:
        with db.connect() as conn:
            conn.execute(text('SET ROLE orgsense_runtime_test'))
            assert not conn.execute(text("SELECT has_schema_privilege(current_user,'kirana_kart','CREATE')")).scalar()
            class BoundEngine:
                def connect(self):
                    @contextmanager
                    def existing():
                        yield conn
                    return existing()
            monkeypatch.setattr(schema, 'engine', BoundEngine())
            schema.verify_schema()
    finally:
        with db.begin() as conn:
            conn.execute(text('DROP OWNED BY orgsense_runtime_test'))
            conn.execute(text('DROP ROLE orgsense_runtime_test'))


def test_customer_lookup_decrypts_identity_and_preserves_block_check(db, monkeypatch):
    from app.l2_cardinal import phase4_enricher, phase1_validator
    from app.utils.customer_pii import protect_customer
    from app.admin import db as database
    monkeypatch.setattr(phase4_enricher, '_get_connection', lambda: raw_connection(db))
    monkeypatch.setattr(database, 'engine', db)
    row = protect_customer({'customer_id': 'integration-blocked', 'email': 'Blocked@example.com', 'phone': '123', 'date_of_birth': None})
    try:
        with db.begin() as conn:
            conn.execute(text('''INSERT INTO kirana_kart.customers(customer_id,email,phone,date_of_birth,email_blind_index,is_blocked,block_reason)
                VALUES (:customer_id,:email,:phone,:date_of_birth,:email_blind_index,TRUE,'manual review')'''), row)
        assert phase1_validator._check_customer_blocked('blocked@EXAMPLE.com', None) == (True, 'manual review')
        profile = phase4_enricher._fetch_customer_profile(None, 'blocked@example.com')
        assert profile.email == 'Blocked@example.com'
        assert profile.is_blocked
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.customers WHERE customer_id='integration-blocked'"))


def test_cardinal_pipeline_persists_enrichment_and_dispatch_state(db, monkeypatch):
    """All five phases against real SQL; Redis is an isolated in-memory boundary."""
    from app.l1_ingestion import normaliser
    from app.l1_ingestion.schemas import CardinalIngestRequest
    from app.l2_cardinal import pipeline, phase2_deduplicator, phase3_handler, phase4_enricher, phase5_dispatcher
    from app.l1_ingestion.kb_registry.kb_registry_service import KBRegistryService
    from app.admin import db as database
    monkeypatch.setattr(database, 'engine', db)
    for module in (normaliser, phase2_deduplicator, phase3_handler, phase4_enricher, phase5_dispatcher):
        monkeypatch.setattr(module, '_get_connection', lambda: raw_connection(db))
    redis = MagicMock()
    redis.get.return_value = None
    redis.xadd.return_value = '1-0'
    monkeypatch.setattr(phase2_deduplicator, 'get_redis', lambda: redis)
    monkeypatch.setattr(phase5_dispatcher, 'get_redis', lambda: redis)
    monkeypatch.setattr(phase3_handler, 'FRESHDESK_WEBHOOK_SECRET', 'test-signing-secret')
    import hmac, hashlib
    raw = b'{"synthetic":"integration"}'
    signature = hmac.new(b'test-signing-secret', raw, hashlib.sha256).hexdigest()
    ticket_id = 987654321
    request = CardinalIngestRequest(
        org='integration', channel='email', source='freshdesk', business_line='ecommerce', module='delivery',
        payload={'ticket_id': ticket_id, 'group_id': '1', 'subject': 'Delivery issue',
                 'description': 'A synthetic delivery issue for integration verification', 'customer_id': 'integration-pipeline'},
    )
    try:
        with db.begin() as conn:
            conn.execute(text("INSERT INTO kirana_kart.policy_versions(policy_version,vector_status) VALUES ('pipeline-policy','ready')"))
            KBRegistryService._activate_version(conn, 'pipeline-policy')
            conn.execute(text("INSERT INTO kirana_kart.customers(customer_id) VALUES ('integration-pipeline')"))
        result = pipeline.run(request, raw_body=raw, signature_header=signature)
        assert result.http_status == 202, result
        redis.xadd.assert_called_once()
        with db.connect() as conn:
            row = conn.execute(text('SELECT pipeline_stage,canonical_payload FROM kirana_kart.fdraw WHERE ticket_id=:id'), {'id': ticket_id}).one()
            assert row[0] == 'DISPATCHED'
            assert row[1]['customer_context']['policy']['active_version'] == 'pipeline-policy'
            assert conn.execute(text('SELECT COUNT(*) FROM kirana_kart.ticket_processing_state WHERE ticket_id=:id'), {'id': ticket_id}).scalar() == 1
    finally:
        with db.begin() as conn:
            conn.execute(text('DELETE FROM kirana_kart.ticket_processing_state WHERE ticket_id=:id'), {'id': ticket_id})
            conn.execute(text("DELETE FROM kirana_kart.cardinal_execution_plans WHERE metadata->>'ticket_id'=:id"), {'id': str(ticket_id)})
            conn.execute(text('DELETE FROM kirana_kart.fdraw WHERE ticket_id=:id'), {'id': ticket_id})
            conn.execute(text("DELETE FROM kirana_kart.customers WHERE customer_id='integration-pipeline'"))
            conn.execute(text("DELETE FROM kirana_kart.kb_runtime_config WHERE active_version='pipeline-policy'"))
            conn.execute(text("UPDATE kirana_kart.policy_versions SET is_active=FALSE WHERE policy_version='pipeline-policy'"))
            conn.execute(text("DELETE FROM kirana_kart.policy_versions WHERE policy_version='pipeline-policy'"))


def test_risk_refresh_counts_non_refund_complaints_and_retries_failures(db, monkeypatch):
    from app.l4_agents import tasks
    monkeypatch.setattr(tasks, '_get_connection', lambda: raw_connection(db))
    monkeypatch.setattr(tasks, '_is_task_enabled', lambda _: True)
    with db.begin() as conn:
        conn.execute(text("INSERT INTO kirana_kart.customers(customer_id) VALUES ('integration-risk')"))
        conn.execute(text("INSERT INTO kirana_kart.orders(order_id,customer_id,order_value) VALUES ('integration-order','integration-risk',100)"))
        conn.execute(text("""INSERT INTO kirana_kart.complaints(ticket_id,customer_id,action_code,issue_type_l2)
            VALUES (987650,'integration-risk','REFUND_FULL','not_received'),
                   (987651,'integration-risk','ESCALATE','late')"""))
    try:
        result = tasks.beat_refresh_risk_profiles.run()
        assert result['updated'] == 1
        with db.connect() as conn:
            row = conn.execute(text("SELECT complaints_last_30_days,refunds_last_30_days FROM kirana_kart.customer_risk_profile WHERE customer_id='integration-risk'")).one()
            assert row == (2, 1)
        with db.begin() as conn:
            conn.execute(text("INSERT INTO kirana_kart.risk_profile_change_log(customer_id) VALUES ('integration-risk')"))
        def unavailable(*args):
            raise RuntimeError('simulated computation failure')
        monkeypatch.setattr(tasks, '_recompute_risk_profile', unavailable)
        assert tasks.beat_refresh_risk_profiles.run()['updated'] == 0
        with db.connect() as conn:
            assert conn.execute(text("SELECT COUNT(*) FROM kirana_kart.risk_profile_change_log WHERE customer_id='integration-risk' AND NOT processed")).scalar() == 1
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.complaints WHERE customer_id='integration-risk'"))
            conn.execute(text("DELETE FROM kirana_kart.orders WHERE customer_id='integration-risk'"))
            conn.execute(text("DELETE FROM kirana_kart.customer_risk_profile WHERE customer_id='integration-risk'"))
            conn.execute(text("DELETE FROM kirana_kart.risk_profile_change_log WHERE customer_id='integration-risk'"))
            conn.execute(text("DELETE FROM kirana_kart.customers WHERE customer_id='integration-risk'"))


def test_grievance_deadline_and_owner_drive_monitoring(db, monkeypatch):
    from app import operational_metrics, readiness
    from app.admin import redis_client
    redis = MagicMock()
    redis.exists.return_value = False
    monkeypatch.setattr(redis_client, "get_redis", lambda: redis)
    from app.admin.routes import data_rights_routes as rights
    monkeypatch.setattr(rights, 'get_db_session', lambda: session_for(db))
    monkeypatch.setattr(readiness, 'probe_engine', db)
    with db.begin() as conn:
        owner = conn.execute(text("INSERT INTO kirana_kart.users(email,full_name) VALUES ('owner@example.invalid','Test owner') RETURNING id")).scalar()
    reference = None
    try:
        result = rights.submit_grievance(rights.GrievanceRequest(grievance_type='access_request',
                description='Synthetic request',contact_email='requester@example.com'), MagicMock(id=owner))
        reference = result['reference_id']
        assert result['due_at']
        with db.begin() as conn:
            conn.execute(text("UPDATE kirana_kart.grievances SET due_at=NOW()-INTERVAL '1 day' WHERE id=:id"),{'id':reference})
        operational_metrics.refresh_operational_gauges()
        assert operational_metrics.overdue_grievances._value.get() == 1
        response = rights.update_grievance(reference, rights.GrievanceUpdate(owner_user_id=owner,status='resolved',resolution='Provided synthetic export'),MagicMock(id=owner))
        assert response['resolved_at']
        operational_metrics.refresh_operational_gauges()
        assert operational_metrics.overdue_grievances._value.get() == 0
    finally:
        with db.begin() as conn:
            conn.execute(text('DELETE FROM kirana_kart.grievances WHERE id=:id'),{'id':reference})
            conn.execute(text('DELETE FROM kirana_kart.users WHERE id=:id'),{'id':owner})


def test_dedup_cleanup_preserves_recent_entries(db, monkeypatch):
    from app.l4_agents import tasks
    monkeypatch.setattr(tasks, '_get_connection', lambda: raw_connection(db))
    monkeypatch.setattr(tasks, '_is_task_enabled', lambda name: True)
    try:
        with db.begin() as conn:
            conn.execute(text("""INSERT INTO kirana_kart.deduplication_log
                (payload_hash, duplicate_received_at) VALUES
                ('integration-old', now() - interval '31 days'),
                ('integration-new', now())"""))
        result = tasks.beat_purge_stale_dedup_keys()
        assert result == {'deleted': 1}
        with db.connect() as conn:
            assert conn.execute(text("SELECT payload_hash FROM kirana_kart.deduplication_log WHERE payload_hash LIKE 'integration-%'" )).scalars().all() == ['integration-new']
    finally:
        with db.begin() as conn:
            conn.execute(text("DELETE FROM kirana_kart.deduplication_log WHERE payload_hash LIKE 'integration-%'"))


def test_qa_reads_completed_conversations_and_persists_score(db, monkeypatch):
    from app.l4_agents.ecommerce import agent_qa_scorer as qa
    monkeypatch.setattr(qa, '_get_db_connection', lambda: raw_connection(db))
    monkeypatch.setattr(qa, '_check_canned', lambda text: (False, 0.0))
    monkeypatch.setattr(qa, '_check_grammar', lambda text: [])
    monkeypatch.setattr(qa, '_classify_sentiment', lambda text: 'POSITIVE')
    cid = None
    try:
        with db.begin() as conn:
            cid = str(conn.execute(text("""INSERT INTO kirana_kart.conversations
                (ticket_id, agent_id, closed_at) VALUES (-98765, 'integration-agent', now())
                RETURNING conversation_id""")).scalar_one())
            conn.execute(text("""INSERT INTO kirana_kart.conversation_turns
                (ticket_id, message_sender, message_text) VALUES
                (-98765, 'customer', 'Thank you'), (-98765, 'agent', 'Your issue is resolved')"""))
        assert qa.score_recent_conversations()['scored'] == 1
        with db.connect() as conn:
            row = conn.execute(text('SELECT total_turns,agent_turns FROM kirana_kart.conversation_qa_scores WHERE conv_id=:cid'), {'cid': cid}).one()
            assert tuple(row) == (2, 1)
        assert qa.score_recent_conversations()['scored'] == 0
    finally:
        with db.begin() as conn:
            conn.execute(text('DELETE FROM kirana_kart.conversation_qa_scores WHERE conv_id=:cid'), {'cid': cid})
            conn.execute(text('DELETE FROM kirana_kart.conversation_turns WHERE ticket_id=-98765'))
            conn.execute(text('DELETE FROM kirana_kart.conversations WHERE ticket_id=-98765'))


def test_password_reset_revokes_access_refresh_and_racing_issuance(db, monkeypatch):
    from app.admin.services import auth_service as auth
    from app.admin.routes import user_management as users
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials
    monkeypatch.setattr(auth, 'get_db_session', lambda: session_for(db))
    monkeypatch.setattr(users, 'get_db_session', lambda: session_for(db))
    monkeypatch.setattr(auth, 'is_token_revoked', lambda jti: False)
    with db.begin() as conn:
        uid = conn.execute(text("INSERT INTO kirana_kart.users(email,full_name,is_active) VALUES ('reset@example.test','Reset',true) RETURNING id")).scalar_one()
    try:
        user = auth.build_user_context_from_db(uid)
        access = auth.create_access_token(user)
        raw, hashed = auth.create_refresh_token(uid)
        auth.store_refresh_token(uid, hashed, 0)
        credentials = HTTPAuthorizationCredentials(scheme='Bearer', credentials=access)
        assert auth.get_current_user(credentials).id == uid
        _, rotated, version = auth.validate_and_rotate_refresh_token(raw)
        assert version == 0
        users.reset_user_password(uid, users.PasswordResetRequest(new_password='replacement-password'), MagicMock())
        for operation in (lambda: auth.get_current_user(credentials),
                          lambda: auth.validate_and_rotate_refresh_token(rotated),
                          lambda: auth.store_refresh_token(uid, 'racing-old-login', 0)):
            with pytest.raises(HTTPException) as error:
                operation()
            assert error.value.status_code == 401
        fresh = auth.build_user_context_from_db(uid)
        assert fresh.auth_version == 1
        assert auth.get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials=auth.create_access_token(fresh))).id == uid
        with db.connect() as conn:
            assert conn.execute(text('SELECT count(*) FROM kirana_kart.refresh_tokens WHERE user_id=:uid'), {'uid': uid}).scalar() == 0
    finally:
        auth.invalidate_user_cache(uid)
        with db.begin() as conn:
            conn.execute(text('DELETE FROM kirana_kart.users WHERE id=:uid'), {'uid': uid})


def test_legacy_pool_reuses_socket_and_preserves_transaction_contexts(db, monkeypatch):
    from app.admin import db as shared
    monkeypatch.setattr(shared, 'engine', db)
    first = shared.get_connection()
    try:
        with first:
            with first.cursor() as cur:
                cur.execute("INSERT INTO kirana_kart.customers(customer_id) VALUES ('pool-commit')")
                cur.execute('SELECT pg_backend_pid()')
                pid = cur.fetchone()[0]
    finally:
        first.close()
    second = shared.get_connection()
    try:
        with pytest.raises(ValueError):
            with second:
                with second.cursor() as cur:
                    cur.execute('SELECT pg_backend_pid()')
                    assert cur.fetchone()[0] == pid
                    cur.execute("INSERT INTO kirana_kart.customers(customer_id) VALUES ('pool-rollback')")
                raise ValueError('rollback')
        with second:
            with second.cursor() as cur:
                cur.execute("DELETE FROM kirana_kart.customers WHERE customer_id LIKE 'pool-%' RETURNING customer_id")
                assert cur.fetchall() == [('pool-commit',)]
    finally:
        second.close()


def test_group_api_keys_are_one_way_and_shown_only_at_issuance(db, monkeypatch):
    import hashlib
    from app.admin.services import crm_service as crm
    monkeypatch.setattr(crm, 'get_db_session', lambda: session_for(db))
    with db.begin() as conn:
        uid = conn.execute(text("INSERT INTO kirana_kart.users(email) VALUES ('group-key@example.test') RETURNING id")).scalar_one()
    gid = None
    try:
        group = crm.create_group('Integration key test', None, 'CUSTOM', 'MANUAL', MagicMock(id=uid))
        gid = group['id']
        result = crm.create_group_integration(gid, 'API_KEY', 'Test', {}, uid)
        raw = result['api_key_full']
        with db.connect() as conn:
            stored = conn.execute(text('SELECT api_key FROM kirana_kart.crm_group_integrations WHERE id=:id'), {'id':result['id']}).scalar_one()
        assert stored == 'sha256:' + hashlib.sha256(raw.encode()).hexdigest()
        assert raw not in str(crm.list_group_integrations(gid))
        replacement = crm.regenerate_api_key(result['id'])['api_key_full']
        assert replacement != raw
        assert replacement not in str(crm.list_group_integrations(gid))
        # Rehearse conversion of a pre-migration plaintext credential.
        spec = spec_from_file_location('key_migration', Path(__file__).parents[2] / 'migrations/versions/0007_group_key_hashes.py')
        migration = module_from_spec(spec)
        spec.loader.exec_module(migration)
        with db.begin() as conn:
            conn.execute(text('UPDATE kirana_kart.crm_group_integrations SET api_key=:key WHERE id=:id'), {'key':raw, 'id':result['id']})
            monkeypatch.setattr(migration.op, 'get_bind', lambda: conn)
            migration.upgrade()
            assert conn.execute(text('SELECT api_key FROM kirana_kart.crm_group_integrations WHERE id=:id'), {'id':result['id']}).scalar_one() == stored
    finally:
        with db.begin() as conn:
            if gid:
                conn.execute(text('DELETE FROM kirana_kart.crm_group_integrations WHERE group_id=:id'), {'id':gid})
                conn.execute(text('DELETE FROM kirana_kart.crm_groups WHERE id=:id'), {'id':gid})
            conn.execute(text('DELETE FROM kirana_kart.users WHERE id=:id'), {'id':uid})
