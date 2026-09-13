"""Low-cardinality, executable operational controls (no customer labels)."""
from functools import wraps
from prometheus_client import Counter

operations = Counter('orgsense_operations_total', 'Completed operations by outcome', ['operation','outcome'])


def observed(operation):
    def decorate(function):
        @wraps(function)
        def wrapper(*args, **kwargs):
            try:
                result = function(*args, **kwargs)
            except Exception:
                operations.labels(operation, 'error').inc()
                raise
            operations.labels(operation, 'ok').inc()
            return result
        return wrapper
    return decorate


from prometheus_client import Gauge
queue_depth = Gauge('orgsense_cardinal_queue_depth', 'Pending plus undispatched messages', ['priority'])
overdue_grievances = Gauge('orgsense_overdue_grievances', 'Unresolved grievances past their response deadline')
unassigned_grievances = Gauge('orgsense_unassigned_grievances', 'Unresolved grievances without an owner')
monitor_healthy = Gauge('orgsense_monitor_healthy', 'Dependency monitoring collection succeeded', ['dependency'])


def refresh_operational_gauges():
    """Called by the governance background worker; errors are never reported as zero."""
    from sqlalchemy import text
    from app.readiness import probe_engine
    from app.admin.redis_client import get_redis
    try:
        with probe_engine.connect() as conn:
            row = conn.execute(text('''SELECT
                COUNT(*) FILTER (WHERE due_at < NOW()),
                COUNT(*) FILTER (WHERE owner_user_id IS NULL)
                FROM kirana_kart.grievances WHERE resolved_at IS NULL''')).one()
        overdue_grievances.set(row[0])
        unassigned_grievances.set(row[1])
        monitor_healthy.labels('database').set(1)
    except Exception:
        monitor_healthy.labels('database').set(0)
    try:
        redis = get_redis()
        for priority in ('P1_CRITICAL','P2_HIGH','P3_STANDARD','P4_LOW'):
            stream = f'cardinal:dispatch:{priority}'
            if not redis.exists(stream):
                depth = 0
            else:
                groups = redis.xinfo_groups(stream)
                # Lag is absent on older Redis versions; report monitor failure
                # instead of falsely presenting the backlog as zero.
                if any(g.get('lag') is None for g in groups):
                    raise RuntimeError('Redis consumer lag is unavailable')
                depth = max((g['pending'] + g['lag'] for g in groups), default=redis.xlen(stream))
            queue_depth.labels(priority).set(depth)
        monitor_healthy.labels('redis').set(1)
    except Exception:
        monitor_healthy.labels('redis').set(0)
