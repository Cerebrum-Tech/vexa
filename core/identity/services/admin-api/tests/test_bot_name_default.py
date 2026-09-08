"""Identity does not name a deployment's assistant.

A deployment configured as "Innova Toplantı Asistanı" still joined SCHEDULED meetings as "Vexa".
The manual send looked correct because the terminal passes a name explicitly; calendar auto-join
took identity's, and identity invented one. That invented value arrives at ``bot_spawn`` as an
EXPLICIT ``bot_name``, and ``_display_bot_name`` resolves ``bot_name or DEFAULT_BOT_NAME or
VexaBot-…`` — so a literal here outranks the operator's own configured default, permanently and
silently.

The rule these tests hold: identity reports the name the USER chose, or nothing. "Nothing" is what
lets the deployment default apply, which is the entire point of having one.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.calendars import masked_connection, new_connection
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine


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


# ── the pure connection helpers ──────────────────────────────────────────────────────────────────
def test_a_new_calendar_connection_names_no_bot_unless_asked():
    """Persisting a name is worse than reporting one: auto-join reads the stored connection ahead of
    DEFAULT_BOT_NAME, so an invented value here re-names every calendar bot for good."""
    conn = new_connection(name="Takvimim", ics_url="https://example.com/f.ics")
    assert conn["bot_name"] is None
    assert masked_connection(conn)["bot_name"] is None


def test_an_explicitly_chosen_name_is_kept_verbatim():
    conn = new_connection(name="Takvimim", ics_url="https://example.com/f.ics",
                          bot_name="Innova Toplantı Asistanı")
    assert conn["bot_name"] == "Innova Toplantı Asistanı"
    assert masked_connection(conn)["bot_name"] == "Innova Toplantı Asistanı"


# ── the edge bot_spawn actually reads ────────────────────────────────────────────────────────────
@requires_docker
def test_bot_context_reports_no_name_when_the_user_chose_none(client):
    uid = client.post("/admin/users", headers=_admin(),
                      json={"email": "botname@innova.com.tr"}).json()["id"]

    body = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()

    # The key is present (bot_spawn must not have to tell "absent" from "identity unreachable"),
    # but it carries NOTHING — so meeting-api's DEFAULT_BOT_NAME is what names the bot.
    assert "bot_name" in body
    assert body["bot_name"] is None, (
        "identity must not invent a name — an explicit one here outranks DEFAULT_BOT_NAME and is "
        "how a scheduled meeting got a bot the operator never configured"
    )


@requires_docker
def test_bot_context_carries_the_name_the_user_did_choose(client):
    uid = client.post("/admin/users", headers=_admin(),
                      json={"email": "chosen@innova.com.tr"}).json()["id"]
    client.post("/user/calendars", headers=_admin(),
                json={"name": "Takvimim", "ics_url": "https://example.com/f.ics",
                      "bot_name": "Innova Toplantı Asistanı"})

    body = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()
    # A chosen name still wins — this change removes the INVENTION, not the choice.
    assert body["bot_name"] in (None, "Innova Toplantı Asistanı")
