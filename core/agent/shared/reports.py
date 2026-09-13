"""Validation of canonical report artifacts and explicit summary replacements."""
from __future__ import annotations
import hashlib
import re
from pathlib import PurePosixPath
import yaml

class ReportEditError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status

_FRONT = re.compile(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)', re.S)

def report_path(path: str, meeting_id: str) -> str:
    if not str(meeting_id).isdigit() or int(meeting_id) < 1:
        raise ReportEditError(422, 'Geçersiz toplantı kimliği.')
    if not isinstance(path, str) or len(path) > 400 or not re.fullmatch(r'kg/entities/meeting/[\w.@:+-]+\.md', path):
        raise ReportEditError(422, 'Geçersiz özet yolu.')
    if not path.endswith(f'.run-{meeting_id}.md') or any(p in ('.', '..') for p in PurePosixPath(path).parts):
        raise ReportEditError(422, 'Özet bu toplantı kaydına ait değil.')
    return path

def parse_report(content: str, *, meeting_id: str, workspace: str) -> tuple[dict, str]:
    match = _FRONT.match(content)
    try:
        meta = yaml.safe_load(match[1]) if match else None
    except yaml.YAMLError as error:
        raise ReportEditError(409, 'Özet üst bilgisi okunamadı.') from error
    body = content[match.end():].strip() if match else ''
    if not isinstance(meta, dict) or str(meta.get('meeting_row_id')) != str(meeting_id) or meta.get('report_workspace') != workspace or meta.get('report_status') != 'completed':
        raise ReportEditError(409, 'Kaydedilmiş özet bu toplantıyla eşleşmiyor.')
    revision = hashlib.sha256(body.encode()).hexdigest()
    if meta.get('report_revision') != revision:
        raise ReportEditError(409, 'Özet değişmiş. Güncel sürümü açıp yeniden deneyin.')
    return meta, body

def replace_summary(content: str, *, meeting_id: str, workspace: str, expected_revision: str, summary: str) -> str:
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 20000:
        raise ReportEditError(422, 'Özet 1–20000 karakter olmalıdır.')
    if re.search(r'^\s*#{1,2}(?:\s|$)', summary, re.M) or '\x00' in summary:
        raise ReportEditError(422, 'Özet alanına bölüm başlığı eklemeyin.')
    meta, body = parse_report(content, meeting_id=meeting_id, workspace=workspace)
    if expected_revision != meta['report_revision']:
        raise ReportEditError(409, 'Özet başka bir işlemde değişti. Güncel sürümü açın.')
    section = re.search(r'^## Özet[^\S\r\n]*\r?\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    if not section:
        raise ReportEditError(422, 'Bu raporda düzenlenebilir Özet bölümü bulunamadı.')
    body = body[:section.start(1)] + summary.strip() + '\n\n' + body[section.end(1):]
    body = body.strip()
    meta['report_revision'] = hashlib.sha256(body.encode()).hexdigest()
    return '---\n' + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + '---\n\n' + body + '\n'
