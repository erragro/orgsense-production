"""Bounded, non-cached readiness checks. Liveness remains dependency-free."""
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.config import settings
from app.admin.redis_client import ping

# Separate from the request pool: saturation must not leave probes waiting for
# DB_POOL_TIMEOUT. PostgreSQL also bounds execution and connection setup.
probe_engine = create_engine(
    settings.database_url, poolclass=NullPool,
    connect_args={"connect_timeout": 2, "options": "-c statement_timeout=2000"},
)


def readiness():
    checks = {"database": False, "redis": False}
    try:
        with probe_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception:
        pass
    checks["redis"] = ping()
    ready = all(checks.values())
    return JSONResponse(
        {"status": "ready" if ready else "not_ready", "checks": checks},
        status_code=200 if ready else 503,
        headers={"Cache-Control": "no-store"},
    )
