# AI Correctness Pass — 2026-09-01

## Outcome

The final source state passes the complete AI backend and browser test sets,
the 100,000-message storage/retrieval performance gate, and ESLint. The pass
covered canonical ingestion, deterministic extraction, Drain-style template
mining, hybrid RAG, GraphRAG source facts, Assistant routes and tools, GLiNER,
ModernBERT, endpoint summaries, embeddings, recovery, privacy controls, and the
Assistant/Settings UI.

## Correctness fixes made during the pass

- An unavailable or disabled summary endpoint may legitimately return `null`.
  Summary normalization now accepts that result and continues through the
  deterministic fallback instead of aborting the entire message pipeline.
- Queue failures now emit a bounded warning with the message ID and stack,
  while never logging the message subject or body. This made a formerly silent
  cross-stage failure diagnosable.
- Graph construction no longer treats a missing `analysisVersion` as a valid
  analyzed record through `Number(undefined)`. Legacy/source records retain
  their complete deterministic fields, and the graph contribution version was
  advanced so stale derived rows rebuild.
- Assistant setup is split into explicit scope, route, retrieval, and prompt
  preparation helpers. The endpoint path maps emitted source URIs for
  diagnostics only; it contains no answer verifier, semantic judge, repair
  loop, or forced-abstention gate.
- AI service shutdown now aborts and awaits the active processing loop before
  closing the RAG index or permitting a new service generation to start. This
  prevents stale endpoint, embedding, template-mining, and worker state from
  leaking across disable/re-enable, profile shutdown, or test lifecycles.
- GLiNER offsets are converted from Python Unicode-code-point offsets to
  JavaScript UTF-16 offsets and are accepted only when the returned text exactly
  matches the bounded input span. ModernBERT output is restricted to the closed
  intent-label set. Both remain retrieval/routing hints, never mail evidence.

## Runtime checks

- The pinned private runner loaded the installed GLiNER and ModernBERT
  artifacts on loopback. A Unicode/emoji GLiNER request returned exact source
  spans; a ModernBERT action request returned a valid closed-set intent.
- Automatic Drain-style mining runs after each canonical local artifact is
  stored. Promotion, bounded examples, pruning, sender/account partitioning,
  and post-promotion rematching are covered by integration tests; no separate
  “run miner” action is required.
- On the frozen dense retrieval corpus, `qwen3-embedding:0.6b` produced 1,024
  dimensions, Recall@1 0.9091, Recall@3 0.9545, and MRR 0.9333 in 1.94 seconds.
  `bge-m3` produced Recall@1 0.8636, Recall@3 0.9545, and MRR 0.9205 in 7.75
  seconds. The Qwen embedder is the measured choice for this machine/corpus.
- The frozen answer-model rerun identifies `qwen3:8b` at a 1,024-token
  completion budget as the only installed 3B/8B/27B candidate that clears all
  six source-fact cases. The current 27B configuration is slower and misses the
  complex comparison when hidden reasoning consumes the output budget.

## Verification record

| Gate | Result |
| --- | --- |
| AI xpcshell unit/integration | 41/41 tests passed |
| AI service lifecycle regression | 838/838 assertions passed |
| AI Assistant and Settings browser tests | 19/19 tests; 1,520 checks; 0 unexpected |
| Assistant controls focused browser test | 73/73 assertions passed |
| ESLint, `comm/mail/components/ai` | 0 errors, 0 warnings |
| 100,000-message performance manifest | Passed in approximately 2m24s |
| Private runner Python syntax | `py_compile` passed |

## Remaining operational choices

The code path is green, but a profile can still select a weaker installed
model. For the measured local setup, bind the Assistant role to `qwen3:8b` with
at least 1,024 completion tokens and the embedder role to
`qwen3-embedding:0.6b`. Reindex derived embeddings after changing the embedder;
canonical mail records do not need to be deleted. A larger held-out real-mail
evaluation remains necessary before treating the synthetic model ranking as a
general production claim.
