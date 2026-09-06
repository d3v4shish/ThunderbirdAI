#!/usr/bin/env python3
"""Verify ThunderbirdAI export integrity and GitHub portability."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "MANIFEST.json"
GITHUB_FILE_LIMIT = 100_000_000
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def safe_path(value: object, context: str, errors: list[str]) -> Optional[Path]:
    if not isinstance(value, str) or not value:
        errors.append(f"{context}: path must be a non-empty string")
        return None
    candidate = PurePosixPath(value)
    if (
        candidate.is_absolute()
        or ".." in candidate.parts
        or "\\" in value
        or "\0" in value
    ):
        errors.append(f"{context}: unsafe path {value!r}")
        return None
    return Path(*candidate.parts)


def verify_regular_file(path: Path, context: str, errors: list[str]) -> bool:
    if path.is_symlink():
        errors.append(f"{context}: symbolic links are not allowed ({path})")
        return False
    if not path.is_file():
        errors.append(f"{context}: missing regular file ({path})")
        return False
    return True


def verify_digest_and_size(
    path: Path,
    expected_size: object,
    expected_digest: object,
    context: str,
    errors: list[str],
) -> None:
    if not verify_regular_file(path, context, errors):
        return
    actual_size = path.stat().st_size
    if not isinstance(expected_size, int) or actual_size != expected_size:
        errors.append(
            f"{context}: size mismatch (manifest {expected_size!r}, actual {actual_size})"
        )
    actual_digest = sha256(path)
    if not isinstance(expected_digest, str) or not SHA256_PATTERN.fullmatch(
        expected_digest
    ):
        errors.append(f"{context}: invalid manifest SHA-256 {expected_digest!r}")
    elif actual_digest != expected_digest:
        errors.append(
            f"{context}: SHA-256 mismatch "
            f"(manifest {expected_digest}, actual {actual_digest})"
        )


def verify_patch(entry: dict[str, object], context: str, errors: list[str]) -> None:
    patch = entry.get("patch")
    if not isinstance(patch, dict):
        errors.append(f"{context}.patch: must be an object")
        return
    relative = safe_path(patch.get("path"), f"{context}.patch", errors)
    if relative is None:
        return
    path = ROOT / relative
    verify_digest_and_size(
        path,
        patch.get("size_bytes"),
        patch.get("sha256"),
        f"{context}.patch",
        errors,
    )
    if path.is_file() and not path.is_symlink():
        with path.open("rb") as stream:
            count = sum(line.startswith(b"diff --git ") for line in stream)
        if count != patch.get("file_count"):
            errors.append(
                f"{context}.patch: file count mismatch "
                f"(manifest {patch.get('file_count')!r}, actual {count})"
            )


def verify_overlay(entry: dict[str, object], context: str, errors: list[str]) -> None:
    overlay = entry.get("overlay")
    if not isinstance(overlay, dict):
        errors.append(f"{context}.overlay: must be an object")
        return
    root_relative = safe_path(overlay.get("path"), f"{context}.overlay", errors)
    files = overlay.get("files")
    if root_relative is None or not isinstance(files, list):
        if not isinstance(files, list):
            errors.append(f"{context}.overlay.files: must be an array")
        return

    overlay_root = ROOT / root_relative
    listed: set[Path] = set()
    content_bytes = 0
    for index, item in enumerate(files):
        file_context = f"{context}.overlay.files[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{file_context}: must be an object")
            continue
        relative = safe_path(item.get("path"), file_context, errors)
        if relative is None:
            continue
        if relative in listed:
            errors.append(f"{file_context}: duplicate path {relative.as_posix()!r}")
            continue
        listed.add(relative)
        path = overlay_root / relative
        verify_digest_and_size(
            path,
            item.get("size_bytes"),
            item.get("sha256"),
            file_context,
            errors,
        )
        if path.is_file() and not path.is_symlink():
            content_bytes += path.stat().st_size
            actual_mode = stat.S_IMODE(path.stat().st_mode)
            expected_mode = item.get("mode")
            if expected_mode not in {"0644", "0755"}:
                errors.append(f"{file_context}: invalid mode {expected_mode!r}")
            elif bool(actual_mode & 0o111) != bool(int(expected_mode, 8) & 0o111):
                errors.append(
                    f"{file_context}: executable-bit mismatch "
                    f"(manifest mode {expected_mode}, actual mode {actual_mode:04o})"
                )

    actual = {
        path.relative_to(overlay_root)
        for path in overlay_root.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    for path in sorted(actual - listed):
        errors.append(f"{context}.overlay: unlisted file {path.as_posix()!r}")
    for path in sorted(listed - actual):
        errors.append(f"{context}.overlay: missing file {path.as_posix()!r}")
    if len(listed) != overlay.get("file_count"):
        errors.append(
            f"{context}.overlay: file count mismatch "
            f"(manifest {overlay.get('file_count')!r}, actual {len(listed)})"
        )
    if content_bytes != overlay.get("content_bytes"):
        errors.append(
            f"{context}.overlay: byte count mismatch "
            f"(manifest {overlay.get('content_bytes')!r}, actual {content_bytes})"
        )


def verify_deletions(
    entry: dict[str, object], context: str, errors: list[str]
) -> None:
    deletions = entry.get("deletions")
    if not isinstance(deletions, dict):
        errors.append(f"{context}.deletions: must be an object")
        return
    relative = safe_path(deletions.get("path"), f"{context}.deletions", errors)
    files = deletions.get("files")
    if relative is None or not isinstance(files, list):
        if not isinstance(files, list):
            errors.append(f"{context}.deletions.files: must be an array")
        return
    normalized: list[str] = []
    for index, item in enumerate(files):
        path = safe_path(item, f"{context}.deletions.files[{index}]", errors)
        if path is not None:
            normalized.append(path.as_posix())
    if len(normalized) != len(set(normalized)):
        errors.append(f"{context}.deletions: duplicate paths")
    if len(normalized) != deletions.get("file_count"):
        errors.append(
            f"{context}.deletions: file count mismatch "
            f"(manifest {deletions.get('file_count')!r}, actual {len(normalized)})"
        )
    path = ROOT / relative
    if verify_regular_file(path, f"{context}.deletions", errors):
        actual = path.read_text(encoding="utf-8").splitlines()
        if actual != normalized:
            errors.append(f"{context}.deletions: list file differs from manifest")


def verify_portability(errors: list[str]) -> int:
    casefolded: dict[str, Path] = {}
    count = 0
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if ".git" in relative.parts or "__pycache__" in relative.parts:
            continue
        if path.is_symlink():
            errors.append(f"repository: symbolic link is not portable ({relative})")
            continue
        if not path.is_file():
            continue
        count += 1
        folded = relative.as_posix().casefold()
        if previous := casefolded.get(folded):
            errors.append(
                f"repository: case collision: {previous.as_posix()!r} and "
                f"{relative.as_posix()!r}"
            )
        else:
            casefolded[folded] = relative
        if path.stat().st_size >= GITHUB_FILE_LIMIT:
            errors.append(
                f"repository: {relative.as_posix()!r} is too large for GitHub "
                f"({path.stat().st_size} bytes)"
            )
    return count


def main() -> int:
    errors: list[str] = []
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"ERROR: cannot read {MANIFEST_PATH}: {error}", file=sys.stderr)
        return 1
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 2:
        print("ERROR: MANIFEST.json must use schema_version 2", file=sys.stderr)
        return 1
    repositories = manifest.get("repositories")
    if not isinstance(repositories, list) or not repositories:
        print("ERROR: MANIFEST.json must contain repositories", file=sys.stderr)
        return 1
    identifiers: set[object] = set()
    for index, entry in enumerate(repositories):
        context = f"repositories[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{context}: must be an object")
            continue
        identifier = entry.get("id")
        if not isinstance(identifier, str) or not identifier:
            errors.append(f"{context}: invalid id {identifier!r}")
        elif identifier in identifiers:
            errors.append(f"{context}: duplicate id {identifier!r}")
        identifiers.add(identifier)
        revision = entry.get("base_revision")
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            errors.append(f"{context}: invalid Mercurial revision {revision!r}")
        verify_patch(entry, context, errors)
        verify_overlay(entry, context, errors)
        verify_deletions(entry, context, errors)
    file_count = verify_portability(errors)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print(f"Verification failed with {len(errors)} error(s).", file=sys.stderr)
        return 1
    print(
        f"Verification passed: {len(repositories)} upstream repositories, "
        f"{file_count} GitHub files."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
