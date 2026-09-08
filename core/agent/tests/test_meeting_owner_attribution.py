"""The copilot runs under the meeting's OWNER, and its dispatch makes the workspace it mounts.

Both halves of one production outage. Every meeting copilot was dispatched under a hardcoded
``u_live`` placeholder; that subject had no workspace on disk, and the mount set names a path the
runtime bind-mounts, so the container could not start:

    docker start vexa-worker-meet-16 failed (404):
    cannot access path .../agent-workspaces/_data/u_live: no such file or directory

No copilot ever ran, so no meeting on that deployment ever got a post-meeting report — and the
terminal's recap panel, which polls the READER'S OWN workspace, would not have found one there even
if it had. These are the assertions for both: attribute the meeting to its owner, and never hand the
runtime a path that is not on disk.
"""
from __future__ import annotations

import json
import types

import pytest

import control_plane.transcription_watcher as w
from control_plane.dispatch import build_mount_set, ensure_subject_home


class _Resp:
    def __init__(self, body: dict):
        self._b = json.dumps(body).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture(autouse=True)
def _clean():
    w._owner.clear()
    w._owner_miss_at.clear()
    w._relay_health["owner_resolve"] = {"ok": True, "kind": None, "detail": None, "at": None, "misses": 0}
    yield
    w._owner.clear()
    w._owner_miss_at.clear()


# ── resolving the owner ──────────────────────────────────────────────────────────────────────────
def test_the_owner_comes_from_meeting_apis_internal_edge(monkeypatch):
    monkeypatch.setenv("VEXA_INTERNAL_API_SECRET", "s3cret")
    monkeypatch.setenv("VEXA_MEETING_API_URL", "http://meeting-api:8080")
    seen = {}

    def fake_urlopen(req, timeout=5):
        seen["url"] = req.full_url
        seen["secret"] = req.headers.get("X-internal-secret")
        return _Resp({"meeting_id": 14, "user_id": 3})

    monkeypatch.setattr(w.urllib.request, "urlopen", fake_urlopen)
    assert w._resolve_owner("14") == "3"
    assert seen["url"] == "http://meeting-api:8080/internal/meetings/14/owner"
    assert seen["secret"] == "s3cret"          # service-to-service, not a user key


def test_the_owner_is_cached_so_it_is_not_looked_up_per_segment(monkeypatch):
    monkeypatch.setenv("VEXA_INTERNAL_API_SECRET", "s3cret")
    calls = []

    monkeypatch.setattr(w.urllib.request, "urlopen",
                        lambda req, timeout=5: (calls.append(1), _Resp({"user_id": 3}))[1])
    assert w._resolve_owner("14") == "3"
    assert w._resolve_owner("14") == "3"
    assert len(calls) == 1


def test_a_missing_secret_is_reported_loudly_rather_than_guessed(monkeypatch):
    """Attributing a meeting to the wrong workspace is worse than not attributing it: the report
    would be written where its reader will never look, and nothing would say so."""
    monkeypatch.delenv("VEXA_INTERNAL_API_SECRET", raising=False)
    assert w._resolve_owner("14") is None
    health = w.relay_health()["owner_resolve"]
    assert health["ok"] is False
    assert health["kind"] == "unauthorized"
    assert "VEXA_INTERNAL_API_SECRET" in health["detail"]


def test_an_unresolvable_owner_is_retried_not_cached(monkeypatch):
    monkeypatch.setenv("VEXA_INTERNAL_API_SECRET", "s3cret")
    monkeypatch.setattr(w.urllib.request, "urlopen",
                        lambda req, timeout=5: (_ for _ in ()).throw(OSError("down")))
    assert w._resolve_owner("14") is None
    assert "14" not in w._owner          # a miss must never freeze the wrong attribution in place


# ── the arm uses it ──────────────────────────────────────────────────────────────────────────────
class _Dispatcher:
    def __init__(self):
        self.dispatched = []

    def dispatch(self, inv):
        self.dispatched.append(inv)
        return "unit-id"


class _Live:
    def __init__(self):
        self.by_uid = {}

    def add(self, m):
        self.by_uid[m["session_uid"]] = dict(m)

    def drop(self, uid):
        self.by_uid.pop(uid, None)


def _handle(monkeypatch, dispatcher, *, owner):
    monkeypatch.setattr(w, "_resolve_owner", lambda mid: owner)
    monkeypatch.setattr(w, "_resolve_native", lambda mid: ("abc-defg-hij", "google_meet"))
    live = _Live()
    payload = {"type": "transcription", "meeting_id": "14", "segments": [
        {"text": "merhaba", "completed": True, "start": 0.0, "end": 1.0, "segment_id": "x"}]}

    class _R:
        kv: dict = {}
        def get(self, k): return None
        def expire(self, k, t): pass
        def delete(self, k): pass

    w._handle(_R(), dispatcher, live, "u_live", payload, {}, {}, {})
    return live


def test_the_copilot_is_dispatched_under_the_meetings_owner(monkeypatch):
    d = _Dispatcher()
    live = _handle(monkeypatch, d, owner="3")
    assert d.dispatched, "the meeting must arm a copilot"
    assert d.dispatched[0]["identity"]["subject"] == "3"   # not the u_live placeholder
    assert live.by_uid["14"]["subject"] == "3"


def test_an_unattributable_meeting_still_arms_under_the_fallback(monkeypatch):
    """Losing the report entirely is worse than writing it somewhere imperfect — the fallback keeps
    the copilot running, and relay_health carries why it was needed."""
    d = _Dispatcher()
    _handle(monkeypatch, d, owner=None)
    assert d.dispatched[0]["identity"]["subject"] == "u_live"


# ── the dispatch makes the home it mounts ────────────────────────────────────────────────────────
def _settings(tmp_path):
    return types.SimpleNamespace(
        workspaces_dir=str(tmp_path), default_template=None, workspace_seeds_dir=None,
    )


def test_ensure_subject_home_materializes_an_absent_workspace(tmp_path, monkeypatch):
    seeded = {}

    def fake_seed(ws, seed_dir):
        ws.mkdir(parents=True, exist_ok=True)
        (ws / ".git").mkdir(exist_ok=True)
        seeded["ws"] = ws
        return ws

    monkeypatch.setattr("control_plane.dispatch.resolve_seed_dir", lambda *a, **k: tmp_path / "seed")
    monkeypatch.setattr("control_plane.dispatch.validate_seed", lambda seed: [])
    monkeypatch.setattr("control_plane.dispatch.seed_workspace", fake_seed)
    monkeypatch.setattr("control_plane.dispatch._system_mounts.ensure_system_workspace",
                        lambda root, subject: None)

    assert ensure_subject_home(_settings(tmp_path), "3") is True
    assert (tmp_path / "3" / ".git").is_dir()
    assert seeded["ws"] == tmp_path / "3"


def test_ensure_subject_home_is_a_no_op_for_an_existing_workspace(tmp_path, monkeypatch):
    (tmp_path / "3" / ".git").mkdir(parents=True)
    monkeypatch.setattr("control_plane.dispatch.seed_workspace",
                        lambda *a, **k: pytest.fail("must not re-seed an existing workspace"))
    assert ensure_subject_home(_settings(tmp_path), "3") is True


def test_a_mount_whose_path_is_not_on_disk_is_dropped(tmp_path, monkeypatch):
    """The exact production failure: the mount set named .../u_live, the runtime bind-mounted it, and
    `docker start` failed because the path did not exist. A phantom mount costs the workload its
    existence, so it never reaches the runtime."""
    monkeypatch.setattr("control_plane.dispatch.build_active_set",
                        lambda s, subj, m=None: [
                            {"slug": "ghost", "path": str(tmp_path / "u_live"), "role": "private",
                             "write": True, "primary": True},
                        ])
    monkeypatch.setattr("control_plane.dispatch.global_mount", lambda *a, **k: None)
    monkeypatch.setattr("control_plane.dispatch.system_mount",
                        lambda root, subject: {"slug": "_system", "path": str(tmp_path)})
    stack = build_mount_set(_settings(tmp_path), "u_live")
    assert all(m.get("slug") != "ghost" for m in stack), "a path not on disk must never be mounted"


def test_a_real_mount_survives(tmp_path, monkeypatch):
    (tmp_path / "3").mkdir()
    monkeypatch.setattr("control_plane.dispatch.build_active_set",
                        lambda s, subj, m=None: [
                            {"slug": "3", "path": str(tmp_path / "3"), "role": "private",
                             "write": True, "primary": True},
                        ])
    monkeypatch.setattr("control_plane.dispatch.global_mount", lambda *a, **k: None)
    monkeypatch.setattr("control_plane.dispatch.system_mount",
                        lambda root, subject: {"slug": "_system", "path": str(tmp_path)})
    stack = build_mount_set(_settings(tmp_path), "3")
    assert any(m.get("slug") == "3" for m in stack)
