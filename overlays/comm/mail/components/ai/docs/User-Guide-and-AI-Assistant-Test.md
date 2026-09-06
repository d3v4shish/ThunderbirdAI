# ThunderbirdAI user guide and complete Assistant test

This guide covers the controls exposed by ThunderbirdAI and a safe, repeatable
test of the entire local-first mail intelligence pipeline. It does **not**
modify mail: analysis produces local derived records, while draft, filter,
tag, move, task, and calendar workflows remain review-first.

## Quick daily setup

For a local Ollama installation with `qwen3:8b` and `bge-m3`:

| Role | Recommended source | Purpose |
| --- | --- | --- |
| Assistant default | `qwen3:8b` chat endpoint | Interactive cited answers |
| Background / Analysis / Summaries | `qwen3:8b` chat endpoint | Optional endpoint enrichment |
| Embeddings | `bge-m3` embedding endpoint | Semantic retrieval vectors |
| Reranking | A source whose role test passes | Improves retrieval ordering |

`bge-m3` is an embedding model. Its source must use Ollama's embedding route
(normally `http://127.0.0.1:11434/api/embed`), not
`/v1/chat/completions`; a chat probe against it correctly returns HTTP 400.

Keep endpoint concurrency at **1** on an 8 GB GPU. Start with **Balanced**
analysis performance and a 45–60 second endpoint timeout if the chat model is
occasionally slow.

## What the Assistant sidebar controls do

### Scope and conversation

- **Selected**, **Folder**, **Account**, and **All Mail** define the only mail
  the current question may retrieve and cite.
- **New conversation** clears chat history only. It leaves mail analysis,
  templates, embeddings, and security data intact.
- **Send** asks a mailbox-grounded question; **Cancel** stops the current
  answer.
- **Test Assistant** probes the selected chat source. **Stop analysis** stops
  pending analysis/reanalysis work without deleting completed records.

### Analysis status and rebuilds

The status pills report Assistant readiness, Direct RAG, reranking, scope
coverage, graph state, and attachment/security state. The progress card shows
the scope's analysis/RAG coverage and any active job.

**Reanalyze** acts only on the current Assistant scope. Its **Only rebuild**
menu means:

| Choice | Recreates |
| --- | --- |
| All AI analysis | Every local derived artifact |
| Summaries | Message summaries only |
| Embeddings and RAG index | Vectors and retrieval records only |
| Template mining | Drain3 families only |
| Regex extraction | Configured deterministic rules only |
| Security artifacts | Local security records only |

### Upgrade with Ollama

This is an optional, background endpoint-enrichment job. It does not change
the original message.

- **Batch** is the number of messages launched before the job pauses.
- **Pause** is the number of seconds to wait between batches.
- **Current scope** upgrades the entire current Assistant scope.
- **Visible messages first** snapshots currently visible message-list rows,
  processes them first, then continues with the rest of scope.
- **Visible messages only** snapshots and processes just those visible rows.
- **Start background upgrade** begins the job. The active-job card reports the
  current batch and next-batch countdown; **Cancel reanalysis** cancels both
  work and any waiting timer.

The default is 10 messages, a five-second pause, and visible-first ordering.

### More controls and Assistant tabs

- **Direct RAG** returns deterministic retrieval-only answers if chat synthesis
  is unavailable. Leave it off for normal Ollama use.
- **Re-ranking** improves source ordering. Leave it on after a compatible
  embedding/reranking source is tested.
- **GraphRAG** uses the bounded, source-linked local relationship graph. It is
  experimental; leave it off until ordinary RAG is satisfactory.
- **Enrich graph** stores separately labelled endpoint hints alongside local
  graph records. Keep it off during initial evaluation.
- **Clear** removes only selected derived artifacts, never original mail.
- **Timeline** displays extracted events and relationships. **Security** shows
  mail-security findings and can export a report. **Email** provides natural
  language search and saved searches. **Data** shows local AI data. **Triage**
  groups and filters analyzed mail. **Debug** is for provider failures and
  trace reports.

## Settings > AI

### Overview and Background analysis

**Overview** is a compact status page: it identifies the active Assistant,
background source, retrieval setup, and queue.

The background controls affect only derived local data:

- **Minimum / Balanced / Max Performance** select conservative, normal, or
  high-throughput worker/queue presets. **Custom** exposes manual values.
- **Workers** are concurrent local analysis tasks; **Queue** caps pending
  work; **Endpoint concurrency** caps concurrent Ollama requests; **Endpoint
  timeout** limits a probe or request.
- **Analyze new mail automatically** queues incoming mail. **Pause background
  analysis** stops backlog work. **Analyze all mail** queues all eligible mail.
- **Show rich AI summary on message-list hover** and **Show AI summary in the
  message reader** control where existing summaries appear.

### Assistant and Saved sources

- **Enable AI mail assistant** is the master switch.
- **Assistant mode** chooses endpoint, automatic endpoint selection, or an
  explicitly configured local CPU/GPU runtime. For the usual Ollama setup,
  use **Ollama / Endpoint**.
- **Allow endpoint fallback** allows a configured endpoint to serve requests
  when a chosen embedded local runtime is unavailable.
- **Assistant prompt** changes high-level response instructions. Leave the
  default during functional testing.

Each saved source has its type, name, endpoint URL, model, optional token,
background permission, and public-network permission. **Probe selected
source** uses a chat probe for chat roles and an embedding probe for embedding
roles.

Role buttons assign a source to **Assistant default**, **Background**,
**Analysis**, **Summaries**, **Embeddings**, or **Reranking**. A source marked
for background work must be local/private unless public-network AI is
explicitly allowed.

### Retrieval, summaries, classification, and specialists

- **Embedding mode** selects endpoint-first vectors with deterministic fallback
  or deterministic vectors only.
- **Summary mode** selects endpoint-first summaries with deterministic fallback
  or deterministic-only summaries.
- **Training Sets** holds labeled examples for the built-in local Sparse Naive
  Bayes classifier. Rebuild after changing examples or labels.
- **Private specialist adapters** enable manually installed GLiNER entity hints
  and ModernBERT intent hints only after a valid local manifest and loopback
  runner pass **Check configuration**. They are ranking/classification hints,
  not evidence and not required for normal RAG.

### Templates and extraction

**TemplateMiner** runs automatically while a message is analyzed. It learns
read-only Drain3 families from normalized structure; a family becomes
reviewable after three matching messages.

- **Mined template families** lists discovered repeated patterns.
- **Manual templates** use From, Subject, and/or Body conditions. They may
  select a template/extractive/normal-AI summary, bias or override a category,
  describe typed slots, and name extraction/sensitive fields.
- **Test template** checks a rule before it is saved. **Import/Export JSON**
  backs up definitions.
- Legacy **Regex extraction** is a targeted compatibility feature; it can be
  rebuilt independently from the Assistant sidebar.

### Policies, workflows, and MCP

- Per-account **Scope and policy** controls analysis, security enrichment,
  background inclusion, Archive/Junk/Trash exclusion, and current-folder
  priority.
- **AI workflows** enable review-first summaries, reply drafts, translation,
  calendar/task suggestions, organization suggestions, and knowledge helpers.
- **MCP server** exposes authenticated, loopback-only, read-only mail search to
  a local MCP client. Keep it disabled unless intentionally using such a
  client. Regenerating its token invalidates old client configurations.
- Folder/filter/tag suggestions are proposals for review, not automatic mail
  moves by default.

### Advanced runtime options

Use these only to diagnose an issue: runtime refresh, source comparisons,
redacted per-lane reports, live inspector, log level, trace capture, backfill
batch/scan/body budgets, and storage-path overrides. Normal operation should
use **Warn** logging and **Metadata only** trace capture.

## Complete Assistant test

Use a small, non-sensitive test folder first. Ideally choose 6–20 messages
with a few repeated sender templates and at least two messages that share a
project, person, invoice, date, or other explicit relationship.

### 1. Verify the model routes

1. Open **Settings > AI > Models & Processing > Saved endpoint sources**.
2. Select the Qwen chat source and press **Probe selected source**. Expect a
   successful chat result.
3. Select the BGE-M3 source and press its matching probe. Expect an embedding
   result, not a chat result.
4. Assign Qwen to Assistant, Background, Analysis, and Summaries; assign BGE
   only to Embeddings initially.
5. In **Assistant**, press **Test Assistant**. Expect **AI ready** and the
   Qwen source/model in the status card.

If BGE-M3 returns `does not support chat`, its URL or role is wrong: use the
embedding endpoint and remove any Assistant/Background/Summaries assignment.

### 2. Build deterministic local analysis

1. Open the test folder and select its test messages.
2. Open **AI Assistant**, choose **Selected**, then choose
   **Reanalyze > All AI analysis > Reanalyze**.
3. Wait for the progress card to complete. Expect coverage such as
   `Analysis 6/6 · RAG 6/6` and no pending analysis.
4. Hover a row and open a message. If those display options are enabled,
   expect a local summary/category card.
5. In **Triage**, verify the folder status lists completed counts and no
   unexplained failures.

### 3. Test ordinary RAG and citations

1. Keep scope on **Selected** and ask a precise, source-answerable question:
   `Which message mentions <unique sender, subject phrase, amount, or date>?`
2. Expect the answer to cite only selected messages and identify the exact
   source.
3. Ask a cross-message question containing two explicit facts:
   `Compare the date in message A with the deadline in message B. Cite both.`
4. Expect two relevant citations. Open each source and verify the facts.
5. Ask for a fact absent from the selected messages. Expect a constrained
   answer saying it was not found rather than an invented value.

### 4. Test semantic retrieval and reranking

1. Ask with a paraphrase rather than exact subject text, for example:
   `Which mail is about changing the payment deadline?`
2. Record the cited messages with **Re-ranking on**.
3. Temporarily turn **Re-ranking off**, repeat in a new conversation, then
   turn it back on. The cited sources should remain in scope; ordering may
   improve with reranking.
4. Leave **Direct RAG off** for this test so Qwen synthesizes the answer.

### 5. Test TemplateMiner and manual templates

1. Select at least six structurally similar messages from one sender.
2. Run **Reanalyze > Template mining**.
3. Open **Settings > AI > Mail Intelligence > Message templates** and refresh
   mined families.
4. Expect a family once at least three normalized messages match. If none
   appear, inspect the messages: materially different subjects/bodies are not
   a valid repeated template.
5. Load a family as a suggestion, inspect its conditions, use **Test
   template**, and save only if it matches the intended messages.

### 6. Test controlled Ollama upgrading

1. In the Assistant choose **Folder** scope.
2. Set **Batch = 2**, **Pause = 10**, and **Target = Visible messages first**.
3. Press **Start background upgrade**.
4. Expect the job card to show batch progress and, after two messages, a
   next-batch countdown.
5. Press **Cancel reanalysis** during the pause. Expect no further batch to
   launch.
6. Repeat with **Visible messages only** and confirm the reported target count
   equals the rows visible when Start was pressed.

### 7. Test GraphRAG conservatively

1. First leave GraphRAG off and ask a normal relationship question.
2. Turn **GraphRAG on** and repeat it in a new conversation.
3. The answer may find additional relevant sources, but every factual claim
   must still be supported by cited mail. Turn GraphRAG off if it reduces
   relevance or adds noise.

### 8. Test background controls and recovery

1. Enable automatic background analysis and open a small folder with
   unanalysed messages.
2. Confirm queue/completion changes in **Triage > Folder AI status** or
   **Settings > AI > Advanced > Runtime status**.
3. Pause background analysis; confirm pending work stops. Resume it and check
   that work continues.
4. Intentionally stop Ollama, run **Test Assistant**, then restart Ollama and
   use **Reset availability** / **Retest Source**. Expect recovery without
   clearing existing local analysis.

## Test pass criteria

The pipeline passes when all of the following hold:

1. Qwen chat and BGE embeddings both pass their role-specific probes.
2. Selected-scope questions never cite mail outside the selection.
3. Source-answerable facts have correct, openable citations.
4. Missing facts are not invented.
5. Analysis, embedding, template-only, and endpoint-upgrade jobs show correct
   progress and can be cancelled.
6. Template families appear only for genuinely repeated mail.
7. Background pause/resume and provider recovery work without deleting mail or
   local derived data.

For a failure, capture **Debug > Copy Report**, the source/model name, active
scope, requested artifact, and the exact error. Do not include raw private
mail in a bug report.
