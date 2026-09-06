# Thunderbird RAG Modernization Plan

## Outcome

Thunderbird should answer mailbox questions from a bounded, inspectable chain
of evidence. It must retrieve the right messages before asking an LLM to write
an answer, cite every material mailbox claim, and update large profiles without
rewriting the entire index. Citation mapping is diagnostic metadata; the
pipeline does not run an answer verifier, repair pass, or forced abstention.

The target pipeline is:

1. Freeze the user-selected message, folder, account, or all-analyzed-mail
   scope.
2. Parse query constraints such as message IDs, transaction references,
   senders, dates, amounts, folders, and requested output fields.
3. Lock exact/structured matches when the query contains authoritative
   constraints. A probabilistic model cannot replace an exact match.
4. Retrieve a wider bounded candidate pool from lexical/FTS, dense vectors,
   sender, entity, template-family, thread, and cached scope-summary channels.
5. Fuse independent ranked lists with reciprocal-rank fusion (RRF).
6. Rerank the bounded pool with a dedicated cross-encoder. On failure, retain
   deterministic field-aware order and surface the degradation in diagnostics.
7. Build contextual evidence cards containing provenance, subject, sender,
   date, thread/template context, extracted fields, trust signals, and bounded
   message passages.
8. Apply the context budget, redact according to endpoint policy, synthesize
   the answer, and map visible citations to the retrieved evidence set. Missing
   evidence remains visible rather than triggering a hidden answer rewrite.

No design stage sends all mailbox bodies in one request.

## Implemented baseline (2026-08-26)

- Canonical row-level SQLite storage with WAL, changed-record checkpoints,
  atomic legacy JSON import, restart coverage, and a retained migration backup.
- Disposable SQLite RAG index with exact rollups, lexical FTS5 when available,
  deterministic lexical fallback, cache generations, and incremental rebuilds.
- Hybrid candidate generation across dense, lexical, sender, entity, template,
  thread, direct, and exact/structured channels, followed by RRF.
- Exact identifier and structured-constraint locks above probabilistic
  reranking.
- Separate Assistant, embedder, and reranker source bindings.
- Dedicated local `qwen3-embedding:0.6b` embedder selected after a reproducible
  local comparison with BGE-M3 on the labelled corpus.
- Dedicated Qwen3 reranker served on loopback through llama.cpp's native
  `/v1/rerank` endpoint, with OpenAI/Cohere-style and TEI protocol negotiation.
- Learned-reranker provenance (`model`, `mode`, `protocol`, redaction state,
  failure reason) in retrieval diagnostics.
- A labelled realistic email corpus with Recall@8, MRR, and abstention gates.
- Continuous 5,000-record write-amplification coverage and a standalone
  100,000-record storage/retrieval benchmark.

## Current gap assessment

The repository now contains implementations of contextual passage indexing,
hybrid passage retrieval, bounded adaptive searches, learned reranking,
source-citation mapping, resumable dedicated-embedding backfills, bounded dense
candidate lookup, and source-backed mailbox hierarchy rows. Exact amount, date,
merchant, and transaction-reference constraints are locked before
probabilistic ranking; the Book Nook near-miss cases are regression fixtures.

The remaining promotion gaps are evaluation breadth and staged real-profile
operation: a substantially larger adversarial/held-out corpus, human review on
an explicitly authorized folder, model-specific latency/quality budgets, and
live recovery exercises across partial indexes and endpoint interruption.
Generated graph edges and community summaries also remain experimental hints,
not authoritative mail evidence.

The work below is ordered by correctness dependency. Later phases must not be
used to mask a failure in an earlier phase.

## Target architecture

The Assistant routes each request to one of four evidence strategies and then
uses one common evidence-and-synthesis contract:

1. **Exact structured lookup** for message IDs, transaction references,
   amounts, dates, senders, recipients, and other authoritative fields.
2. **Local hybrid passage retrieval** for ordinary semantic questions about
   one or a few messages, using contextual lexical and dense passage indexes.
3. **Hierarchical corpus retrieval** for folder/account/mailbox summaries,
   trends, counts, and other global questions, using incrementally maintained
   rollups plus drill-down evidence.
4. **Bounded adaptive retrieval** for comparison and multi-part questions,
   with deterministic decomposition, a strict tool budget, scope locking, and
   early stopping.

Every route returns typed evidence with source-message provenance. The LLM is
an answer composer, not the source of mailbox facts. Endpoint answers are not
post-judged, repaired, or forcibly replaced with an abstention. Visible source
URIs are mapped only when they belong to the bounded retrieved set; the Sources
panel otherwise exposes that retrieved set for inspection.

## Delivery status: source-fact hardening wave (2026-08-31)

The following parts of this plan are implemented and covered by focused
Thunderbird tests:

- **Canonical ingestion:** decoded, non-attachment source text is immutable;
  body/signature/quoted segments are labelled before later processing. An
  opt-in local translation pass produces English-derived retrieval text, never
  citation evidence.
- **Automatic template and routing signals:** messages are partitioned by
  sender domain and surface before Drain3-style mining. Promoted templates are
  frozen; template, rule, sparse classifier, and optional transformer signals
  remain retrieval/routing hints rather than evidence.
- **Deterministic relation facts:** explicit ownership, per-person deadlines,
  proposal/approval, and rollback clauses are extracted with exact original
  offsets. Absence is open-world `unknown`, not a negative fact. The compact
  graph carries these facts back to the originating message only.
- **Answer route:** an explicit source-fact proposal/final comparison renders
  the retrieved clauses directly and makes no answer-model call. Endpoint
  synthesis has citation mapping and provenance diagnostics, not a semantic
  judge, repair pass, NLI gate, or forced abstention.
- **Migration and evaluation:** analysis version 7 schedules old records for
  low-priority source reanalysis; the disposable RAG index rebuilds from those
  artifacts. A synthetic frozen answer corpus and local Ollama A/B runner
  exercise required facts, source URIs, unsupported-fact abstention, prompt
  injection resistance, latency, unavailable-model reporting, corpus hashes,
  resolved model digests, and local runtime metadata. The first 3B/8B/27B
  baseline is recorded in `Model-Evaluation-Baseline-2026-08-31.md`; it is not
  sufficient by itself for promotion.
- **Bounded dense candidates:** dedicated passage embeddings populate a
  rebuildable SQLite LSH sidecar. Query-time dense scoring probes at most 36
  deterministic buckets and scores at most 4,096 candidates with the original
  vectors; it never scans an entire embedding column in JavaScript. Diagnostics
  expose the candidate index, probe count, candidate cap, and truncation.
- **Durable source-backed overview cache:** cached folder/account/mailbox
  overviews record their source-message dependencies and scope membership.
  A changed message invalidates only caches that contained it; a newly ingested
  message invalidates only caches whose scope includes it. Every cache miss
  recomputes from canonical records—there is no opaque generated-summary cache.
- **Typed hierarchy base and drill-down:** a per-message SQLite rollup sidecar
  is updated in the same transaction as RAG rows and exposes exact scoped
  counts/facets for account, folder, month, category, sender/domain, template,
  thread, status, priority, actions, and risks. `aggregate_mail` queries the
  sidecar directly and returns bounded leaf message IDs for every group, so a
  count remains inspectable and citable. The mailbox-overview tool carries
  these facts separately from endpoint-generated semantic summaries.
- **Derived-index recovery:** a malformed RAG SQLite sidecar is identified by
  its native corruption error, then only that sidecar and its WAL/SHM files are
  removed and rebuilt from canonical AIStorage rows. Lock, permission,
  disk-full, and other transient errors remain visible and never trigger data
  deletion.
- **Canonical deletion propagation:** removing a mail from AIStorage removes
  its derived retrieval rows in the next bounded transaction and invalidates
  only overview cache entries that cited it. A regression test covers the
  canonical record, index, and cached overview together.
- **Interrupted rebuild recovery:** the sidecar records its source generation
  only after every bounded rebuild chunk succeeds. An interrupted rebuild
  remains stale, then is rebuilt from canonical rows on the next query; a
  regression test injects an interruption between records.
- **Restart continuity:** closing and reopening a current profile-local RAG
  sidecar preserves its generation metadata and searchable rows, so the next
  query reopens it without a needless canonical rebuild.
- **Staged retrieval kill switch:** `mail.ai.rag.rollout.stage` makes exact,
  dense, reranking, hierarchy, and adaptive retrieval independently
  auditable. Lower stages retain the selected scope and use the conservative
  exact/lexical baseline; every answer trace records the effective stage.

The following remain explicitly controlled:

- GLiNER and ModernBERT private adapters require a user-supplied manifest with
  pinned SHA-256 and byte size for every artifact plus a loopback-only runner.
  Thunderbird validates those artifacts only when the user requests a
  configuration check; it does not hash them on every Settings-pane open.
  Product defaults remain off, while a private profile may opt in to either
  role independently. The intake and evaluation record is
  `Local-ML-Artifact-Intake.md`.
- LLM-derived graph edges/community summaries remain experimental retrieval
  hints. Deterministic graph facts and hierarchical source-backed rollups are
  the production baseline.

Recommended rollout order: let version-7 reanalysis finish for a small folder,
run retrieval and deterministic-fact tests, run the frozen 3B/8B/27B A/B
corpus locally, promote an answer model only if it meets its frozen quality and
latency gate, then expand reanalysis by account. Keep the exact/source-fact
lane enabled regardless of the selected answer model.

### Thunderbird storage benchmark invocation

Mozilla's generic `mach perftest` command presently accepts Firefox and
Android build applications only. The Thunderbird benchmark therefore has a
small xpcshell adapter and must be invoked directly from its manifest:

```sh
./mach xpcshell-test \
  --manifest comm/mail/components/ai/test/performance/xpcshell.toml \
  --timeout-factor 20 --sequential
```

The default corpus is **100,000 synthetic records** and is the only run that
can satisfy the mailbox-scale promotion gate. An explicit
`TB_AI_BENCHMARK_RECORD_COUNT` value from 1,000 through 100,000 is available
only to diagnose a constrained developer host; it must be reported as its
actual size and must never be used for promotion. On the 2026-08-31 local
developer build, the 20,000-record diagnostic run passed the bounded
checkpoint assertions in 28.8 seconds with 750 MiB peak RSS. On the 2026-09-01
local optimized developer build, the complete 100,000-row xpcshell gate passed
in 2 minutes 20.47 seconds with no retries or unexpected results.

## Milestone 0: freeze contracts and reproducible baselines

Define versioned schemas before changing retrieval again:

- `QueryPlan`: selected UI scope, intent, hard constraints, soft concepts,
  requested output fields, route, search budget, and missing-evidence behavior.
- `Evidence`: record ID, passage ID/span, source URI, retrieval channels,
  scores, extracted fields, provenance, trust state, and index/model versions.
- `AssistantAnswer`: display text, model/route provenance, mapped source IDs,
  the bounded retrieved source set, and explicit endpoint failure state. It is
  not a claim-level verification verdict.
- `IndexManifest`: source hash, parser/chunker/context schema, embedder model and
  digest, dimensions, redaction policy, and build generation.

Record the current v2 quality results and 6,000/100,000-message performance
results as immutable baselines. Add a replayable trace for every previously
observed human failure.

Acceptance criteria:

- The Book Nook prompts, cross-account scope cases, long-message cases, and
  prompt-injection cases are committed as deterministic regression fixtures.
- Every debug trace identifies the route, frozen scope, hard constraints,
  index generation, model provenance, candidate counts, and final stop reason.
- No raw unsafe body or credential is written to metadata-only traces.

## Milestone 1: exact and structured retrieval lane

Store normalized, typed values rather than attempting to recover important
fields from summary prose at query time. Initial typed fields include message
and thread IDs, transaction/reference/order/tracking IDs, normalized money,
ISO dates and date ranges, sender/recipient/domain, merchant/employer/project,
folder/account, attachment metadata, and extraction confidence/provenance.

Parse the query into hard and soft constraints. Intersect hard constraints in
SQLite first. Only use hybrid retrieval to rank within the exact result set or
to find candidates when no hard constraint is present. Conflicting constraints
must return `not found` or request clarification; they must never silently
relax. All requested exact fields in one answer row must originate from the
same source record.

Acceptance criteria:

- `Book Nook + 24 Aug 2026 + INR 805` and `TXN-HC-100005` both return only the
  intended record, with exact subject, amount, date, reference, and a clickable
  source message.
- Toggling dense retrieval or reranking cannot change an exact-match result.
- A one-digit amount/reference/date near miss produces no substitution.
- Exact lookup has 100% precision and recall on the labelled exact subset, zero
  cross-account leakage, and a recorded warm p95 latency gate.

## Milestone 2: production contextual passage index

Use structure-aware child passages rather than only one vector per message.
Split on MIME/HTML structure, paragraphs, quoted replies, signatures, tables,
and attachment boundaries; use bounded overlap only when a semantic boundary
cannot be preserved. Prefix each indexed child with deterministic parent
context: subject, sender/domain, sent date, folder/account, thread subject,
template family, category, and safe typed entities. Retrieve child passages but
expand the selected result to a bounded parent window for answer generation.

Keep the existing deterministic local embedding fallback. Wire the selected
dedicated embedder into resumable, low-priority batch backfills with per-input
hash checks, cancellation, model/dimension versioning, and visible progress.
Evaluate long-context late chunking behind a feature flag; promote it only if
the mailbox corpus shows a material gain over deterministic contextual headers
at acceptable memory and indexing cost.

Acceptance criteria:

- Answer-bearing text near the end of very long messages is retrieved at the
  passage level, with exact offsets and a clickable parent message.
- Quoted history, signatures, hidden HTML, and attachment text are labelled and
  cannot outrank trusted current-body text without an explicit reason.
- Restart, cancellation, model change, and partial backfill resume without
  duplicate passages or full-index rewrites.
- The UI shows passage indexing `done/total`, current model, degraded fallback,
  and last error without requiring Debug.

## Milestone 3: scalable hybrid retrieval and reranking

Make contextual FTS5/BM25 and dense retrieval independent candidate channels.
Use field-aware tokenization for email addresses, identifiers, dates, currency,
and Unicode/multilingual mail. Retrieve a broad bounded pool from lexical,
dense, sender, entity, template, thread, recency, and exact channels; combine
independent ranks with reciprocal-rank fusion rather than incomparable raw
scores.

Replace JSON-vector scans with a disposable approximate-nearest-neighbour
sidecar once the 100,000-message benchmark proves the need. Benchmark HNSW or a
Mozilla-compatible equivalent against exact search for recall, latency, memory,
incremental updates, deletion, crash recovery, and package size. Keep canonical
records and vector provenance in SQLite so the ANN structure can always be
rebuilt.

Rerank only the bounded fused pool with the dedicated cross-encoder. Preserve
hard constraints, add template/thread diversity, and fall back to deterministic
field-aware ranking if the reranker is absent or times out. Benchmark a
ColBERT-style late-interaction lane only as an optional alternative; do not add
its storage cost without a measured win.

Acceptance criteria:

- Every result exposes lexical, dense, exact, structural, fusion, and reranker
  provenance; `reranking on` visibly changes ranking only when scores justify
  it.
- Native FTS5 and lexical fallback both pass the same relevance contract.
- At 100,000 messages, warm hybrid search and reranking meet recorded p50/p95,
  peak-memory, and disk-size gates without an unbounded vector scan.
- Disabling or failing a model degrades quality visibly but does not disable
  exact/lexical search or the Assistant.

## Milestone 4: deterministic query router and bounded adaptive retrieval

Classify requests into exact lookup, local semantic, global aggregate, or
multi-part comparison before searching. Use rules for authoritative fields and
a small local classifier only where rules are ambiguous. Decompose only truly
multi-part queries. Each subquery inherits the immutable UI scope and receives
a fixed candidate, token, round, and wall-clock budget. Deduplicate with RRF,
stop when the evidence contract is satisfied, and never let an LLM invent tool
parameters outside the selected scope.

HyDE and unrestricted agent loops are not default retrieval methods: generated
hypothetical text can erase exact constraints and autonomous loops make privacy,
latency, and reproducibility harder. They may be evaluated only behind flags on
semantic-only subsets.

Acceptance criteria:

- Exact and single-message requests use one retrieval round.
- Multi-facet requests use at most three searches, with every query, count,
  duration, and stop reason visible in Debug.
- Adaptive retrieval improves the labelled multi-hop subset without regressing
  exact lookup, scope isolation, or p95 latency beyond the agreed budget.
- Cancellation immediately stops outstanding retrieval and endpoint work.

## Milestone 5: mailbox-wide hierarchical retrieval

Do not send thousands of messages to Ollama. Incrementally maintain typed,
versioned rollups by folder, account, time bucket, category, sender, template,
thread, project/entity, action, and risk. Store exact counts and deterministic
aggregates separately from generated summaries. Build a RAPTOR-like hierarchy
of source-backed summaries for global questions, then drill down from relevant
rollups to leaf messages before composing an answer.

Expose this through Thunderbird's internal read-only tool interface. The same
contract may be exposed through MCP for external clients, but the in-product
Assistant must not require an MCP server or network hop to query its own local
index.

The compact source-backed graph is an optional retrieval capability, not the
default answer path. It contains only deterministic local relationships plus
explicitly enabled, locally validated endpoint hints. Full LLM-derived
GraphRAG/community construction remains an experiment: promote it only if
labelled relationship-heavy and global-summary questions show a material gain
over hierarchical rollups that justifies its indexing cost, freshness
complexity, privacy surface, and disk footprint.

Acceptance criteria:

- A 6,000-message mailbox summary reports coverage and exact counts, samples
  all relevant rollups, and links every material theme/action to leaf evidence.
- One changed/deleted message updates only affected leaves and ancestors.
- Global answers state coverage (`indexed/eligible/total`), time range, stale
  rollups, and unsupported requested dimensions.
- Mailbox summary quality is evaluated separately from local retrieval quality.

## Milestone 6: citation presentation and bounded fallback

Pass evidence IDs to the answer model and preserve the model's cited message
links in the rendered answer. Use exact deterministic fields when they are
already available. Retrieved email text remains untrusted data and cannot issue
instructions to the Assistant.

If endpoint synthesis fails, return the best available retrieval summary with
its source links. Do not run verifier-driven repair or global-abstention loops.

Acceptance criteria:

- Retrieved claims retain clickable message citations where the model supplies
  them.
- Exact deterministic fields remain source-linked without requiring a second
  model to approve them.
- Direct RAG and Ollama synthesis use the same retrieved evidence contract.

## Milestone 7: evaluation, observability, and human feedback

Expand the labelled corpus beyond the current small v2 set. Include exact and
near-miss transactions, paraphrases, typos, multilingual/cross-lingual mail,
duplicate templates, long bodies, quoted contradictions, evolving thread
decisions, global summaries, prompt injection, PII, missing answers, partial
indexes, stale rollups, and cross-account keyword stuffing. Label relevant
messages, passages, exact fields, expected facts, citations, and expected
missing-evidence responses.

Report retrieval and answer metrics separately: Recall@1/3/8, MRR, nDCG@10,
exact-match accuracy, scope violations, answer correctness, citation
precision/recall, latency p50/p95, memory, index size, update amplification, and
energy/CPU time. Model-based judges are not part of the runtime answer path.

Add a human test harness that shows the question, expected facts, answer,
clickable sources, route, and simple `useful/wrong/missing context/unsafe`
feedback. Store only opt-in, privacy-safe evaluation artifacts.

Acceptance criteria:

- A versioned adversarial suite has enough examples per route and failure class
  to detect regressions; reports include confidence intervals where useful.
- Every model/configuration report records corpus version, model digest,
  context/index schemas, hardware, runtime, and retrieval settings.
- A failed quality, privacy, recovery, or performance gate blocks promotion and
  automatically preserves the last known-good configuration.

## Milestone 8: operational hardening and staged rollout

Exercise migration/restart, crash recovery, source deletion, model/dimension
change, cancellation, endpoint timeout, partial index, disk-full, corrupt
sidecar, and downgrade scenarios. Keep canonical AI records in row-level SQLite
WAL storage; use bounded transactions and rebuildable derived indexes. Add
generation-based atomic swaps for index upgrades and enforce disk/memory/CPU
budgets for foreground and background work.

Roll out in stages: exact/lexical only, local dense passages, learned reranker,
hierarchical global summaries, then bounded adaptive retrieval. Each stage has
a kill switch and a last-known-good rollback path.

Acceptance criteria:

- A killed migration/reindex resumes without record loss or duplicate canonical
  state, and a corrupt derived index is rebuilt without losing mail.
- A 1,000-row checkpoint in a 100,000-message profile remains one SQLite
  transaction, touches at most 1,010 rows, and serializes under 8 MiB.
- Background analysis never returns to monolithic-file write amplification and
  respects idle, power, thermal, and endpoint-background policies.
- Basic UI shows readiness, selected scope, analysis/RAG progress, and degraded
  mode; Advanced/Debug shows model versions, channel scores, exclusions,
  timings, budgets, redaction, and recovery state without flickering.

## Promotion order

1. Ship Milestones 0 and 1 together; exact correctness is the release blocker.
2. Complete and live-validate Milestones 2 and 3 on 6,000 and 100,000 messages.
3. Enable Milestone 6 before exposing broader Ollama synthesis.
4. Add Milestone 5 for whole-mailbox questions, then Milestone 4 for bounded
   multi-step requests.
5. Keep Milestones 7 and 8 running as continuous gates for every phase.

## Research basis and deliberate non-defaults

This plan adopts contextual lexical+dense retrieval and reranking, contextual
or late chunk representations where measured, fine-grained claim attribution,
adaptive retrieval by query complexity, and hierarchical retrieval for global
questions. It deliberately does not equate novelty with suitability:

- Contextual Retrieval motivates contextual embeddings, contextual lexical
  indexing, hybrid fusion, and reranking.
- Late Chunking and ColBERTv2 are benchmark candidates, not unconditional
  dependencies, because their runtime and index costs differ substantially.
- RAPTOR-style trees are a lower-risk fit for mailbox summaries than immediately
  building a generated knowledge graph.
- GraphRAG/DRIFT is reserved for demonstrated global or relationship-heavy
  gains.
- Citations are presented as provenance links, not as a second-model correctness
  gate.

Primary references:

- https://www.anthropic.com/engineering/contextual-retrieval
- https://arxiv.org/abs/2409.04701
- https://arxiv.org/abs/2112.01488
- https://arxiv.org/abs/2401.18059
- https://arxiv.org/abs/2403.14403
- https://aclanthology.org/2025.findings-naacl.55/
- https://aclanthology.org/2025.acl-industry.23/
- https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/
- https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/
- https://github.com/QwenLM/Qwen3-Embedding

## Explicitly inactive

Source-backed local GraphRAG is available behind the experimental
`mail.ai.rag.graph.enabled` preference for bounded relationship queries. It
does not use LLM-generated entities by default, and it does not replace
hierarchical rollups for mailbox-wide summaries. LLM-derived global
GraphRAG/DRIFT should be reconsidered only if a labelled global or
relationship-heavy query set demonstrates a material gain over thread,
template, entity, and cached hierarchical rollups that justifies its graph
build, freshness, privacy, storage, and explanation costs.

Visual retrieval is inactive. Attachments remain untrusted and must first pass
the attachment-security gate. OCR/image embeddings require a separately
versioned, deletable index, provenance down to attachment/page/region, and an
evaluation corpus covering malicious and malformed inputs before they may
participate in retrieval.

## Model and rollback policy

Model selection is data-driven, not hard-coded as a permanent product choice.
The shipped preference records a source binding; records retain model and
schema provenance. A new embedder or reranker is promoted only after it clears
the labelled quality, privacy, latency, memory, storage, and recovery gates.
Changing an embedder schedules an incremental compatible reindex; changing a
reranker requires no vector rebuild. Removing or failing either source falls
back to deterministic lexical/field-aware retrieval. Canonical mail and
canonical AI records remain local and deletable throughout.
