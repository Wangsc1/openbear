"""Local release adapter tests; no GitHub, Docker, build or service effects."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from scripts import release_local as release

RUN = "0.11.1-abcdef123456"
TOKEN = "fixture-github-token-never-persist"

# A real foreground subprocess implements the CLI transport contract. The
# synthetic credential is deliberately printed to verify output redaction.
SCRIPT = r'''
import json, os, sys, time
from pathlib import Path
root = Path.cwd() / '.release-runs'
action = sys.argv[1]
run = '0.11.1-abcdef123456'
directory = root / run
state_path = directory / 'state.json'
if action == 'start':
    assert os.environ.get('GH_TOKEN') == 'fixture-github-token-never-persist'
    assert 'GITHUB_TOKEN' not in os.environ
    assert 'fixture-github-token-never-persist' not in ' '.join(sys.argv)
    directory.mkdir(parents=True)
    notes = Path(sys.argv[sys.argv.index('--notes') + 1]).read_text()
    state = {'schema': 1, 'runId': run, 'version': '0.11.1', 'repo': str(Path.cwd()),
             'repository': 'fixture/project', 'completed': False, 'notes': notes}
    state_path.write_text(json.dumps(state))
    print('Release run: ' + run, flush=True)
    print('[py311] running ' + os.environ['GH_TOKEN'], flush=True)
    if notes == 'slow':
        (directory / 'pid').write_text(str(os.getpid()))
        print('[waiting] ready', flush=True)
        time.sleep(300)
    print('simulated failure ' + os.environ['GH_TOKEN'], flush=True)
    raise SystemExit(1)
elif action == 'resume':
    assert os.environ.get('GH_TOKEN') == 'fixture-github-token-never-persist'
    state = json.loads(state_path.read_text())
    state['completed'] = True
    if '--files' in sys.argv:
        state['resumeFiles'] = sys.argv[sys.argv.index('--files')+1:sys.argv.index('--approve-container-cgroup')]
    state_path.write_text(json.dumps(state))
    print('[publication] passed', flush=True)
elif action == 'cleanup':
    assert 'GH_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ
    (directory / 'cleaned').touch()
elif action == 'status':
    assert '--summary' in sys.argv
    assert 'GH_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ
    state = json.loads(state_path.read_text())
    print(json.dumps({'runId': run, 'completed': state['completed'],
        'status': 'completed' if state['completed'] else 'failed',
        'failedStages': [] if state['completed'] else [{'stage': 'py311',
        'failures': [{'id': 'tests.test_fixture::test_result', 'message': 'assert 500 == 200'}]}],
        'reusableStages': ['frontend', 'build'], 'resume': {'action': 'resume', 'runId': run}}))
'''


@pytest.fixture
def harness(tmp_path, monkeypatch):
    (tmp_path / '.git').mkdir()
    (tmp_path / 'scripts').mkdir()
    (tmp_path / 'scripts/release.py').write_text(SCRIPT)
    (tmp_path / '.venv/bin').mkdir(parents=True)
    (tmp_path / '.venv/bin/python').symlink_to(sys.executable)
    monkeypatch.setenv('GH_TOKEN', TOKEN)
    progress = []
    client = release.LocalRelease(tmp_path, progress=progress.append)
    return SimpleNamespace(repo=tmp_path, client=client, call=client.run, progress=progress)


def start(notes='fixture notes'):
    return {'action': 'start', 'version': '0.11.1', 'notes': notes, 'files': [],
            'approveContainerCgroup': True}


async def test_start_uses_environment_and_returns_redacted_failure(harness, monkeypatch):
    h = harness
    monkeypatch.setenv('GITHUB_TOKEN', 'unrelated-inherited-secret')
    result = await h.call(start())
    assert result['status'] == 'failed' and result['exitCode'] == 1
    assert result['runId'] == RUN
    assert result['failedStages'][0]['failures'][0]['message'] == 'assert 500 == 200'
    assert result['reusableStages'] == ['frontend', 'build']
    assert h.progress and TOKEN not in str(h.progress)
    assert '<redacted>' in h.progress[-1]
    assert TOKEN not in json.dumps(result)
    assert not list((h.repo / '.release-runs').glob('.local-notes-*'))
    for file in (h.repo / '.release-runs').rglob('*'):
        if file.is_file():
            assert TOKEN not in file.read_text()


async def test_resume_requires_explicit_authorization_and_completed_is_noop(harness, monkeypatch):
    h = harness
    await h.call(start())
    denied = await h.call({'action': 'resume', 'runId': RUN, 'files': ['tests/fix.py']})
    assert denied['status'] == 'not_started'
    result = await h.call({'action': 'resume', 'runId': RUN, 'files': ['tests/fix.py'],
                           'approveContainerCgroup': True})
    assert result['completed'] is True and result['exitCode'] == 0
    state_path = h.repo / '.release-runs' / RUN / 'state.json'
    before = state_path.read_bytes()
    assert json.loads(before)['resumeFiles'] == ['tests/fix.py']
    monkeypatch.delenv('GH_TOKEN')
    again = await h.call({'action': 'resume', 'runId': RUN})
    assert again['completed'] is True
    assert state_path.read_bytes() == before


async def test_status_and_duplicate_start_do_not_need_credentials_or_restart(harness, monkeypatch):
    h = harness
    await h.call(start())
    state_path = h.repo / '.release-runs' / RUN / 'state.json'
    before = state_path.read_bytes()
    monkeypatch.delenv('GH_TOKEN')
    assert (await h.call({'action': 'status', 'runId': RUN}))['status'] == 'failed'
    duplicate = await h.call({**start(), 'approveContainerCgroup': False})
    assert duplicate['startNotRepeated'] is True
    assert state_path.read_bytes() == before


@pytest.mark.parametrize('approval', [None, False, 'true'])
async def test_missing_authorization_never_starts(harness, approval):
    result = await harness.call({**start(), 'approveContainerCgroup': approval})
    assert result['status'] == 'not_started' and result['exitCode'] == 2
    assert not (harness.repo / '.release-runs').exists()


async def test_state_cannot_cross_repository(harness):
    await harness.call(start())
    path = harness.repo / '.release-runs' / RUN / 'state.json'
    state = json.loads(path.read_text())
    state['repo'] = str(harness.repo / 'another')
    path.write_text(json.dumps(state))
    result = await harness.call({'action': 'resume', 'runId': RUN, 'approveContainerCgroup': True})
    assert result['status'] == 'error' and 'mismatch' in result['error']


async def test_bad_paths_and_credential_arguments_do_not_execute(harness):
    for files in (['../private'], ['/tmp/private'], ['--unexpected']):
        assert (await harness.call({**start(), 'files': files}))['status'] == 'error'
    result = await harness.call({**start(), 'GH_TOKEN': TOKEN})
    assert result['status'] == 'error' and TOKEN not in str(result)
    assert not (harness.repo / '.release-runs').exists()


async def test_missing_credential_is_reported_without_start(harness, monkeypatch):
    monkeypatch.delenv('GH_TOKEN')
    monkeypatch.delenv('GITHUB_TOKEN', raising=False)
    result = await harness.call(start())
    assert result['status'] == 'error' and 'environment' in result['error']
    assert not (harness.repo / '.release-runs').exists()


async def test_cancellation_stops_child_and_cleans_only_known_run(harness):
    h = harness
    running = asyncio.Event()
    def progress(text):
        h.progress.append(text)
        if text.startswith('[waiting]'):
            running.set()
    h.client.progress = progress
    task = asyncio.create_task(h.call(start('slow')))
    await asyncio.wait_for(running.wait(), 5)
    pid = int((h.repo / '.release-runs' / RUN / 'pid').read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert (h.repo / '.release-runs' / RUN / 'cleaned').is_file()
    assert not list((h.repo / '.release-runs').glob('.local-notes-*'))


async def test_reads_real_release_script_summary_without_external_effects(harness):
    h = harness
    await h.call(start())
    source = Path(__file__).resolve().parents[1] / 'scripts'
    h.client.script.write_text((source / 'release.py').read_text())
    (h.repo / 'scripts/release_support').symlink_to(source / 'release_support', target_is_directory=True)
    state_path = h.repo / '.release-runs' / RUN / 'state.json'
    state = json.loads(state_path.read_text())
    state.update(createdAt=1, completed=True, completedAt=3, stages={
        'publication': {'status': 'passed', 'startedAt': 1, 'finishedAt': 3,
                        'result': {'url': 'https://example.invalid/releases/v0.11.1'}}})
    state_path.write_text(json.dumps(state))
    before = state_path.read_bytes()
    result = await h.call({'action': 'status', 'runId': RUN})
    assert result['completed'] is True and result['runId'] == RUN
    assert 'https://example.invalid/releases/v0.11.1' in json.dumps(result)
    assert state_path.read_bytes() == before


def test_real_cli_forwards_start_notes_and_explicit_files(harness, tmp_path):
    notes = tmp_path / 'notes.md'
    notes.write_text('fixture CLI release notes')
    result = subprocess.run([sys.executable, str(Path(release.__file__)), '--repo', str(harness.repo),
                             'start', '0.11.1', '--notes', str(notes), '--files',
                             '--approve-container-cgroup'], capture_output=True, text=True, timeout=10)
    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload['status'] == 'failed' and payload['runId'] == RUN
    assert TOKEN not in result.stdout + result.stderr
    state = json.loads((harness.repo / '.release-runs' / RUN / 'state.json').read_text())
    assert state['notes'] == 'fixture CLI release notes'


def test_core_environment_uses_private_local_config(tmp_path):
    from scripts.release import environment
    local = tmp_path / '.release-environment.json'
    images = {'pythonImages': {v: 'fixture-py' + v for v in ('311', '312', '313')},
              'systemdImage': 'fixture-systemd:local'}
    local.write_text(json.dumps(images))
    assert environment(None, tmp_path) == images
    override = tmp_path / 'override.json'
    changed = {**images, 'systemdImage': 'other-systemd:local'}
    override.write_text(json.dumps(changed))
    assert environment(str(override), tmp_path) == changed
