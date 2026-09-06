/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Policy and provenance helpers for the local-first AI pipeline.
 *
 * This module deliberately has no endpoint, mailbox, or storage dependency.
 * Thunderbird owns the policy boundary and persistence; callers use these
 * helpers to decide which derived artifact is active and to keep a compact,
 * inspectable history of the local and endpoint versions for the current
 * message body.
 */

export const AI_PIPELINE_PROFILES = Object.freeze([
  "local-only",
  "balanced",
  "ollama-first",
  "custom",
  "legacy",
]);

export const AI_PIPELINE_STAGES = Object.freeze([
  "analysis",
  "summaries",
  "embeddings",
  "reranking",
  "answers",
]);

const ACTIVE_ENDPOINT_FIELDS = Object.freeze([
  "summary",
  "summarySource",
  "embedding",
  "embeddingModel",
  "embeddingSourceId",
  "suggestedTags",
  "actionItems",
  "riskFlags",
  "riskLevel",
  "priority",
  "status",
  "timelineStages",
]);

function text(value = "", limit = 240) {
  return String(value || "")
    .trim()
    .slice(0, limit);
}

function copy(value) {
  return structuredClone(value || {});
}

export function normalizePipelineProfile(value = "") {
  const profile = String(value || "")
    .trim()
    .toLocaleLowerCase();
  return AI_PIPELINE_PROFILES.includes(profile) ? profile : "balanced";
}

export function normalizePipelineStageMode(value = "") {
  const mode = String(value || "")
    .trim()
    .toLocaleLowerCase();
  return ["profile", "local", "endpoint"].includes(mode) ? mode : "profile";
}

export function profileUsesEndpoint(profile = "", stage = "") {
  const normalizedProfile = normalizePipelineProfile(profile);
  if (
    !AI_PIPELINE_STAGES.includes(stage) ||
    normalizedProfile == "local-only"
  ) {
    return false;
  }
  if (normalizedProfile == "legacy") {
    return true;
  }
  // Even in Ollama-first mode, parsing, PII policy, exact matching, and the
  // deterministic baseline remain Thunderbird-owned. These stages are the
  // configurable semantic stages only.
  return ["balanced", "ollama-first", "custom"].includes(normalizedProfile);
}

export function stageUsesEndpoint({
  profile = "",
  stage = "",
  mode = "",
} = {}) {
  const normalizedMode = normalizePipelineStageMode(mode);
  if (normalizedMode == "local") {
    return false;
  }
  if (normalizedMode == "endpoint") {
    return true;
  }
  return profileUsesEndpoint(profile, stage);
}

export function isProgressiveProfile(profile = "") {
  return ["balanced", "ollama-first", "custom"].includes(
    normalizePipelineProfile(profile)
  );
}

export function snapshotArtifactRecord(record = {}) {
  const snapshot = copy(record);
  delete snapshot.analysisArtifacts;
  delete snapshot.activeAnalysisArtifact;
  delete snapshot.endpointUpgrade;
  return snapshot;
}

export function createAnalysisArtifact(
  record = {},
  {
    origin = "local",
    state = "complete",
    bodyHash = "",
    sourceId = "",
    sourceName = "",
    model = "",
    pipelineVersion = 1,
    error = "",
    graphEnrichment = null,
  } = {}
) {
  const createdAt = new Date().toISOString();
  return {
    origin: origin == "endpoint" ? "endpoint" : "local",
    state: text(state, 40) || "complete",
    bodyHash: text(bodyHash, 128),
    sourceId: text(sourceId, 120),
    sourceName: text(sourceName, 240),
    model: text(model, 240),
    pipelineVersion: Math.max(1, Number(pipelineVersion) || 1),
    createdAt,
    validatedAt: state == "validated" ? createdAt : "",
    error: text(error, 400),
    // This is deliberately separate from the active semantic record. It is
    // consumed only by GraphRAG after local validation, so an endpoint cannot
    // silently replace Thunderbird-owned parsing/extraction facts.
    graphEnrichment:
      graphEnrichment && typeof graphEnrichment == "object"
        ? copy(graphEnrichment)
        : null,
    record: snapshotArtifactRecord(record),
  };
}

export function analysisArtifactsForRecord(record = {}) {
  const artifacts = record.analysisArtifacts || {};
  return {
    local: artifacts.local ? copy(artifacts.local) : null,
    endpoint: artifacts.endpoint ? copy(artifacts.endpoint) : null,
    endpointState: text(artifacts.endpointState, 40) || "not-requested",
    endpointError: text(artifacts.endpointError, 400),
    upgradeRequestedAt: text(artifacts.upgradeRequestedAt, 80),
    upgradedAt: text(artifacts.upgradedAt, 80),
  };
}

export function attachLocalArtifact(record = {}, options = {}) {
  const next = copy(record);
  const artifacts = analysisArtifactsForRecord(next);
  artifacts.local = createAnalysisArtifact(next, {
    ...options,
    origin: "local",
    state: "complete",
  });
  artifacts.endpoint = null;
  artifacts.endpointState = options.endpointEligible
    ? "pending"
    : "not-requested";
  artifacts.endpointError = "";
  artifacts.upgradeRequestedAt = options.endpointEligible
    ? new Date().toISOString()
    : "";
  artifacts.upgradedAt = "";
  next.analysisArtifacts = artifacts;
  next.activeAnalysisArtifact = "local";
  return next;
}

export function endpointArtifactIsUsable(artifact = {}) {
  if (artifact?.origin != "endpoint") {
    return false;
  }
  if (!["complete", "validated"].includes(artifact.state)) {
    return false;
  }
  const record = artifact.record || {};
  const embedding = Array.isArray(record.embedding) ? record.embedding : [];
  const validEmbedding =
    !!embedding.length &&
    embedding.length <= 16384 &&
    embedding.every(value => Number.isFinite(Number(value)));
  return !!(text(record.summary, 1200) || validEmbedding);
}

export function attachEndpointArtifact(record = {}, artifact = {}) {
  const next = copy(record);
  const artifacts = analysisArtifactsForRecord(next);
  const localBodyHash = text(artifacts.local?.bodyHash, 128);
  const endpointBodyHash = text(artifact?.bodyHash, 128);
  const staleBody =
    !!localBodyHash && (!endpointBodyHash || endpointBodyHash != localBodyHash);
  const usableArtifact = endpointArtifactIsUsable(artifact);
  if (!usableArtifact || staleBody) {
    artifacts.endpointState = "failed";
    artifacts.endpointError = !usableArtifact
      ? text(artifact?.error, 400) || "Endpoint result was not valid."
      : "Endpoint result does not match the current local message body.";
    next.analysisArtifacts = artifacts;
    next.activeAnalysisArtifact = "local";
    return next;
  }
  artifacts.endpoint = copy(artifact);
  artifacts.endpointState = "complete";
  artifacts.endpointError = "";
  artifacts.upgradedAt = new Date().toISOString();
  next.analysisArtifacts = artifacts;
  next.activeAnalysisArtifact = "endpoint";

  if (artifact.graphEnrichment?.state == "validated") {
    next.graphEnrichment = copy(artifact.graphEnrichment);
  }

  // Keep Thunderbird-owned parse, safety, PII, scope, and exact-lookup
  // fields on the root record. Only endpoint-derived semantic fields replace
  // their local provisional counterparts.
  for (const field of ACTIVE_ENDPOINT_FIELDS) {
    if (artifact.record?.[field] !== undefined) {
      next[field] = copy(artifact.record[field]);
    }
  }
  return next;
}

export function pipelineStatusForRecord(record = {}) {
  const artifacts = analysisArtifactsForRecord(record);
  return {
    active: record.activeAnalysisArtifact || "local",
    local: !!artifacts.local,
    endpoint: !!artifacts.endpoint,
    endpointState: artifacts.endpointState,
    endpointError: artifacts.endpointError,
    upgrading: artifacts.endpointState == "pending",
  };
}
