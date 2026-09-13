"""Deterministic worker operation for owner-submitted summary edits."""
from __future__ import annotations
import json
import os
import subprocess
import tempfile
from pathlib import Path
from shared.gitenv import scrubbed_git_env
from shared.reports import ReportEditError, parse_report, replace_summary, report_path
from worker.report_lock import workspace_report_lock


def _target(work: Path, relative: str) -> Path:
    target = work
    for part in relative.split('/'):
        target = target / part
        if target.is_symlink():
            raise ReportEditError(403, 'Sembolik bağlantı üzerinden özet yazılamaz.')
    if work.resolve() not in target.resolve().parents:
        raise ReportEditError(403, 'Çalışma alanı dışına yazılamaz.')
    return target


def _git(work: Path, *args: str, author: tuple[str, str] | None = None) -> bytes:
    name, email = author or ('Vexa', 'platform@vexa.ai')
    env = scrubbed_git_env(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                          GIT_COMMITTER_NAME='Vexa', GIT_COMMITTER_EMAIL='platform@vexa.ai')
    result = subprocess.run(['git', '-C', str(work), *args], env=env, capture_output=True)
    if result.returncode:
        raise ReportEditError(503, 'Özet çalışma alanı geçmişine kaydedilemedi.')
    return result.stdout


def commit_report_paths(work: Path, paths: list[str], author=None) -> None:
    if _git(work, 'diff', 'HEAD', '--', *paths):
        _git(work, 'commit', '--only', '-m', 'Edit meeting summary', '--', *paths, author=author)
    for path in paths:
        if _git(work, 'show', f'HEAD:{path}') != (work / path).read_bytes():
            raise ReportEditError(503, 'Özetin kaydedildiği doğrulanamadı.')


def _write(target: Path, content: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix='.report-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def edit_report_summary(job: dict, *, mounts: list[dict], grants: list[dict], author=None) -> dict:
    meeting_id, workspace = str(job.get('meeting_id', '')), job.get('workspace')
    relative = report_path(job.get('path'), meeting_id)
    allowed = any(grant.get('id') == workspace and grant.get('mode') == 'rw' for grant in grants)
    mount = next((m for m in mounts if m.get('slug') == workspace and m.get('write') is True and m.get('role') not in ('system', 'global')), None)
    if not allowed or mount is None:
        raise ReportEditError(403, 'Bu çalışma alanına yazma yetkiniz yok.')
    work = Path(mount['path'])
    if work.is_symlink() or not (work / '.git').is_dir():
        raise ReportEditError(403, 'Çalışma alanı doğrulanamadı.')
    target = _target(work, relative)
    if not target.is_file():
        raise ReportEditError(404, 'Özet bulunamadı.')
    with workspace_report_lock(work, blocking=False):
        original = target.read_bytes()
        if _git(work, 'show', f'HEAD:{relative}') != original:
            raise ReportEditError(409, 'Özetin kaydedilmemiş değişiklikleri var.')
        content = replace_summary(original.decode(), meeting_id=meeting_id, workspace=workspace,
                                  expected_revision=job.get('expected_revision'), summary=job.get('summary'))
        originals = {relative: original}
        alias_relative = relative[:-len(f'.run-{meeting_id}.md')] + '.md'
        alias = _target(work, alias_relative)
        if alias.is_file():
            try:
                alias_original = alias.read_bytes()
                meta, _ = parse_report(alias_original.decode(), meeting_id=meeting_id, workspace=workspace)
                if meta['report_revision'] == job['expected_revision'] and _git(work, 'show', f'HEAD:{alias_relative}') == alias_original:
                    originals[alias_relative] = alias_original
            except (ReportEditError, UnicodeError):
                pass
        try:
            for path in originals:
                _write(_target(work, path), content.encode())
            commit_report_paths(work, list(originals), author=author)
        except Exception:
            for path, before in originals.items():
                _write(_target(work, path), before)
            raise
        meta, _ = parse_report(content, meeting_id=meeting_id, workspace=workspace)
        return {'meeting_id':meeting_id, 'workspace':workspace, 'path':relative,
                'revision':meta['report_revision'], 'content':content}


def run_report_edit(stream, *, start: dict, out_topic: str, mounts: list[dict], grants: list[dict], author=None) -> None:
    stream.xadd(out_topic, {'event':json.dumps({'type':'turn-accepted','turn_id':'t0'})})
    try:
        job = json.loads(start['entrypoint']['inline'])
        result = edit_report_summary(job, mounts=mounts, grants=grants, author=author)
        event = {'type':'done','ok':True,'report':result}
    except ReportEditError as error:
        event = {'type':'done','ok':False,'status':error.status,'error':str(error)}
    except Exception:
        event = {'type':'done','ok':False,'status':503,'error':'Özet kaydedilemedi. Yeniden deneyin.'}
    stream.xadd(out_topic, {'event':json.dumps(event, ensure_ascii=False)})
    stream.xadd(out_topic, {'event':json.dumps({'type':'turn-complete','turn_id':'t0'})})
