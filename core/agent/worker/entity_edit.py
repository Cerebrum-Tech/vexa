"""Deterministic worker operation for owner-authored directory cards (person / company / note)."""
from __future__ import annotations
import json
import subprocess
from pathlib import Path
from shared.entities import EntityEditError, render_entity, validate_entity_path
from shared.gitenv import scrubbed_git_env
from shared.reports import ReportEditError
from worker.report_edit import _target, _write
from worker.report_lock import workspace_report_lock


def _git(work: Path, *args: str, author: tuple[str, str] | None = None) -> bytes:
    name, email = author or ("Vexa", "platform@vexa.ai")
    env = scrubbed_git_env(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                           GIT_COMMITTER_NAME="Vexa", GIT_COMMITTER_EMAIL="platform@vexa.ai")
    result = subprocess.run(["git", "-C", str(work), *args], env=env, capture_output=True)
    if result.returncode:
        raise EntityEditError(503, "Kayıt çalışma alanı geçmişine kaydedilemedi.")
    return result.stdout


def _commit(work: Path, relative: str, author=None) -> None:
    """Stage the card and commit it. A NEW card is untracked, so it is added first — without that,
    `commit --only <path>` has nothing to commit and the file never reaches history at all."""
    _git(work, "add", "--", relative)
    if _git(work, "diff", "--cached", "--", relative):
        _git(work, "commit", "--only", "-m", f"Edit {relative}", "--", relative, author=author)
    if _git(work, "show", f"HEAD:{relative}") != (work / relative).read_bytes():
        raise EntityEditError(503, "Kaydın kaydedildiği doğrulanamadı.")


def write_entity(job: dict, *, mounts: list[dict], grants: list[dict], author=None) -> dict:
    """Write ONE entity file and commit it. No model call: the bytes come from `render_entity`.

    The authorization, symlink refusal, workspace lock and commit verification are the same ones the
    summary edit runs under — a hand-written card reaches history exactly the way an edited report
    does, and a failure leaves the file as it was."""
    workspace, kind = job.get("workspace"), str(job.get("kind", ""))
    relative = validate_entity_path(job.get("path"), kind)
    allowed = any(g.get("id") == workspace and g.get("mode") == "rw" for g in grants)
    mount = next((m for m in mounts if m.get("slug") == workspace and m.get("write") is True
                  and m.get("role") not in ("system", "global")), None)
    if not allowed or mount is None:
        raise EntityEditError(403, "Bu çalışma alanına yazma yetkiniz yok.")
    work = Path(mount["path"])
    if work.is_symlink() or not (work / ".git").is_dir():
        raise EntityEditError(403, "Çalışma alanı doğrulanamadı.")
    content = render_entity(kind=kind, title=job.get("title"), body=job.get("body"),
                            entity_id=job.get("entity_id"))
    try:
        target = _target(work, relative)
    except ReportEditError as error:
        raise EntityEditError(error.status, str(error)) from error
    if job.get("create") and target.exists():
        raise EntityEditError(409, "Bu kayıt zaten var.")
    if not job.get("create") and not target.is_file():
        raise EntityEditError(404, "Kayıt bulunamadı.")
    with workspace_report_lock(work, blocking=False):
        before = target.read_bytes() if target.is_file() else None
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            _write(target, content.encode())
            _commit(work, relative, author=author)
        except Exception:
            if before is None:
                target.unlink(missing_ok=True)
                _git(work, "reset", "--quiet", "HEAD", "--", relative)
            else:
                _write(target, before)
            raise
    return {"workspace": workspace, "kind": kind, "path": relative, "content": content}


def run_entity_edit(stream, *, start: dict, out_topic: str, mounts: list[dict],
                    grants: list[dict], author=None) -> None:
    stream.xadd(out_topic, {"event": json.dumps({"type": "turn-accepted", "turn_id": "t0"})})
    try:
        job = json.loads(start["entrypoint"]["inline"])
        event = {"type": "done", "ok": True, "entity": write_entity(job, mounts=mounts, grants=grants, author=author)}
    except (EntityEditError, ReportEditError) as error:
        event = {"type": "done", "ok": False, "status": error.status, "error": str(error)}
    except Exception:
        event = {"type": "done", "ok": False, "status": 503, "error": "Kayıt kaydedilemedi. Yeniden deneyin."}
    stream.xadd(out_topic, {"event": json.dumps(event, ensure_ascii=False)})
    stream.xadd(out_topic, {"event": json.dumps({"type": "turn-complete", "turn_id": "t0"})})
