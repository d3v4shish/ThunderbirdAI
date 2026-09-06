/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Local-first mailbox relationship graph.
 *
 * This module deliberately builds only deterministic, source-backed edges.
 * Endpoint enrichment is layered on top later and must use a distinct source
 * and confidence label. Graph records never duplicate message bodies: every
 * node and edge points back to the canonical AI message record.
 */

const MAX_GRAPH_LABEL_LENGTH = 300;
const MAX_GRAPH_VALUES_PER_FIELD = 20;
const MAX_GRAPH_ACTIONS = 12;
// Bump whenever the deterministic graph contribution changes. Stored graph
// rows are deliberately rebuildable from local AI records, so a profile never
// keeps reporting a complete graph built with an older topology.
const GRAPH_CONTRIBUTION_VERSION = 8;
const SUBJECT_TOPIC_STOP_WORDS = new Set([
  "about",
  "approved",
  "daily",
  "debit",
  "final",
  "follow",
  "launch",
  "meeting",
  "message",
  "notification",
  "production",
  "receipt",
  "schedule",
  "stand",
  "status",
  "thread",
  "transaction",
  "update",
]);

function stringValue(value, limit = MAX_GRAPH_LABEL_LENGTH) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

function normalizedValue(value) {
  return stringValue(value).toLocaleLowerCase().replace(/\s+/gu, " ");
}

function graphID(type, value) {
  return `${type}:${encodeURIComponent(normalizedValue(value))}`;
}

function messageIDForRecord(record = {}, fallback = "") {
  // Graph edges must use Thunderbird's stable local record identifier. An RFC
  // Message-ID is useful message metadata, but it cannot be joined back to the
  // local RAG record (whose key is folderURI#messageKey) to render evidence or
  // citations. AIStorage passes that canonical key as fallback on every write.
  const canonicalFromRecord =
    record.folderURI && Number.isInteger(record.messageKey)
      ? `${record.folderURI}#${record.messageKey}`
      : "";
  return stringValue(
    fallback || record.storageId || canonicalFromRecord || record.messageId,
    1000
  );
}

function senderEmail(author = "") {
  const match = String(author || "").match(/<([^>\s]+@[^>\s]+)>/u);
  return normalizedValue(match?.[1] || author).includes("@")
    ? normalizedValue(match?.[1] || author)
    : "";
}

function threadLabel(record = {}) {
  const explicit = stringValue(record.threadKey || record.threadId);
  if (explicit) {
    return explicit;
  }
  return stringValue(record.subject)
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function values(value, limit = MAX_GRAPH_VALUES_PER_FIELD) {
  return Array.isArray(value)
    ? value
        .map(item => stringValue(item))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function subjectTopicLabels(record = {}) {
  // Subject terms are already canonical Thunderbird metadata.  Keeping a few
  // distinctive terms gives local GraphRAG a bridge when the deterministic
  // field extractor did not explicitly recognise a project name, without
  // inventing entities from an endpoint or copying message bodies into graph
  // storage.
  const subject = threadLabel(record);
  const labels = [];
  const seen = new Set();
  for (const match of subject.matchAll(/[\p{L}][\p{L}\p{N}-]{3,}/gu)) {
    const label = stringValue(match[0], 80);
    const normalized = normalizedValue(label);
    if (
      !normalized ||
      SUBJECT_TOPIC_STOP_WORDS.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    labels.push(label);
    if (labels.length >= 4) {
      break;
    }
  }
  return labels;
}

function entityTypeForField(field = "") {
  const key = normalizedValue(field).replace(/[^a-z0-9]/gu, "");
  if (
    ["transactionids", "referenceids", "invoiceids", "references"].includes(key)
  ) {
    return "reference";
  }
  if (["merchants", "vendors"].includes(key)) {
    return "merchant";
  }
  if (["organizations", "organisation", "orgs", "companies"].includes(key)) {
    return "organization";
  }
  if (["people", "persons", "contacts"].includes(key)) {
    return "person";
  }
  if (["projects", "project"].includes(key)) {
    return "project";
  }
  if (["urls", "url", "links"].includes(key)) {
    return "url";
  }
  if (["dates", "date", "deadlines"].includes(key)) {
    return "date";
  }
  if (["amounts", "amount", "currencies"].includes(key)) {
    return "amount";
  }
  return key ? `entity-${key}` : "entity";
}

function node(type, label, properties = {}, source = "deterministic-local") {
  const normalized = normalizedValue(label);
  if (!normalized) {
    return null;
  }
  return {
    id: graphID(type, normalized),
    type,
    label: stringValue(label),
    source,
    confidence: source == "deterministic-local" ? 1 : 0.8,
    ...properties,
  };
}

function edge(
  messageId,
  predicate,
  targetId,
  { source = "deterministic-local", confidence = 1 } = {}
) {
  return {
    // Source is part of the identity. An endpoint-enriched relation must not
    // overwrite a deterministic edge to the same entity, because callers need
    // to be able to distinguish a local fact from a model-derived artifact.
    id: `edge:${encodeURIComponent(messageId)}:${source}:${predicate}:${encodeURIComponent(targetId)}`,
    from: `message:${encodeURIComponent(normalizedValue(messageId))}`,
    target: targetId,
    predicate,
    source,
    confidence,
    sourceMessageIds: [messageId],
  };
}

function factEdge(messageId, predicate, fromId, targetId, properties = {}) {
  return {
    id: `fact-edge:${encodeURIComponent(messageId)}:${predicate}:${encodeURIComponent(fromId)}:${encodeURIComponent(targetId)}`,
    from: fromId,
    target: targetId,
    predicate,
    source: "deterministic-local",
    confidence: 1,
    sourceMessageIds: [messageId],
    ...properties,
  };
}

function endpointEnrichmentForRecord(record = {}) {
  const direct = record.graphEnrichment;
  const artifact = record.analysisArtifacts?.endpoint?.graphEnrichment;
  const enrichment = direct || artifact;
  if (
    !enrichment ||
    enrichment.state != "validated" ||
    enrichment.origin != "endpoint" ||
    !Array.isArray(enrichment.entities)
  ) {
    return null;
  }
  return enrichment;
}

/**
 * Build a graph-only endpoint artifact from a validated endpoint result.
 *
 * The endpoint may suggest only values which Thunderbird can find verbatim in
 * the canonical local record. This intentionally rejects useful-sounding but
 * unsupported model claims. The raw email is never copied into the graph.
 *
 * @param {object} localRecord
 * @param {object} endpointResult
 * @param {object} root0
 * @param {string} root0.sourceId
 * @param {string} root0.sourceName
 * @param {string} root0.model
 */
export function validatedEndpointGraphEnrichment(
  localRecord = {},
  endpointResult = {},
  { sourceId = "", sourceName = "", model = "" } = {}
) {
  const canonicalText = [
    localRecord.originalSubject,
    localRecord.subject,
    localRecord.author,
    localRecord.recipients,
    localRecord.originalBody,
    localRecord.body,
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  const rawEntities = endpointResult?.extractedEntities;
  if (!canonicalText || !rawEntities || typeof rawEntities != "object") {
    return null;
  }
  const entities = [];
  for (const [field, rawValues] of Object.entries(rawEntities)) {
    const type = entityTypeForField(field);
    for (const value of values(rawValues, MAX_GRAPH_VALUES_PER_FIELD)) {
      // Do not persist an endpoint-proposed entity unless it can be checked
      // directly against Thunderbird's local representation of the message.
      if (!canonicalText.includes(normalizedValue(value))) {
        continue;
      }
      entities.push({
        type,
        label: value,
        predicate: `endpoint-mentions-${type}`,
      });
    }
  }
  const uniqueEntities = Array.from(
    new Map(
      entities.map(entity => [
        `${entity.type}\u0000${normalizedValue(entity.label)}`,
        entity,
      ])
    ).values()
  ).slice(0, MAX_GRAPH_VALUES_PER_FIELD * 4);
  if (!uniqueEntities.length) {
    return null;
  }
  return {
    version: 1,
    origin: "endpoint",
    state: "validated",
    sourceId: stringValue(sourceId, 120),
    sourceName: stringValue(sourceName, 240),
    model: stringValue(model, 240),
    createdAt: new Date().toISOString(),
    // A model-selected entity is useful as a retrieval signal, but it is not
    // as authoritative as Thunderbird's deterministic extraction.
    confidence: 0.8,
    entities: uniqueEntities,
  };
}

function graphSourceRecord(record = {}) {
  const localArtifactRecord = record.analysisArtifacts?.local?.record;
  if (
    record.activeAnalysisArtifact != "endpoint" ||
    !localArtifactRecord ||
    typeof localArtifactRecord != "object"
  ) {
    return record;
  }
  return {
    ...localArtifactRecord,
    accountKey: record.accountKey || localArtifactRecord.accountKey,
    folderURI: record.folderURI || localArtifactRecord.folderURI,
    messageKey: Number.isInteger(record.messageKey)
      ? record.messageKey
      : localArtifactRecord.messageKey,
  };
}

function deterministicGraphFieldsForRecord(sourceRecord = {}) {
  if (
    sourceRecord.deterministicGraphFields &&
    typeof sourceRecord.deterministicGraphFields == "object"
  ) {
    return sourceRecord.deterministicGraphFields;
  }
  const analysisVersion = Number(sourceRecord.analysisVersion);
  if (!Number.isFinite(analysisVersion) || analysisVersion <= 0) {
    return sourceRecord;
  }
  // An analyzed legacy record without the frozen boundary cannot prove which
  // top-level semantic fields predated model enrichment. Retain only fields
  // with explicit deterministic provenance until full reanalysis replaces it.
  const deterministicCategory = ["template", "deterministic-rule"].includes(
    sourceRecord.classification?.source
  );
  return {
    category: deterministicCategory ? sourceRecord.category || "" : "",
    templateFamily: sourceRecord.matchedTemplateId
      ? sourceRecord.templateFamily || ""
      : "",
    extractedEntities: {},
    actionItems: [],
    riskFlags: [],
  };
}

function appendDeterministicFactRelations({
  sourceRecord,
  messageId,
  add,
  nodes,
  edges,
}) {
  const facts = Array.isArray(sourceRecord.deterministicFacts)
    ? sourceRecord.deterministicFacts.slice(0, MAX_GRAPH_VALUES_PER_FIELD)
    : [];
  for (const relation of facts) {
    const predicate = stringValue(relation?.predicate, 80);
    const subject = stringValue(relation?.subject, 160);
    const object = stringValue(relation?.object, MAX_GRAPH_LABEL_LENGTH);
    if (!predicate || !object) {
      continue;
    }
    const spanProperties = {
      sourceField: stringValue(relation?.sourceField, 80),
      startOffset: Math.max(0, Number(relation?.startOffset) || 0),
      endOffset: Math.max(0, Number(relation?.endOffset) || 0),
      sourceText: stringValue(relation?.text, MAX_GRAPH_LABEL_LENGTH),
      evidenceLevel: "source-span",
    };
    add(
      "relation",
      `${subject ? `${subject} ` : ""}${predicate}: ${object}`,
      `asserts-${predicate}`,
      spanProperties
    );
    if (!subject) {
      continue;
    }
    const subjectNode = node("fact-subject", subject, spanProperties);
    const objectNode = node("fact-object", object, spanProperties);
    if (subjectNode && objectNode) {
      nodes.push(subjectNode, objectNode);
      edges.push(
        factEdge(messageId, predicate, subjectNode.id, objectNode.id, {
          ...spanProperties,
          subject,
          object,
        })
      );
    }
  }
}

function endpointGraphContributionForMessage(
  record = {},
  fallbackMessageId = ""
) {
  const messageId = messageIDForRecord(record, fallbackMessageId);
  const enrichment = endpointEnrichmentForRecord(record);
  if (!messageId || !enrichment) {
    return { nodes: [], edges: [] };
  }
  const nodes = [];
  const edges = [];
  for (const entity of enrichment.entities) {
    const graphNode = node(
      stringValue(entity.type, 80) || "entity",
      entity.label,
      {
        endpointSourceId: enrichment.sourceId,
        endpointModel: enrichment.model,
        endpointCreatedAt: enrichment.createdAt,
      },
      "endpoint-enriched"
    );
    if (!graphNode) {
      continue;
    }
    nodes.push(graphNode);
    edges.push(
      edge(
        messageId,
        stringValue(entity.predicate, 120) || "endpoint-mentions",
        graphNode.id,
        {
          source: "endpoint-enriched",
          confidence: Math.min(
            0.8,
            Math.max(0.1, Number(enrichment.confidence) || 0.8)
          ),
        }
      )
    );
  }
  return {
    nodes: Array.from(new Map(nodes.map(item => [item.id, item])).values()),
    edges: Array.from(new Map(edges.map(item => [item.id, item])).values()),
  };
}

/**
 * Produce a source-scoped graph contribution for one stored mail record.
 * No heuristic relation is emitted without a direct field in that record.
 *
 * @param {object} record
 * @param {string} fallbackMessageId
 */
export function graphContributionForMessage(
  record = {},
  fallbackMessageId = ""
) {
  const messageId = messageIDForRecord(record, fallbackMessageId);
  if (!messageId) {
    return { messageId: "", nodes: [], edges: [] };
  }
  // An endpoint artifact may replace semantic fields on the active root
  // record. Build deterministic graph rows from the preserved local artifact
  // in that case; endpoint entities enter only through the separately labelled
  // validated enrichment below.
  const sourceRecord = graphSourceRecord(record);
  const deterministicFields = deterministicGraphFieldsForRecord(sourceRecord);
  const nodes = [];
  const edges = [];
  const add = (type, label, predicate, properties = {}) => {
    const next = node(type, label, properties);
    if (!next) {
      return;
    }
    nodes.push(next);
    edges.push(edge(messageId, predicate, next.id));
  };

  const messageNode = node("message", messageId, {
    label: stringValue(sourceRecord.subject || messageId),
    accountKey: stringValue(sourceRecord.accountKey, 120),
    folderURI: stringValue(sourceRecord.folderURI, 1000),
    date: Number(sourceRecord.date) || 0,
  });
  if (messageNode) {
    nodes.push(messageNode);
  }

  const author = stringValue(sourceRecord.author, 300);
  const email = senderEmail(author);
  if (email) {
    add("person", email, "sent-by", { displayName: author });
    add("domain", email.split("@")[1], "sender-domain");
  }
  add("thread", threadLabel(sourceRecord), "in-thread");
  add(
    "category",
    deterministicFields.category || deterministicFields.trustedCategory,
    "has-category"
  );
  add("template", deterministicFields.templateFamily, "matches-template");
  for (const topic of subjectTopicLabels(sourceRecord)) {
    add("topic", topic, "has-subject-topic");
  }

  for (const [field, rawValues] of Object.entries(
    deterministicFields.extractedEntities &&
      typeof deterministicFields.extractedEntities == "object"
      ? deterministicFields.extractedEntities
      : {}
  )) {
    const type = entityTypeForField(field);
    for (const value of values(rawValues)) {
      add(type, value, `mentions-${type}`);
    }
  }
  for (const value of values(
    deterministicFields.actionItems,
    MAX_GRAPH_ACTIONS
  )) {
    add("action", value, "has-action");
  }
  // The Datalog layer contributes only explicit source-span relations. Keep
  // a message-attached relation node for inspection, and also connect the
  // stated subject directly to the stated object. The latter is the actual
  // deterministic relationship GraphRAG needs; routing through a subject
  // keyword or message-topic heuristic can otherwise invent the wrong path.
  appendDeterministicFactRelations({
    sourceRecord,
    messageId,
    add,
    nodes,
    edges,
  });
  for (const value of values(
    deterministicFields.riskFlags ||
      deterministicFields.risks ||
      deterministicFields.security?.risks,
    MAX_GRAPH_ACTIONS
  )) {
    add("risk", value, "has-risk");
  }

  const endpointContribution = endpointGraphContributionForMessage(
    record,
    messageId
  );
  return {
    version: GRAPH_CONTRIBUTION_VERSION,
    messageId,
    nodes: Array.from(
      new Map(
        [...nodes, ...endpointContribution.nodes].map(item => [item.id, item])
      ).values()
    ),
    edges: Array.from(
      new Map(
        [...edges, ...endpointContribution.edges].map(item => [item.id, item])
      ).values()
    ),
    endpointEdgeCount: endpointContribution.edges.length,
  };
}

/**
 * A compact deterministic identity for the graph-bearing part of one message.
 * It lets storage avoid deleting/reinserting graph rows when a non-graph field
 * such as a summary, classification confidence, or embedding changes.
 *
 * @param {object} contribution
 */
export function graphContributionFingerprint(contribution = {}) {
  const text = JSON.stringify({
    version: contribution.version || 1,
    messageId: contribution.messageId || "",
    nodes: contribution.nodes || [],
    edges: contribution.edges || [],
  });
  // Two independent 32-bit rolling hashes keep this synchronous and compact
  // while making a false "unchanged contribution" result impractical.
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    primary ^= code;
    primary = Math.imul(primary, 0x01000193);
    secondary ^= code + index;
    secondary = Math.imul(secondary, 0x85ebca6b);
  }
  return `${(primary >>> 0).toString(16).padStart(8, "0")}${(secondary >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function graphContributionStatus(data = {}, scope = null) {
  const sources =
    data.graphSources && typeof data.graphSources == "object"
      ? Object.values(data.graphSources)
      : [];
  const matchesScope = source => {
    if (!scope || typeof scope != "object") {
      return true;
    }
    return (
      (!scope.accountKey || source.accountKey == scope.accountKey) &&
      (!scope.folderURI || source.folderURI == scope.folderURI)
    );
  };
  const selected = sources.filter(matchesScope);
  const nodeIds = new Set();
  const edgeIds = new Set();
  for (const source of selected) {
    for (const id of values(source.nodeIds, 10000)) {
      nodeIds.add(id);
    }
    for (const id of values(source.edgeIds, 10000)) {
      edgeIds.add(id);
    }
  }
  return {
    version: GRAPH_CONTRIBUTION_VERSION,
    sourceMessages: selected.length,
    nodeCount: nodeIds.size,
    edgeCount: edgeIds.size,
    deterministicMessages: selected.filter(
      source => source.source != "endpoint-only"
    ).length,
    endpointEnrichedMessages: selected.filter(
      source => source.endpointEdgeCount > 0
    ).length,
    complete: selected.every(
      source =>
        source.state == "ready" &&
        Number(source.graphVersion || 1) == GRAPH_CONTRIBUTION_VERSION
    ),
  };
}
