#!/usr/bin/env python3

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Run a reproducible, local-only A/B comparison of Ollama answer models.

The input corpus is a redacted JSON document:

{
  "corpusId": "mail-assistant-ab-v1",
  "cases": [{
    "id": "proposal-final",
    "messages": [{"role": "system", "content": "..."},
                 {"role": "user", "content": "..."}],
    "requiredSubstrings": ["15 September", "18 September"],
    "forbiddenSubstrings": ["probably"],
    "requiredCitationURIs": ["mailbox://eval/Office#26"],
    "requireCitation": true
  }]
}

It intentionally does not read Thunderbird profiles, send mail, or persist
mail content. Use the exact same frozen evidence-pack messages for every
model. Required/forbidden checks are reproducible model-comparison signals;
the Thunderbird answer path does not add a separate post-answer verifier.

Every report contains an explicit non-promotion decision. This narrow runner
cannot establish held-out retrieval quality, privacy behavior, or human-review
quality, even when every synthetic case passes.
"""

import argparse
import hashlib
import json
import math
import pathlib
import platform
import statistics
import tempfile
import time
import urllib.parse
import urllib.request


def compact(value, limit=12000):
    return str(value or "").strip()[:limit]


def request_completion(endpoint, model, messages, timeout, max_completion_tokens):
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "temperature": 0,
        # A benchmark must not let a verbose or reasoning-enabled model hold a
        # comparison slot indefinitely. The evidence packs ask for compact,
        # cited answers, so this is an evaluation bound rather than a quality
        # shortcut; a truncated answer simply fails its required checks.
        "max_tokens": max_completion_tokens,
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        result = json.load(response)
    latency_ms = (time.perf_counter() - started) * 1000
    answer = compact(result.get("choices", [{}])[0].get("message", {}).get("content"))
    usage = result.get("usage") or {}
    return answer, latency_ms, usage


def ollama_model_metadata(endpoint, model, timeout):
    """Return immutable-ish Ollama metadata when the endpoint exposes it.

    The OpenAI-compatible endpoint intentionally does not expose a model digest.
    Ollama's adjacent ``/api/show`` endpoint does.  This is best-effort so the
    evaluator remains useful with another OpenAI-compatible local server, but a
    result with an empty ``modelMetadata`` must not be treated as a promoted A/B
    run.
    """
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return {}, "Endpoint is not an HTTP(S) URL."
    url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/api/show", "", "", ""))
    request = urllib.request.Request(
        url,
        data=json.dumps({"name": model}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            metadata = json.load(response)
    except Exception as error:
        return {}, compact(error, 1000)

    details = metadata.get("details") if isinstance(metadata, dict) else {}
    details = details if isinstance(details, dict) else {}
    model_info = metadata.get("model_info") if isinstance(metadata, dict) else {}
    model_info = model_info if isinstance(model_info, dict) else {}
    result = {
        "requestedTag": model,
        "digest": compact(metadata.get("digest"), 200),
        "modifiedAt": compact(metadata.get("modified_at"), 200),
        "format": compact(details.get("format"), 100),
        "family": compact(details.get("family"), 200),
        "parameterSize": compact(details.get("parameter_size"), 100),
        "quantizationLevel": compact(details.get("quantization_level"), 100),
        "architecture": compact(model_info.get("general.architecture"), 200),
    }
    # ``/api/show`` is authoritative for model details but some Ollama builds
    # omit the digest there.  Fill only that missing value from the read-only
    # tag inventory; a mismatch is retained as diagnostic metadata.
    if not result["digest"]:
        tags_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/api/tags", "", "", ""))
        try:
            with urllib.request.urlopen(tags_url, timeout=timeout) as response:
                tags = json.load(response)
            for candidate in tags.get("models", []):
                if candidate.get("name") == model:
                    result["digest"] = compact(candidate.get("digest"), 200)
                    break
        except Exception:
            # Show metadata is still useful, and endpoint compatibility is more
            # important than requiring this optional Ollama convenience route.
            pass
    return result, ""


def ollama_runtime_metadata(endpoint, timeout):
    """Capture local runtime facts without treating them as a quality signal.

    An A/B report needs to say what answered the cases, but it must not invoke
    a shell command or inspect a Thunderbird profile. Ollama exposes enough
    read-only metadata to make a report comparable across runs.  Failures are
    retained as diagnostics because the evaluator also supports other
    OpenAI-compatible local endpoints.
    """
    parsed = urllib.parse.urlparse(endpoint)
    result = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "ollamaVersion": "",
        "loadedModels": [],
    }
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return result, "Endpoint is not an HTTP(S) URL."
    errors = []
    for path, key in (("/api/version", "version"), ("/api/ps", "models")):
        url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                payload = json.load(response)
            if path == "/api/version":
                result["ollamaVersion"] = compact(payload.get(key), 100)
            else:
                result["loadedModels"] = [
                    {
                        "name": compact(model.get("name"), 200),
                        "digest": compact(model.get("digest"), 200),
                        "sizeVram": model.get("size_vram"),
                    }
                    for model in payload.get(key, [])
                    if isinstance(model, dict)
                ]
        except Exception as error:
            errors.append(compact(error, 500))
    return result, "; ".join(errors)


def score_case(case, answer):
    normalized = answer.casefold()
    required = [compact(value, 400) for value in case.get("requiredSubstrings", [])]
    forbidden = [compact(value, 400) for value in case.get("forbiddenSubstrings", [])]
    required_citations = [compact(value, 800) for value in case.get("requiredCitationURIs", [])]
    missing = [value for value in required if value.casefold() not in normalized]
    present_forbidden = [value for value in forbidden if value.casefold() in normalized]
    # Citation renderers may use inline URI citations or numbered references.
    # URI presence is the interoperability contract; bracket style is not.
    citation_present = "mailbox://" in normalized or "folder://" in normalized
    missing_citations = [
        value for value in required_citations if value.casefold() not in normalized
    ]
    return {
        "requiredPassed": not missing,
        "missingRequired": missing,
        "forbiddenPassed": not present_forbidden,
        "presentForbidden": present_forbidden,
        "citationPresent": citation_present,
        "citationPassed": not case.get("requireCitation", False) or citation_present,
        "requiredCitationURIsPassed": not missing_citations,
        "missingCitationURIs": missing_citations,
        "passed": not missing
        and not present_forbidden
        and (not case.get("requireCitation", False) or citation_present)
        and not missing_citations,
    }


def promotion_assessment(corpus):
    """State why this isolated answer-model comparison cannot promote a model."""
    tier = compact(corpus.get("evaluationTier"), 80).casefold() or "synthetic"
    reasons = [
        "This runner evaluates answer completions only, not live or held-out Thunderbird retrieval.",
        "This run does not include a separate post-answer verifier.",
        "Privacy review, recovery gates, and human review are not part of this run.",
    ]
    if tier == "synthetic":
        reasons.insert(
            0,
            "Synthetic frozen evidence packs cannot by themselves promote an answer model.",
        )
    return {
        "eligible": False,
        "evaluationTier": tier,
        "reasons": reasons,
    }


def evaluate_model(endpoint, model, cases, timeout, warmup, max_completion_tokens):
    model_metadata, model_metadata_error = ollama_model_metadata(endpoint, model, timeout)
    warmup_error = ""
    if warmup and cases:
        try:
            request_completion(
                endpoint,
                model,
                cases[0]["messages"],
                timeout,
                max_completion_tokens,
            )
        except Exception as error:
            # Keep evaluating the model. A cold start may exceed a short
            # warmup timeout while later requests succeed, and an unavailable
            # model should be reported alongside the other variants.
            warmup_error = compact(error, 1000)
    outcomes = []
    latencies = []
    output_tokens = []
    for case in cases:
        try:
            answer, latency_ms, usage = request_completion(
                endpoint, model, case["messages"], timeout, max_completion_tokens
            )
        except Exception as error:
            outcomes.append(
                {
                    "id": case["id"],
                    "error": compact(error, 1000),
                    "passed": False,
                    "requiredPassed": False,
                    "forbiddenPassed": False,
                    "citationPresent": False,
                    "citationPassed": False,
                    "requiredCitationURIsPassed": False,
                    "missingRequired": list(case.get("requiredSubstrings", [])),
                    "presentForbidden": [],
                    "missingCitationURIs": list(case.get("requiredCitationURIs", [])),
                }
            )
            continue
        outcome = {
            "id": case["id"],
            "latencyMs": round(latency_ms, 2),
            "usage": usage,
            "answer": answer,
            **score_case(case, answer),
        }
        outcomes.append(outcome)
        latencies.append(latency_ms)
        if isinstance(usage.get("completion_tokens"), int):
            output_tokens.append(usage["completion_tokens"])
    total = len(outcomes)
    return {
        "model": model,
        "modelMetadata": model_metadata,
        "modelMetadataError": model_metadata_error,
        "warmupError": warmup_error,
        "cases": total,
        "passRate": round(sum(item["passed"] for item in outcomes) / total, 4) if total else 0,
        "requiredFactRate": round(sum(item["requiredPassed"] for item in outcomes) / total, 4)
        if total
        else 0,
        "citationRate": round(sum(item["citationPassed"] for item in outcomes) / total, 4)
        if total
        else 0,
        "requiredCitationURIrate": round(
            sum(item.get("requiredCitationURIsPassed", False) for item in outcomes) / total,
            4,
        )
        if total
        else 0,
        "meanLatencyMs": round(statistics.mean(latencies), 2) if latencies else 0,
        "p95LatencyMs": round(sorted(latencies)[max(0, math.ceil(len(latencies) * 0.95) - 1)], 2)
        if latencies
        else 0,
        "meanCompletionTokens": round(statistics.mean(output_tokens), 2)
        if output_tokens
        else None,
        "maxCompletionTokens": max_completion_tokens,
        "outcomes": outcomes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="+", help="Ollama model tags to compare")
    parser.add_argument("--corpus", required=True, type=pathlib.Path)
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:11434/v1/chat/completions",
    )
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument(
        "--max-completion-tokens",
        type=int,
        default=512,
        help="Bound generated tokens per case; values below 16 are rejected.",
    )
    parser.add_argument("--warmup", action="store_true")
    parser.add_argument(
        "--minimum-pass-rate",
        type=float,
        default=0,
        help="Return a non-zero status if any model has a lower pass rate.",
    )
    parser.add_argument(
        "--minimum-citation-rate",
        type=float,
        default=0,
        help="Return a non-zero status if any model has a lower citation rate.",
    )
    parser.add_argument(
        "--max-p95-ms",
        type=float,
        default=0,
        help="Return a non-zero status if any non-empty run exceeds this p95 latency.",
    )
    parser.add_argument(
        "--require-model-digest",
        action="store_true",
        help="Return a non-zero status unless every evaluated model has an Ollama digest.",
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        help="Optional JSON output path. It is atomically replaced after a complete run.",
    )
    args = parser.parse_args()
    if args.max_completion_tokens < 16:
        raise SystemExit("--max-completion-tokens must be at least 16")

    corpus_bytes = args.corpus.read_bytes()
    corpus = json.loads(corpus_bytes.decode("utf-8"))
    cases = corpus.get("cases")
    if not isinstance(cases, list) or not cases:
        raise SystemExit("corpus.cases must be a non-empty array")
    if not isinstance(corpus.get("schemaVersion"), int):
        raise SystemExit("corpus.schemaVersion must be an integer")
    for case in cases:
        if not compact(case.get("id")) or not isinstance(case.get("messages"), list):
            raise SystemExit("each case needs an id and OpenAI-compatible messages")
        if not case["messages"]:
            raise SystemExit("each case must contain at least one message")

    runtime_metadata, runtime_metadata_error = ollama_runtime_metadata(args.endpoint, args.timeout)
    result = {
        "corpusId": compact(corpus.get("corpusId"), 200),
        "corpusSha256": hashlib.sha256(corpus_bytes).hexdigest(),
        "promotion": promotion_assessment(corpus),
        "endpoint": args.endpoint,
        "temperature": 0,
        "maxCompletionTokens": args.max_completion_tokens,
        "runtimeMetadata": runtime_metadata,
        "runtimeMetadataError": runtime_metadata_error,
        "results": [
            evaluate_model(
                args.endpoint,
                model,
                cases,
                args.timeout,
                args.warmup,
                args.max_completion_tokens,
            )
            for model in args.models
        ],
    }
    serialized = json.dumps(result, indent=2)
    print(serialized)
    if args.output:
        output_parent = args.output.parent
        if not output_parent.is_dir():
            raise SystemExit(f"output directory does not exist: {output_parent}")
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output_parent, delete=False
        ) as temporary:
            temporary.write(serialized)
            temporary.write("\n")
            temporary_path = pathlib.Path(temporary.name)
        temporary_path.replace(args.output)
    failures = []
    for model_result in result["results"]:
        if model_result["passRate"] < args.minimum_pass_rate:
            failures.append(f"{model_result['model']}: pass rate")
        if model_result["citationRate"] < args.minimum_citation_rate:
            failures.append(f"{model_result['model']}: citation rate")
        if args.max_p95_ms and model_result["p95LatencyMs"] > args.max_p95_ms:
            failures.append(f"{model_result['model']}: p95 latency")
        if args.require_model_digest and not model_result["modelMetadata"].get("digest"):
            failures.append(f"{model_result['model']}: missing model digest")
    if failures:
        raise SystemExit("A/B quality gate failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()
