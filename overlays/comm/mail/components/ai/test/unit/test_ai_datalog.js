/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { AIDatalog } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIDatalog.sys.mjs"
);

add_task(function test_extracts_only_explicit_source_span_facts() {
  const record = {
    folderURI: "folder://office",
    messageKey: 44,
    originalBody: [
      "Meera Iyer owns the Atlas Checkout launch.",
      "Arjun must post payments sign-off by 16 Sep 15:00 IST.",
      "Roll back if checkout error rate exceeds 2 percent for ten consecutive minutes.",
    ].join("\n"),
  };
  const facts = AIDatalog.extractFacts(record);
  Assert.deepEqual(
    facts.map(item => item.predicate),
    ["owns", "deadline", "rollback-condition"]
  );
  Assert.ok(facts.every(item => item.evidenceLevel == "source-span"));
  Assert.ok(facts[0].text.includes("Meera Iyer owns"));

  const result = AIDatalog.query([{ ...record, deterministicFacts: facts }], {
    predicate: "owns",
    subject: "Meera Iyer",
    object: "Atlas Checkout",
  });
  Assert.equal(result.length, 1);
  Assert.equal(result[0].messageId, "folder://office#44");
});

add_task(function test_open_world_does_not_infer_missing_facts() {
  const facts = AIDatalog.extractFacts({
    originalBody: "Atlas Checkout will be discussed tomorrow.",
  });
  Assert.equal(facts.length, 0);
  Assert.equal(
    AIDatalog.query([{ folderURI: "folder://x", messageKey: 1 }], {
      predicate: "owns",
    }).length,
    0
  );
});

add_task(function test_extracts_explicit_passive_ownership() {
  const facts = AIDatalog.extractFacts({
    originalBody: "The Atlas Checkout launch is owned by Meera Iyer.",
  });
  Assert.deepEqual(
    facts.map(item => [item.predicate, item.subject, item.object]),
    [["owns", "Meera Iyer", "The Atlas Checkout launch"]]
  );
});

add_task(function test_extracts_each_explicit_fact_from_one_prose_paragraph() {
  const record = {
    originalBody:
      "Meera Iyer owns the Atlas Checkout launch; Arjun must post payments sign-off by 16 Sep 15:00 IST; Leena: send customer communications by 17 Sep noon IST; Roll back if checkout errors exceed 2 percent for ten consecutive minutes.",
  };
  const facts = AIDatalog.extractFacts(record);
  Assert.deepEqual(
    facts.map(item => item.predicate),
    ["owns", "deadline", "deadline", "rollback-condition"],
    "each semicolon-delimited source clause has its own fact"
  );
  Assert.deepEqual(
    facts
      .filter(item => item.predicate == "deadline")
      .map(item => item.subject),
    ["Arjun", "Leena"],
    "individual deadline owners remain distinct"
  );
  Assert.ok(
    facts.every(
      item =>
        record.originalBody.slice(item.startOffset, item.endOffset) == item.text
    ),
    "stored offsets point to exact original source spans"
  );
});

add_task(function test_ignores_quoted_and_signature_segments() {
  const originalBody = [
    "Meera Iyer owns the current launch.",
    "-- ",
    "Meera",
    "On Thursday wrote:",
    "> Arjun owns the old launch.",
  ].join("\n");
  const facts = AIDatalog.extractFacts({
    originalBody,
    textSegments: [
      {
        kind: "body",
        includedForAI: true,
        sourceText: "Meera Iyer owns the current launch.",
        sourceStartOffset: 0,
      },
      {
        kind: "signature",
        includedForAI: false,
        sourceText: "-- \nMeera",
        sourceStartOffset: 36,
      },
      {
        kind: "quoted",
        includedForAI: false,
        sourceText: "On Thursday wrote:\n> Arjun owns the old launch.",
        sourceStartOffset: 47,
      },
    ],
  });
  Assert.deepEqual(
    facts.map(item => [item.subject, item.object]),
    [["Meera Iyer", "the current launch"]]
  );
});
