# Contributing

Thanks for helping make ThunderbirdAI easier to review and reproduce.

## Before opening a pull request

1. Make source changes in clean Gecko and `comm` Mercurial worktrees based on
   the revisions recorded in `MANIFEST.json`.
2. Regenerate the export with `python3 scripts/export_active.py`; do not edit
   generated patches or manifest hashes by hand.
3. Review the patch, overlay, deletion list, and worktree status counts.
4. Run `python3 scripts/verify_bundle.py` from the repository root.
5. Build and run the focused tests described in `docs/TESTING.md` when the
   source payload changes.
6. Explain the upstream bases, changed entries, and verification in the pull
   request description.

Keep generated build output, downloaded models, virtual environments, mail
profiles, raw logs, API keys, tokens, and other personal data out of commits.
Use synthetic data in tests and examples. A payload file must remain below
GitHub's 100 MB hard limit; prefer small source patches over binary archives.

Documentation-only fixes do not require regenerating `MANIFEST.json` unless
they change a generated file under `patches/`, `overlays/`, or `deletions/`.

By contributing, you agree that your contribution is available under the
Mozilla Public License 2.0 and any compatible existing license carried by an
upstream file you modify.
