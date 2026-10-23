#!/usr/bin/env python3
"""Build the independent gateway from this checkout without installing a service."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

ARCHES = ("amd64", "arm64")


def build(source: Path, output: Path, *, go="go", arches=ARCHES, test=True):
    source, output = source.resolve(), output.resolve()
    if not (source / "go.mod").is_file():
        raise ValueError("gateway Go source is missing")
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "GOTOOLCHAIN": "local", "GOFLAGS": "-mod=readonly"}
    version = subprocess.check_output([go, "version"], text=True, env=env).strip()
    if test:
        subprocess.run([go, "test", "-race", "./..."], cwd=source, env=env, check=True)
    binaries = {}
    for arch in arches:
        if arch not in ARCHES:
            raise ValueError("unsupported gateway architecture")
        target = output / f"openbear-gateway-linux-{arch}"
        temporary = target.with_suffix(".pending")
        try:
            subprocess.run([go, "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w",
                            "-o", str(temporary), "./cmd/openbear-gateway"], cwd=source,
                           env={**env, "GOOS": "linux", "GOARCH": arch, "CGO_ENABLED": "0"}, check=True)
            temporary.chmod(0o755)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        binaries[target.name] = {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                                 "bytes": target.stat().st_size}
    manifest = {"schema": 1, "toolchain": version, "binaries": binaries}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "gateway")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--go", default="go")
    parser.add_argument("--arch", choices=ARCHES, action="append")
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output, go=args.go, arches=args.arch or ARCHES,
                           test=not args.skip_tests), indent=2))


if __name__ == "__main__":
    main()
