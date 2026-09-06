/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { AIClassification } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIClassification.sys.mjs"
);

add_task(function test_exact_rule_cannot_be_overridden_by_sparse_prediction() {
  const result = AIClassification.resolve({
    deterministic: {
      category: "finance",
      confidence: "high",
      ruleMatched: true,
    },
    sparse: { label: "jobs", confidence: "high" },
  });

  Assert.equal(result.category, "finance");
  Assert.equal(result.source, "deterministic-rule");
  Assert.equal(result.evidenceLevel, "routing-metadata");
});

add_task(function test_template_override_has_strict_precedence() {
  const result = AIClassification.resolve({
    deterministic: { category: "finance", ruleMatched: true },
    template: { category: "support", mode: "override" },
    sparse: { label: "jobs", confidence: "high" },
  });

  Assert.equal(result.category, "support");
  Assert.equal(result.source, "template");
});

add_task(function test_sparse_result_requires_confidence_threshold() {
  const lowConfidence = AIClassification.resolve({
    deterministic: { category: "personal", confidence: "low" },
    sparse: { label: "jobs", confidence: "low" },
  });
  Assert.equal(lowConfidence.category, "personal");
  Assert.equal(lowConfidence.source, "fallback");

  const accepted = AIClassification.resolve({
    deterministic: { category: "personal", confidence: "low" },
    sparse: { label: "jobs", confidence: "medium" },
  });
  Assert.equal(accepted.category, "jobs");
  Assert.equal(accepted.source, "sparse-naive-bayes");
  Assert.equal(accepted.evidenceLevel, "routing-metadata");
});

add_task(
  function test_transformer_is_only_used_for_novel_or_low_confidence_mail() {
    const result = AIClassification.resolve({
      deterministic: { category: "personal", confidence: "low" },
      sparse: { label: "jobs", confidence: "low" },
      transformer: { label: "support", confidence: "high" },
    });
    Assert.equal(result.category, "support");
    Assert.equal(result.source, "transformer");
  }
);

add_task(function test_numeric_transformer_confidence_is_normalized() {
  const result = AIClassification.resolve({
    deterministic: {
      category: "personal",
      confidence: "low",
      ruleMatched: false,
    },
    transformer: { label: "finance", confidence: 0.88 },
  });

  Assert.equal(result.category, "finance");
  Assert.equal(result.confidence, "high");
  Assert.equal(result.source, "transformer");
});
