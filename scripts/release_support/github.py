"""GitHub transport: credentials stay in memory and never cross download hosts."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from .common import ReleaseError


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ReleaseError("Refusing a non-HTTPS GitHub download redirect")
        result = super().redirect_request(req, fp, code, msg, headers, newurl)
        if result and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            result.remove_header("Authorization")
        return result


class GitHub:
    def __init__(self, repository: str, token: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ReleaseError("Invalid GitHub repository")
        self.repository, self.token = repository, token
        self.base = "https://api.github.com/repos/" + repository
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, url, *, method="GET", data=None, binary=False, authenticated=True, missing=False):
        if url == "" or url.startswith("/"):
            url = self.base + url
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ReleaseError("Invalid GitHub URL")
        headers = {"User-Agent": "OpenBear-release", "X-GitHub-Api-Version": "2022-11-28",
                   "Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        if authenticated:
            if parsed.netloc not in {"api.github.com", "uploads.github.com"}:
                raise ReleaseError("Credential recipient is not a GitHub API host")
            headers["Authorization"] = "Bearer " + self.token
        if isinstance(data, dict):
            data = json.dumps(data, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"
        elif isinstance(data, bytes):
            headers["Content-Type"] = "application/octet-stream"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=150) as response:
                if response.status not in {200, 201, 204}:
                    raise ReleaseError(f"GitHub {method} {parsed.path}: HTTP {response.status}")
                if method == "HEAD":
                    return response.status
                raw = response.read()
                return raw if binary else (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            if missing and exc.code == 404:
                return None
            raise ReleaseError(f"GitHub {method} {parsed.path}: HTTP {exc.code}; inspect then resume") from None
        except (OSError, ValueError, urllib.error.URLError) as exc:
            raise ReleaseError(f"GitHub {method} {parsed.path}: {type(exc).__name__}; outcome may be unknown, resume reconciles remote state") from None

    def api(self, path, **kwargs):
        return self.request(path, **kwargs)

    def download_asset(self, asset):
        return self.request(asset["url"], binary=True)
