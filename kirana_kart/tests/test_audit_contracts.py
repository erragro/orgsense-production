import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest
from app.admin.rate_limit_identity import client_address

ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT.parent / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_forwarded_rate_limit_identity_only_trusts_configured_proxies(monkeypatch):
    monkeypatch.setenv('TRUSTED_PROXY_CIDRS', '10.0.0.0/24')
    def request(peer, forwarded):
        return SimpleNamespace(client=SimpleNamespace(host=peer), headers={'x-forwarded-for': forwarded})
    assert client_address(request('192.0.2.1','198.51.100.1')) == '192.0.2.1'
    assert client_address(request('10.0.0.2','203.0.113.9, 192.0.2.1, 10.0.0.3')) == '192.0.2.1'
    assert client_address(request('10.0.0.2','invalid')) == '10.0.0.2'


def test_pipeline_cannot_open_unpooled_psycopg_connections():
    for path in (ROOT / 'app').rglob('*.py'):
        tree = ast.parse(path.read_text())
        assert not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and isinstance(n.func.value, ast.Name) and n.func.value.id == 'psycopg2'
            and n.func.attr == 'connect' for n in ast.walk(tree)), path


def test_release_gate_requires_current_success_from_github_actions():
    gate = load_script('require_ci')
    runs = [dict(id=i, name=name, head_sha='a'*40, app={'slug':'github-actions'}, conclusion='success') for i,name in enumerate(gate.REQUIRED)]
    gate.validate(runs, 'a'*40)
    for invalid in (runs[:-1], [dict(r, head_sha='b'*40) for r in runs], [dict(r, app={'slug':'other'}) for r in runs], runs+[dict(runs[0], id=100, conclusion='failure')]):
        with pytest.raises(RuntimeError): gate.validate(invalid, 'a'*40)


def test_release_renderer_requires_immutable_app_images():
    import yaml
    renderer = load_script('render_k8s_release')
    with pytest.raises(ValueError): renderer.render({'governance':'repo:latest'})
    images = {name:f'registry/{name}@sha256:'+'a'*64 for name in ('governance','ingest','ui')}
    rendered = renderer.render(images)
    assert 'RELEASE_REQUIRED' not in rendered
    for doc in yaml.safe_load_all(rendered):
        if doc.get('kind') not in ('Deployment','Job'): continue
        pod = doc['spec']['template']['spec']
        assert pod['securityContext']['runAsNonRoot']
        for c in pod['containers']:
            assert c['securityContext']['readOnlyRootFilesystem']
            assert not c['securityContext']['allowPrivilegeEscalation']
            assert c['securityContext']['capabilities']['drop'] == ['ALL']
