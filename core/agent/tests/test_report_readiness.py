"""A ready report is a committed artifact for the exact canonical run and workspace."""
import hashlib
import json
import subprocess
from unittest import mock

import yaml
import pytest

from llm.claude_code import ClaudeCodeHarness
from worker import meeting, worker

REPORT = "---\ntype: meeting\nid: recurring\ntitle: Toplantı\n---\n\n## Özet\nPlan görüşüldü.\n\n## Alınan Kararlar\nKarar alınmadı.\n\n## Aksiyon Maddeleri\nAksiyon yok.\n"


def test_report_readiness_is_stamped_by_producer_after_committed_success(tmp_path):
    target = tmp_path / "kg/entities/meeting/recurring.md"
    def execute(argv, cwd):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(REPORT)
        yield json.dumps({"type": "result", "subtype": "success", "result": "wrote", "session_id": "s"})
    with mock.patch.object(worker, "harness_factory", lambda: ClaudeCodeHarness(exec_fn=execute)):
        events = list(meeting.meeting_doc_turn(tmp_path, [], native="recurring", meeting_id="42", session_uid="run-42", platform="teams", date="2026-09-10", title="Toplantı", report_language="tr", workspace="team-one"))
    snapshot = target.with_name("recurring.run-42.md")
    assert snapshot.read_text() == target.read_text()
    from shared.gitenv import scrubbed_git_env
    for artifact in (snapshot, target):
        result = subprocess.run(["git", "-C", str(tmp_path), "show", f"HEAD:{artifact.relative_to(tmp_path)}"], capture_output=True, env=scrubbed_git_env())
        assert result.returncode == 0
        assert result.stdout == artifact.read_bytes()
    _, frontmatter, body = snapshot.read_text().split("---", 2)
    meta = yaml.safe_load(frontmatter)
    assert meta["meeting_row_id"] == "42"
    assert meta["report_workspace"] == "team-one"
    assert meta["report_status"] == "completed"
    assert meta["report_revision"] == hashlib.sha256(body.strip().encode()).hexdigest()
    assert events[-1]["type"] == "done" and events[-1]["ok"] is True
    assert any(event["type"] == "commit" for event in events)


def test_uncommitted_or_failed_model_output_never_becomes_ready(tmp_path, monkeypatch):
    target = tmp_path / "kg/entities/meeting/recurring.md"
    target.parent.mkdir(parents=True)
    original = "---\ntype: meeting\n---\n## Hazırlık\nGündem.\n"
    target.write_text(original)
    def fake_turn(*args, **kwargs):
        target.write_text(REPORT)
        yield {"type": "done", "ok": True}
    monkeypatch.setattr(worker, "run_turn_over_workspace", fake_turn)
    monkeypatch.setattr(meeting, "_DOC_TURN_BACKOFF_S", 0)
    events = list(meeting.meeting_doc_turn(tmp_path, [], native="recurring", meeting_id="42", session_uid="run-42", platform="teams", date="2026-09-10", title="Toplantı", report_language="tr", workspace="team-one"))
    assert target.read_text() == original
    assert events[-1]["ok"] is False


def test_failed_publication_rolls_back_both_artifacts(tmp_path, monkeypatch):
    from pathlib import Path
    target = tmp_path / "kg/entities/meeting/recurring.md"
    target.parent.mkdir(parents=True)
    target.write_text("original transcript")
    def execute(argv, cwd):
        target.write_text(REPORT)
        yield json.dumps({"type": "result", "subtype": "success", "result": "wrote"})
    replace = Path.replace
    def fail_native(self, destination):
        if destination == target:
            raise OSError("publication unavailable")
        return replace(self, destination)
    monkeypatch.setattr(Path, "replace", fail_native)
    monkeypatch.setattr(meeting, "_DOC_TURN_BACKOFF_S", 0)
    with mock.patch.object(worker, "harness_factory", lambda: ClaudeCodeHarness(exec_fn=execute)):
        try:
            list(meeting.meeting_doc_turn(tmp_path, [], native="recurring", meeting_id="42", session_uid="run-42", platform="teams", date="2026-09-10", title="Toplantı", report_language="tr", workspace="team-one"))
        except OSError:
            pass
    assert not target.with_name("recurring.run-42.md").exists()
    assert target.read_text() == "original transcript"


@pytest.mark.parametrize("status", ["completed", '"completed"', "  completed"])
def test_stamped_report_reader_requires_matching_committed_bytes(tmp_path, status):
    from control_plane.workspace_reader import WorkspaceReader
    from shared.gitenv import scrubbed_git_env
    work = tmp_path / "alice"
    target = work / "kg/entities/meeting/recurring.run-42.md"
    target.parent.mkdir(parents=True)
    content = f"---\nreport_status: {status}\n---\n## Summary\nReady.\n"
    target.write_text(content)
    reader = WorkspaceReader(str(tmp_path))
    path = target.relative_to(work).as_posix()
    assert reader.read_at(work, path) is None
    env = scrubbed_git_env()
    for args in (["init"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@vexa.local", "commit", "-m", "report"]):
        subprocess.run(["git", "-C", str(work), *args], env=env, check=True, capture_output=True)
    assert reader.read_at(work, path) == content
    target.write_text(content + "uncommitted change")
    assert reader.read_at(work, path) is None
