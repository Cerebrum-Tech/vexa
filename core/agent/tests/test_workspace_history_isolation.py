"""Conversation lookup never discovers another subject's legacy continuity."""
import json

import pytest

from control_plane.workspace_reader import WorkspaceReader


def seed_history(ws, session="meeting-28-42", text="private conversation"):
    sessions = ws / ".claude" / "sessions"
    sessions.mkdir(parents=True)
    (sessions / f"{session}.session").write_text("sid-1")
    projects = ws / ".claude" / "projects" / "cwd"
    projects.mkdir(parents=True)
    (projects / "sid-1.jsonl").write_text(json.dumps({
        "type": "user", "message": {"content": text},
    }))


@pytest.mark.parametrize("foreign_root", ["alice", ".attached/alice/private", ".system/alice", "revoked-shared"])
def test_history_never_discovers_foreign_or_revoked_roots(tmp_path, foreign_root):
    seed_history(tmp_path / foreign_root)
    reader = WorkspaceReader(str(tmp_path))
    assert reader.history("bob", "meeting-28-42") == []


def test_authorized_legacy_mount_remains_readable(tmp_path):
    shared = tmp_path / "shared"
    seed_history(shared)
    reader = WorkspaceReader(str(tmp_path))
    assert reader.history("bob", "meeting-28-42", extra_roots=[shared]) == [
        {"role": "user", "text": "private conversation"},
    ]
    assert reader.history("bob", "meeting-28-42") == []
