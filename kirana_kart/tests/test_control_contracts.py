"""Regression contracts for controls that previously existed without callers."""
import ast
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

ROOT = Path(__file__).resolve().parents[1]

# Exact route + method + function, never wildcard prefixes. Reasons are reviewed
# alongside each exception. Application endpoints must reach get_current_user.
PUBLIC = {
    ('POST', '/auth/signup', 'signup'): 'Disabled by default; registration accepts no authority.',
    ('POST', '/auth/login', 'login'): 'Password authentication entry point, rate limited.',
    ('POST', '/auth/refresh', 'refresh_token'): 'Validates a rotating refresh credential.',
    **{('GET', f'/auth/oauth/{p}', f'{p}_login'): 'Starts OAuth state challenge.' for p in ('github', 'google', 'microsoft')},
    **{('GET', f'/auth/oauth/{p}/callback', f'{p}_callback'): 'Validates OAuth state and provider credential.' for p in ('github', 'google', 'microsoft')},
    ('GET', '/health', 'health'): 'Process liveness only.',
    ('GET', '/ready', 'readiness'): 'Dependency booleans for the load balancer.',
    ('GET', '/vectorize/health', 'vector_health'): 'Static module health.',
    ('GET', '/simulation/health', 'simulation_health'): 'Static module health.',
    ('GET', '/health/worker', 'worker_health'): 'Background worker heartbeat, no customer data.',
}


def authenticated(dependency):
    from app.admin.services.auth_service import get_current_user
    return dependency.call is get_current_user or any(authenticated(d) for d in dependency.dependencies)


def test_every_mounted_governance_route_requires_authentication():
    from app.admin.main import app
    used = set()
    missing = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            # Framework docs plus the network-restricted Prometheus scrape route.
            assert route.path in {'/openapi.json', '/docs', '/docs/oauth2-redirect', '/redoc', '/metrics'}
            continue
        for method in route.methods:
            key = (method, route.path, route.name)
            if key in PUBLIC:
                used.add(key)
            elif not authenticated(route.dependant):
                missing.append(key)
    assert not missing, f'Unauthenticated routes need a reviewed exception: {missing}'
    assert used == PUBLIC.keys(), f'Remove stale exceptions: {PUBLIC.keys() - used}'


@pytest.mark.parametrize('caller,symbol', [
    ('app/admin/routes/customers.py', 'log_pii_access'),
    ('app/l4_agents/tasks.py', 'run_retention_sweep'),
])
def test_registered_control_is_imported_and_called(caller, symbol):
    tree = ast.parse((ROOT / caller).read_text())
    names = {alias.asname or alias.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)
             for alias in n.names if alias.name == symbol}
    assert names, f'{caller} must import {symbol}'
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in names
               for n in ast.walk(tree)), f'{caller} must call {symbol}'


def test_retention_task_is_scheduled():
    tree = ast.parse((ROOT / 'app/l4_agents/tasks.py').read_text())
    assert any(isinstance(n, ast.Dict) and any(
        isinstance(k, ast.Constant) and k.value == 'task' and isinstance(v, ast.Constant)
        and v.value == 'app.l4_agents.tasks.beat_retention_sweep'
        for k, v in zip(n.keys, n.values)) for n in ast.walk(tree))


def test_ingest_routes_have_source_authentication():
    import main
    from app.l2_cardinal.routes import require_verified_source
    for route in main.app.routes:
        if isinstance(route, APIRoute):
            if route.path in {'/health', '/ready'}:
                continue
            assert route.path == '/cardinal/ingest'
            assert any(d.call is require_verified_source for d in route.dependant.dependencies)


@pytest.mark.parametrize('handler', ['list_customers', 'get_customer'])
def test_each_identity_response_records_access(handler):
    tree = ast.parse((ROOT / 'app/admin/routes/customers.py').read_text())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == handler)
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id == 'log_pii_access' for n in ast.walk(function))


def test_no_new_runtime_schema_definitions():
    import hashlib, json
    current = {}
    for path in (ROOT / 'app').rglob('*.py'):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                sql = node.value.upper()
                if any(token in sql for token in ('CREATE TABLE ', 'ALTER TABLE ', 'CREATE INDEX ', 'CREATE EXTENSION ')):
                    key = str(path.relative_to(ROOT)) + ':' + hashlib.sha256(node.value.encode()).hexdigest()
                    current[key] = True
    frozen = json.loads((ROOT / 'tests/runtime-ddl-baseline.json').read_text())
    assert current.keys() <= frozen.keys(), 'New schema changes belong in Alembic migrations, not app code'
