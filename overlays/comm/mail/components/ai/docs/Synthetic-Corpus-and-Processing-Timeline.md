# Synthetic AI evaluation and message processing Timeline

This document describes two local developer tools: the deterministic synthetic
mail corpus and the per-message **Timeline** in the AI Assistant sidebar.
Neither sends mail nor enables a network model. The synthetic corpus contains
only fictional `*.synthetic.invalid` identities.

## What happens to one incoming message

The source message is always untrusted input. Thunderbird stores the original
message in the mail store; AI-generated state is separate, profile-local data.

| Phase | Processing | Input | Result and storage |
| --- | --- | --- | --- |
| Ingest | Selection, MIME decode, canonicalization, optional local English derivation, parser | Mail headers and decoded non-attachment text | Authoritative decoded source plus MIME/header diagnostics in the local AI record. Attachments are not made canonical body text. |
| Local intelligence | Deterministic analysis, classification, Drain-style template mining/matching, extraction, PII and security policy, compact local summary | Canonical source and trusted parse artifacts | Categories, template observations, extracted typed values, safety decisions, and summary in the profile-local AI record. |
| Retrieval | Policy-safe embedding, passage index, source-linked GraphRAG contribution | Post-PII-safe representation and deterministic facts | Disposable RAG passages/vectors plus source-linked graph nodes and edges. The graph is not a source of uncited facts. |
| Optional Ollama upgrade | Background endpoint summary and/or embedding update | Only the policy-safe local record | A separately labelled endpoint artifact; the decoded source and deterministic local facts remain intact. |
| Assistant turn | Scope lock, candidate retrieval, reranking, context budget, source cards, optional bounded local tools, cited answer | Selected, folder, account, or all-mail scope | A local trace, retrieved-message list, and citations. A model answer is not ingested back as a source fact. |

### RAG versus GraphRAG

RAG indexes selected passages from the local record for hybrid lexical/vector
retrieval. It contains canonical and policy-safe derived text, summary,
category, extraction and template signals as retrieval features; it is rebuilt
from the local record rather than an LLM answer.

GraphRAG creates source-linked nodes and edges for deterministic relations such
as sender, thread, entities, dates, actions, risks, template family and
explicit relationships. It narrows or connects retrieval candidates. It never
allows an endpoint-generated relation to become a deterministic mail fact.

### What **Upgrade with Ollama** changes

It is a background job, not normal ingestion. The job starts from a completed
local record and may add endpoint-derived summary/vector artifacts. The
Timeline records source/model, batch number and whether an endpoint artifact
was accepted. Failed or unavailable upgrades retain the existing local result.

## Viewing a message Timeline

1. Select a message and open **AI Assistant > Timeline**.
2. The phase rail shows **Ingest**, **Local intelligence**, **Retrieval**,
   **Ollama upgrade**, and **Assistant turn**. A phase is pending, queued,
   active, complete, degraded, or failed.
3. Read a compact card to see the stage input, output, decision and where it
   is stored. The Timeline queries RAG status only; opening it never rebuilds
   the mailbox index.
4. Select **Expanded details** only when diagnosing a local issue. It reveals
   bounded counts and configuration diagnostics, not raw mail bodies or
   endpoint payloads. The same disabled-by-default preference is available in
   **Settings > AI > Advanced**.

The Timeline is intentionally per-message. Folder/account queue and progress
remain in the Assistant scope status and Advanced runtime status; a message
shown as active or queued is marked in the relevant phase card.

## Deterministic 10K corpus

`test/unit/data/ai-synthetic-corpus.js` generates exactly 10,000 raw MIME
messages from a fixed seed. The family allocation is stable:

| Family | Count | Primary coverage |
| --- | ---: | --- |
| Transactional | 4,000 | Amounts, merchants, references, structured extraction |
| Project | 2,000 | Proposal/final chronology, ownership, deadlines, rollback |
| Distractor | 1,500 | Superseded near-matches and relevance precision |
| Newsletter | 800 | Repeated template families |
| Prompt injection | 500 | Untrusted-content resistance |
| PII | 400 | Endpoint-safe redaction |
| Encoded | 300 | Base64 and quoted-printable non-attachment decode |
| Multipart | 300 | Canonical body versus attachment boundary |
| Cross-account | 200 | Scope isolation |

It also produces 300 gold query contracts: exact fact, semantic transaction,
proposal-to-final relationship, chronology, scope isolation, abstention,
prompt-injection, and decoded-source cases. A contract checks the expected
source message IDs and scope, rather than comparing free-form prose exactly.

| Synthetic input | Required pipeline outcome | Expected retrieval outcome |
| --- | --- | --- |
| `FINAL: Atlas-205 Checkout launch approved` plus prior proposals | Canonical parse, local facts, RAG passages and source-linked graph rows all complete | A one-sided final-launch query returns the final approval record, not a nearby proposal revision; a comparison query keeps both sides. |
| Receipt with `TX-…` and a currency amount | Extraction and a policy-safe embedding complete | The exact reference resolves inside its account/folder scope. |
| Base64 or quoted-printable non-attachment body | Decoded canonical source contains the unique token | A decoded-source query finds the source record. |
| Multipart mail with an attachment | Body text is canonical; attachment text is not merged into mail evidence | The attachment marker does not become a cited body fact. |
| Prompt-injection mail | Mail stays labelled untrusted; local safety stages complete | Injection language never expands scope or becomes an instruction. |
| Cross-account near-match | RAG and graph records are source-linked to their account | Account/folder/selection queries never return the forbidden account. |

### Run it

The normal unit test validates a 200-message representative sample:

```sh
./mach xpcshell-test comm/mail/components/ai/test/unit/test_ai_synthetic_corpus.js
```

The full test is deliberately opt-in because it inserts and processes 10,000
messages through the real local parser, analysis, storage, RAG and GraphRAG
paths. It performs no endpoint calls.

```sh
TB_AI_10K_EVAL=1 ./mach xpcshell-test \
  comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

The test writes `ai-synthetic-10k-evaluation-report.json` in its temporary
test profile. To retain it after the harness cleans the profile, provide an
absolute output path:

```sh
TB_AI_10K_EVAL=1 \
TB_AI_10K_EVAL_REPORT_PATH=/tmp/thunderbird-ai-synthetic-10k-report.json \
./mach xpcshell-test comm/mail/components/ai/test/unit/test_ai_synthetic_10k_evaluation.js
```

The report contains the synthetic raw MIME corpus, gold facts, compact local
execution evidence, retrieval outcomes, timings and every failure; it may be
shared only as synthetic test output. A run passes only when all 10,000 records
have the required local stages, decoded/PII/graph checks pass, and every gold
retrieval and scope check passes.

### Optional live Ollama model comparison

The 10K test tests Thunderbird ingestion/retrieval deterministically. Model
quality is a separate, explicitly local experiment: run the frozen evidence
pack against candidate Ollama models with the existing evaluator. It does not
read a Thunderbird profile or promote a model automatically.

```sh
python3 comm/mail/components/ai/tools/evaluate_ollama_assistant_models.py \
  qwen3:8b qwen2.5:3b qwen2.5:27b \
  --corpus comm/mail/components/ai/tools/data/model-answer-eval-v1.json \
  --warmup --output /tmp/thunderbird-ai-model-ab.json
```

Use a model tag only if it is installed locally. Compare required-fact rate,
citation rate, p95 latency, model digest, VRAM use and human-reviewed answers.
The evaluator intentionally records a non-promotion decision: synthetic answer
quality alone cannot establish retrieval quality, privacy behavior or product
readiness.
