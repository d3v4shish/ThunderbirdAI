#!/usr/bin/env python3
"""Export the active ThunderbirdAI Mercurial worktrees into this Git repo."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = REPOSITORY_ROOT.parent
GECKO_ROOT = WORKSPACE_ROOT / "mozilla-unified"
COMM_ROOT = GECKO_ROOT / "comm"


def hg(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["hg", "--cwd", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def status_paths(repo: Path, flag: str) -> list[str]:
    output = hg(repo, "status", flag, "-0")
    return sorted(
        item.decode("utf-8") for item in output.split(b"\0") if item
    )


def status_counts(repo: Path) -> dict[str, int]:
    labels = {
        "M": "modified",
        "A": "added",
        "R": "removed",
        "!": "missing",
        "?": "unknown",
    }
    counts = Counter(
        line[:1].decode("ascii")
        for line in hg(repo, "status", "-mardu").splitlines()
    )
    return {labels[key]: counts[key] for key in labels if counts[key]}


def clear_generated_payload() -> None:
    for name in ("patches", "overlays", "deletions", "snapshots"):
        path = REPOSITORY_ROOT / name
        if path.exists():
            shutil.rmtree(path)
    (REPOSITORY_ROOT / "patches").mkdir()
    (REPOSITORY_ROOT / "overlays").mkdir()
    (REPOSITORY_ROOT / "deletions").mkdir()


def export_repository(
    *, repo: Path, identifier: str, upstream: str, destination_name: str
) -> dict[str, object]:
    node = hg(repo, "log", "-r", ".", "-T", "{node}").decode("ascii")
    short_node = node[:12]
    patch_relative = Path("patches") / f"{destination_name}-{short_node}.patch"
    patch_path = REPOSITORY_ROOT / patch_relative
    patch = hg(repo, "diff", "--git")
    patch_path.write_bytes(patch)

    overlay_relative = Path("overlays") / destination_name
    overlay_root = REPOSITORY_ROOT / overlay_relative
    overlay_files: list[dict[str, object]] = []
    for relative_string in status_paths(repo, "-un"):
        relative = Path(relative_string)
        source = repo / relative
        destination = overlay_root / relative
        if source.is_symlink() or not source.is_file():
            raise RuntimeError(f"unsupported overlay entry: {source}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        mode = 0o755 if source.stat().st_mode & stat.S_IXUSR else 0o644
        os.chmod(destination, mode)
        overlay_files.append(
            {
                "path": relative.as_posix(),
                "size_bytes": destination.stat().st_size,
                "sha256": digest(destination),
                "mode": f"{mode:04o}",
            }
        )

    deleted = status_paths(repo, "-dn")
    deletion_relative = Path("deletions") / f"{destination_name}.txt"
    deletion_path = REPOSITORY_ROOT / deletion_relative
    deletion_path.write_text(
        "".join(f"{path}\n" for path in deleted), encoding="utf-8"
    )

    return {
        "id": identifier,
        "upstream": upstream,
        "base_revision": node,
        "patch": {
            "path": patch_relative.as_posix(),
            "size_bytes": patch_path.stat().st_size,
            "sha256": digest(patch_path),
            "file_count": sum(
                line.startswith(b"diff --git ") for line in patch.splitlines()
            ),
        },
        "overlay": {
            "path": overlay_relative.as_posix(),
            "file_count": len(overlay_files),
            "content_bytes": sum(
                int(file["size_bytes"]) for file in overlay_files
            ),
            "files": overlay_files,
        },
        "deletions": {
            "path": deletion_relative.as_posix(),
            "file_count": len(deleted),
            "files": deleted,
        },
        "worktree_status": status_counts(repo),
    }


def main() -> None:
    if not (GECKO_ROOT / ".hg").is_dir() or not (COMM_ROOT / ".hg").is_dir():
        raise SystemExit(
            "Expected active Mercurial worktrees at mozilla-unified and "
            "mozilla-unified/comm"
        )
    clear_generated_payload()
    repositories = [
        export_repository(
            repo=GECKO_ROOT,
            identifier="gecko",
            upstream="https://hg.mozilla.org/mozilla-unified",
            destination_name="mozilla-unified",
        ),
        export_repository(
            repo=COMM_ROOT,
            identifier="comm",
            upstream="https://hg.mozilla.org/comm-central",
            destination_name="comm",
        ),
    ]
    manifest = {
        "schema_version": 2,
        "project": "ThunderbirdAI",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "description": (
            "Reproducible export of the active ThunderbirdAI Mercurial "
            "worktrees. Patches contain tracked changes; overlays contain "
            "authored unknown files; deletion lists contain intentionally "
            "absent tracked files."
        ),
        "repositories": repositories,
    }
    manifest_path = REPOSITORY_ROOT / "MANIFEST.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.chmod(manifest_path, 0o664)
    print(
        "Exported "
        + ", ".join(
            f"{entry['id']} ({entry['patch']['file_count']} patched, "
            f"{entry['overlay']['file_count']} overlay, "
            f"{entry['deletions']['file_count']} deleted)"
            for entry in repositories
        )
    )


if __name__ == "__main__":
    main()
