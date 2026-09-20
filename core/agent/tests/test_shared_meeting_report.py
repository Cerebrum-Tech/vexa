"""A meeting shared with you serves ITS report — the one in its owner's workspace, not yours."""
import hashlib
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


def commit(work):
    """A report is only served once it is in HISTORY — the reader refuses a working-tree file that
    does not match HEAD, so a half-written report can never be handed to a share recipient."""
    git(work, 'init')
    git(work, 'add', '.')
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'report')

BODY = '## Özet\nBir özet.\n\n## Alınan Kararlar\nKarar.\n\n## Aksiyon Maddeleri\n- Aksiyon.'
NATIVE = '268388393189834'
PATH = f'kg/entities/meeting/{NATIVE}.run-149.md'


def report(row='149', workspace='seed'):
    return (f'---\ntype: meeting\nid: {NATIVE}\nmeeting_row_id: "{row}"\nreport_workspace: {workspace}\n'
            f'report_status: completed\nreport_language: tr\n'
            f'report_revision: {hashlib.sha256(BODY.encode()).hexdigest()}\n---\n\n{BODY}\n')


ROW = {'id': 149, 'user_id': 'busra', 'native_meeting_id': NATIVE, 'status': 'completed'}


@pytest.fixture
def setup(tmp_path):
    """Büşra owns 149 and its report; Alp Eren redeemed her share link. meeting-api answers BOTH of
    them (owner → shared False, viewer → shared True) and nobody else — exactly as it does live."""
    owner = tmp_path / 'busra'
    target = owner / PATH
    target.parent.mkdir(parents=True)
    target.write_text(report())
    commit(owner)
    (tmp_path / 'alperen' / 'kg' / 'entities' / 'meeting').mkdir(parents=True)

    def lookup(user, meeting_id):
        if meeting_id != '149':
            return None
        if user == 'busra':
            return {**ROW, 'shared': False}
        if user == 'alperen':
            return {**ROW, 'shared': True}
        return None  # meeting-api 404s a stranger, so agent-api never even looks at the disk

    settings = load_settings().model_copy(update={'workspaces_dir': str(tmp_path)})
    app = create_app(Dispatcher(settings, object(), object()),
                     reader=WorkspaceReader(str(tmp_path)), meeting_owner_lookup=lookup)
    return TestClient(app), owner


def get(client, user, meeting_id='149'):
    return client.get(f'/api/meeting/{meeting_id}/report', headers={'X-User-Id': user})


def test_the_share_recipient_reads_the_owners_report(setup):
    client, _ = setup
    response = get(client, 'alperen')
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['meeting_id'] == '149' and body['workspace'] == 'seed' and body['path'] == PATH
    assert 'Aksiyon Maddeleri' in body['content']
    assert body['revision'] == hashlib.sha256(BODY.encode()).hexdigest()


def test_the_owner_reads_it_too(setup):
    client, _ = setup
    assert get(client, 'busra').status_code == 200


def test_a_stranger_reads_nothing(setup):
    client, _ = setup
    response = get(client, 'ayse')
    assert response.status_code == 404
    assert 'Aksiyon' not in response.text


def test_an_unshared_meeting_is_not_reachable(setup):
    client, _ = setup
    assert get(client, 'alperen', '150').status_code == 404


def test_a_report_bound_to_another_row_is_refused(setup):
    """The path is derived from the row, but the file could still carry another meeting's frontmatter —
    a recurring link reuses the same native id. The binding is checked before any byte is returned."""
    client, owner = setup
    (owner / PATH).write_text(report(row='999'))
    git(owner, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-am', 'rebind')
    response = get(client, 'alperen')
    assert response.status_code == 404
    assert 'Aksiyon' not in response.text


def test_nothing_but_this_meetings_report_is_reachable(setup):
    """The caller supplies only a meeting id, so no private file of the owner's can be addressed."""
    client, owner = setup
    secret = owner / 'kg' / 'entities' / 'meeting' / 'private.md'
    secret.write_text('gizli')
    for attempt in ('149/../../workspace/file', '..%2F..%2Fprivate'):
        assert get(client, 'alperen', attempt).status_code in (404, 422)
