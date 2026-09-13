"""Migrations use an explicit owner URL; runtime credentials need no DDL rights."""
import os
from alembic import context
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

url = os.environ.get('MIGRATION_DATABASE_URL')
if not url:
    raise RuntimeError('Set MIGRATION_DATABASE_URL to the schema-owner database URL')

if context.is_offline_mode():
    raise RuntimeError('These migrations require a live connection for validation; offline SQL generation is unsupported')
else:
    engine = create_engine(url, poolclass=NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, version_table_schema="public")
        with context.begin_transaction():
            # Serialise competing deploy jobs; transaction-scoped, released even on error.
            connection.exec_driver_sql('SELECT pg_advisory_xact_lock(88010001)')
            context.run_migrations()
    engine.dispose()
