# Testing and smoke checks

Run commands from the patched `mozilla-unified` source root. Use Python 3.12
for the pinned tree.

## Build verification

```bash
python3.12 ./mach build
```

The export was last verified on 6 September 2026 with a successful incremental
build and zero compiler warnings.

## Safe launch smoke test

Launch with a disposable profile so existing mail is not touched:

```bash
mkdir -p ../thunderbirdai-smoke-profile
python3.12 ./mach run --profile ../thunderbirdai-smoke-profile
```

Confirm that ThunderbirdAI opens, the custom branding renders, Settings opens,
and the Assistant and Sources panes load. Configure a test-only local endpoint
if you want to exercise inference.

## AI unit tests

Run the AI xpcshell suite sequentially first for deterministic diagnostics:

```bash
python3.12 ./mach xpcshell-test --sequential \
  comm/mail/components/ai/test/unit
```

Then exercise normal parallel scheduling:

```bash
python3.12 ./mach test comm/mail/components/ai/test/unit
```

## Focused browser tests

The main Assistant UI coverage is under the mail-window and preferences test
directories. Useful focused entry points include:

```bash
python3.12 ./mach test \
  comm/mail/base/test/browser/browser_aiTriageCenter.js

python3.12 ./mach test \
  comm/mail/components/preferences/test/browser/browser_aiSettings.js
```

Browser tests need a graphical session. On headless Linux, use the display
setup supported by your environment, such as Xvfb.

## Real endpoint smoke test

The Marionette real-endpoint test sends synthetic test content to the endpoint
you configure. Review the test and its environment-variable contract before
running it:

```bash
python3.12 ./mach marionette-test \
  comm/mail/test/marionette/test_ai_real_endpoint_smoke.py
```

Keep credentials out of shell history and diagnostic artifacts. Prefer a
loopback Ollama endpoint with a disposable Thunderbird profile.

## Interpreting results

A successful compile proves source and link compatibility. It does not prove
that endpoint configuration, profile migration, every UI path, or platform
packaging works. Record the exact revision, command, environment, and any
unexpected test result when reporting a failure.
