"""GET /api/integrations/summaries — one account's meeting summaries for an integrating system.

The caller is a service holding the deployment's fixed key, naming the account by email. The two
upstreams (admin-api account lookup, meeting-api meeting list) are faked at their seams; reports are
real committed files in the owner's workspace, read through the same path as the per-meeting reader.
"""
import hashlib
import subprocess

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from control_plane.summaries_integration import UpstreamError, summary_text
from control_plane.workspace_reader import WorkspaceReader
from shared.config import load_settings
from shared.gitenv import scrubbed_git_env

KEY = 'summary-key-for-tests'
BODY = '## Özet\nBütçe onaylandı.\n\n## Alınan Kararlar\nKarar.\n\n## Aksiyon Maddeleri\n- Aksiyon.'


def git(work, *args):
    return subprocess.run(['git', '-C', str(work), *args], env=scrubbed_git_env(),
                          capture_output=True, check=True).stdout


def report(native, row, title):
    return (f'---\ntype: meeting\nid: {native}\ntitle: {title}\nmeeting_row_id: "{row}"\n'
            f'report_workspace: seed\nreport_status: completed\nreport_language: tr\n'
            f'report_revision: {hashlib.sha256(BODY.encode()).hexdigest()}\n---\n\n{BODY}\n')


def meeting(row, native, owner, start):
    return {'id': row, 'user_id': owner, 'platform': 'teams', 'native_meeting_id': native,
            'status': 'completed', 'start_time': start, 'end_time': None,
            'created_at': start, 'data': {}}


# Ayşe (user 7) owns 101 (Oct 2) and 102 (Sep 20); 103 (Oct 3) has no report yet; 104 (Oct 1) is
# Büşra's (user 9), shared with Ayşe, and its report lives in Büşra's workspace.
MEETINGS = {
    '7': [meeting(103, 'n103', 7, '2026-10-03T09:00:00'),
          meeting(101, 'n101', 7, '2026-10-02T09:00:00'),
          meeting(104, 'n104', 9, '2026-10-01T09:00:00'),
          meeting(102, 'n102', 7, '2026-09-20T09:00:00')],
}
USERS = {'ayse@innova.com.tr': {'user_id': 7, 'email': 'ayse@innova.com.tr', 'name': 'Ayşe'}}


@pytest.fixture
def make_client(tmp_path):
    for owner, rows in (('7', ((101, 'Bütçe'), (102, 'Planlama'))), ('9', ((104, 'Ortak'),))):
        work = tmp_path / owner
        for row, title in rows:
            target = work / f'kg/entities/meeting/n{row}.run-{row}.md'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(report(f'n{row}', row, title))
        git(work, 'init')
        git(work, 'add', '.')
        git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'reports')

    def build(key=KEY, user_by_email=None, meeting_page=None):
        settings = load_settings().model_copy(update={
            'workspaces_dir': str(tmp_path), 'summary_api_key': SecretStr(key)})

        def pages(user_id, limit, offset):
            return MEETINGS.get(str(user_id), [])[offset:offset + limit]

        app = create_app(Dispatcher(settings, object(), object()),
                         reader=WorkspaceReader(str(tmp_path)),
                         user_by_email=user_by_email or (lambda email: USERS.get(email.lower())),
                         meeting_page=meeting_page or pages)
        return TestClient(app)

    return build


def get(client, key=KEY, **params):
    headers = {'X-Summary-Api-Key': key} if key is not None else {}
    return client.get('/api/integrations/summaries', params=params, headers=headers)


def test_returns_the_accounts_reports_newest_first(make_client):
    r = get(make_client(), email='ayse@innova.com.tr')
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['user'] == {'user_id': 7, 'email': 'ayse@innova.com.tr', 'name': 'Ayşe'}
    assert [s['meeting_id'] for s in body['summaries']] == ['101', '104', '102']
    assert body['count'] == 3
    first = body['summaries'][0]
    assert first['title'] == 'Bütçe' and first['summary'] == 'Bütçe onaylandı.'
    assert first['shared'] is False and first['language'] == 'tr'
    assert 'Aksiyon Maddeleri' in first['content'] and not first['content'].startswith('---')
    assert body['summaries'][1]['shared'] is True  # Büşra's meeting, read from HER workspace


def test_since_until_and_limit_bound_the_rows(make_client):
    client = make_client()
    r = get(client, email='ayse@innova.com.tr', since='2026-10-01', until='2026-10-02T12:00:00Z')
    assert [s['meeting_id'] for s in r.json()['summaries']] == ['101', '104']
    r = get(client, email='ayse@innova.com.tr', limit=1)
    assert [s['meeting_id'] for s in r.json()['summaries']] == ['101']


def test_the_key_is_required_and_checked(make_client):
    client = make_client()
    assert get(client, key=None, email='ayse@innova.com.tr').status_code == 401
    r = get(client, key='wrong', email='ayse@innova.com.tr')
    assert r.status_code == 401 and 'Bütçe' not in r.text


def test_an_unset_key_disables_the_route(make_client):
    """Fail closed: no configured key never means 'any key' — not even an empty one."""
    client = make_client(key='')
    assert get(client, key='', email='ayse@innova.com.tr').status_code == 503
    assert get(client, key='anything', email='ayse@innova.com.tr').status_code == 503


def test_unknown_account_is_404(make_client):
    assert get(make_client(), email='nobody@innova.com.tr').status_code == 404


def test_bad_parameters_are_422(make_client):
    client = make_client()
    assert get(client).status_code == 422
    assert get(client, email='not-an-email').status_code == 422
    assert get(client, email='ayse@innova.com.tr', since='yesterday').status_code == 422
    assert get(client, email='ayse@innova.com.tr', limit=0).status_code == 422


def test_an_unreachable_upstream_is_503_not_empty(make_client):
    def down(*_args):
        raise UpstreamError('admin-api unreachable: URLError')

    assert get(make_client(user_by_email=down), email='ayse@innova.com.tr').status_code == 503
    assert get(make_client(meeting_page=down), email='ayse@innova.com.tr').status_code == 503


def test_summary_text_reads_both_report_shapes():
    assert summary_text(BODY) == 'Bütçe onaylandı.'
    assert summary_text('The team agreed the plan.\n\n## Decisions\n- [[x]]') == 'The team agreed the plan.'
