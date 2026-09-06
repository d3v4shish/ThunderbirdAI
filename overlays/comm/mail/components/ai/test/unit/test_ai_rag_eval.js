/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const { AIChat } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIChat.sys.mjs"
);
const { AIStorage } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIStorage.sys.mjs"
);

function localEmbedding(text = "") {
  const vector = new Array(32).fill(0);
  for (const word of String(text).toLocaleLowerCase().split(/\W+/u)) {
    if (word.length < 3) {
      continue;
    }
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    }
    vector[hash % vector.length]++;
  }
  return vector;
}

add_task(async function test_versioned_labelled_rag_corpus_quality_gates() {
  Services.prefs.setBoolPref("mail.ai.enabled", true);
  Services.prefs.setStringPref("mail.ai.provider", "local");
  await AIStorage.clearGeneratedData();
  const fixture = await IOUtils.readJSON(
    do_get_file("data/rag-eval-v2.json").path
  );
  Assert.equal(fixture.schemaVersion, 2);
  Assert.ok(fixture.corpusId);
  for (const source of fixture.records) {
    const { id, ...record } = source;
    AIStorage.setMessage(id, {
      ...record,
      embedding: localEmbedding(
        [record.subject, record.author, record.summary, record.localText]
          .filter(Boolean)
          .join(" ")
      ),
    });
  }

  const recallTotals = new Map([
    [1, 0],
    [3, 0],
    [8, 0],
  ]);
  let reciprocalRankTotal = 0;
  let ndcgTotal = 0;
  let evaluated = 0;
  let abstentionQueries = 0;
  let abstentionFalsePositives = 0;
  let exactQueries = 0;
  let exactSubstitutions = 0;
  let scopeCheckedQueries = 0;
  let scopeViolations = 0;
  for (const labelled of fixture.queries) {
    const result = await AIChat.retrieveContext({
      prompt: labelled.query,
      accountKey: labelled.accountKey || "server1",
      scopeMode: labelled.scopeMode || "account",
      folderURI: labelled.folderURI || null,
      limit: 8,
      reranking: true,
    });
    const ids = result.records.map(
      record => `${record.folderURI}#${record.messageKey}`
    );
    const forbidden = [
      ...(fixture.accountForbidden?.[labelled.accountKey || "server1"] || []),
      ...(labelled.forbidden || []),
    ];
    if (forbidden.length) {
      scopeCheckedQueries++;
      if (ids.some(id => forbidden.includes(id))) {
        scopeViolations++;
      }
    }
    if (!labelled.relevant.length) {
      if (labelled.kind == "abstention") {
        abstentionQueries++;
        if (ids.length) {
          abstentionFalsePositives++;
        }
      }
      continue;
    }
    evaluated++;
    const relevant = new Set(labelled.relevant);
    const ranks = ids
      .map((id, rank) => (relevant.has(id) ? rank : -1))
      .filter(rank => rank >= 0);
    for (const cutoff of recallTotals.keys()) {
      const found = ids.slice(0, cutoff).filter(id => relevant.has(id)).length;
      recallTotals.set(
        cutoff,
        recallTotals.get(cutoff) + found / relevant.size
      );
    }
    reciprocalRankTotal += ranks.length ? 1 / (Math.min(...ranks) + 1) : 0;
    const dcg = ids
      .slice(0, 10)
      .reduce(
        (total, id, rank) =>
          total + (relevant.has(id) ? 1 / Math.log2(rank + 2) : 0),
        0
      );
    const idealCount = Math.min(relevant.size, 10);
    const idealDcg = Array.from({ length: idealCount }).reduce(
      (total, _value, rank) => total + 1 / Math.log2(rank + 2),
      0
    );
    ndcgTotal += idealDcg ? dcg / idealDcg : 0;
    if (labelled.kind == "exact") {
      exactQueries++;
      if (ids.some(id => !relevant.has(id))) {
        exactSubstitutions++;
      }
    }
  }
  const recallAt1 = recallTotals.get(1) / evaluated;
  const recallAt3 = recallTotals.get(3) / evaluated;
  const recallAt8 = recallTotals.get(8) / evaluated;
  const mrr = reciprocalRankTotal / evaluated;
  const ndcgAt10 = ndcgTotal / evaluated;
  const abstentionFalsePositiveRate = abstentionQueries
    ? abstentionFalsePositives / abstentionQueries
    : 0;
  const exactSubstitutionRate = exactQueries
    ? exactSubstitutions / exactQueries
    : 0;
  const scopeViolationRate = scopeCheckedQueries
    ? scopeViolations / scopeCheckedQueries
    : 0;
  info(
    `RAG eval ${fixture.corpusId}: recall@1=${recallAt1}, recall@3=${recallAt3}, recall@8=${recallAt8}, MRR=${mrr}, nDCG@10=${ndcgAt10}, abstentionFP=${abstentionFalsePositiveRate}, exactSubstitution=${exactSubstitutionRate}, scopeViolation=${scopeViolationRate}`
  );
  Assert.greaterOrEqual(recallAt1, fixture.gates.recallAt1);
  Assert.greaterOrEqual(recallAt3, fixture.gates.recallAt3);
  Assert.greaterOrEqual(recallAt8, fixture.gates.recallAt8);
  Assert.greaterOrEqual(mrr, fixture.gates.mrr);
  Assert.greaterOrEqual(ndcgAt10, fixture.gates.ndcgAt10);
  Assert.lessOrEqual(
    abstentionFalsePositiveRate,
    fixture.gates.abstentionFalsePositiveRate
  );
  Assert.lessOrEqual(
    exactSubstitutionRate,
    fixture.gates.exactSubstitutionRate
  );
  Assert.lessOrEqual(scopeViolationRate, fixture.gates.scopeViolationRate);

  Services.prefs.clearUserPref("mail.ai.enabled");
  Services.prefs.clearUserPref("mail.ai.provider");
  await AIStorage.clearGeneratedData();
});
