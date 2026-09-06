# Export format and maintenance

This Git repository is a reproducible delta over two pinned Mercurial trees.

## Manifest schema

`MANIFEST.json` records, for each upstream repository:

- the canonical upstream URL and 40-character base revision;
- the patch path, size, SHA-256 digest, and changed-file count;
- every overlay path, size, SHA-256 digest, and normalized Git mode;
- every intentionally deleted tracked path;
- source worktree status counts at export time.

Tracked Mercurial modifications and additions live in `patches/`. Files that
were authored but unknown to Mercurial live under `overlays/`. Missing tracked
files are represented explicitly under `deletions/`; they are not silently
lost from the export.

## Verify an export

```bash
python3 scripts/verify_bundle.py
```

Verification checks manifest structure, hashes, byte counts, patch file counts,
overlay executable bits, deletion lists, path safety, case collisions,
symlinks, and GitHub's per-file size limit. Git stores only the executable bit;
the apply script installs the exact normalized `0644` or `0755` manifest mode.

## Refresh from the maintainer workspace

`scripts/export_active.py` is intentionally maintainer-specific. It expects
this repository and the active checkout to be siblings:

```text
workspace/
├── ThunderbirdAI/        # this Git repository
└── mozilla-unified/
    └── comm/
```

Run:

```bash
python3 scripts/export_active.py
python3 scripts/verify_bundle.py
git diff --stat
```

The exporter replaces generated payload directories, emits fresh Mercurial Git
patches, copies unknown authored files, normalizes modes to `0644` or `0755`,
records missing tracked files, and rebuilds the manifest. Review every status
count and diff before committing.

Do not run the exporter from a consumer clone without the sibling active
worktrees. Do not add build products, downloaded models, profiles, credentials,
mail data, or raw logs to the export.
