/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* global AIEvaluationCorpus */

load(do_get_file("data/ai-synthetic-corpus.js").path);

add_task(
  async function test_generated_synthetic_corpus_is_reproducible_and_safe() {
    const first = AIEvaluationCorpus.create({ count: 200, seed: 42 });
    const second = AIEvaluationCorpus.create({ count: 200, seed: 42 });
    const differentSeed = AIEvaluationCorpus.create({ count: 200, seed: 43 });

    Assert.equal(first.records.length, 200);
    Assert.equal(first.records.length, second.records.length);
    Assert.equal(first.queries.length, 300);
    Assert.deepEqual(
      first.records.map(record => record.source),
      second.records.map(record => record.source),
      "a fixed seed should recreate identical raw MIME messages"
    );
    Assert.notEqual(
      first.records[0].source,
      differentSeed.records[0].source,
      "a different seed should change synthetic presentation variants"
    );
    Assert.ok(
      first.records.every(record =>
        record.source.includes("synthetic.invalid")
      ),
      "the corpus must never contain a real email address"
    );
    Assert.ok(
      first.records.some(record => record.encoding == "base64"),
      "the representative corpus should contain base64 source text"
    );
    Assert.ok(
      first.records.some(record => record.encoding == "quoted-printable"),
      "the representative corpus should contain quoted-printable source text"
    );
    Assert.ok(
      first.records.some(record => record.injection),
      "the representative corpus should contain untrusted prompt-injection mail"
    );
    Assert.ok(
      first.records.some(record => record.piiMarker),
      "the representative corpus should contain PII redaction cases"
    );
    Assert.deepEqual(
      first.requiredStages,
      AIEvaluationCorpus.REQUIRED_STAGES,
      "each generated message should use the same pipeline-stage contract"
    );
  }
);
