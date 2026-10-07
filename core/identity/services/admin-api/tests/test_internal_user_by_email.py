"""Internal account lookup by email — `GET /internal/users/by-email/{email}`.

The service-to-service summaries reader (agent-api) resolves the account an integrating system
names by email over this X-Internal-Secret edge. Same testcontainers-PG harness as the other
suites (skips without docker).
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _internal():
    return {"X-Internal-Secret": INTERNAL_SECRET}


def test_lookup_requires_the_internal_secret(client):
    client.post("/admin/users", headers=_admin(), json={"email": "ayse.yilmaz@innova.com.tr"})
    assert client.get("/internal/users/by-email/ayse.yilmaz@innova.com.tr").status_code == 403
    assert client.get("/internal/users/by-email/ayse.yilmaz@innova.com.tr",
                      headers={"X-Internal-Secret": "wrong"}).status_code == 403


def test_lookup_resolves_case_insensitively(client):
    created = client.post("/admin/users", headers=_admin(),
                          json={"email": "ayse.yilmaz@innova.com.tr", "name": "Ayşe Yılmaz"}).json()
    r = client.get("/internal/users/by-email/Ayse.Yilmaz@Innova.com.tr", headers=_internal())
    assert r.status_code == 200
    assert r.json() == {"user_id": created["id"], "email": "ayse.yilmaz@innova.com.tr", "name": "Ayşe Yılmaz"}


def test_unknown_email_is_404(client):
    r = client.get("/internal/users/by-email/nobody@innova.com.tr", headers=_internal())
    assert r.status_code == 404
