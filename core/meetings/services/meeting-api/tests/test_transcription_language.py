"""VEXA_TRANSCRIPTION_LANGUAGE — the deployment's default transcription language.

The caller's `language` wins; otherwise the deployment default; otherwise None and whisper
auto-detects. One key, read by the bot spawn (every path goes through build_invocation) and by
POST /uploads, so a bot-attended meeting and an uploaded recording are transcribed alike.
"""
from __future__ import annotations

import io

import pytest

from meeting_api.bot_spawn.service import _transcription_language


def test_deployment_default_applies_when_the_caller_names_none(monkeypatch):
    monkeypatch.setenv("VEXA_TRANSCRIPTION_LANGUAGE", "tr")
    assert _transcription_language(None) == "tr"
    assert _transcription_language("") == "tr"
    assert _transcription_language("  ") == "tr"


def test_the_callers_language_wins(monkeypatch):
    monkeypatch.setenv("VEXA_TRANSCRIPTION_LANGUAGE", "tr")
    assert _transcription_language("en") == "en"


def test_unset_means_auto_detect(monkeypatch):
    monkeypatch.delenv("VEXA_TRANSCRIPTION_LANGUAGE", raising=False)
    assert _transcription_language(None) is None
    monkeypatch.setenv("VEXA_TRANSCRIPTION_LANGUAGE", "  ")
    assert _transcription_language(None) is None


def test_invocation_carries_the_deployment_language(monkeypatch):
    monkeypatch.setenv("VEXA_TRANSCRIPTION_LANGUAGE", "tr")
    from meeting_api.bot_spawn import invocation as inv_mod
    from meeting_api.bot_spawn import service as svc

    inv = inv_mod.build_invocation(
        meeting_id=1, platform="teams", meeting_url="https://teams.microsoft.com/l/meetup-join/x",
        bot_name="Innova Toplantı Asistanı", passcode=None, token="t", native_meeting_id="x",
        connection_id="c", language=svc._transcription_language(None), task=None,
        transcription_tier="realtime", redis_url="redis://r",
        meeting_api_callback_url="http://m/cb", internal_secret="s",
    )
    assert inv["language"] == "tr"


def test_upload_row_carries_the_deployment_language(monkeypatch):
    monkeypatch.setenv("VEXA_TRANSCRIPTION_LANGUAGE", "tr")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "http://stt")
    from fastapi.testclient import TestClient
    from meeting_api.app import create_app

    client = TestClient(create_app())
    resp = client.post(
        "/uploads", headers={"X-User-Id": "7"},
        files={"file": ("a.mp3", io.BytesIO(b"\x00" * 64), "audio/mpeg")},
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["upload"]["language"] == "tr"
    resp = client.post(
        "/uploads", headers={"X-User-Id": "7"}, data={"language": "en"},
        files={"file": ("a.mp3", io.BytesIO(b"\x00" * 64), "audio/mpeg")},
    )
    assert resp.json()["upload"]["language"] == "en"
