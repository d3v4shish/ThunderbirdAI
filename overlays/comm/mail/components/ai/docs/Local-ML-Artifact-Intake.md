# Local ML Artifact Intake

No local ML artifact is currently approved for Thunderbird AI. This checklist
is the required intake record before enabling GLiNER entity extraction or
ModernBERT mail-intent classification.

## Existing runtime defaults are not approved Thunderbird artifacts

The Mozilla ML runtime exposes generic defaults, including
`Xenova/distilbert-base-uncased-mnli` for zero-shot classification and
`Xenova/bert-base-multilingual-cased-ner-hrl` for token classification. They
are useful capability demonstrations, but Thunderbird must not consume them
for entity extraction yet: their generic defaults do not supply a
Thunderbird feature registration, immutable revision, artifact SHA-256,
role-specific labels, or the evaluation evidence required below. Using a
default model identifier as if it were a pinned mail-safety artifact would
make updates and score interpretation unauditable.

## One record per role and artifact

| Required field | Why it is required |
| --- | --- |
| Role and task contract | Prevents a classifier or entity model from being substituted for another role. |
| Publisher, immutable revision, SHA-256, license | Makes the downloaded bytes and redistribution terms reviewable. |
| Mozilla model-distribution feature and download lifecycle | Ensures the artifact is delivered, cached, removed, and permissioned through the platform model service—not an ad-hoc Thunderbird download. |
| Exact tokenizer, model inputs/outputs, label mapping, and failure behavior | Prevents a superficially successful inference call from producing wrongly interpreted scores. |
| CPU/RAM/VRAM/download-size and p50/p95 latency measurements | Establishes a profile- and hardware-safe budget. |
| Versioned, redacted role-specific evaluation corpus | Measures the intended task without reading a live profile. |
| Accuracy, calibration, privacy, recovery, and human-review gate results | Determines whether the role is safe to enable and which fallback remains active. |

## Role-specific decision boundaries

| Role | May do | Must not do |
| --- | --- | --- |
| GLiNER-style token classification | Produce bounded entity candidates with offsets for retrieval and review. | Treat entities as proof, mutate mail, or create graph facts without deterministic/source-span confirmation. |
| ModernBERT intent classification | Add a mail-intent routing hint with confidence and model provenance. | Override deterministic policy, move mail automatically, or become answer evidence. |

## Promotion procedure

1. Complete and review an intake record with every field above.
2. Register the approved artifact through Mozilla's model-distribution
   mechanism and verify its immutable metadata after installation.
3. Implement the adapter with an explicit `unavailable` result when the model,
   tokenizer, labels, or runtime are absent or incompatible.
4. Run the role-specific redacted corpus, recovery tests, and hardware-budget
   measurements on the target machines.
5. Run the Assistant end-to-end source-span and citation-mapping suite with
   role-specific retrieval, privacy, and unavailable-runtime cases.
6. Conduct privacy-safe human review. Only then can the feature be enabled for
   a limited staged rollout; the deterministic path remains the kill switch.

## Developer-only private experiment registry

For a personal developer build, `mail.ai.private_ml.enabled` and an absolute
`mail.ai.private_ml.manifest_path` can validate manually installed artifacts.
This is neither Mozilla approval nor a product distribution route. The
manifest requires explicit acknowledgement, a supported role, an
`external-loopback` runtime, a loopback HTTP(S) endpoint, and an exact
size/SHA-256 for every already-local file. Thunderbird neither downloads the
artifacts nor starts the runner. A failed hash, changed size, missing file, or
non-loopback address leaves the experiment invalid and unavailable.

The registry accepts `gliner-entities` and `modernbert-intent` records so
private work can pin all bytes.

For private developer testing, the GLiNER adapter is separately enabled by
`mail.ai.private_ml.gliner.enabled` and receives at most 6,000 characters of
post-PII-safe text as `{"text":"..."}`. Its response must be
`{"entities":[{"text":"...","label":"...","start":0,"end":3,"confidence":0.9}]}`;
Thunderbird drops every candidate whose offsets do not exactly reproduce its
text, retains accepted results only as ranking hints, strips those hint chunks
before synthesis and citation, and never adds them to deterministic entities or
graph facts. The ModernBERT adapter is separately
enabled by `mail.ai.private_ml.modernbert_intent.enabled`, receives
`{"text":"...","labels":[...]}`, and accepts only
`{"intent":{"label":"<provided label>","confidence":0.9}}`. Its label is
a bounded ranking-only retrieval-routing hint, never a category override or answer
evidence. None of this relaxes the role boundaries above.
