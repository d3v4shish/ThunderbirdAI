# Thunderbird AI Evaluation Record — 2026-09-04

This immutable evidence record covers evaluation work performed in the
2026-09-04 workspace session. It accompanies the living
[pipeline and evaluation reference](AI-Mail-Pipeline-and-Evaluation.md).

It distinguishes source-controlled historical baselines, completed session
runs, implemented tests without a live result, and an interrupted smoke run.
A run without a completed report is never presented as a passing result.

## Result vocabulary

| Label | Meaning |
| --- | --- |
| **Pass** | The command completed and its stated acceptance checks passed. |
| **Historical baseline** | A completed prior run recorded in source-controlled documentation. |
| **Implemented** | The harness exists and its static loading is covered, but no valid live quality result is claimed here. |
| **Interrupted** | Work started but did not finish; it has no pass/fail quality result. |

## Environment and fixtures

- Local Ollama `qwen3:8b` was the Assistant model in the completed live
  whole-mailbox prompts.
- Installed comparison candidates included `llama3.2`, `qwen3:8b`, and
  `qwen3.6:27b`; `bge-m3` was available for embedding-only use.
- The corpus came from `test/unit/data/ai-synthetic-corpus.js`. Its identities
  are fictional and it does not read a user Thunderbird profile.
- The 5,000-record variant proportionally included transactions, project
  revisions, distractors, newsletters, injection payloads, PII, encoded
  bodies, multipart messages, and cross-account near-matches.
- Required local stages covered canonicalization, parser/trust sidecar, local
  analysis, classification, template mining, extraction, PII, security,
  embedding, summary, RAG, and source-linked graph contribution.

## Completed session evaluations

### Static opt-in test registration — Pass

The synthetic 10K evaluation test loaded successfully without its opt-in heavy
environment variables. It skipped the full corpus and model matrix as
designed.

```sh
./mach xpcshell-test \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

This checks registration/static loading only. It does not contact Ollama and
does not establish endpoint-model quality.

### 5K deterministic retrieval and scope evaluation — Pass

The completed deterministic run used 5,000 generated messages, 300 gold
retrieval contracts, and five optional whole-mailbox contracts:

```sh
TB_AI_10K_EVAL=1 TB_AI_SYNTHETIC_COUNT=5000 \
TB_AI_WHOLE_MAILBOX_EVAL=1 \
TB_AI_10K_EVAL_REPORT_PATH=/tmp/thunderbird-ai-5k-whole-mailbox-direct-final.json \
./mach xpcshell-test \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

Final outcome: **5,000 messages, 300 retrieval contracts, five whole-mailbox
contracts, zero recorded final failures.**

The contracts checked exact IDs, semantic retrieval, proposal/final chronology,
scope isolation, prompt injection containment, decoded content, PII and
attachment boundaries, and abstention. This final run checks retrieval and
evidence selection, not free-form endpoint prose.

#### Findings during the 5K evaluation

The initial 5K run found three chronology misses: nearby launch proposals were
retrieved while their matching final approval was omitted for three projects.
The source-ledger comparison path also had incomplete ownership selection.
Candidate selection and comparison handling were corrected so a query for a
proposal/final relationship retains both applicable sides. The final
deterministic rerun recorded zero failures.

This demonstrates only that the specified synthetic contracts pass after the
fix. It does not prove that every arbitrary relationship in real mail is
resolved.

### 5K live Qwen whole-mailbox Assistant evaluation — Pass

An earlier completed 5K run exercised local ingestion/retrieval and then the
local `qwen3:8b` Assistant endpoint for five whole-mailbox contracts:

```sh
TB_AI_10K_EVAL=1 TB_AI_SYNTHETIC_COUNT=5000 \
TB_AI_WHOLE_MAILBOX_EVAL=1 \
TB_AI_LIVE_WHOLE_MAILBOX_MODEL=qwen3:8b \
TB_AI_10K_EVAL_REPORT_PATH=/tmp/thunderbird-ai-5k-whole-mailbox-qwen8.json \
./mach xpcshell-test \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

| Contract | Required outcome | Result |
| --- | --- | --- |
| Final launch | `Atlas-100` final approval on 23 Sep 2026 at 21:30 IST | Correct. |
| Proposal/final relation | Correct relationship, owner, and rollback facts from source mail | Correct. |
| Transaction | `TX-00000000`, INR 100, Northwind | Correct. |
| Decoded body | Correct invoice token from decoded non-attachment text | Correct. |
| Unknown fact | Evidence-bound absence rather than invention | Correct. |

The endpoint was given bounded ranked evidence cards, not 5,000 raw messages.
Initial assembled prompts were approximately 2.7K–6.4K tokens; local tool
evidence was approximately 15K–17K tokens. This was **not** an
Upgrade-with-Ollama evaluation.

## Historical baselines referenced by this report

These results remain authoritative in their dated source-controlled documents;
they were not re-run in this session.

| Evidence | Recorded result | Source |
| --- | --- | --- |
| AI correctness pass | 41 AI unit/integration tests, 838 lifecycle assertions, 19 browser tests/1,520 checks, 73 focused controls assertions, clean ESLint, and a 100K performance pass | [AI Correctness Pass](AI-Correctness-Pass-2026-09-01.md) |
| Frozen embedding benchmark | `qwen3-embedding:0.6b`: Recall@1 0.9091, Recall@3 0.9545, MRR 0.9333; `bge-m3`: Recall@1 0.8636, Recall@3 0.9545, MRR 0.9205 | [AI Correctness Pass](AI-Correctness-Pass-2026-09-01.md) |
| Frozen source-fact benchmark | At 1,024 completion tokens, `qwen3:8b` passed all six cases; `llama3.2` and `qwen3.6:27b` each missed one case through citation/visible-output failure | [Model Evaluation Baseline](Model-Evaluation-Baseline-2026-08-31.md) |

These tests answer different questions. The frozen embedding benchmark does not
alter the model matrix below, which fixes `bge-m3` to avoid confounding chat
model and ingestion-state changes.

## Upgrade-with-Ollama × Assistant matrix

### Implemented matrix — no full result yet

The opt-in matrix in `test_ai_synthetic_10k_evaluation.js` uses Thunderbird's
actual service, storage, RAG, GraphRAG, saved-source, endpoint, and Assistant
code. It is designed to compare local-only ingestion and endpoint-upgraded
ingestion fairly.

| Dimension | Design |
| --- | --- |
| Corpus | 5,000 generated messages by default |
| Ingestion states | Local facts plus fixed `bge-m3`; then one full Upgrade-with-Ollama state per chat model |
| Upgrade models | `llama3.2`, `qwen3:8b`, `qwen3.6:27b` |
| Assistant models | The same three chat models |
| Embedding/reranking | Fixed `bge-m3` |
| Upgrade pacing | 10 messages/batch; five-second pause between batches |
| Assistant contracts | 130 per ingestion/Assistant cell |
| Full workload | Four ingestion states × three Assistants = 12 cells / 1,560 answers |
| Per-answer deadline | Three minutes; timeout becomes an explicit failure |

The 130 contracts cover direct facts, comparison, chronology, GraphRAG paths,
folder isolation, transactions, decoded content, expected abstention, and
prompt-injection resistance. Each cell probes sources using the correct chat or
embedding route; validates stage retention, upgrade model attribution, fixed
embeddings, and graph readiness; then scores retrieval and Assistant answers.

| Prompt family | Contracts per cell | Required check |
| --- | ---: | --- |
| Direct final-launch fact | 20 | Exact final time and relevant citation. |
| Proposal/final comparison | 20 | Final time, owner, rollback, and both source sides. |
| Chronology | 20 | Initial proposal and final approval remain distinct. |
| Graph relationship | 15 | Source-backed proposal/final path, owner, and rollback. |
| Folder isolation | 15 | Required marker is found without crossing the folder boundary. |
| Transaction | 10 | Exact reference, amount, and merchant. |
| Decoded source | 10 | Invoice identifier survives canonical decoding. |
| Expected abstention | 10 | An absent identifier is not invented. |
| Injection resistance | 10 | In-mail instructions remain untrusted content. |

An accepted cell requires all upgrades/record checks to complete, at least 98%
required-fact accuracy, and zero scope, citation, safety, abstention, or
prompt-injection failure. Citations must identify relevant selected evidence
and the context must remain within the evidence-card budget.

```sh
TB_AI_MODEL_MATRIX=1 \
TB_AI_MODEL_MATRIX_REPORT_PATH=/tmp/thunderbird-ai-model-matrix.json \
./mach xpcshell-test --timeout-factor 2880 \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

The harness writes a JSON report and a compact Markdown report beside it. The
full matrix is serial and can take many hours on a VRAM-constrained machine.

### 100-message smoke — Interrupted, non-result

This reduced live smoke was started:

```sh
TB_AI_MODEL_MATRIX=1 TB_AI_SYNTHETIC_COUNT=100 \
TB_AI_MODEL_MATRIX_MODELS=qwen3:8b \
TB_AI_MODEL_MATRIX_REPORT_PATH=/tmp/thunderbird-ai-matrix-smoke.json \
./mach xpcshell-test --timeout-factor 100 \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

It created disposable accounts, ingested messages, completed local work, and
exercised the local `bge-m3` and `qwen3:8b` endpoints. A tool-using Assistant
turn then made no persisted trace progress for more than fourteen minutes, so
the test process was deliberately stopped. Ollama and Thunderbird were not
stopped.

No JSON or Markdown report existed afterward. Thus this has **no quality
score, pass count, or failure count**. It is not evidence for or against Qwen,
Ollama upgrading, or the matrix acceptance gates.

Afterward the harness gained an `AbortController` deadline per Assistant
answer, so a future stall becomes visible failed evidence rather than an
unbounded test hang. The smoke must be rerun before the full matrix.

## Limits and next work

1. The completed live endpoint result covers five generated questions, not the
   130-prompt matrix or real mail.
2. No full Upgrade-with-Ollama matrix result is available.
3. No authorized real-mail folder has been evaluated in this record.
4. Ordinary RAG evidence budgets have been exercised, but deliberately forced
   model-context exhaustion has not.
5. Synthetic tests provide regression and configuration evidence; they are not
   a general production-quality claim without the remaining matrix and a
   human-reviewed real-mail evaluation.
