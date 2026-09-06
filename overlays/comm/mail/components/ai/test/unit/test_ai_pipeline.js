/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const {
  attachEndpointArtifact,
  attachLocalArtifact,
  createAnalysisArtifact,
  normalizePipelineProfile,
  pipelineStatusForRecord,
  stageUsesEndpoint,
} = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIPipeline.sys.mjs"
);

add_task(function test_profiles_keep_control_plane_local() {
  Assert.equal(normalizePipelineProfile("OLLAMA-FIRST"), "ollama-first");
  Assert.equal(
    stageUsesEndpoint({ profile: "local-only", stage: "summaries" }),
    false
  );
  Assert.equal(
    stageUsesEndpoint({ profile: "balanced", stage: "embeddings" }),
    true
  );
  Assert.equal(
    stageUsesEndpoint({
      profile: "custom",
      stage: "answers",
      mode: "local",
    }),
    false
  );
});

add_task(function test_endpoint_artifact_replaces_only_semantic_projection() {
  const local = attachLocalArtifact(
    {
      subject: "Invoice",
      summary: "Local summary",
      embedding: [0.1, 0.2],
      piiDecision: "redact",
      immutableEvidence: { messageId: "<one@example.invalid>" },
    },
    { bodyHash: "local-body", endpointEligible: true }
  );
  Assert.equal(local.activeAnalysisArtifact, "local");
  Assert.equal(local.analysisArtifacts.endpointState, "pending");

  const endpoint = createAnalysisArtifact(
    {
      ...local,
      summary: "Endpoint summary",
      embedding: [0.8, 0.9, 1],
      piiDecision: "incorrect endpoint value",
      immutableEvidence: { messageId: "<incorrect@example.invalid>" },
    },
    { origin: "endpoint", state: "validated", bodyHash: "local-body" }
  );
  const upgraded = attachEndpointArtifact(local, endpoint);
  Assert.equal(upgraded.activeAnalysisArtifact, "endpoint");
  Assert.equal(upgraded.summary, "Endpoint summary");
  Assert.deepEqual(upgraded.embedding, [0.8, 0.9, 1]);
  Assert.equal(upgraded.piiDecision, "redact");
  Assert.equal(upgraded.immutableEvidence.messageId, "<one@example.invalid>");
  Assert.deepEqual(pipelineStatusForRecord(upgraded), {
    active: "endpoint",
    local: true,
    endpoint: true,
    endpointState: "complete",
    endpointError: "",
    upgrading: false,
  });
});

add_task(function test_invalid_endpoint_artifact_keeps_local_active() {
  const local = attachLocalArtifact(
    { summary: "Local summary" },
    { bodyHash: "body", endpointEligible: true }
  );
  const rejected = attachEndpointArtifact(
    local,
    createAnalysisArtifact(
      { summary: "" },
      { origin: "endpoint", state: "failed", error: "invalid schema" }
    )
  );
  Assert.equal(rejected.activeAnalysisArtifact, "local");
  Assert.equal(rejected.analysisArtifacts.endpointState, "failed");
  Assert.equal(rejected.analysisArtifacts.endpointError, "invalid schema");
});

add_task(function test_empty_or_stale_endpoint_artifact_keeps_local_active() {
  const local = attachLocalArtifact(
    { summary: "Local summary", embedding: [0.1, 0.2] },
    { bodyHash: "current-body", endpointEligible: true }
  );
  const empty = attachEndpointArtifact(
    local,
    createAnalysisArtifact(
      { summary: "", embedding: [] },
      { origin: "endpoint", state: "validated", bodyHash: "current-body" }
    )
  );
  Assert.equal(empty.activeAnalysisArtifact, "local");
  Assert.equal(empty.analysisArtifacts.endpointState, "failed");

  const stale = attachEndpointArtifact(
    local,
    createAnalysisArtifact(
      { summary: "Stale endpoint summary" },
      { origin: "endpoint", state: "validated", bodyHash: "older-body" }
    )
  );
  Assert.equal(stale.activeAnalysisArtifact, "local");
  Assert.equal(stale.summary, "Local summary");
  Assert.equal(
    stale.analysisArtifacts.endpointError,
    "Endpoint result does not match the current local message body."
  );
});
