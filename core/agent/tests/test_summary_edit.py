"""Explicit owner edits use the worker, preserve report sections and compare revisions."""
import hashlib,json,subprocess
import pytest
from fastapi.testclient import TestClient
from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from control_plane.workspace_reader import WorkspaceReader
from shared.config import load_settings
from shared.gitenv import scrubbed_git_env

BODY='## Özet\nİlk özet.\n\n## Alınan Kararlar\nKarar metni.\n\n## Aksiyon Maddeleri\n- Aksiyon metni.'
PATH='kg/entities/meeting/recurring.run-42.md'
def git(work,*args):
    return subprocess.run(['git','-C',str(work),*args],env=scrubbed_git_env(),capture_output=True,check=True).stdout
def report(row='42'):
    return f'---\ntype: meeting\nid: recurring\ntitle: Görüşme\nmeeting_row_id: "{row}"\nsession_uid: session-{row}\nreport_workspace: seed\nreport_status: completed\nreport_language: tr\nreport_revision: {hashlib.sha256(BODY.encode()).hexdigest()}\n---\n\n{BODY}\n'
@pytest.fixture
def setup(tmp_path):
    work=tmp_path/'alice';target=work/PATH;target.parent.mkdir(parents=True);target.write_text(report());target.with_name('recurring.md').write_text(report())
    git(work,'init');git(work,'add','.');git(work,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','report')
    calls,events=[],[]
    class Runtime:
        def spawn(self,uid,profile,env):
            from worker.report_edit import edit_report_summary
            calls.append(env)
            job=json.loads(json.loads(env['VEXA_START'])['entrypoint']['inline'])
            try:
                result=edit_report_summary(job,mounts=json.loads(env['VEXA_MOUNTS']),grants=json.loads(env['VEXA_WORKSPACES']),author=('alice','alice@example.test'))
                events.append({'type':'done','ok':True,'report':result})
            except Exception as e: events.append({'type':'done','ok':False,'status':getattr(e,'status',500),'error':str(e)})
            return uid
    class Identity:
        def mint(self,*args):return 'test-token'
    class Reader:
        def read(self,*args,**kwargs):yield from events
    settings=load_settings().model_copy(update={'workspaces_dir':str(tmp_path)})
    app=create_app(Dispatcher(settings,Runtime(),Identity()),reader=WorkspaceReader(str(tmp_path)),stream_reader=Reader(),meeting_owner_lookup=lambda user,mid:{'id':42,'user_id':'alice','shared':False,'status':'completed'} if user=='alice' and mid=='42' else None)
    payload={'workspace':'seed','path':PATH,'expected_revision':hashlib.sha256(BODY.encode()).hexdigest(),'summary':'Düzenlenmiş özet.\n\n- Açık bilgi.'}
    return TestClient(app),work,calls,payload

def test_save_commits_exact_summary_preserving_sections_and_unrelated_draft(setup):
    c,work,calls,payload=setup;(work/'personal-draft.md').write_text('private draft')
    r=c.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert r.status_code==200,r.text
    content=(work/PATH).read_text()
    assert len(calls)==1 and calls[0]['VEXA_RUNNER']=='report-edit'
    assert payload['summary'] in content and 'Karar metni.' in content and '- Aksiyon metni.' in content
    assert (work/'kg/entities/meeting/recurring.md').read_text()==content
    assert git(work,'show',f'HEAD:{PATH}').decode()==content
    assert git(work,'status','--porcelain').decode().strip()=='?? personal-draft.md'
    assert r.json()['content']==content

def test_stale_revision_refuses_before_dispatch(setup):
    c,work,calls,payload=setup;payload['expected_revision']='0'*64
    r=c.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert r.status_code==409 and not calls and (work/PATH).read_text()==report()

@pytest.mark.parametrize('user',[None,'bob'])
def test_actual_owner_required(setup,user):
    c,work,calls,payload=setup
    r=c.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':user} if user else {})
    assert r.status_code in (401,403) and not calls and (work/PATH).read_text()==report()

@pytest.mark.parametrize('change',[{'workspace':'foreign'},{'path':'../../private.md'},{'path':'kg/entities/meeting/recurring.run-99.md'},{'summary':'## Alınan Kararlar\nInjected'},{'summary':''}])
def test_invalid_target_or_summary_has_no_effect(setup,change):
    c,work,calls,payload=setup;payload.update(change)
    r=c.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert r.status_code in (403,404,422) and not calls and (work/PATH).read_text()==report()

def test_old_run_edit_preserves_newer_native_alias(setup):
    c,work,calls,payload=setup;alias=work/'kg/entities/meeting/recurring.md';alias.write_text(report('43'))
    git(work,'add',str(alias.relative_to(work)));git(work,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','newer')
    r=c.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert r.status_code==200,r.text
    assert alias.read_text()==report('43')

def test_worker_checks_grant_and_restores_after_commit_failure(setup,monkeypatch):
    from worker import report_edit
    from shared.reports import ReportEditError
    _,work,_,payload=setup;job={**payload,'meeting_id':'42'};mounts=[{'slug':'seed','path':str(work),'write':True,'role':'private'}]
    with pytest.raises(ReportEditError):report_edit.edit_report_summary(job,mounts=mounts,grants=[])
    head=git(work,'rev-parse','HEAD');original=(work/PATH).read_bytes()
    def fail(*a,**k):raise OSError('commit unavailable')
    monkeypatch.setattr(report_edit,'commit_report_paths',fail)
    with pytest.raises(OSError):report_edit.edit_report_summary(job,mounts=mounts,grants=[{'id':'seed','mode':'rw'}])
    assert (work/PATH).read_bytes()==original and git(work,'rev-parse','HEAD')==head


def _client_with_owner(setup, owner_lookup, *, completion=True):
    client,work,_,_=setup
    class Reader:
        def read(self,*args,**kwargs):
            if completion:
                yield {'type':'done','ok':True}
    app=create_app(client.app.state.dispatcher,reader=WorkspaceReader(str(work.parent)),
                   stream_reader=Reader(),meeting_owner_lookup=owner_lookup)
    return TestClient(app,raise_server_exceptions=False)


def test_busy_report_generation_refuses_edit_without_wait_or_file_changes(setup):
    from worker.report_lock import workspace_report_lock
    client,work,calls,payload=setup
    before=(work/PATH).read_bytes(); head=git(work,'rev-parse','HEAD')
    with workspace_report_lock(work):
        response=client.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert response.status_code==409,response.text
    assert len(calls)==1 and (work/PATH).read_bytes()==before
    assert git(work,'rev-parse','HEAD')==head


def test_shared_viewer_flag_denied_even_with_matching_owner_fields(setup):
    _,work,calls,payload=setup
    client=_client_with_owner(setup,lambda *_:{'id':42,'user_id':'alice','shared':True})
    response=client.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert response.status_code==403 and not calls
    assert (work/PATH).read_text()==report()


def test_owner_revoked_before_response_never_returns_private_report(setup):
    _,work,calls,payload=setup
    lookups=[]
    def owner(*args):
        lookups.append(args)
        return {'id':42,'user_id':'alice','shared':False} if len(lookups)==1 else None
    client=_client_with_owner(setup,owner)
    response=client.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert response.status_code==403 and len(calls)==1 and len(lookups)==2
    assert payload['summary'] not in response.text and 'content' not in response.json()


def test_symlink_outside_workspace_denied_before_dispatch(setup,tmp_path):
    original_client,work,calls,payload=setup
    outside=tmp_path/'private-report.md'; outside.write_text(report())
    target=work/PATH;target.unlink();target.symlink_to(outside)
    client=TestClient(original_client.app,raise_server_exceptions=False)
    response=client.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert response.status_code==403,response.text
    assert not calls and outside.read_text()==report()


def test_missing_worker_completion_does_not_claim_a_confirmed_save(setup):
    _,_,calls,payload=setup
    client=_client_with_owner(setup,lambda *_:{'id':42,'user_id':'alice','shared':False},completion=False)
    response=client.patch('/api/meeting/42/summary',json=payload,headers={'X-User-Id':'alice'})
    assert response.status_code==503 and len(calls)==1
    assert 'content' not in response.json()
