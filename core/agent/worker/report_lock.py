"""One workspace lock for report generation, transcript mirrors and explicit edits."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat

from shared.reports import ReportEditError


@contextmanager
def workspace_report_lock(work: Path, *, blocking: bool = True):
    """Serialize capture/write/commit/rollback; interactive edits use nonblocking mode."""
    work = Path(work)
    git = work / '.git'
    if work.is_symlink() or git.is_symlink() or not git.is_dir():
        raise ReportEditError(403, 'Çalışma alanı doğrulanamadı.')
    try:
        fd = os.open(git / 'vexa-report-edit.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        raise ReportEditError(403, 'Özet kilidi güvenle açılamadı.') from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ReportEditError(403, 'Özet kilidi doğrulanamadı.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError as error:
            raise ReportEditError(409, 'Bu çalışma alanında rapor işleniyor. Biraz sonra yeniden deneyin.') from error
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
