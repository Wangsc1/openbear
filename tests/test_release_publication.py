from __future__ import annotations

import copy
import io
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from release_support.common import ReleaseError, State, load, sha
from release_support.publication import publish
from release_support.github import GitHub


@pytest.mark.parametrize('path', ['', '/releases/latest'])
def test_github_repository_relative_paths_include_empty_root(monkeypatch, path):
    github = GitHub('fixture/openbear', 'only-in-memory-fixture')
    requests = []

    def open_request(request, timeout):
        requests.append(request)
        assert timeout == 150
        response = io.BytesIO(b'{"permissions":{"push":true}}')
        response.status = 200
        return response

    monkeypatch.setattr(github.opener, 'open', open_request)
    assert github.api(path) == {'permissions': {'push': True}}
    assert len(requests) == 1
    assert requests[0].full_url == 'https://api.github.com/repos/fixture/openbear' + path
    assert requests[0].get_header('Authorization') == 'Bearer only-in-memory-fixture'


class FakeGitHub:
    token = 'only-in-memory-fixture'

    def __init__(self, lose=None):
        self.main = 'base'
        self.tag = None
        self.release = None
        self.uploads = []
        self.payloads = {}
        self.lose = lose
        self.lost = False
        self.create_calls = 0
        self.publish_calls = 0

    def maybe_lose(self, phase):
        if phase == self.lose and not self.lost:
            self.lost = True
            raise ReleaseError('response lost after ' + phase)

    def api(self, path, method='GET', data=None, missing=False):
        if path == '/git/ref/heads/main':
            return {'object': {'sha': self.main}}
        if path.startswith('/git/ref/tags/'):
            return {'object': {'sha': self.tag}} if self.tag else None
        if path.startswith('/releases/tags/'):
            return copy.deepcopy(self.release)
        if path == '/releases' and method == 'POST':
            self.create_calls += 1
            assert self.release is None
            self.release = {**data, 'id': 12, 'assets': [], 'upload_url': 'https://uploads.github.com/upload{?name}',
                            'html_url': 'https://github.com/fixture/openbear/releases/tag/v1.0.1'}
            self.maybe_lose('create')
            return copy.deepcopy(self.release)
        if path == '/releases/12' and method == 'PATCH':
            self.publish_calls += 1
            self.release.update(data)
            self.maybe_lose('publish')
            return copy.deepcopy(self.release)
        if path == '/releases/latest':
            return copy.deepcopy(self.release)
        raise AssertionError((path, method))

    def request(self, url, method='GET', data=None, **kwargs):
        if method == 'POST':
            name = parse_qs(urlsplit(url).query)['name'][0]
            assert name not in self.uploads, 'resuming must not reupload a confirmed asset'
            self.uploads.append(name)
            self.payloads[name] = data
            asset = {'id': 100 + len(self.uploads), 'name': name, 'state': 'uploaded', 'size': len(data),
                     'browser_download_url': 'https://github.com/fixture/openbear/releases/download/v1.0.1/' + name}
            self.release['assets'].append(asset)
            self.maybe_lose('upload')
            return asset
        assert method == 'HEAD' and kwargs['authenticated'] is False
        return 200

    def download_asset(self, asset):
        return self.payloads[asset['name']]


class FakeGit:
    def __init__(self, github, notes):
        self.github, self.notes = github, notes
        self.local_tag = False
        self.pushes = []

    def __call__(self, args, _label, **kwargs):
        if 'status' in args:
            return ''
        if args[-2:] == ['rev-parse', 'HEAD'] or args[-1].endswith('^{commit}'):
            return 'candidate'
        if 'tag' in args and '--list' in args:
            return 'v1.0.1' if self.local_tag else ''
        if 'tag' in args and '-a' in args:
            assert '--cleanup=verbatim' in args
            self.local_tag = True
            return ''
        if 'cat-file' in args:
            return 'object candidate\ntagger virus <virusinstant@gmail.com> 1 +0000\n\n' + self.notes.rstrip('\n')
        if 'rev-parse' in args:
            return 'tag-object'
        if 'push' in args:
            assert kwargs['env'].get('GIT_CONFIG_COUNT') == '2'
            self.pushes.append(args[-1])
            if args[-1] == 'candidate:refs/heads/main':
                self.github.main = 'candidate'
            else:
                self.github.tag = 'tag-object'
            return ''
        raise AssertionError(args)


@pytest.fixture
def publication(tmp_path):
    (tmp_path / 'source').mkdir()
    (tmp_path / 'assets').mkdir()
    notes = 'Version 1.0.0 → 1.0.1\n\n### Fixes\n\n- Original Markdown.\n'
    (tmp_path / 'notes.md').write_text(notes)
    assets = {}
    for name in ('install.sh', 'openbear-1.0.1.zip', 'SHA256SUMS', 'release-meta.json'):
        content = name.encode()
        (tmp_path / 'assets' / name).write_bytes(content)
        assets[name] = {'bytes': len(content), 'sha256': sha(content)}
    state = State(tmp_path, {'candidate': {'localCommit': 'local', 'publicCommit': 'candidate'}, 'version': '1.0.1',
                            'publicBase': 'base', 'notes': notes, 'stages': {'package': {'result': {'assets': assets}}}})
    return tmp_path, state, notes


@pytest.mark.parametrize('phase', ['create', 'upload', 'publish'])
def test_unknown_remote_result_reconciles_before_retry(publication, phase):
    directory, state, notes = publication
    github = FakeGitHub(lose=phase)
    git = FakeGit(github, notes)
    with pytest.raises(ReleaseError, match='response lost'):
        publish(directory, state, git, github)
    restored = State(directory, load(directory / 'state.json'))
    result = publish(directory, restored, git, github)
    assert result['ok'] and result['latest']
    assert github.create_calls == 1 and github.publish_calls == 1
    assert len(github.uploads) == 4 and len(set(github.uploads)) == 4
    assert git.pushes == ['candidate:refs/heads/main', 'refs/tags/v1.0.1']
    assert github.release['body'] == notes
    assert github.token not in (directory / 'state.json').read_text()


def test_changed_zip_cannot_be_uploaded(publication):
    directory, state, notes = publication
    (directory / 'assets/openbear-1.0.1.zip').write_bytes(b'changed')
    github = FakeGitHub()
    with pytest.raises(ReleaseError, match='asset bytes differ'):
        publish(directory, state, FakeGit(github, notes), github)
    assert github.main == 'base' and not github.create_calls


def test_foreign_main_refuses_to_force_push(publication):
    directory, state, notes = publication
    github = FakeGitHub()
    github.main = 'someone-elses-commit'
    with pytest.raises(ReleaseError, match='Public main moved'):
        publish(directory, state, FakeGit(github, notes), github)
    assert not github.create_calls


def test_foreign_asset_is_not_deleted_or_replaced(publication):
    directory, state, notes = publication
    github = FakeGitHub(lose='upload')
    git = FakeGit(github, notes)
    with pytest.raises(ReleaseError):
        publish(directory, state, git, github)
    github.release['assets'].append({'name': 'foreign.txt', 'id': 444})
    with pytest.raises(ReleaseError, match='foreign or duplicate'):
        publish(directory, state, git, github)
    assert not github.publish_calls
