"""Fail startup on missing/outdated schema, without attempting DDL."""
from sqlalchemy import text
from app.admin.db import engine

SCHEMA_REVISION = '0007_group_key_hashes'


def verify_schema():
    from app.config import settings
    if settings.is_production:
        from app.utils.encryption import _load_key
        _load_key()
    try:
        with engine.connect() as conn:
            if settings.is_production:
                plaintext = conn.execute(text("""SELECT EXISTS(SELECT 1 FROM kirana_kart.customers
                    WHERE (email IS NOT NULL AND email NOT LIKE 'pii:v1:%')
                       OR (phone IS NOT NULL AND phone NOT LIKE 'pii:v1:%')
                       OR (date_of_birth IS NOT NULL AND date_of_birth NOT LIKE 'pii:v1:%')
                       OR (email IS NOT NULL AND email_blind_index IS NULL))""")).scalar()
                if plaintext:
                    raise RuntimeError('Customer PII backfill must complete before production startup')
            versions = conn.execute(text('SELECT version_num FROM public.alembic_version')).scalars().all()
        if versions != [SCHEMA_REVISION]:
            raise RuntimeError('Database schema revision mismatch')
    except Exception as exc:
        raise RuntimeError('Database is not migrated. Run alembic upgrade head before starting services.') from exc
