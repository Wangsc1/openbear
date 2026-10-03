"""Local version authority and public-history export; never push private history."""
from __future__ import annotations

import io
import re
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

from .common import ReleaseError, atomic_json, fingerprint, sha

VERSION_FILES = {"app/__init__.py", "pyproject.toml", "uv.lock", "web/package.json", "web/package-lock.json"}
PUBLIC_ROOTS = {".githooks", ".gitignore", "README.md", "README", "LICENSE", "app", "docs", "evals",
                "openbear.json.example", "openbear.service", "prompts", "pyproject.toml", "scripts", "tests", "uv.lock", "web"}
VERSION_RE = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")


def version(repo: Path) -> str:
    match = re.search(r'^__version__\s*=\s*[\'"]([^\'"]+)[\'"]', (repo / "app/__init__.py").read_text(), re.M)
    if not match or not VERSION_RE.fullmatch(match[1]):
        raise ReleaseError("Cannot read stable app/__init__.py version")
    return match[1]


def valid_path(name: str) -> bool:
    p = PurePosixPath(name)
    return bool(name and not p.is_absolute() and ".." not in p.parts and "\\" not in name
                and p.parts[0] in PUBLIC_ROOTS and not any(x in p.parts for x in ("__pycache__", "node_modules", ".venv", ".git"))
                and not name.startswith(("web/dist/", "web/data/", "web/logs/", "evals/agent_delegation/reports/"))
                and not name.endswith((".db", ".db-wal", ".db-shm", ".pyc")))


def changed_paths(git) -> set[str]:
    raw = git("status", "--porcelain=v1", "--untracked-files=all", "-z")
    values, result, i = raw.split("\0"), set(), 0
    while i < len(values):
        row = values[i]
        i += 1
        if not row:
            continue
        result.add(row[3:])
        if "R" in row[:2] or "C" in row[:2]:
            result.add(values[i])
            i += 1
    # Old developer build backups are never release inputs. Tracked build files
    # still fail the complete public-tree allowlist below.
    return {p for p in result if not p.startswith("build/")}


def tree_files(git) -> list[str]:
    rows = git("ls-tree", "-r", "HEAD").splitlines()
    files = []
    for row in rows:
        header, name = row.split("\t", 1)
        mode, kind, _oid = header.split()
        if kind != "blob" or mode not in {"100644", "100755"} or not valid_path(name):
            raise ReleaseError(f"Source is not approved for public export: {name}")
        files.append(name)
    return files


def freeze(repo: Path, directory: Path, state, command) -> dict:
    value = state.value

    def git(*args, check=True):
        return command(["git", *args], "candidate-git", cwd=repo, check=check)

    if git("branch", "--show-current") != "main":
        raise ReleaseError("Release must start from local main")
    current = git("rev-parse", "HEAD")
    intent = value.get("commitIntent")
    recovered_commit = False
    if intent:
        if current != intent["parent"]:
            parents = git("show", "-s", "--format=%P", current).split()
            if parents != [intent["parent"]] or git("rev-parse", current + "^{tree}") != intent["tree"]:
                raise ReleaseError("Uncertain commit does not match the saved release intent", code=2)
            value["localCandidate"] = current
            recovered_commit = True
    prior = value.get("localCandidate")
    if prior and prior != current:
        raise ReleaseError("Local HEAD changed outside this run; refusing to adopt unrelated history", code=2)
    changed = changed_paths(git)
    allowed = set(value["files"]) | VERSION_FILES
    if any(not valid_path(p) for p in allowed):
        raise ReleaseError("--files contains an unsafe or non-public path")
    if changed - allowed:
        raise ReleaseError("Unreviewed changes: " + ", ".join(sorted(changed - allowed)))
    if changed and value.get("publicationIntent"):
        raise ReleaseError("Candidate already has publication effects; do not replace it or move its tag", code=2)
    if prior and not changed and not recovered_commit:
        if version(repo) != value["version"]:
            raise ReleaseError("Local release version drifted")
        return value["candidate"]
    current_version = version(repo)
    if not prior:
        if current_version not in {value["oldVersion"], value["version"]}:
            raise ReleaseError("Local version changed outside this run")
        command([value["python"], str(repo / "scripts/bump_version.py"), value["version"]], "bump-version", cwd=repo)
    elif current_version != value["version"]:
        raise ReleaseError("Corrective candidate must keep this run's version")
    command([value["python"], str(repo / "scripts/bump_version.py"), "--check", "--expect", value["version"]], "check-version", cwd=repo)
    if not recovered_commit:
        git("add", "--all", "--", *sorted(allowed))
        staged = set(git("diff", "--cached", "--name-only").splitlines())
        if staged - allowed:
            raise ReleaseError("Index contains unrelated changes")
        if not staged:
            raise ReleaseError("No candidate changes to commit")
        hook = repo / ".githooks/pre-commit"
        if hook.is_file() and git("config", "--get", "core.hooksPath", check=False) != ".githooks":
            command(["bash", str(hook)], "pre-commit-hook", cwd=repo)
        value["commitIntent"] = {"parent": current, "tree": git("write-tree")}
        state.save()
        git("-c", "user.name=virus", "-c", "user.email=virusinstant@gmail.com", "commit", "-m", f"release: prepare {value['version']}")
    local = git("rev-parse", "HEAD")
    files = tree_files(git)
    contents = {p: sha((repo / p).read_bytes()) for p in files}
    candidate = {"localCommit": local, "version": value["version"], "files": contents,
                 "sourceFingerprint": fingerprint(contents)}
    if value.get("candidate"):
        value.setdefault("candidateHistory", []).append({"candidate": value["candidate"], "stages": value.get("stages", {})})
        archive = directory / "superseded" / value["candidate"]["localCommit"]
        archive.mkdir(parents=True, exist_ok=True)
        for name in ("source", "build", "package", "assets", "results", "acceptance"):
            path = directory / name
            if path.exists():
                shutil.move(str(path), archive / name)
    value.update(localCandidate=local, candidate=candidate, stages={})
    value.pop("commitIntent", None)
    state.save()
    return candidate


def export(repo: Path, directory: Path, state, command) -> dict:
    value, source = state.value, directory / "source"
    candidate = value["candidate"]
    if source.exists():
        if source.is_symlink():
            raise ReleaseError("Public source directory cannot be a symlink")
        shutil.rmtree(source)
    source.mkdir()
    repository = value["repository"]
    url = f"https://github.com/{repository}.git"

    def git(*args):
        return command(["git", *args], "public-git", cwd=source)

    git("init", "-b", "main")
    git("remote", "add", "origin", url)
    git("fetch", "--depth", "1", "origin", value["publicBase"])
    git("reset", "--hard", value["publicBase"])
    for item in source.iterdir():
        if item.name == ".git":
            continue
        if item.is_dir() and not item.is_symlink():
            shutil.rmtree(item)
        else:
            item.unlink()
    archive = subprocess.check_output(["git", "archive", "--format=tar", candidate["localCommit"]], cwd=repo)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar:
            if member.isdir():
                continue
            if not member.isreg() or member.name not in candidate["files"]:
                raise ReleaseError(f"Unsafe exported file: {member.name}")
            target = source / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            data = tar.extractfile(member).read()
            if sha(data) != candidate["files"][member.name]:
                raise ReleaseError("Frozen source differs from local candidate")
            target.write_bytes(data)
            target.chmod(member.mode)
    git("config", "core.hooksPath", ".githooks")
    git("add", "--all")
    git("diff", "--cached", "--check")
    git("-c", "user.name=virus", "-c", "user.email=virusinstant@gmail.com", "commit", "-m",
        f"release: synchronize local candidate for {value['version']}")
    public = git("rev-parse", "HEAD")
    value["candidate"]["publicCommit"] = public
    state.save()
    atomic_json(directory / "candidate.json", value["candidate"])
    return {"sourceDir": str(source), "publicCommit": public, "sourceFingerprint": candidate["sourceFingerprint"]}


def assert_local(repo: Path, value: dict, command):
    current = command(["git", "rev-parse", "HEAD"], "check-head", cwd=repo)
    if current != value["candidate"]["localCommit"]:
        raise ReleaseError("Local HEAD changed after validation", code=2)
    if any(not (repo / p).is_file() or sha((repo / p).read_bytes()) != digest for p, digest in value["candidate"]["files"].items()):
        raise ReleaseError("Local candidate files changed after validation", code=2)
    if changed_paths(lambda *args: command(["git", *args], "check-worktree", cwd=repo)):
        raise ReleaseError("Working tree has new unreviewed files after validation", code=2)
