"""Container deploy entry point; no application import or .env loading."""
import os
from pathlib import Path
from sqlalchemy.engine import URL
from alembic.config import Config
from alembic import command

if __name__ == '__main__':
    if not os.environ.get('MIGRATION_DATABASE_URL'):
        os.environ['MIGRATION_DATABASE_URL'] = URL.create(
            'postgresql+psycopg2', username=os.environ['DB_USER'],
            password=os.environ['DB_PASSWORD'], host=os.environ['DB_HOST'],
            port=int(os.environ.get('DB_PORT', '5432')), database=os.environ['DB_NAME'],
        ).render_as_string(hide_password=False)
    command.upgrade(Config(str(Path(__file__).parents[1] / 'alembic.ini')), 'head')
