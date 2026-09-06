#!/usr/bin/env python3
"""Apply the verified ThunderbirdAI export to clean upstream worktrees."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "MANIFEST.json").read_text(encoding="utf-8"))


def run(*args: str, cwd: Optional[Path] = None, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def repository_target(source_root: Path, identifier: str) -> Path:
    if identifier == "gecko":
        return source_root
    if identifier == "comm":
        return source_root / "comm"
    raise SystemExit(f"Unsupported repository id: {identifier}")


def check_target(source_root: Path, entry: dict[str, object]) -> Path:
    target = repository_target(source_root, str(entry["id"]))
    if not (target / ".hg").is_dir():
        raise SystemExit(f"Expected a Mercurial checkout at {target}")
    revision = run("hg", "log", "-r", ".", "-T", "{node}", cwd=target, capture=True)
    if revision != entry["base_revision"]:
        raise SystemExit(
            f"{entry['id']} is at {revision}; expected {entry['base_revision']}"
        )
    status = run("hg", "status", cwd=target, capture=True)
    if status:
        raise SystemExit(
            f"{target} is not clean. Commit, shelve, or discard its changes first."
        )
    return target


def patch_command(target: Path, patch: Path, dry_run: bool) -> Tuple[str, ...]:
    command = ["patch", "--batch", "--forward", "-p1", "-d", str(target)]
    if dry_run:
        command.append("--dry-run")
    command.extend(("-i", str(patch)))
    return tuple(command)


def safe_destination(target: Path, relative: str) -> Path:
    destination = target / relative
    try:
        destination.resolve(strict=False).relative_to(target.resolve())
    except ValueError as error:
        raise SystemExit(f"Unsafe manifest path: {relative}") from error
    return destination


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} /path/to/mozilla-unified", file=sys.stderr)
        return 2
    source_root = Path(sys.argv[1]).expanduser().resolve()
    run(sys.executable, str(ROOT / "scripts" / "verify_bundle.py"))

    targets: dict[str, Path] = {}
    for entry in MANIFEST["repositories"]:
        targets[entry["id"]] = check_target(source_root, entry)

    # Validate both patches before changing either checkout.
    for entry in MANIFEST["repositories"]:
        target = targets[entry["id"]]
        patch = ROOT / entry["patch"]["path"]
        run(*patch_command(target, patch, dry_run=True))

    for entry in MANIFEST["repositories"]:
        target = targets[entry["id"]]
        patch = ROOT / entry["patch"]["path"]
        run(*patch_command(target, patch, dry_run=False))

        overlay_root = ROOT / entry["overlay"]["path"]
        for item in entry["overlay"]["files"]:
            source = overlay_root / item["path"]
            destination = safe_destination(target, item["path"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() or destination.is_symlink():
                raise SystemExit(f"Refusing to overwrite overlay destination: {destination}")
            shutil.copyfile(source, destination)
            os.chmod(destination, int(item["mode"], 8))
            if sha256(destination) != item["sha256"]:
                raise SystemExit(f"Copied overlay failed verification: {destination}")

        for relative in entry["deletions"]["files"]:
            destination = safe_destination(target, relative)
            if destination.is_dir():
                raise SystemExit(f"Refusing to delete a directory: {destination}")
            if destination.exists() or destination.is_symlink():
                destination.unlink()

    mozconfig = source_root / "mozconfig"
    if not mozconfig.exists():
        shutil.copyfile(ROOT / "config" / "mozconfig.example", mozconfig)
        os.chmod(mozconfig, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        print(f"Installed {mozconfig}")
    else:
        print(f"Kept existing {mozconfig}; compare it with config/mozconfig.example")

    print(f"ThunderbirdAI applied successfully to {source_root}")
    print("Next: cd to that directory and run: python3.12 ./mach build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
