# Local Assistant Model Evaluation Baseline — 2026-08-31

The frozen source-fact corpus was evaluated locally with temperature zero,
required model digests, and a bounded completion budget. This is a regression
baseline, **not** a promotion of any model: it contains six synthetic,
redacted cases and does not yet measure held-out mailbox tasks, claim spans,
human review.

| Model | Digest | Parameters / quantization | Pass / citation rate | p95 latency |
| --- | --- | --- | --- | --- |
| `llama3.2:latest` | `a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72` | 3.2B / Q4_K_M | 1.00 / 1.00 | 899.63 ms |
| `qwen3:8b` | `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` | 8.2B / Q4_K_M | 1.00 / 1.00 | 4,363.85 ms |
| `qwen3.6:27b` | `a50eda8ed977ab48a12431878896b27ffd5cef552c17af3317d9623b939a7f1e` | 27.8B / Q4_K_M | 1.00 / 1.00 | 43,394.51 ms |

The first three-case run above is retained as a historical baseline. The
expanded corpus is `thunderbird-assistant-source-fact-ab-v2`, SHA-256
`67744072302f400f844f0e7d3f4c6c1f298bd89db599a899ed5f1b6e00ea6a8e`.
It adds a superseded-final decision, an INR 805/1,805 near-miss, and an
open-world unknown ownership request.

| Model | Completion cap | Pass / citation rate | p95 latency | Result |
| --- | --- | --- | --- | --- |
| `llama3.2:latest` | 256 | 0.8333 / 0.8333 | 828.73 ms | Correct numeric reference but omitted its requested source URI. |
| `qwen3:8b` | 256 | 0.6667 / 0.6667 | 1,903.67 ms | Hidden reasoning consumed the short output budget and truncated visible answers. |
| `qwen3:8b` | 1,024 | 1.0000 / 1.0000 | 4,349.84 ms | Clears this synthetic source-fact gate; observed VRAM was 7.70 GB. |
| `qwen3.6:27b` | 1,024 | 0.8333 / 0.8333 | 21,846.33 ms | Hidden reasoning exhausted the complex comparison's output budget. |

### Reproducibility rerun

A second local run on 2026-08-31 used the verified corpus hash above, the
same three resolved model digests, temperature zero, warmup, and a 1,024-token
completion cap. It produced the following results:

| Model | Pass / citation rate | p95 latency | Result |
| --- | --- | --- | --- |
| `llama3.2:latest` | 0.8333 / 0.8333 | 983.49 ms | Omitted the required source URI for the exact numeric near-miss. |
| `qwen3:8b` | 1.0000 / 1.0000 | 4,818.37 ms | Clears this synthetic source-fact gate. |
| `qwen3.6:27b` | 0.8333 / 0.8333 | 21,821.99 ms | Produced no visible answer for the complex source-fact comparison after consuming the output budget. |

The JSON report for this run is deliberately written outside the source tree
(`/tmp/thunderbird-ai-model-ab-20260831.json`). It is reproducible from the
command below and contains the full per-case output and runtime metadata.

The 8B Qwen configuration is the only candidate that clears the expanded
synthetic gate. It remains unpromoted until the Thunderbird end-to-end,
retrieval, citation-mapping, recovery, and human-review gates are also passed.
The 3B model remains the lower-latency fallback candidate; it needs citation
format enforcement or a passing end-to-end guard before it can be promoted.

Reproduce a candidate run without reading a Thunderbird profile:

```bash
python3 comm/mail/components/ai/tools/evaluate_ollama_assistant_models.py \
  llama3.2:latest qwen3:8b qwen3.6:27b \
  --corpus comm/mail/components/ai/tools/data/model-answer-eval-v1.json \
  --warmup --timeout 120 --max-completion-tokens 1024 \
  --require-model-digest \
  --output /tmp/thunderbird-ai-model-ab.json
```

The generated report records the frozen corpus SHA-256, Ollama/runtime
metadata, requested tags, resolved digests, model details, output cap,
per-case answers, and latency. A capped run that returns an empty or truncated
answer is a failed gate, not an invitation to accept hidden reasoning as an
answer. Treat a missing digest, a failed gate, or a report from a changed
corpus as non-promotable.
