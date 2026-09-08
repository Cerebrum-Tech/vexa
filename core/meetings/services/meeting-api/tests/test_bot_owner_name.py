"""bot_spawn — the in-meeting display name is tagged with the owner's username.

Every spawn path (UI/API via the gateway's ``x-user-email`` header, calendar auto-join via the
admin-api bot-context) folds the owner's email local-part into the bot's display name, so an
operator watching the participant list can tell one deployment's bots apart. The full address is
never shown; VEXA_BOT_NAME_APPEND_OWNER=false opts out.
"""
from __future__ import annotations

import json

import pytest

from meeting_api.bot_spawn import request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.invocation import conforms_invocation
from meeting_api.bot_spawn.service import _display_bot_name, _owner_username

SECRET = "test-admin-token"
USER = 7


# ── unit: the pure name resolver ─────────────────────────────────────────────────────────────────

def test_username_is_the_sanitized_local_part():
    assert _owner_username("alperenoz93@innova.com.tr") == "alperenoz93"
    assert _owner_username("jane.doe@corp.com") == "jane.doe"
    assert _owner_username("weird+name/hax@x.com") == "weirdnamehax"  # non-identifier chars dropped
    assert _owner_username(None) is None
    assert _owner_username("") is None


def test_display_name_appends_owner(monkeypatch):
    monkeypatch.delenv("VEXA_BOT_NAME_APPEND_OWNER", raising=False)
    monkeypatch.delenv("DEFAULT_BOT_NAME", raising=False)
    assert _display_bot_name("Innova Toplantı Asistanı", "a@b.com") == "Innova Toplantı Asistanı - a"
    # already present → not duplicated
    assert _display_bot_name("alperenoz93 team", "alperenoz93@x.com") == "alperenoz93 team"
    # no email → base untouched
    assert _display_bot_name("Innova", None) == "Innova"


def test_toggle_off_leaves_base(monkeypatch):
    monkeypatch.setenv("VEXA_BOT_NAME_APPEND_OWNER", "false")
    assert _display_bot_name("Innova", "a@b.com") == "Innova"


def test_default_base_still_gets_owner(monkeypatch):
    monkeypatch.delenv("VEXA_BOT_NAME_APPEND_OWNER", raising=False)
    monkeypatch.setenv("DEFAULT_BOT_NAME", "Bot")
    assert _display_bot_name(None, "sam@corp.com") == "Bot - sam"


# ── flow: the owner reaches the sealed invocation's botName ───────────────────────────────────────

async def test_spawn_tags_invocation_bot_name(monkeypatch):
    monkeypatch.delenv("VEXA_BOT_NAME_APPEND_OWNER", raising=False)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await request_bot(
        repo, runtime, user_id=USER, platform="google_meet",
        native_meeting_id="abc-defg-hij", bot_name="Innova Toplantı Asistanı",
        owner_email="alperenoz93@innova.com.tr",
        redis_url="redis://redis:6379/0", meeting_api_url="http://meeting-api:8080",
        token_secret=SECRET,
    )
    inv = json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"])
    conforms_invocation(inv)
    assert inv["botName"] == "Innova Toplantı Asistanı - alperenoz93"


async def test_spawn_without_owner_is_unchanged(monkeypatch):
    """Negative control: no owner email → the base name ships as-is (anonymous flow untouched)."""
    monkeypatch.delenv("VEXA_BOT_NAME_APPEND_OWNER", raising=False)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await request_bot(
        repo, runtime, user_id=USER, platform="google_meet",
        native_meeting_id="abc-defg-hij", bot_name="Innova Toplantı Asistanı",
        redis_url="redis://redis:6379/0", meeting_api_url="http://meeting-api:8080",
        token_secret=SECRET,
    )
    inv = json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"])
    assert inv["botName"] == "Innova Toplantı Asistanı"
