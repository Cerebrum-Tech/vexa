"""Report writers serialize their original-byte capture through the same real lock."""
from pathlib import Path
import threading
import pytest
from shared.reports import ReportEditError
from worker.report_lock import workspace_report_lock
from worker import meeting, worker


def workspace(tmp_path):
    work=tmp_path/'work'; (work/'.git').mkdir(parents=True)
    return work


def test_nonblocking_report_lock_is_busy_and_workspace_scoped(tmp_path):
    work=workspace(tmp_path); other=tmp_path/'other'; (other/'.git').mkdir(parents=True)
    with workspace_report_lock(work):
        with pytest.raises(ReportEditError) as error:
            with workspace_report_lock(work,blocking=False):pass
        assert error.value.status==409
        with workspace_report_lock(other,blocking=False):pass
    with workspace_report_lock(work,blocking=False):pass


def test_symlink_lock_file_is_rejected(tmp_path):
    work=workspace(tmp_path); outside=tmp_path/'outside'; outside.write_text('private')
    (work/'.git/vexa-report-edit.lock').symlink_to(outside)
    with pytest.raises(ReportEditError):
        with workspace_report_lock(work):pass
    assert outside.read_text()=='private'


def test_producer_captures_original_only_after_acquiring_lock(tmp_path,monkeypatch):
    work=workspace(tmp_path); target=work/'kg/entities/meeting/demo.md'; target.parent.mkdir(parents=True)
    target.write_text('Before lock')
    entered=threading.Event(); finished=threading.Event(); errors=[]
    def fake_turn(*args,**kwargs):
        entered.set()
        with pytest.raises(ReportEditError):
            with workspace_report_lock(work,blocking=False):pass
        target.write_text('Failed model output')
        yield {'type':'done','ok':False,'reply':'invalid request'}
    monkeypatch.setattr(worker,'run_turn_over_workspace',fake_turn)
    def run():
        try:list(meeting.meeting_doc_turn(work,[],native='demo',meeting_id='42',session_uid='run-42',platform='teams',date='2026-09-10',title='Title',workspace='seed'))
        except BaseException as error:errors.append(error)
        finally:finished.set()
    with workspace_report_lock(work):
        thread=threading.Thread(target=run);thread.start()
        assert not entered.wait(0.1)
        target.write_text('Updated while lock is held')
    thread.join(3)
    assert finished.is_set() and not errors and entered.is_set()
    assert target.read_text()=='Updated while lock is held'


def test_transcript_mirror_reads_and_writes_under_report_lock(tmp_path):
    work=workspace(tmp_path); target=work/'kg/entities/meeting/demo.md';target.parent.mkdir(parents=True)
    meta={'native':'demo','title':'Title'}
    target.write_text(meeting.render_meeting_transcript(meta,[{'id':'old','speaker':'A','text':'Old note'}]))
    finished=threading.Event();errors=[]
    def run():
        try:meeting.upsert_meeting_transcript_file(target,meta,{'id':'added','speaker':'B','text':'New note'})
        except BaseException as error:errors.append(error)
        finally:finished.set()
    with workspace_report_lock(work):
        thread=threading.Thread(target=run);thread.start()
        assert not finished.wait(0.1)
        target.write_text(meeting.render_meeting_transcript(meta,[{'id':'newer','speaker':'C','text':'Latest locked note'}]))
    thread.join(3)
    assert finished.is_set() and not errors
    text=target.read_text()
    assert 'Latest locked note' in text and 'New note' in text and 'Old note' not in text
