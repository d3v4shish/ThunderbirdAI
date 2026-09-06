# Building ThunderbirdAI from source

This guide produces a full local ThunderbirdAI build from clean, pinned Mozilla
and Thunderbird source checkouts. It does not use or require any deleted
`parallel/` development trees.

The commands below target 64-bit Linux, the platform on which this export was
verified. Mozilla and Thunderbird also support Windows and macOS, but their
platform-specific prerequisite steps differ; follow the upstream prerequisite
guide first and then return to the checkout, apply, and build sections here.

## 1. Hardware and software

Plan for:

- a 64-bit operating system;
- at least 8 GB RAM (more improves parallel build performance);
- at least 40 GB free for source, toolchains, and build output;
- a reliable connection for the initial clones and bootstrap downloads;
- Mercurial, Git, Python 3.9 or newer, and the `patch` utility.

On Debian or Ubuntu, begin with:

```bash
sudo apt update
sudo apt install curl git mercurial patch python3 python3-venv
```

Mozilla's bootstrap process installs or downloads the remaining compiler,
Rust, Node, and system dependencies. Python 3.12 is recommended for this pinned
tree and is the version used for the verified build. Newer Python versions may
be ahead of the range understood by the pinned Mach code. The repository's
verification and apply scripts require Python 3.9 or newer.

Upstream references:

- [Thunderbird Linux prerequisites](https://developer.thunderbird.net/thunderbird-development/building-thunderbird/linux-build-prerequisites)
- [Building Thunderbird](https://developer.thunderbird.net/thunderbird-development/building-thunderbird)
- [Thunderbird build environment](https://developer.thunderbird.net/thunderbird-development/setting-up-a-build-environment)

## 2. Clone the exact upstream revisions

Thunderbird uses Gecko plus a nested `comm-central` repository. Both revisions
must match `MANIFEST.json`; applying to current upstream tips is intentionally
rejected because the patch context and APIs may have changed.

```bash
mkdir thunderbirdai-build
cd thunderbirdai-build

hg clone -r 54d5670601c9b2567d694229f03231bf773746ad \
  https://hg.mozilla.org/mozilla-unified mozilla-unified

hg clone -r a0de8c0b460faf0b30917f2e545998ef312727b4 \
  https://hg.mozilla.org/comm-central mozilla-unified/comm

git clone https://github.com/d3v4shish/ThunderbirdAI.git ThunderbirdAI
```

Confirm the revisions:

```bash
hg --cwd mozilla-unified log -r . -T '{node}\n'
hg --cwd mozilla-unified/comm log -r . -T '{node}\n'
```

They must print the two 40-character revisions above.

## 3. Bootstrap the build environment

Run Mach bootstrap from the Gecko root:

```bash
cd mozilla-unified
python3.12 ./mach bootstrap
cd ..
```

Choose a full desktop build when prompted. Bootstrap may install system
packages and writes downloaded toolchains under `~/.mozbuild` by default. It
may also create a `mozconfig`; the ThunderbirdAI configuration is installed in
the next section.

## 4. Verify and apply ThunderbirdAI

First verify that the Git checkout is intact:

```bash
cd ThunderbirdAI
python3 scripts/verify_bundle.py
```

Apply both patches, the authored overlay, and the intentional deletion list:

```bash
python3 scripts/apply_bundle.py ../mozilla-unified
```

The apply script refuses to proceed unless both Mercurial repositories are
clean and at the exact pinned revisions. It dry-runs both patches before making
changes, verifies copied overlay files, prevents path traversal, and will not
overwrite pre-existing overlay destinations.

Install the tested build configuration. This explicit copy is recommended even
if the apply script already installed it:

```bash
cp config/mozconfig.example ../mozilla-unified/mozconfig
```

The configuration enables `comm/mail`, uses the ThunderbirdAI branding,
enables automatic clobbering when upstream requires it, uses `sccache`, and
writes output to `obj-thunderbirdai`.

## 5. Compile

```bash
cd ../mozilla-unified
python3.12 ./mach build
```

A successful build ends with:

```text
Your build was successful!
To take your build for a test drive, run: |mach run|
```

The Linux executable will be:

```text
obj-thunderbirdai/dist/bin/thunderbird
```

Incremental rebuilds use the same command. Mach recompiles only what changed.

## 6. Run without touching a normal profile

Use a dedicated development profile:

```bash
mkdir -p ../thunderbirdai-profile
python3.12 ./mach run --profile ../thunderbirdai-profile
```

Do not point an experimental build at a valuable production profile without a
backup. Generated AI data belongs to the selected Thunderbird profile.

## 7. Package the build

After a successful compile:

```bash
python3.12 ./mach package
```

Packages are written beneath `obj-thunderbirdai/dist/`. Locally produced
packages are unsigned and should not be represented as official Thunderbird
releases.

## 8. Clean rebuilds

Normally, rerun `mach build`. If Mach explicitly requires a clobber or stale
generated state is suspected:

```bash
python3.12 ./mach clobber
python3.12 ./mach build
```

`mach clobber` permanently removes the object directory, not source files. The
following build takes substantially longer.

## Troubleshooting

### The apply script reports the wrong revision

Create fresh clones at the exact revisions above. Do not force the patches onto
a different upstream revision.

### The apply script reports a dirty checkout

Use a fresh checkout or preserve your work with Mercurial before applying.
The script deliberately avoids overwriting unrelated local changes.

### Mach rejects the Python version

Install Python 3.12 and invoke Mach explicitly as `python3.12 ./mach ...`.

### `sccache` is unavailable

Run `mach bootstrap` again. As a temporary alternative, remove
`ac_add_options --with-ccache=sccache` from `mozconfig`; the build remains
correct but recompilation will be slower.

### Build files request a clobber

Run `python3.12 ./mach clobber`, then build again. This is expected after some
build-system changes.

### Assistant is unavailable after launch

Compilation does not install an inference endpoint or model. Start Ollama or
another supported OpenAI-compatible endpoint, then configure it in
**Settings > Sources** and run **Test Assistant**.
