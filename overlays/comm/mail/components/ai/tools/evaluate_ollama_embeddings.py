#!/usr/bin/env python3

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Compare local Ollama embedders on Thunderbird's labelled mail corpus."""

import argparse
import json
import math
import pathlib
import time
import urllib.request

DEFAULT_CORPUS = pathlib.Path(__file__).parents[1] / "test" / "unit" / "data" / "rag-eval-v1.json"


def document_text(record):
    return "\n".join(
        value
        for value in (
            f"Subject: {record.get('subject', '')}",
            f"From: {record.get('author', '')}",
            f"Category: {record.get('category', '')}",
            record.get("summary", ""),
            record.get("localText", ""),
        )
        if value
    )


def query_text(model, query):
    if model.startswith("qwen3-embedding"):
        return (
            "Instruct: Retrieve the email that answers the user's mailbox question.\n"
            f"Query: {query}"
        )
    return query


def embed(endpoint, model, values):
    request = urllib.request.Request(
        f"{endpoint.rstrip('/')}/api/embed",
        data=json.dumps({"model": model, "input": values}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.load(response)
    return payload["embeddings"], (time.perf_counter() - started) * 1000


def cosine(left, right):
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0


def rerank(endpoint, model, query, documents):
    request = urllib.request.Request(
        f"{endpoint.rstrip('/')}/v1/rerank",
        data=json.dumps(
            {
                "model": model,
                "query": query,
                "documents": documents,
                "top_n": len(documents),
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.load(response)
    ranked = [int(result["index"]) for result in payload.get("results", [])]
    return ranked, (time.perf_counter() - started) * 1000


def evaluate_reranker(endpoint, model, corpus):
    records = corpus["records"]
    documents = [document_text(record) for record in records]
    queries = [query for query in corpus["queries"] if query["relevant"]]
    reciprocal_ranks = []
    recall_at_1 = 0
    recall_at_3 = 0
    latency_ms = 0
    outcomes = []
    for query in queries:
        indices, query_latency_ms = rerank(endpoint, model, query["query"], documents)
        latency_ms += query_latency_ms
        ranked_ids = [records[index]["id"] for index in indices]
        relevant = set(query["relevant"])
        rank = next(
            (index + 1 for index, record_id in enumerate(ranked_ids) if record_id in relevant),
            0,
        )
        reciprocal_ranks.append(1 / rank if rank else 0)
        recall_at_1 += int(bool(relevant.intersection(ranked_ids[:1])))
        recall_at_3 += int(bool(relevant.intersection(ranked_ids[:3])))
        outcomes.append(
            {
                "id": query["id"],
                "kind": query["kind"],
                "rank": rank,
                "top": ranked_ids[:3],
            }
        )
    count = len(queries)
    return {
        "model": model,
        "mode": "learned-cross-encoder",
        "queries": count,
        "latencyMs": round(latency_ms, 2),
        "meanQueryLatencyMs": round(latency_ms / count, 2),
        "recallAt1": round(recall_at_1 / count, 4),
        "recallAt3": round(recall_at_3 / count, 4),
        "mrr": round(sum(reciprocal_ranks) / count, 4),
        "outcomes": outcomes,
    }


def evaluate(endpoint, model, corpus):
    records = corpus["records"]
    queries = [query for query in corpus["queries"] if query["relevant"]]
    inputs = [document_text(record) for record in records]
    inputs.extend(query_text(model, query["query"]) for query in queries)
    embeddings, latency_ms = embed(endpoint, model, inputs)
    documents = embeddings[: len(records)]
    query_vectors = embeddings[len(records) :]
    reciprocal_ranks = []
    recall_at_1 = 0
    recall_at_3 = 0
    outcomes = []
    for query, query_vector in zip(queries, query_vectors):
        ranked = sorted(
            zip(records, documents),
            key=lambda item: cosine(query_vector, item[1]),
            reverse=True,
        )
        ranked_ids = [record["id"] for record, _ in ranked]
        relevant = set(query["relevant"])
        rank = next(
            (index + 1 for index, record_id in enumerate(ranked_ids) if record_id in relevant),
            0,
        )
        reciprocal_ranks.append(1 / rank if rank else 0)
        recall_at_1 += int(bool(relevant.intersection(ranked_ids[:1])))
        recall_at_3 += int(bool(relevant.intersection(ranked_ids[:3])))
        outcomes.append(
            {
                "id": query["id"],
                "kind": query["kind"],
                "rank": rank,
                "top": ranked_ids[:3],
            }
        )
    count = len(queries)
    return {
        "model": model,
        "dimensions": len(embeddings[0]),
        "batchedInputs": len(inputs),
        "latencyMs": round(latency_ms, 2),
        "recallAt1": round(recall_at_1 / count, 4),
        "recallAt3": round(recall_at_3 / count, 4),
        "mrr": round(sum(reciprocal_ranks) / count, 4),
        "queries": outcomes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="+", help="Ollama model names to compare")
    parser.add_argument("--endpoint", default="http://127.0.0.1:11434")
    parser.add_argument("--rerank-endpoint", default="")
    parser.add_argument("--rerank-model", default="qwen3-reranker-0.6b")
    parser.add_argument("--corpus", type=pathlib.Path, default=DEFAULT_CORPUS)
    args = parser.parse_args()
    with args.corpus.open(encoding="utf-8") as corpus_file:
        corpus = json.load(corpus_file)
    output = {
        "corpusId": corpus["corpusId"],
        "results": [evaluate(args.endpoint, model, corpus) for model in args.models],
    }
    if args.rerank_endpoint:
        output["reranker"] = evaluate_reranker(args.rerank_endpoint, args.rerank_model, corpus)
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
