import asyncio
from io import BytesIO
from unittest.mock import MagicMock, patch
import pytest
from fastapi import HTTPException, UploadFile
from app.admin.routes import bpm_routes
from app.l5_intelligence.policy_shadow import routes as shadow


def test_upload_saves_business_intent_with_proposal():
    actor = MagicMock(id=1, email='owner@example.test')
    with patch.object(bpm_routes, 'engine'), patch.object(bpm_routes, '_bpm_service') as bpm, patch('app.l1_ingestion.kb_registry.markdown_converter.MarkdownConverter') as converter:
        bpm.create_instance.return_value = {'id': 1}
        converter.return_value.convert.return_value = '# Missing items'
        result = asyncio.run(bpm_routes.upload_document_file('default', UploadFile(filename='policy.md', file=BytesIO(b'# Policy')), ' Faster refunds ', ' Reduce manual review ', ' Missing items ', actor))
        assert result['bpm_instance_id'] == 1
        assert bpm.create_instance.call_args.kwargs['metadata']['business_brief'] == {
            'name': 'Faster refunds', 'outcome': 'Reduce manual review', 'scope': 'Missing items'}


@pytest.mark.parametrize('stage', ['RULE_EDIT', 'SIMULATION_GATE', 'SHADOW_GATE'])
def test_early_stage_cannot_activate_before_transition_validation(stage):
    from tests.policy_fakes import FakeConn
    conn = FakeConn(stage=stage)
    engine = MagicMock()
    engine.begin.return_value.__enter__.return_value = conn
    with patch.object(bpm_routes, 'engine', engine), patch.object(bpm_routes, '_require_kb_access'), \
         patch('app.l1_ingestion.kb_registry.kb_registry_service.KBRegistryService') as registry, \
         patch('app.l45_ml_platform.compiler.sop_extractor.commit_proposals_to_registry') as commit:
        with pytest.raises(HTTPException) as error:
            bpm_routes.publish_version_bpm('default', bpm_routes.PublishRequest(entity_id='proposal'), MagicMock())
        assert error.value.status_code == 409
        registry.assert_not_called()
        commit.assert_not_called()
    assert conn.transitions == []


def test_shadow_statistics_scope_to_current_version_pair():
    session = MagicMock()
    session.execute.return_value.mappings.return_value.first.side_effect = [
        {'active_version':'current', 'shadow_version':'proposal', 'kb_id':'default'},
        {'total': 0, 'changed':None, 'last_evaluated_at':None},
    ]
    with patch.object(shadow, 'get_db_session') as context:
        context.return_value.__enter__.return_value = session
        result = shadow.get_shadow_stats(MagicMock())
    query, params = session.execute.call_args.args
    assert 'active_policy_version = :active' in str(query)
    assert 'candidate_policy_version = :candidate' in str(query)
    assert params == {'active':'current', 'candidate':'proposal'}
    assert result['is_active'] and result['total_evaluated'] == 0
    assert result['last_evaluated_at'] is None


def test_publish_requires_policy_admin_at_http_boundary():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.admin.services.auth_service import get_current_user
    app = FastAPI()
    app.include_router(bpm_routes.router)
    actor = MagicMock(is_super_admin=False, permissions={'knowledgeBase': {'admin': True}})
    app.dependency_overrides[get_current_user] = lambda: actor
    with patch.object(bpm_routes, 'engine') as engine:
        response = TestClient(app).post('/bpm/kb/default/publish', json={'entity_id': 'proposal'})
    assert response.status_code == 403
    assert 'policy.admin' in response.json()['detail']
    engine.connect.assert_not_called()


def test_publish_requires_access_to_selected_kb():
    actor = MagicMock(id=7, is_super_admin=False)
    with patch.object(bpm_routes, '_bpm_service') as bpm, patch.object(bpm_routes, 'engine') as engine:
        bpm.check_kb_access.return_value = False
        with pytest.raises(HTTPException) as error:
            bpm_routes.publish_version_bpm('restricted', bpm_routes.PublishRequest(entity_id='proposal'), actor)
    assert error.value.status_code == 403
    engine.connect.assert_not_called()
    engine.begin.assert_not_called()


def test_proposal_lookup_filters_before_limit():
    from app.admin.services.bpm_service import BPMService
    engine = MagicMock()
    conn = engine.connect.return_value.__enter__.return_value
    conn.execute.return_value.mappings.return_value.all.return_value = [{'id': 1, 'entity_id': 'older-proposal'}]
    result = BPMService(engine).list_instances('default', limit=1, entity_id='older-proposal')
    query, params = conn.execute.call_args.args
    assert str(query).index('i.entity_id = :entity_id') < str(query).index('LIMIT :limit')
    assert params == {'kb_id': 'default', 'limit': 1, 'entity_id': 'older-proposal'}
    assert result[0]['entity_id'] == 'older-proposal'


def test_shadow_writer_uses_latest_runtime_config():
    from app.l5_intelligence.policy_shadow.shadow_repository import ShadowRepository
    engine = MagicMock()
    conn = engine.connect.return_value.__enter__.return_value
    conn.execute.return_value.mappings.return_value.first.return_value = {'active_version': 'current', 'shadow_version': 'proposal'}
    assert ShadowRepository(engine).get_runtime_versions() == ('current', 'proposal')
    assert 'ORDER BY id DESC LIMIT 1' in str(conn.execute.call_args.args[0])
