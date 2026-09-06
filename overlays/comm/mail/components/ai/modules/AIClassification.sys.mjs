/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Classification is useful for routing and retrieval, but is never evidence
// for a mailbox claim. Keep the resolution policy small and deterministic so
// it is auditable, and so a learned model cannot silently replace an exact
// rule or a user-approved template.

const CONFIDENCE_RANK = new Map([
  ["", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
]);

// One closed routing vocabulary is shared by the private ModernBERT adapter
// and the persistence boundary. Keeping it here prevents a newly accepted
// runtime label from being silently discarded (or an obsolete label from
// being resurrected) after Thunderbird restarts.
export const AI_PRIVATE_INTENT_LABELS = Object.freeze([
  "action-required",
  "calendar",
  "developer-update",
  "finance",
  "job-hunt",
  "jobs",
  "legal",
  "newsletter",
  "personal",
  "promotion",
  "security",
  "shipping",
  "social-update",
  "support",
  "travel",
]);

function confidenceAtLeast(value = "", threshold = "medium") {
  return (
    (CONFIDENCE_RANK.get(String(value)) || 0) >=
    (CONFIDENCE_RANK.get(String(threshold)) || 0)
  );
}

function normalizedConfidence(value = "low") {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric >= 0.8) {
      return "high";
    }
    if (numeric >= 0.55) {
      return "medium";
    }
    return "low";
  }
  const label = String(value || "low").toLocaleLowerCase();
  return CONFIDENCE_RANK.has(label) ? label : "low";
}

function candidateFrom(result = {}, source = "") {
  const label = String(result?.label || result?.category || "").trim();
  if (!label) {
    return null;
  }
  return {
    label,
    confidence: normalizedConfidence(result?.confidence),
    source,
  };
}

/**
 * Resolve a routing category without treating classifier output as proof.
 *
 * Precedence: explicit template override -> exact deterministic rule ->
 * trusted sparse model -> explicitly available transformer -> safe fallback.
 * A transformer result is intentionally opt-in: installing a model must not
 * change mail routing until its runtime explicitly reports an executable
 * result.
 */
export const AIClassification = {
  resolve({
    deterministic = {},
    template = {},
    sparse = null,
    transformer = null,
  } = {}) {
    const candidates = [];
    const templateCategory = String(template?.category || "").trim();
    if (templateCategory && template?.mode == "override") {
      return {
        category: templateCategory,
        confidence: "high",
        source: "template",
        reason: "User-approved template override.",
        evidenceLevel: "routing-metadata",
        candidates,
      };
    }

    const deterministicCategory = String(deterministic?.category || "").trim();
    if (deterministicCategory && deterministic?.ruleMatched) {
      return {
        category: deterministicCategory,
        confidence: String(deterministic?.confidence || "high"),
        source: "deterministic-rule",
        reason: "Exact local category rule matched.",
        evidenceLevel: "routing-metadata",
        candidates,
      };
    }

    const sparseCandidate = candidateFrom(sparse, "sparse-naive-bayes");
    if (sparseCandidate) {
      candidates.push(sparseCandidate);
    }
    const transformerCandidate = candidateFrom(transformer, "transformer");
    if (transformerCandidate) {
      candidates.push(transformerCandidate);
    }

    if (sparseCandidate && confidenceAtLeast(sparseCandidate.confidence)) {
      if (
        transformerCandidate &&
        transformerCandidate.label != sparseCandidate.label &&
        confidenceAtLeast(transformerCandidate.confidence, "high") &&
        !confidenceAtLeast(sparseCandidate.confidence, "high")
      ) {
        return {
          category: transformerCandidate.label,
          confidence: transformerCandidate.confidence,
          source: transformerCandidate.source,
          reason:
            "Transformer resolved a lower-confidence sparse disagreement.",
          evidenceLevel: "routing-metadata",
          candidates,
        };
      }
      return {
        category: sparseCandidate.label,
        confidence: sparseCandidate.confidence,
        source: sparseCandidate.source,
        reason: "User-trained sparse classifier met the confidence threshold.",
        evidenceLevel: "routing-metadata",
        candidates,
      };
    }

    if (
      transformerCandidate &&
      confidenceAtLeast(transformerCandidate.confidence)
    ) {
      return {
        category: transformerCandidate.label,
        confidence: transformerCandidate.confidence,
        source: transformerCandidate.source,
        reason:
          "Configured transformer classified a novel or low-confidence message.",
        evidenceLevel: "routing-metadata",
        candidates,
      };
    }

    return {
      category: deterministicCategory || "personal",
      confidence: String(deterministic?.confidence || "low"),
      source: "fallback",
      reason:
        "No exact rule or confident learned classification was available.",
      evidenceLevel: "routing-metadata",
      candidates,
    };
  },
};
