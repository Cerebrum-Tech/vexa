"""A directory card the owner writes by hand: committed exactly, with no model call anywhere."""
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from control_plane.workspace_reader import WorkspaceReader
from shared.config import load_settings
from shared.gitenv import scrubbed_git_env


def git(work, *args):
    return subprocess.run(['git', '-C', str(work), *args], env=scrubbed_git_env(),
                          capture_output=True, check=True).stdout


@pytest.fixture
def setup(tmp_path):
    work = tmp_path / 'alice'
    (work / 'kg' / 'entities').mkdir(parents=True)
    (work / 'kg' / 'index.md').write_text('# Bilgi grafiği\n')
    git(work, 'init')
    git(work, 'add', '.')
    git(work, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-m', 'seed')
    calls, events = [], []

    class Runtime:
        def spawn(self, uid, profile, env):
            from worker.entity_edit import write_entity
            calls.append(env)
            job = json.loads(json.loads(env['VEXA_START'])['entrypoint']['inline'])
            try:
                events.append({'type': 'done', 'ok': True,
                               'entity': write_entity(job, mounts=json.loads(env['VEXA_MOUNTS']),
                                                      grants=json.loads(env['VEXA_WORKSPACES']),
                                                      author=('alice', 'alice@example.test'))})
            except Exception as e:
                events.append({'type': 'done', 'ok': False, 'status': getattr(e, 'status', 500), 'error': str(e)})
            return uid

    class Identity:
        def mint(self, *args):
            return 'test-token'

    class Reader:
        def read(self, *args, **kwargs):
            yield from events

    settings = load_settings().model_copy(update={'workspaces_dir': str(tmp_path)})
    app = create_app(Dispatcher(settings, Runtime(), Identity()),
                     reader=WorkspaceReader(str(tmp_path)), stream_reader=Reader())
    return TestClient(app), work, calls


BODY = {'workspace': 'seed', 'kind': 'person', 'title': 'Ayşe Yılmaz',
        'body': 'Satış ekibinde çalışıyor.\nAnkara ofisinde.'}


def test_the_card_is_written_and_committed_exactly_as_typed(setup):
    client, work, calls = setup
    response = client.post('/api/workspace/entity', json=BODY, headers={'X-User-Id': 'alice'})
    assert response.status_code == 201, response.text
    path = response.json()['path']
    assert path.startswith('kg/entities/person/ayse-yilmaz-')
    content = (work / path).read_text()
    # The person's own words, not a model's rendering of them.
    assert 'Satış ekibinde çalışıyor.\nAnkara ofisinde.' in content
    assert content.startswith('---\ntype: person\n')
    assert 'title: "Ayşe Yılmaz"' in content
    assert git(work, 'show', f'HEAD:{path}').decode() == content
    assert git(work, 'status', '--porcelain').decode().strip() == ''
    # ONE deterministic worker ran, and it was not a language turn.
    assert len(calls) == 1 and calls[0]['VEXA_RUNNER'] == 'entity-edit'


def test_the_whole_directory_comes_back_in_one_request(setup):
    """The directory is read in ONE call. Built from a tree listing plus a read per document, a refresh
    was hundreds of requests — which the gateway's per-user guard answered with 429."""
    client, work, _ = setup
    for kind, title in (('person', 'Ayşe Yılmaz'), ('company', 'Innova'), ('note', 'İş birliği')):
        client.post('/api/workspace/entity', json={**BODY, 'kind': kind, 'title': title},
                    headers={'X-User-Id': 'alice'})
    # A meeting document, which is never a directory card and must not be shipped with them.
    meeting = work / 'kg' / 'entities' / 'meeting' / '42.md'
    meeting.parent.mkdir(parents=True, exist_ok=True)
    meeting.write_text('---\ntype: meeting\nid: 42\n---\n\nToplantı.\n')
    (work / 'kg' / 'entities' / 'person' / 'index.md').write_text('# Kişiler\n')

    response = client.get('/api/workspace/entities', headers={'X-User-Id': 'alice'})
    assert response.status_code == 200, response.text
    payload = response.json()
    paths = sorted(f['path'].rsplit('/', 1)[0] for f in payload['files'])
    assert paths == ['kg/entities/company', 'kg/entities/note', 'kg/entities/person']
    assert all(f['content'].startswith('---\ntype:') for f in payload['files'])
    assert [m['slug'] for m in payload['mounts']] == ['seed']
    assert payload['unreadable'] == [] and payload['truncated'] is False


def test_the_directory_read_never_leaves_this_subject(setup):
    client, _, _ = setup
    mine = client.get('/api/workspace/entities', headers={'X-User-Id': 'alice'}).json()
    client.post('/api/workspace/entity', json=BODY, headers={'X-User-Id': 'alice'})
    theirs = client.get('/api/workspace/entities', headers={'X-User-Id': 'bob'}).json()
    assert mine['files'] == [] and theirs['files'] == []


def test_a_second_save_updates_the_same_card(setup):
    client, work, _ = setup
    created = client.post('/api/workspace/entity', json=BODY, headers={'X-User-Id': 'alice'}).json()['path']
    response = client.post('/api/workspace/entity', headers={'X-User-Id': 'alice'},
                           json={**BODY, 'path': created, 'body': 'Artık pazarlamada.'})
    assert response.status_code == 201, response.text
    assert response.json()['path'] == created
    assert 'Artık pazarlamada.' in (work / created).read_text()
    assert len(list((work / 'kg' / 'entities' / 'person').glob('*.md'))) == 1


def test_a_note_and_a_company_land_in_their_own_folders(setup):
    client, work, _ = setup
    for kind, folder in (('company', 'company'), ('note', 'note')):
        response = client.post('/api/workspace/entity', headers={'X-User-Id': 'alice'},
                               json={**BODY, 'kind': kind, 'title': 'Innova', 'body': 'Kayıt.'})
        assert response.status_code == 201, response.text
        assert response.json()['path'].startswith(f'kg/entities/{folder}/innova-')


@pytest.mark.parametrize('change', [
    {'workspace': 'foreign'},                                   # not a workspace the caller can write
    {'kind': 'meeting'},                                        # meetings are authored from a meeting
    {'kind': 'secret'},                                         # not a kind at all
    {'title': '   '},                                           # a card with no name
    {'path': '../../private.md'},                               # traversal
    {'path': 'kg/entities/meeting/42.md'},                      # another kind's folder
    {'path': 'kg/entities/person/index.md'},                    # the folder's own index
])
def test_an_invalid_target_writes_nothing(setup, change):
    client, work, calls = setup
    response = client.post('/api/workspace/entity', json={**BODY, **change}, headers={'X-User-Id': 'alice'})
    assert response.status_code in (403, 404, 422), response.text
    assert list((work / 'kg' / 'entities').rglob('*.md')) == []
    assert not calls


def test_another_subject_never_writes_into_this_workspace(setup):
    """Each subject writes into their OWN workspace. Bob asking for the `seed` slug gets bob's seed —
    never alice's — so the card cannot land in a workspace its author cannot see."""
    client, work, _ = setup
    response = client.post('/api/workspace/entity', json=BODY, headers={'X-User-Id': 'bob'})
    assert response.status_code == 201, response.text
    assert list((work / 'kg' / 'entities').rglob('*.md')) == []
