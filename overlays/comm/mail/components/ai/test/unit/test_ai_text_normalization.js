/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const {
  deriveMailText,
  protectTranslatableTokens,
  restoreProtectedTokens,
  segmentMailText,
} = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AITextNormalization.sys.mjs"
);

add_task(
  function test_segments_quotes_and_signatures_without_mutating_source() {
    const result = segmentMailText(
      "Hello team,\nThe launch is Friday.\n-- \nMeera\nOn Thursday wrote:\n> Old mail"
    );

    Assert.equal(result.originalText.includes("Old mail"), true);
    Assert.equal(result.analysisText, "Hello team,\nThe launch is Friday.");
    Assert.equal(result.segments.length, 3);
    Assert.equal(result.segments[1].kind, "signature");
    Assert.equal(result.segments[2].kind, "quoted");
  }
);

add_task(function test_preserves_exact_decoded_source_and_source_ranges() {
  const source =
    "  Hello\tteam,\r\nThe   launch is Friday.\r\n-- \r\nMeera\r\n> Old mail  ";
  const result = segmentMailText(source);

  Assert.equal(result.originalText, source, "decoded source is immutable");
  Assert.equal(
    result.analysisText,
    "Hello team,\nThe launch is Friday.",
    "analysis receives a disposable normalized view"
  );
  for (const segment of result.segments) {
    Assert.equal(
      source.slice(segment.sourceStartOffset, segment.sourceEndOffset),
      segment.sourceText,
      "segment coordinates address the exact decoded source"
    );
  }
});

add_task(function test_protected_tokens_survive_translation_variation() {
  const protectedText = protectTranslatableTokens(
    "Approve $42.50 at https://example.test/a for INV-2026-42"
  );
  const translated = protectedText.text.replaceAll("_", " _ ");
  const restored = restoreProtectedTokens(translated, protectedText.tokens);

  Assert.ok(restored.includes("$42.50"));
  Assert.ok(restored.includes("https://example.test/a"));
  Assert.ok(restored.includes("INV-2026-42"));
});

add_task(function test_protected_token_markers_do_not_collide_with_mail_text() {
  const source = "Keep [[TB_AI_0_PROTECTED_0]] and translate $42.50";
  const protectedText = protectTranslatableTokens(source);
  Assert.ok(
    protectedText.tokens[0].marker.startsWith("[[TB_AI_1_PROTECTED_"),
    "a namespace already present in mail text is never reused"
  );
  Assert.equal(
    restoreProtectedTokens(protectedText.text, protectedText.tokens),
    source
  );
});

add_task(async function test_derives_english_without_making_it_evidence() {
  const result = await deriveMailText(
    { subject: "Lanzamiento", body: "Aprobar INV-2026-42 el viernes." },
    {
      translationEnabled: true,
      detectLanguage: async () => "es",
      translateText: async text =>
        text
          .replace("Lanzamiento", "Launch")
          .replace("Aprobar", "Approve")
          .replace("el viernes", "on Friday"),
    }
  );

  Assert.equal(result.originalBody, "Aprobar INV-2026-42 el viernes.");
  Assert.equal(result.englishSubject, "Launch");
  Assert.equal(result.englishBody, "Approve INV-2026-42 on Friday.");
  Assert.equal(result.translation.status, "translated");
  Assert.ok(result.translation.sourceIsAuthoritative);
  Assert.equal(result.translation.attachmentTextIncluded, false);
});

add_task(async function test_reports_disabled_translation_explicitly() {
  const result = await deriveMailText(
    { subject: "Bonjour", body: "Bonjour monde" },
    { translationEnabled: false }
  );

  Assert.equal(result.translation.status, "disabled");
  Assert.equal(result.englishBody, "");
  Assert.ok(result.analysisText.includes("Bonjour monde"));
});

add_task(
  async function test_empty_mail_component_does_not_hide_english_status() {
    const bodyOnly = await deriveMailText(
      { subject: "", body: "The release is ready." },
      {
        translationEnabled: true,
        detectLanguage: async text => (text ? "en" : "und"),
      }
    );
    Assert.equal(bodyOnly.translation.status, "english");
    Assert.equal(bodyOnly.englishBody, "The release is ready.");

    const subjectOnly = await deriveMailText(
      { subject: "Release ready", body: "" },
      {
        translationEnabled: true,
        detectLanguage: async text => (text ? "en" : "und"),
      }
    );
    Assert.equal(subjectOnly.translation.status, "english");
    Assert.equal(subjectOnly.englishSubject, "Release ready");
  }
);

add_task(async function test_reports_partial_translation_explicitly() {
  const body = `Inicio ${"x".repeat(13000)}`;
  const result = await deriveMailText(
    { subject: "Lanzamiento", body },
    {
      translationEnabled: true,
      detectLanguage: async () => "es",
      translateText: async text => text,
    }
  );

  Assert.equal(result.translation.status, "translated-partial");
  Assert.equal(result.translation.body.truncated, true);
  Assert.equal(result.translation.body.sourceLength, body.length);
  Assert.equal(result.translation.body.processedLength, 12000);
  Assert.equal(result.englishBody.length, 12000);
});
