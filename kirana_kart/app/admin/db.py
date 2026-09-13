"""
app/admin/db.py
===============
Shared database layer — SQLAlchemy engine, session factory, and
pool-backed raw-connection helper.

All database access in Kirana Kart routes through this module so that
every connection is drawn from a single shared pool rather than
opening a new TCP connection per operation.

Exports:
    engine          — SQLAlchemy Engine (singleton, pool-backed)
    SessionLocal    — sessionmaker factory; use via get_db_session()
    get_db_session  — context manager → SQLAlchemy Session
    get_db_connection — context manager → pool-backed DBAPI connection
                         for code that still uses raw psycopg2 SQL

Migration path:
    New code and refactored services: use get_db_session() + text()
    Legacy pipeline code (normaliser, phase1, worker): use get_db_connection()
    Both draw from the same pool — no separate connections created.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine, event, text, exc
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import QueuePool

from app.config import settings

logger = logging.getLogger(__name__)

# ============================================================
# ENGINE — created once at import time
# ============================================================

engine = create_engine(
    settings.database_url,
    poolclass=QueuePool,
    hide_parameters=True,
    connect_args={"connect_timeout": 5},
    pool_size=settings.db_pool_size,        # long-lived connections kept open
    max_overflow=settings.db_max_overflow,  # burst headroom above pool_size
    pool_timeout=settings.db_pool_timeout,  # seconds to wait for a free connection
    pool_recycle=settings.db_pool_recycle,  # recycle connections after N seconds
    pool_pre_ping=True,                     # check connection health before use
    echo=False,                             # set True for SQL query logging in dev
)


@event.listens_for(engine, "connect")
def _on_connect(dbapi_conn, connection_record):
    """Log new physical connections to the pool (not per-checkout)."""
    connection_record.info["pid"] = os.getpid()
    logger.debug("New database connection established to pool.")


@event.listens_for(engine, "checkout")
def _on_checkout(dbapi_conn, connection_record, connection_proxy):
    """Emitted on every connection checkout from the pool."""
    if connection_record.info.get("pid") != os.getpid():
        connection_record.dbapi_connection = connection_proxy.dbapi_connection = None
        raise exc.DisconnectionError("Connection belongs to another process")
    logger.debug("Connection checked out from pool.")


# ============================================================
# SESSION FACTORY
# ============================================================

SessionLocal: sessionmaker[Session] = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,   # keep attributes accessible after commit
)


# ============================================================
# SESSION CONTEXT MANAGER — for service layer code
# ============================================================

@contextmanager
def get_db_session() -> Generator[Session, None, None]:
    """
    Yield a SQLAlchemy Session drawn from the shared pool.

    Commits on clean exit; rolls back and re-raises on exception.
    The session is always closed (connection returned to pool) in the
    finally block regardless of success or failure.

    Usage:
        from app.admin.db import get_db_session
        from sqlalchemy import text

        with get_db_session() as session:
            row = session.execute(
                text("SELECT role FROM kirana_kart.admin_users WHERE api_token = :token"),
                {"token": api_token},
            ).mappings().first()

    FastAPI dependency injection alternative:
        def get_db():
            with get_db_session() as session:
                yield session

        @app.get("/")
        def endpoint(db: Session = Depends(get_db)):
            ...
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# ============================================================
# RAW CONNECTION CONTEXT MANAGER — for legacy psycopg2 code
# ============================================================

@contextmanager
def get_db_connection():
    """
    Yield a pool-backed DBAPI (psycopg2) connection.

    Use this as a drop-in replacement for psycopg2.connect() in modules
    that still use raw SQL cursors (normaliser, phase1_validator, worker).
    The connection is drawn from — and returned to — the SQLAlchemy pool,
    so it benefits from pooling without requiring a session/ORM migration.

    Commits on clean exit; rolls back on exception.
    Calling conn.close() returns the connection to the pool (does NOT
    close the underlying TCP socket).

    Usage:
        from app.admin.db import get_db_connection

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    """
    conn = engine.raw_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()   # returns to pool


# ============================================================
# LEGACY SHIM — backward compatibility for existing callers
# ============================================================

class PooledConnection:
    """Preserve psycopg2 transaction contexts while returning sockets to the pool.

    SQLAlchemy's raw proxy context closes on exit, unlike psycopg2's commit/rollback
    context. Legacy callers therefore need this explicit compatibility adapter.
    """
    def __init__(self, connection):
        object.__setattr__(self, "_connection", connection)

    def __getattr__(self, name):
        return getattr(self._connection.driver_connection, name)

    def __setattr__(self, name, value):
        setattr(self._connection.driver_connection, name, value)

    def __enter__(self):
        self._connection.driver_connection.__enter__()
        return self

    def __exit__(self, *args):
        return self._connection.driver_connection.__exit__(*args)

    def close(self):
        self._connection.close()


def get_connection():
    """Borrow a legacy-compatible connection; caller must close it in finally."""
    return PooledConnection(engine.raw_connection())
