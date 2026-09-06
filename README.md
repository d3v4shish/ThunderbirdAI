# ThunderbirdAI

ThunderbirdAI is an experimental Thunderbird source customization that adds an
endpoint-backed Assistant, local mail analysis and retrieval, privacy controls,
security enrichment, and dedicated AI settings and diagnostics.

Assistant requests use a configured Ollama, LiteLLM, or OpenAI-compatible
endpoint. Thunderbird owns message selection, MIME parsing, deterministic
extraction, classification, PII handling, retrieval, redaction, evidence
packing, citations, conversation history, and generated-data governance.

> [!IMPORTANT]
> This is an independent experimental project, not an official Mozilla or
> Thunderbird release. Back up valuable mail profiles and review the source
> before using it with real mail.

## Why this repository contains patches

Thunderbird is built from two large upstream Mercurial repositories: Gecko in
`mozilla-unified` and Thunderbird in a nested `mozilla-unified/comm` checkout.
Uploading those complete working trees would produce an impractically large
and misleading fork. This repository instead pins both upstream revisions and
contains:

- exact patches for every tracked modification and addition;
- a browseable overlay for newly authored files not yet tracked by Mercurial;
- explicit deletion lists;
- a manifest with SHA-256 hashes, sizes, modes, and file counts;
- scripts that verify and apply the export safely.

There is one active Thunderbird tree: `mozilla-unified/comm`. No alternate
`parallel/` checkout is required.

## Build it

The short version on 64-bit Linux is:

```bash
git clone https://github.com/d3v4shish/ThunderbirdAI.git
cd ThunderbirdAI
python3 scripts/verify_bundle.py
python3 scripts/apply_bundle.py /path/to/clean/mozilla-unified
cp config/mozconfig.example /path/to/clean/mozilla-unified/mozconfig
cd /path/to/clean/mozilla-unified
python3.12 ./mach build
```

The target must contain clean Gecko and `comm` Mercurial checkouts at the exact
revisions in `MANIFEST.json`. See **[Building from source](docs/BUILDING.md)**
for prerequisites, checkout commands, bootstrapping, building, running,
packaging, testing, updating, and troubleshooting.

## Repository layout

| Path | Purpose |
| --- | --- |
| `patches/` | Tracked Gecko and Thunderbird changes |
| `overlays/comm/` | Authored Thunderbird files absent from the base revision |
| `deletions/` | Base files intentionally omitted by ThunderbirdAI |
| `config/mozconfig.example` | Tested full-build configuration and custom branding |
| `MANIFEST.json` | Exact source bases and integrity metadata |
| `scripts/apply_bundle.py` | Safe application to clean upstream checkouts |
| `scripts/verify_bundle.py` | Integrity, size, mode, and portability validation |
| `scripts/export_active.py` | Maintainer-only exporter for the local active worktrees |
| `docs/` | Build, test, architecture, and export documentation |

## Verified state

The exported active tree was compiled on 6 September 2026 with Python 3.12:

```text
Your build was successful!
0 compiler warnings present.
```

That verification used a normal incremental `mach build` with the bundled
`mozconfig` settings. Consumers should run the tests relevant to their target
platform and use case; a successful build is not a security or production
readiness guarantee.

## Documentation

- [Building from source](docs/BUILDING.md)
- [Testing and smoke checks](docs/TESTING.md)
- [Architecture and privacy model](docs/ARCHITECTURE.md)
- [Export format and maintenance](docs/EXPORT_FORMAT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License and trademarks

This repository is licensed under the Mozilla Public License 2.0. Files
derived from upstream retain their original notices and licensing terms.
Mozilla, Thunderbird, and their logos are trademarks of their respective
owners. This project grants no trademark rights and is not endorsed by Mozilla
or the Thunderbird project.
