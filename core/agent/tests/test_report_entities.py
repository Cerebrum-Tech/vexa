from pathlib import Path
from types import SimpleNamespace
import pytest
import yaml
from worker.report_entities import entity_page_updates, extract_entity_mentions


def test_extraction_accepts_a_single_json_fence_and_still_rejects_unsubstantiated_names():
    import json
    from types import SimpleNamespace
    class Completion:
        def complete(self, prompt):
            return SimpleNamespace(text='```json\n' + json.dumps({'entity_mentions': [
                {'kind': 'person', 'name': 'Deniz', 'evidence': 'Deniz katıldı.'},
                {'kind': 'company', 'name': 'Invented', 'evidence': 'Invented katıldı.'},
            ]}) + '\n```')
    assert extract_entity_mentions(Completion(), '## Özet\nDeniz katıldı.') == [
        {'kind': 'person', 'name': 'Deniz', 'evidence': 'Deniz katıldı.'},
    ]

REPORT='kg/entities/meeting/demo.run-42.md'
BODY='## Özet\nAyşe Yılmaz, Innova ile görüştü.\n\n## Alınan Kararlar\nKarar yok.\n\n## Aksiyon Maddeleri\nEylem yok.\n'
MENTIONS=[{'kind':'person','name':'Ayşe Yılmaz','evidence':'Ayşe Yılmaz, Innova ile görüştü.'},
          {'kind':'company','name':'Innova','evidence':'Ayşe Yılmaz, Innova ile görüştü.'}]

def report(mentions=MENTIONS,body=BODY):
    return '---\n'+yaml.safe_dump({'type':'meeting','meeting_id':'42','entity_mentions':mentions},allow_unicode=True)+'---\n'+body

def test_creates_minimal_supported_entities_without_writes(tmp_path):
    updates=entity_page_updates(tmp_path,report(),REPORT,'42')
    assert len(updates)==2 and not list(tmp_path.iterdir())
    for path,text in updates.items():
        assert path.startswith(('kg/entities/person/','kg/entities/company/'))
        assert '../meeting/demo.run-42.md' in text and 'Toplantı 42' in text
        assert 'Ayşe Yılmaz, Innova ile görüştü.' in text
        assert 'description:' not in text and 'role:' not in text

@pytest.mark.parametrize('mention',[
    {'kind':'person','name':'Jane Liu','evidence':BODY},
    {'kind':'person','name':'Ayşe Yılmaz','evidence':'Invented biography'},
    {'kind':'company','name':'Innova','evidence':'Karar yok.'},
    {'kind':'product','name':'Innova','evidence':BODY},
    {'kind':'person','name':'Ayşe Yılmaz\nInjected','evidence':BODY},
])
def test_rejects_unproven_or_invalid_mentions(tmp_path,mention):
    assert entity_page_updates(tmp_path,report([mention]),REPORT,'42')=={}

def test_frontmatter_names_are_not_report_evidence(tmp_path):
    assert entity_page_updates(tmp_path,report(body='No names here.'),REPORT,'42')=={}

def test_typed_cards_only_fallback_when_exact_name_occurs_in_body(tmp_path):
    cards=[{'kind':'person','title':'Ayşe Yılmaz','body':'Invented executive biography'},
           {'kind':'company','title':'Missing Co'}, {'kind':'topic','title':'Innova'}]
    updates=entity_page_updates(tmp_path,report([]),REPORT,'42',cards)
    assert len(updates)==1
    assert 'Invented executive' not in next(iter(updates.values()))

def test_reuses_alias_and_preserves_user_content_and_is_idempotent(tmp_path):
    path=tmp_path/'kg/entities/person/real-id.md'; path.parent.mkdir(parents=True)
    original='---\ntype: person\nid: real-id\ntitle: AYŞE YILMAZ\naliases: [Ayşe Yılmaz]\n---\nUser biography must survive.\n'
    path.write_text(original)
    updates=entity_page_updates(tmp_path,report(MENTIONS[:1]),REPORT,'42')
    assert list(updates)==['kg/entities/person/real-id.md']
    assert updates['kg/entities/person/real-id.md'].startswith(original)
    path.write_text(updates['kg/entities/person/real-id.md'])
    assert entity_page_updates(tmp_path,report(MENTIONS[:1]),REPORT,'42')=={}
    next_run=entity_page_updates(tmp_path,report(MENTIONS[:1]),'kg/entities/meeting/demo.run-43.md','43')
    assert 'Toplantı 43' in next_run['kg/entities/person/real-id.md']

def test_different_workspace_is_not_read(tmp_path):
    other=tmp_path/'other/kg/entities/person/person.md'; other.parent.mkdir(parents=True)
    other.write_text('---\ntype: person\ntitle: Ayşe Yılmaz\n---\nPRIVATE DATA\n')
    work=tmp_path/'work'; work.mkdir()
    updates=entity_page_updates(work,report(MENTIONS[:1]),REPORT,'42')
    assert len(updates)==1 and 'PRIVATE DATA' not in next(iter(updates.values()))

def test_turkish_dotted_uppercase_name_reuses_existing_page(tmp_path):
    path = tmp_path / 'kg/entities/person/mediha.md'
    path.parent.mkdir(parents=True)
    path.write_text('---\ntype: person\ntitle: Mediha Nurdan ÇELİK\n---\nUser notes.\n')
    text = 'Mediha Nurdan Çelik katıldı.'
    mentions = [{'kind': 'person', 'name': 'Mediha Nurdan Çelik', 'evidence': text}]
    updates = entity_page_updates(tmp_path, report(mentions, text), REPORT, '42')
    assert list(updates) == ['kg/entities/person/mediha.md']
    assert 'User notes.' in updates['kg/entities/person/mediha.md']

def test_ambiguous_existing_names_do_not_pick_arbitrary_record(tmp_path):
    folder=tmp_path/'kg/entities/person'; folder.mkdir(parents=True)
    for name in ['first','second']:
        (folder/f'{name}.md').write_text('---\ntype: person\ntitle: Ayşe Yılmaz\n---\nUser notes\n')
    assert entity_page_updates(tmp_path,report(MENTIONS[:1]),REPORT,'42')=={}

@pytest.mark.parametrize('path',['../outside.md','/tmp/outside.md','kg/entities/person/other.md','kg/entities/meeting/../../outside.md'])
def test_unsafe_report_path_rejected(tmp_path,path):
    with pytest.raises(ValueError):entity_page_updates(tmp_path,report(),path,'42')

def test_symlink_entity_directory_rejected(tmp_path):
    outside=tmp_path/'outside'; outside.mkdir()
    work=tmp_path/'work'; (work/'kg/entities').mkdir(parents=True)
    (work/'kg/entities/person').symlink_to(outside,target_is_directory=True)
    with pytest.raises(ValueError):entity_page_updates(work,report(),REPORT,'42')
    assert not list(outside.iterdir())

def test_symlink_existing_page_rejected(tmp_path):
    work=tmp_path/'work'; folder=work/'kg/entities/person'; folder.mkdir(parents=True)
    outside=tmp_path/'private'; outside.write_text('secret')
    (folder/'person.md').symlink_to(outside)
    with pytest.raises(ValueError):entity_page_updates(work,report(),REPORT,'42')

def test_extraction_validates_model_response_and_ignores_instructions():
    class Completion:
        def complete(self,prompt,**kwargs):
            assert 'untrusted' in prompt.lower() and 'entity_mentions' in prompt
            return SimpleNamespace(text='{"entity_mentions":[{"kind":"person","name":"Ayşe Yılmaz","evidence":"Ayşe Yılmaz, Innova ile görüştü."},{"kind":"company","name":"Fake","evidence":"Fake"}]}')
    assert extract_entity_mentions(Completion(),report([]))==MENTIONS[:1]

def test_extraction_rejects_oversize_before_call():
    class Completion:
        def complete(self,*args,**kwargs):raise AssertionError('Must not invoke provider')
    with pytest.raises(ValueError):extract_entity_mentions(Completion(),'x'*200001)

def test_generated_path_collision_preserves_unrelated_file(tmp_path):
    updates=entity_page_updates(tmp_path,report(MENTIONS[:1]),REPORT,'42')
    path=tmp_path/next(iter(updates)); path.parent.mkdir(parents=True)
    path.write_text('Unrelated user-owned data without a matching title.')
    assert entity_page_updates(tmp_path,report(MENTIONS[:1]),REPORT,'42')=={}
    assert path.read_text()=='Unrelated user-owned data without a matching title.'

def test_substring_name_is_not_evidence(tmp_path):
    mention={'kind':'person','name':'Ann','evidence':'Annual meeting is over.'}
    assert entity_page_updates(tmp_path,report([mention],body=mention['evidence']),REPORT,'42')=={}

def test_extraction_invalid_json_is_empty():
    completion=SimpleNamespace(complete=lambda *_:SimpleNamespace(text='Do something else'))
    assert extract_entity_mentions(completion,report())==[]

def test_report_prompts_keep_identity_headings_and_request_verified_mentions():
    # Read constants without importing the runtime's unrelated infrastructure.
    import ast
    source=Path(__file__).resolve().parents[1]/'worker'/'meeting.py'
    constants={node.targets[0].id:ast.literal_eval(node.value) for node in ast.parse(source.read_text()).body
               if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name)
               and node.targets[0].id in {'MEETING_DOC_PROMPT','TURKISH_MEETING_DOC_PROMPT'}}
    for prompt in constants.values():
        text=prompt.format(native='call',title='Title',meeting_id='42',session_uid='session',platform='google_meet',date='2026-09-10',cards='[]',evidence='Evidence',participants='Participants')
        assert 'meeting_id: 42' in text and 'session_uid: session' in text
        assert 'entity_mentions:' in text and 'FINAL REPORT BODY' in text
        assert 'Do not invent' in text
    turkish=constants['TURKISH_MEETING_DOC_PROMPT']
    assert (turkish.index('## Özet') < turkish.index('## Alınan Kararlar')
            < turkish.index('## Aksiyon Maddeleri') < turkish.index('## Katılımcı Özetleri'))


def _produce_entities(tmp_path, monkeypatch, *, commit_mode='normal'):
    import json
    import subprocess
    from llm.claude_code import ClaudeCodeHarness
    from llm import ports
    from shared.gitenv import scrubbed_git_env
    from worker import meeting, worker
    target=tmp_path/'kg/entities/meeting/demo.md'
    person=tmp_path/'kg/entities/person/known-person.md'
    person.parent.mkdir(parents=True,exist_ok=True)
    original='---\ntype: person\nid: known-person\ntitle: Ayşe Yılmaz\n---\nExisting user biography.\n'
    person.write_text(original)
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text('Original transcript')
    def execute(argv,cwd):
        mentions = [{**m, 'evidence': 'A transcript quote outside the summary.'} for m in MENTIONS] if commit_mode == 'transcript_quotes' else MENTIONS
        target.write_text(report(mentions))
        yield json.dumps({'type':'result','subtype':'success','result':'wrote','session_id':'s'})
    monkeypatch.setattr(worker,'harness_factory',lambda:ClaudeCodeHarness(exec_fn=execute))
    monkeypatch.setattr(meeting,'_DOC_TURN_BACKOFF_S',0)
    staged=[]
    real_commit=ports._commit_mount
    def commit(work,**kwargs):
        pages=[p for kind in ['person','company'] for p in (work/'kg/entities'/kind).glob('*.md')]
        staged.append({p.relative_to(work).as_posix():p.read_text() for p in pages})
        if commit_mode=='fail':
            return None
        if commit_mode=='report_only':
            env=scrubbed_git_env()
            for args in [['add','kg/entities/meeting'],['-c','user.name=test','-c','user.email=test@vexa.local','commit','--allow-empty','-m','partial report']]:
                subprocess.run(['git','-C',str(work),*args],check=True,capture_output=True,env=env)
            return 'partial'
        if commit_mode=='entity_changed':
            person.write_text('Changed after planning.\n')
        return real_commit(work,**kwargs)
    monkeypatch.setattr(ports,'_commit_mount',commit)
    events=list(meeting.meeting_doc_turn(tmp_path,[],native='demo',meeting_id='42',session_uid='run-42',platform='teams',date='2026-09-10',title='Toplantı',report_language='tr',workspace='seed'))
    return events,person,original,target,staged


def test_producer_extracts_from_finished_summary_when_model_quotes_transcript(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    from worker import meeting
    calls = []
    class Completion:
        def complete(self, prompt, **kwargs):
            calls.append(prompt)
            return SimpleNamespace(text=json.dumps({'entity_mentions': MENTIONS}))
    monkeypatch.setattr(meeting, 'completion_from_env', lambda: Completion())
    events, person, original, target, staged = _produce_entities(tmp_path, monkeypatch, commit_mode='transcript_quotes')
    assert len(calls) == 1
    assert events[-1]['ok'] is True and person.read_text().startswith(original)
    assert 'Toplantı 42' in person.read_text()
    assert any('kg/entities/company/' in path for path in staged[-1])


def test_producer_commits_entities_with_report_and_preserves_existing_notes(tmp_path,monkeypatch):
    import subprocess
    from shared.gitenv import scrubbed_git_env
    events,person,original,target,staged=_produce_entities(tmp_path,monkeypatch)
    assert events[-1]['ok'] is True
    assert person.read_text().startswith(original)
    assert 'demo.run-42.md' in person.read_text()
    companies=list((tmp_path/'kg/entities/company').glob('*.md'))
    assert len(companies)==1
    assert len(staged[-1])==2
    for artifact in [person,*companies,target,target.with_name('demo.run-42.md')]:
        result=subprocess.run(['git','-C',str(tmp_path),'show',f'HEAD:{artifact.relative_to(tmp_path)}'],capture_output=True,env=scrubbed_git_env())
        assert result.returncode==0 and result.stdout==artifact.read_bytes()


@pytest.mark.parametrize('commit_mode',['fail','report_only','entity_changed'])
def test_producer_rolls_back_all_entities_unless_every_page_reaches_head(tmp_path,monkeypatch,commit_mode):
    events,person,original,target,staged=_produce_entities(tmp_path,monkeypatch,commit_mode=commit_mode)
    assert events[-1]['ok'] is False
    assert any(len(pages)==2 for pages in staged), 'The failure must happen after entity writes were staged'
    assert person.read_text()==original
    assert not list((tmp_path/'kg/entities/company').glob('*.md'))
    assert target.read_text()=='Original transcript'
    assert not target.with_name('demo.run-42.md').exists()


@pytest.mark.parametrize('failure',['publication','entity_write'])
def test_producer_preparation_failure_restores_partially_written_entities(tmp_path,monkeypatch,failure):
    from worker import meeting
    person=tmp_path/'kg/entities/person/known-person.md'
    observed=[]
    if failure=='publication':
        def fail_publication(*args,**kwargs):
            assert 'demo.run-42.md' in person.read_text()
            assert len(list((tmp_path/'kg/entities/company').glob('*.md')))==1
            observed.append(True)
            raise OSError('disk failure')
        monkeypatch.setattr(meeting,'_publish_report_readiness',fail_publication)
    else:
        write_bytes=Path.write_bytes
        def partial_write(self,data):
            result=write_bytes(self,data)
            if self.parent==tmp_path/'kg/entities/company':
                observed.append(True)
                raise OSError('disk failure')
            return result
        monkeypatch.setattr(Path,'write_bytes',partial_write)
    with pytest.raises(OSError,match='disk failure'):
        _produce_entities(tmp_path,monkeypatch)
    assert observed
    assert person.read_text().endswith('Existing user biography.\n')
    assert 'demo.run-42.md' not in person.read_text()
    assert not list((tmp_path/'kg/entities/company').glob('*.md'))
    assert (tmp_path/'kg/entities/meeting/demo.md').read_text()=='Original transcript'
    assert not (tmp_path/'kg/entities/meeting/demo.run-42.md').exists()
