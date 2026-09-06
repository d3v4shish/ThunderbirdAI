/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AIRuntimePaths } from "moz-src:///comm/mail/components/ai/modules/AIRuntimePaths.sys.mjs";
import { AIEndpoint } from "moz-src:///comm/mail/components/ai/modules/AIEndpoint.sys.mjs";
import { AIStorage } from "moz-src:///comm/mail/components/ai/modules/AIStorage.sys.mjs";

const SCHEMA_VERSION = 15;
const CONTEXT_SCHEMA_VERSION = 5;
const INSERT_YIELD_INTERVAL = 500;
const REBUILD_TRANSACTION_SIZE = 1000;
const CHILD_CHUNK_CHARS = 1200;
const CHILD_CHUNK_OVERLAP_CHARS = 180;
const MAX_CHILD_CHUNKS_PER_MESSAGE = 24;
const MAX_TRANSLATION_CHUNKS_PER_MESSAGE = 6;
const MAX_DERIVED_HINT_CHUNKS_PER_MESSAGE = 1;
const LOCAL_PASSAGE_EMBEDDING_MODEL = "deterministic-local-v1";
const LOCAL_PASSAGE_EMBEDDING_DIMENSION = 32;
// A small, deterministic locality-sensitive hash index bounds dedicated
// embedding candidates before cosine scoring. It is a disposable SQLite
// sidecar derived solely from the canonical chunk vectors: no mailbox data is
// duplicated outside the RAG index, and a schema rebuild can always recreate
// it. Four independent 8-bit projections keep a 100k-chunk corpus in bounded
// candidate sets while the original vectors make the final ranking exact.
const VECTOR_LSH_TABLES = 4;
const VECTOR_LSH_BITS = 8;
const MAX_ENDPOINT_DENSE_CANDIDATES = 4096;
const MAX_EMBEDDING_DIMENSIONS = 16384;
const MAX_EMBEDDING_COMPONENT_MAGNITUDE = 1e6;
const AI_STORAGE_RECORD_CHANGED_TOPIC = "mail-ai-storage-record-changed";
const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

function now() {
  return new Date().toISOString();
}

// The RAG database is derived exclusively from profile-local AIStorage rows.
// Recover only errors that prove this disposable sidecar is malformed. Lock,
// disk-full, permission, and transient I/O failures must remain visible rather
// than being misclassified as safe-to-delete corruption.
function isCorruptIndexError(error) {
  const message = [error?.name, error?.message, error]
    .filter(Boolean)
    .map(value => String(value))
    .join(" ")
    .toLocaleLowerCase();
  return [
    "file is not a database",
    "database disk image is malformed",
    "database corruption",
    "malformed database schema",
    "sqlite_corrupt",
    "ns_error_file_corrupted",
    "ns_error_storage_corrupt",
  ].some(marker => message.includes(marker));
}

async function removeDerivedIndexFiles(path) {
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map(filePath =>
      IOUtils.remove(filePath, { ignoreAbsent: true })
    )
  );
}

function scopeKey(scope = {}) {
  return JSON.stringify({
    mode: scope.scopeMode || "all",
    accountKey: scope.accountKey || "",
    folderURI: scope.folderURI || "",
    messageIds: Array.isArray(scope.messageIds)
      ? scope.messageIds.map(String).sort()
      : [],
  });
}

function coverageKey(scopeCoverage = null) {
  return JSON.stringify({
    totalMessages: Number(scopeCoverage?.totalMessages) || 0,
    remainingAnalysisCount: Number(scopeCoverage?.remainingAnalysisCount) || 0,
    ragIndexedCount: Number(scopeCoverage?.ragIndexedCount) || 0,
  });
}

function searchText(record = {}) {
  return [
    record.subject,
    record.author,
    record.summary,
    record.category,
    record.primaryCategory,
    record.subcategory,
    record.status,
    record.priority,
    record.originalSubject,
    record.englishSubject,
    record.originalBody,
    record.englishBody,
    record.localText,
    Array.isArray(record.retrievalEntityHints)
      ? record.retrievalEntityHints.join(" ")
      : "",
    record.privateIntentHint?.label,
    Array.isArray(record.actionItems) ? record.actionItems.join(" ") : "",
    Array.isArray(record.riskFlags) ? record.riskFlags.join(" ") : "",
    JSON.stringify(record.extractedEntities || {}),
    JSON.stringify(record.deterministicFacts || []),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}

function messageIdForRecord(record = {}) {
  return `${record.folderURI || ""}#${record.messageKey ?? ""}`;
}

function indexedRecord(record = {}) {
  return {
    accountKey: record.accountKey,
    folderURI: record.folderURI,
    messageKey: record.messageKey,
    subject: record.subject,
    author: record.author,
    date: record.date,
    category: record.category,
    primaryCategory: record.primaryCategory,
    subcategory: record.subcategory,
    status: record.status,
    priority: record.priority,
    summary: record.summary,
    needsReply: record.needsReply,
    actionItems: record.actionItems,
    extractedEntities: record.extractedEntities,
    riskFlags: record.riskFlags,
    securityAssessment: record.securityAssessment,
  };
}

function searchTerms(query = "") {
  return Array.from(
    new Set(
      String(query || "")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu) || []
    )
  ).slice(0, 12);
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function rollupSenderDomain(author = "") {
  const address = String(author || "")
    .toLocaleLowerCase()
    .match(/[\w.%+-]+@([\w.-]+\.[a-z]{2,})/iu);
  return address?.[1] || "";
}

function rollupMonth(date = 0) {
  const dateMs = Number(date);
  if (!Number.isFinite(dateMs) || dateMs <= 0) {
    return "";
  }
  const value = new Date(dateMs);
  return Number.isFinite(value.getTime())
    ? `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`
    : "";
}

function recordRollupValues(record = {}) {
  const actions = Array.isArray(record.actionItems) ? record.actionItems : [];
  const risks = Array.isArray(record.riskFlags) ? record.riskFlags : [];
  const verdict = String(record.securityAssessment?.verdict || "")
    .trim()
    .toLocaleLowerCase();
  return {
    accountKey: String(record.accountKey || ""),
    folderURI: String(record.folderURI || ""),
    dateMs: Number(record.date) || 0,
    monthBucket: rollupMonth(record.date),
    category: String(
      record.category || record.primaryCategory || "uncategorized"
    ),
    status: String(record.status || "unknown"),
    priority: String(record.priority || "normal"),
    sender: String(record.author || ""),
    senderDomain: rollupSenderDomain(record.author),
    templateFamily: String(record.templateFamily || ""),
    threadKey: String(record.threadId || record.threadKey || ""),
    needsReply: record.needsReply ? 1 : 0,
    highPriority: /^(high|urgent|critical)$/iu.test(
      String(record.priority || "")
    )
      ? 1
      : 0,
    actionCount: actions.filter(Boolean).length,
    riskCount: risks.filter(Boolean).length,
    securityVerdict: verdict,
  };
}

function normalizedIdentifier(value = "") {
  const match = String(value || "")
    .toLocaleUpperCase()
    .match(/\b(?:TXN|UTR|RRN|REF)[-_][A-Z0-9][A-Z0-9_-]{3,}\b/u)?.[0];
  return match ? match.replace(/_+/g, "-") : "";
}

function identifiersInText(value = "") {
  return uniqueValues(
    (
      String(value || "")
        .toLocaleUpperCase()
        .match(/\b(?:TXN|UTR|RRN|REF)[-_][A-Z0-9][A-Z0-9_-]{3,}\b/gu) || []
    ).map(normalizedIdentifier)
  );
}

function normalizedAmountValue(currency = "", value = "") {
  const normalizedCurrency = String(currency || "")
    .replace(/\./g, "")
    .toLocaleUpperCase();
  const currencyCode = normalizedCurrency == "RS" ? "INR" : normalizedCurrency;
  const number = Number(String(value || "").replace(/,/g, ""));
  return currencyCode && Number.isFinite(number)
    ? `${currencyCode}:${Math.round(number * 100)}`
    : "";
}

function amountValuesInText(value = "") {
  const text = String(value || "");
  const values = [];
  for (const match of text.matchAll(
    /\b(INR|RS\.?|USD|EUR|GBP)\s*([0-9][\d,]*(?:\.\d{1,2})?)\b/giu
  )) {
    values.push(normalizedAmountValue(match[1], match[2]));
  }
  for (const match of text.matchAll(
    /\b([0-9][\d,]*(?:\.\d{1,2})?)\s*(INR|RS\.?|USD|EUR|GBP)\b/giu
  )) {
    values.push(normalizedAmountValue(match[2], match[1]));
  }
  return uniqueValues(values);
}

const MONTH_NUMBERS = new Map(
  [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].map((month, index) => [month, index + 1])
);

function normalizedDateValue(year, month, day) {
  const monthNumber =
    typeof month == "number"
      ? month
      : MONTH_NUMBERS.get(
          String(month || "")
            .slice(0, 3)
            .toLocaleLowerCase()
        );
  const numericYear = Number(year);
  const numericDay = Number(day);
  if (
    !monthNumber ||
    !Number.isInteger(numericYear) ||
    !Number.isInteger(numericDay) ||
    numericDay < 1 ||
    numericDay > 31
  ) {
    return "";
  }
  return `${String(numericYear).padStart(4, "0")}-${String(
    monthNumber
  ).padStart(2, "0")}-${String(numericDay).padStart(2, "0")}`;
}

function dateValuesInText(value = "") {
  const text = String(value || "");
  const values = [];
  for (const match of text.matchAll(
    /\b([0-3]?\d)\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/giu
  )) {
    values.push(normalizedDateValue(match[3], match[2], match[1]));
  }
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    values.push(normalizedDateValue(match[1], Number(match[2]), match[3]));
  }
  return uniqueValues(values);
}

function exactEntityRows(record = {}) {
  // Exact constraints are an authoritative retrieval lane. Index only the
  // decoded source surface (or explicit source-span facts for a legacy row),
  // never summaries, classifier output, GLiNER hints, endpoint entities, or
  // other generated search text. Otherwise a fabricated model date/reference
  // can consume the SQL LIMIT before AIChat's canonical post-filter sees the
  // real source message.
  const sourceBody =
    record.originalBody ||
    record.body ||
    record.externalSafeText ||
    record.redactedText ||
    record.localText ||
    "";
  const sourceFacts = sourceBody
    ? []
    : (record.deterministicFacts || [])
        .filter(fact => fact?.evidenceLevel == "source-span")
        .map(fact => fact?.text)
        .filter(Boolean);
  const text = [
    record.originalSubject || record.subject,
    sourceBody,
    ...sourceFacts,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    ...identifiersInText(text).map(value => ({ type: "identifier", value })),
    ...amountValuesInText(text).map(value => ({ type: "amount", value })),
    ...dateValuesInText(text).map(value => ({ type: "date", value })),
  ];
}

function stableTextHash(value = "") {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of String(value || "")) {
    const code = character.codePointAt(0);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

function localPassageEmbedding(text = "") {
  const vector = new Array(LOCAL_PASSAGE_EMBEDDING_DIMENSION).fill(0);
  for (const word of String(text).toLocaleLowerCase().split(/\W+/u)) {
    if (word.length < 2) {
      continue;
    }
    let hash = 0;
    for (let index = 0; index < word.length; index++) {
      hash = (Math.imul(hash, 31) + word.charCodeAt(index)) >>> 0;
    }
    vector[hash % vector.length]++;
  }
  return vector;
}

function projectionSign(table, bit, dimension) {
  // A stable integer mixer avoids a model-specific random seed while giving
  // every dimension an independent +/- projection for each LSH table/bit.
  let value = Math.imul(dimension + 1, 0x45d9f3b);
  value ^= Math.imul(table + 1, 0x27d4eb2d);
  value ^= Math.imul(bit + 1, 0x165667b1);
  value ^= value >>> 16;
  return value & 1 ? 1 : -1;
}

function vectorBucketKeys(vector = [], { includeNeighbors = false } = {}) {
  const normalized = normalizeEmbeddingVector(vector);
  if (!normalized.length) {
    return [];
  }
  const keys = [];
  for (let table = 0; table < VECTOR_LSH_TABLES; table++) {
    let bucket = 0;
    for (let bit = 0; bit < VECTOR_LSH_BITS; bit++) {
      let projection = 0;
      for (let dimension = 0; dimension < normalized.length; dimension++) {
        projection +=
          normalized[dimension] * projectionSign(table, bit, dimension);
      }
      if (projection >= 0) {
        bucket |= 1 << bit;
      }
    }
    keys.push(`${table}:${bucket}`);
    // One-bit probes improve recall around projection boundaries without
    // falling back to an unbounded vector scan (4 * (1 + 8) keys maximum).
    if (includeNeighbors) {
      for (let bit = 0; bit < VECTOR_LSH_BITS; bit++) {
        keys.push(`${table}:${bucket ^ (1 << bit)}`);
      }
    }
  }
  return uniqueValues(keys);
}

function normalizeEmbeddingVector(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_EMBEDDING_DIMENSIONS
  ) {
    return [];
  }
  let hasMagnitude = false;
  const normalized = [];
  for (const component of value) {
    if (
      typeof component != "number" ||
      !Number.isFinite(component) ||
      Math.abs(component) > MAX_EMBEDDING_COMPONENT_MAGNITUDE
    ) {
      return [];
    }
    normalized.push(component);
    hasMagnitude ||= component != 0;
  }
  return hasMagnitude ? normalized : [];
}

async function writeVectorBuckets(
  connection,
  {
    chunkId = "",
    embeddingModel = "",
    embeddingSourceId = "",
    embedding = [],
  } = {}
) {
  const normalizedEmbedding = normalizeEmbeddingVector(embedding);
  if (!chunkId || !embeddingModel || !normalizedEmbedding.length) {
    return;
  }
  for (const bucketKey of vectorBucketKeys(normalizedEmbedding)) {
    await connection.executeCached(
      `INSERT OR REPLACE INTO rag_vector_buckets(
         chunk_id, embedding_model, embedding_source_id,
         embedding_dimension, bucket_key
       ) VALUES(
         :chunkId, :embeddingModel, :embeddingSourceId,
         :embeddingDimension, :bucketKey
       )`,
      {
        chunkId,
        embeddingModel,
        embeddingSourceId: String(embeddingSourceId || ""),
        embeddingDimension: normalizedEmbedding.length,
        bucketKey,
      }
    );
  }
}

function cosineSimilarity(left, right) {
  const normalizedLeft = normalizeEmbeddingVector(left);
  const normalizedRight = normalizeEmbeddingVector(right);
  if (
    !normalizedLeft.length ||
    normalizedLeft.length != normalizedRight.length
  ) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < normalizedLeft.length; index++) {
    const leftValue = normalizedLeft[index];
    const rightValue = normalizedRight[index];
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return leftMagnitude && rightMagnitude
    ? dot / Math.sqrt(leftMagnitude * rightMagnitude)
    : 0;
}

function contextHeader(record = {}) {
  const parentContext = [
    record.subject ? `Subject: ${record.subject}` : "",
    record.author ? `From: ${record.author}` : "",
    record.date ? `Date: ${record.date}` : "",
    record.folderURI ? `Folder: ${record.folderURI}` : "",
    record.summary ? `Summary: ${record.summary}` : "",
    record.category ? `Category: ${record.category}` : "",
    record.templateFamily ? `Template: ${record.templateFamily}` : "",
    Array.isArray(record.actionItems) && record.actionItems.length
      ? `Actions: ${record.actionItems.join("; ")}`
      : "",
    Object.keys(record.extractedEntities || {}).length
      ? `Entities: ${JSON.stringify(record.extractedEntities)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  return parentContext;
}

function sectionLabelForOffset(body = "", offset = 0) {
  // PageIndex-style hierarchy starts with a conservative, source-text-only
  // section detector. It does not ask a model to invent headings. Markdown
  // headings, numbered headings, and short title-case lines are retained;
  // all other mail stays in the document's root section.
  const prefix = String(body || "").slice(Math.max(0, offset - 6000), offset);
  const lines = prefix.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line || line.length > 160) {
      continue;
    }
    const match = line.match(
      /^(?:#{1,6}\s+|\d+(?:\.\d+)*[.)]\s+|(?:[A-Z][A-Za-z0-9/& -]{2,}:))(.+)$/u
    );
    if (match) {
      return String(match[1] || line)
        .trim()
        .slice(0, 160);
    }
    if (
      line.length >= 4 &&
      line.length <= 80 &&
      /^[A-Z][A-Za-z0-9/& -]+$/u.test(line) &&
      line.split(/\s+/u).length <= 10
    ) {
      return line;
    }
  }

  // The first child chunk can start at offset zero and still contain a
  // structured section heading later in that chunk. Prefer the first
  // explicit heading in that case so an otherwise small document does not
  // lose its available hierarchy. Do not use the looser title-case fallback
  // here: a subject-like first line is not necessarily a document section.
  const followingLines = String(body || "")
    .slice(Math.max(0, offset), Math.max(0, offset) + CHILD_CHUNK_CHARS)
    .split(/\r?\n/u);
  for (const rawLine of followingLines) {
    const line = rawLine.trim();
    const match = line.match(
      /^(?:#{1,6}\s+|\d+(?:\.\d+)*[.)]\s+|(?:[A-Z][A-Za-z0-9/& -]{2,}:))(.+)$/u
    );
    if (match) {
      return String(match[1] || line)
        .trim()
        .slice(0, 160);
    }
  }
  return "";
}

function contextualChunksForSource(
  record = {},
  {
    sourceField = "body",
    body = "",
    redactionPolicy = "local-only",
    limit = MAX_CHILD_CHUNKS_PER_MESSAGE,
  } = {}
) {
  const parentContext = contextHeader(record);
  const boundedBody = String(body || "").slice(0, 20000);
  if (!boundedBody) {
    const contextualText = parentContext || searchText(record);
    return contextualText
      ? [
          {
            contextualText,
            passageText: "",
            sectionLabel: "",
            startOffset: 0,
            endOffset: 0,
            sourceField: "metadata",
            redactionPolicy,
          },
        ]
      : [];
  }

  const chunks = [];
  let start = 0;
  while (start < boundedBody.length && chunks.length < limit) {
    let end = Math.min(start + CHILD_CHUNK_CHARS, boundedBody.length);
    if (end < boundedBody.length) {
      const boundary = boundedBody.lastIndexOf(" ", end);
      if (boundary > start + CHILD_CHUNK_CHARS / 2) {
        end = boundary;
      }
    }
    const rawPassage = boundedBody.slice(start, end);
    const leadingWhitespace = rawPassage.length - rawPassage.trimStart().length;
    const trailingWhitespace = rawPassage.length - rawPassage.trimEnd().length;
    const passageStart = start + leadingWhitespace;
    const passageEnd = Math.max(passageStart, end - trailingWhitespace);
    const passage = boundedBody
      .slice(passageStart, passageEnd)
      .replace(/\s+/g, " ")
      .trim();
    if (passage) {
      const sectionLabel = sectionLabelForOffset(boundedBody, passageStart);
      chunks.push({
        contextualText: [
          parentContext,
          sectionLabel ? `Section: ${sectionLabel}` : "",
          `Passage ${chunks.length + 1}: ${passage}`,
        ]
          .filter(Boolean)
          .join("\n"),
        passageText: passage,
        sectionLabel,
        startOffset: passageStart,
        endOffset: passageEnd,
        sourceField,
        redactionPolicy,
      });
    }
    if (end >= boundedBody.length) {
      break;
    }
    const nextStart = Math.max(0, end - CHILD_CHUNK_OVERLAP_CHARS);
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

function primaryChunkSource(record = {}) {
  if (record.externalSafeText) {
    return {
      sourceField: "externalSafeText",
      body: record.externalSafeText,
      redactionPolicy: "pre-redacted",
    };
  }
  if (record.redactedText) {
    return {
      sourceField: "redactedText",
      body: record.redactedText,
      redactionPolicy: "pre-redacted",
    };
  }
  if (record.originalBody || record.body) {
    return {
      sourceField: "originalBody",
      body: record.originalBody || record.body,
      redactionPolicy: "local-only",
    };
  }
  // Older records predate canonical source-text artifacts. Preserve that
  // provenance instead of pretending a local field is decoded evidence.
  return {
    sourceField: "localText",
    body: record.localText,
    redactionPolicy: "legacy-local",
  };
}

function selectedMessageIdsForScope(scope = {}) {
  if (!Array.isArray(scope.messageIds)) {
    return [];
  }
  return scope.messageIds.map(String).filter(Boolean).slice(0, 500);
}

function appendScopeConditions(scope = {}, conditions = [], parameters = {}) {
  if (scope.accountKey) {
    conditions.push("records.account_key = :accountKey");
    parameters.accountKey = String(scope.accountKey);
  }
  if (scope.folderURI) {
    conditions.push("records.folder_uri = :folderURI");
    parameters.folderURI = String(scope.folderURI);
  }
}

function endpointDenseQueryIsUsable({ embedding, model, sourceId }) {
  return Boolean(
    embedding.length &&
    model &&
    sourceId &&
    model != LOCAL_PASSAGE_EMBEDDING_MODEL
  );
}

function contextualChunks(record = {}) {
  // Original decoded text is always indexed and cited. A local English
  // derivative is a second retrieval surface only: it makes cross-language
  // queries find the same mail, but never replaces the original evidence.
  const primary = primaryChunkSource(record);
  const chunks = contextualChunksForSource(record, {
    ...primary,
    limit: MAX_CHILD_CHUNKS_PER_MESSAGE,
  });
  const englishBody = String(record.englishBody || "").trim();
  if (
    !record.externalSafeText &&
    !record.redactedText &&
    englishBody &&
    englishBody != String(primary.body || "").trim()
  ) {
    chunks.push(
      ...contextualChunksForSource(record, {
        sourceField: "englishBody",
        body: englishBody,
        redactionPolicy: "derived-local-translation",
        limit: MAX_TRANSLATION_CHUNKS_PER_MESSAGE,
      })
    );
  }
  const derivedHints = [
    Array.isArray(record.retrievalEntityHints) &&
    record.retrievalEntityHints.length
      ? `Entities: ${record.retrievalEntityHints.join("; ")}`
      : "",
    record.privateIntentHint?.label
      ? `Intent: ${record.privateIntentHint.label}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (derivedHints) {
    // These tokens improve candidate selection only. `rowRecord` removes a
    // derived-hints passage before it can enter synthesis or citations.
    chunks.push(
      ...contextualChunksForSource(record, {
        sourceField: "derived-hints",
        body: derivedHints,
        redactionPolicy: "derived-non-evidence",
        limit: MAX_DERIVED_HINT_CHUNKS_PER_MESSAGE,
      })
    );
  }
  return chunks;
}

async function yieldToMainThread() {
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

/**
 * Disposable, profile-local acceleration data for mailbox RAG. AIStorage is
 * always the source of truth; this database can be deleted and rebuilt.
 */
export const AIRAGIndex = {
  _connection: null,
  _connectionPath: "",
  _openPromise: null,
  _openingConnection: null,
  _rebuildPromise: null,
  _passageBackfillPromise: null,
  _passageBackfillRequested: false,
  _passageBackfillStopRequested: false,
  _passageBackfillOptions: null,
  _lastRebuild: null,
  _ftsAvailable: false,
  _shutdownBlockerRegistered: false,
  _pendingIds: new Set(),
  _pendingStartGeneration: 0,
  _pendingEndGeneration: 0,
  _forceRebuild: false,

  observe(_subject, topic, data) {
    if (topic != AI_STORAGE_RECORD_CHANGED_TOPIC) {
      return;
    }
    if (data == "*") {
      this._forceRebuild = true;
      this._pendingIds.clear();
      this._pendingStartGeneration = 0;
      this._pendingEndGeneration = 0;
      return;
    }
    let generation = 0;
    try {
      generation = AIStorage.getRecordGeneration();
    } catch {
      this._forceRebuild = true;
      return;
    }
    if (!this._pendingStartGeneration) {
      this._pendingStartGeneration = generation;
    }
    this._pendingEndGeneration = generation;
    this._pendingIds.add(String(data || ""));
  },

  async _open() {
    const path = AIRuntimePaths.ragIndexFilePath();
    if (this._connection && !(await IOUtils.exists(path))) {
      await this.close();
    }
    if (this._connection && this._connectionPath != path) {
      await this.close();
    }
    if (this._connection) {
      return this._connection;
    }
    if (!this._openPromise) {
      this._openPromise = (async () => {
        await IOUtils.makeDirectory(AIRuntimePaths.aiDataRootDir(), {
          createAncestors: true,
          ignoreExisting: true,
        });
        let connection;
        try {
          connection = await lazy.Sqlite.openConnection({
            path,
            sharedMemoryCache: false,
            extensions: ["fts5"],
          });
          this._ftsAvailable = true;
        } catch {
          // Some downstream SQLite builds do not package Gecko's allow-listed
          // FTS5 extension. Keep the index usable with its lexical fallback.
          connection = await lazy.Sqlite.openConnection({
            path,
            sharedMemoryCache: false,
          });
          this._ftsAvailable = false;
        }
        this._openingConnection = connection;
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )`);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_records (
            message_id TEXT PRIMARY KEY,
            account_key TEXT NOT NULL,
            folder_uri TEXT NOT NULL,
            date_ms INTEGER NOT NULL,
            search_text TEXT NOT NULL,
            record_json TEXT NOT NULL
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_records_account " +
            "ON rag_records(account_key, date_ms DESC)"
        );
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_records_folder " +
            "ON rag_records(folder_uri, date_ms DESC)"
        );
        // Typed, source-derived aggregate inputs. This avoids treating a
        // generated mailbox digest as the source of a count or facet.
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_record_rollups (
            message_id TEXT PRIMARY KEY,
            account_key TEXT NOT NULL,
            folder_uri TEXT NOT NULL,
            date_ms INTEGER NOT NULL,
            month_bucket TEXT NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_domain TEXT NOT NULL,
            template_family TEXT NOT NULL,
            thread_key TEXT NOT NULL,
            needs_reply INTEGER NOT NULL,
            high_priority INTEGER NOT NULL,
            action_count INTEGER NOT NULL,
            risk_count INTEGER NOT NULL,
            security_verdict TEXT NOT NULL
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_record_rollups_scope " +
            "ON rag_record_rollups(account_key, folder_uri, date_ms DESC)"
        );
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_record_rollups_category " +
            "ON rag_record_rollups(category, date_ms DESC)"
        );
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_exact_entities (
            message_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            normalized_value TEXT NOT NULL,
            PRIMARY KEY(message_id, entity_type, normalized_value)
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_exact_entities_lookup " +
            "ON rag_exact_entities(entity_type, normalized_value, message_id)"
        );
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_chunks (
            chunk_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            account_key TEXT NOT NULL,
            folder_uri TEXT NOT NULL,
            date_ms INTEGER NOT NULL,
            chunk_text TEXT NOT NULL,
            passage_text TEXT NOT NULL DEFAULT '',
            section_label TEXT NOT NULL DEFAULT '',
            start_offset INTEGER NOT NULL DEFAULT 0,
            end_offset INTEGER NOT NULL DEFAULT 0,
            source_field TEXT NOT NULL DEFAULT '',
            context_schema_version INTEGER NOT NULL DEFAULT 1,
            input_hash TEXT NOT NULL DEFAULT '',
            embedding_model TEXT NOT NULL DEFAULT '',
            embedding_source_id TEXT NOT NULL DEFAULT '',
            embedding_dimension INTEGER NOT NULL DEFAULT 0,
            redaction_policy TEXT NOT NULL DEFAULT 'local-only',
            embedding_json TEXT NOT NULL DEFAULT '[]'
          )`);
        const chunkColumns = new Set(
          (await connection.execute("PRAGMA table_info(rag_chunks)")).map(row =>
            row.getResultByName("name")
          )
        );
        const missingChunkColumns = [
          ["passage_text", "TEXT NOT NULL DEFAULT ''"],
          ["section_label", "TEXT NOT NULL DEFAULT ''"],
          ["start_offset", "INTEGER NOT NULL DEFAULT 0"],
          ["end_offset", "INTEGER NOT NULL DEFAULT 0"],
          ["source_field", "TEXT NOT NULL DEFAULT ''"],
          ["context_schema_version", "INTEGER NOT NULL DEFAULT 1"],
          ["input_hash", "TEXT NOT NULL DEFAULT ''"],
          ["embedding_model", "TEXT NOT NULL DEFAULT ''"],
          ["embedding_source_id", "TEXT NOT NULL DEFAULT ''"],
          ["embedding_dimension", "INTEGER NOT NULL DEFAULT 0"],
          ["redaction_policy", "TEXT NOT NULL DEFAULT 'local-only'"],
          ["embedding_json", "TEXT NOT NULL DEFAULT '[]'"],
        ];
        for (const [name, definition] of missingChunkColumns) {
          if (!chunkColumns.has(name)) {
            await connection.execute(
              `ALTER TABLE rag_chunks ADD COLUMN ${name} ${definition}`
            );
          }
        }
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_chunks_message " +
            "ON rag_chunks(message_id, chunk_index)"
        );
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_chunks_scope " +
            "ON rag_chunks(account_key, folder_uri, date_ms DESC)"
        );
        const embeddingSourceIndexColumns = (
          await connection.execute(
            "PRAGMA index_info(rag_chunks_embedding_source)"
          )
        ).map(row => row.getResultByName("name"));
        if (
          embeddingSourceIndexColumns.length &&
          embeddingSourceIndexColumns.join("\n") !=
            [
              "embedding_model",
              "embedding_source_id",
              "embedding_dimension",
              "date_ms",
            ].join("\n")
        ) {
          // CREATE INDEX IF NOT EXISTS does not update the column list of an
          // index created by an older schema. Rebuild only that disposable
          // index instead of paying the cost on every application start.
          await connection.execute("DROP INDEX rag_chunks_embedding_source");
        }
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_chunks_embedding_source " +
            "ON rag_chunks(embedding_model, embedding_source_id, embedding_dimension, date_ms DESC)"
        );
        const vectorBucketColumns = new Set(
          (
            await connection.execute("PRAGMA table_info(rag_vector_buckets)")
          ).map(row => row.getResultByName("name"))
        );
        if (
          vectorBucketColumns.size &&
          !vectorBucketColumns.has("embedding_source_id")
        ) {
          // The vector buckets are fully disposable. Recreate this small
          // acceleration table so source identity participates in its key;
          // ALTER TABLE cannot extend an existing SQLite primary key.
          await connection.execute(
            "DROP INDEX IF EXISTS rag_vector_buckets_lookup"
          );
          await connection.execute("DROP TABLE rag_vector_buckets");
        }
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_vector_buckets (
            chunk_id TEXT NOT NULL,
            embedding_model TEXT NOT NULL,
            embedding_source_id TEXT NOT NULL DEFAULT '',
            embedding_dimension INTEGER NOT NULL,
            bucket_key TEXT NOT NULL,
            PRIMARY KEY(
              chunk_id, embedding_model, embedding_source_id,
              embedding_dimension, bucket_key
            )
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_vector_buckets_lookup " +
            "ON rag_vector_buckets(embedding_model, embedding_source_id, embedding_dimension, bucket_key, chunk_id)"
        );
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_scope_overviews (
            cache_key TEXT PRIMARY KEY,
            source_generation INTEGER NOT NULL,
            built_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          )`);
        // Overview payloads are derived from source records. Keep their
        // dependencies explicitly instead of invalidating every scope whenever
        // any mail changes. This is intentionally a small relational cache,
        // not an LLM summary store: a cache miss always rebuilds from the
        // canonical AIStorage records.
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_scope_overview_dependencies (
            cache_key TEXT NOT NULL,
            message_id TEXT NOT NULL,
            PRIMARY KEY(cache_key, message_id)
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_scope_overview_dependency_message " +
            "ON rag_scope_overview_dependencies(message_id, cache_key)"
        );
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS rag_scope_overview_scopes (
            cache_key TEXT PRIMARY KEY,
            scope_mode TEXT NOT NULL,
            account_key TEXT NOT NULL,
            folder_uri TEXT NOT NULL
          )`);
        await connection.execute(
          "CREATE INDEX IF NOT EXISTS rag_scope_overview_scopes_lookup " +
            "ON rag_scope_overview_scopes(scope_mode, account_key, folder_uri)"
        );
        try {
          await connection.execute(`
            CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts
            USING fts5(chunk_id UNINDEXED, message_id UNINDEXED, chunk_text)`);
          // Schema versions before 4 duplicated every message in a second FTS
          // table. Retrieval now searches contextual child chunks only, so
          // retaining that unused table wastes rebuild time and profile space.
          await connection.execute("DROP TABLE IF EXISTS rag_records_fts");
          this._ftsAvailable = true;
        } catch {
          this._ftsAvailable = false;
        }
        this._connection = connection;
        this._connectionPath = path;
        if (!this._shutdownBlockerRegistered) {
          lazy.AsyncShutdown.profileBeforeChange.addBlocker(
            "Thunderbird AI local RAG index close",
            () => this.close()
          );
          this._shutdownBlockerRegistered = true;
        }
        this._openingConnection = null;
        return connection;
      })().catch(async error => {
        const openingConnection = this._openingConnection;
        this._openingConnection = null;
        if (openingConnection) {
          await openingConnection.close();
        }
        if (!isCorruptIndexError(error)) {
          throw error;
        }
        // No canonical mail data is removed here. The next _open creates an
        // empty sidecar and ensureCurrent rebuilds it from AIStorage.
        this._connection = null;
        this._connectionPath = "";
        this._ftsAvailable = false;
        this._lastRebuild = null;
        await removeDerivedIndexFiles(path);
        this._openPromise = null;
        return this._open();
      });
    }
    try {
      return await this._openPromise;
    } finally {
      this._openPromise = null;
    }
  },

  async _meta(key) {
    const connection = await this._open();
    const rows = await connection.executeCached(
      "SELECT value FROM rag_meta WHERE key = :key",
      { key }
    );
    return rows[0]?.getResultByName("value") || "";
  },

  async _setMeta(key, value) {
    const connection = await this._open();
    await connection.executeCached(
      `INSERT INTO rag_meta(key, value) VALUES(:key, :value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      { key, value: String(value) }
    );
  },

  async ensureCurrent() {
    await AIStorage.init();
    const sourceGeneration = AIStorage.getRecordGeneration();
    const indexedGeneration = Number(await this._meta("recordGeneration"));
    const schemaVersion = Number(await this._meta("schemaVersion"));
    if (
      indexedGeneration == sourceGeneration &&
      schemaVersion == SCHEMA_VERSION
    ) {
      return {
        rebuilt: false,
        updateMode: "current",
        updatedRecords: 0,
        sourceGeneration,
        indexedGeneration,
        recordCount: AIStorage.getMessageCount(),
      };
    }
    if (
      !this._forceRebuild &&
      schemaVersion == SCHEMA_VERSION &&
      this._pendingIds.size &&
      this._pendingStartGeneration == indexedGeneration + 1 &&
      this._pendingEndGeneration == sourceGeneration
    ) {
      if (!this._rebuildPromise) {
        this._rebuildPromise = this._applyPending(sourceGeneration);
      }
      try {
        return await this._rebuildPromise;
      } finally {
        this._rebuildPromise = null;
      }
    }
    if (!this._rebuildPromise) {
      this._rebuildPromise = this._rebuild(sourceGeneration);
    }
    try {
      return await this._rebuildPromise;
    } finally {
      this._rebuildPromise = null;
    }
  },

  /**
   * Return a compact, source-derived outline for one already-indexed mail
   * record. This is deliberately not an LLM-generated document map: labels,
   * offsets, and previews are all taken from the locally stored child chunks.
   * Callers remain responsible for enforcing their mailbox scope.
   *
   * @param {object} root0
   * @param {string} root0.messageId
   * @param {number} root0.limit
   */
  async getDocumentOutline({ messageId = "", limit = 24 } = {}) {
    const id = String(messageId || "")
      .trim()
      .slice(0, 2000);
    const sectionLimit = Math.max(1, Math.min(Number(limit) || 24, 48));
    if (!id) {
      return { messageId: "", found: false, sections: [] };
    }
    await this.ensureCurrent();
    const connection = await this._open();
    const rows = await connection.executeCached(
      `SELECT records.record_json, chunks.chunk_index, chunks.section_label,
              chunks.start_offset, chunks.end_offset, chunks.source_field,
              chunks.passage_text
         FROM rag_chunks AS chunks
         JOIN rag_records AS records ON records.message_id = chunks.message_id
        WHERE chunks.message_id = :messageId
        ORDER BY chunks.chunk_index ASC
        LIMIT :limit`,
      { messageId: id, limit: sectionLimit * 12 }
    );
    if (!rows.length) {
      return { messageId: id, found: false, sections: [] };
    }
    let record = {};
    try {
      record = JSON.parse(rows[0].getResultByName("record_json"));
    } catch {}
    const grouped = new Map();
    for (const row of rows) {
      const label =
        String(row.getResultByName("section_label") || "").trim() ||
        "Document root";
      const current = grouped.get(label) || {
        label,
        sourceField: String(row.getResultByName("source_field") || ""),
        firstChunk: Number(row.getResultByName("chunk_index")) || 0,
        lastChunk: Number(row.getResultByName("chunk_index")) || 0,
        startOffset: Number(row.getResultByName("start_offset")) || 0,
        endOffset: Number(row.getResultByName("end_offset")) || 0,
        passageCount: 0,
        preview: "",
      };
      current.firstChunk = Math.min(
        current.firstChunk,
        Number(row.getResultByName("chunk_index")) || 0
      );
      current.lastChunk = Math.max(
        current.lastChunk,
        Number(row.getResultByName("chunk_index")) || 0
      );
      current.startOffset = Math.min(
        current.startOffset,
        Number(row.getResultByName("start_offset")) || 0
      );
      current.endOffset = Math.max(
        current.endOffset,
        Number(row.getResultByName("end_offset")) || 0
      );
      current.passageCount++;
      current.preview ||= String(row.getResultByName("passage_text") || "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 280);
      grouped.set(label, current);
    }
    return {
      messageId: id,
      found: true,
      document: {
        subject: String(record.subject || "").slice(0, 500),
        author: String(record.author || "").slice(0, 500),
        date: Number(record.date) || 0,
      },
      sections: Array.from(grouped.values()).slice(0, sectionLimit),
    };
  },

  /**
   * Return compact indexing state for one message without forcing a rebuild.
   * Timeline callers use this to distinguish a stored canonical record from
   * passages that have actually reached the disposable RAG index. Calling
   * ensureCurrent here would make merely opening the Timeline unexpectedly
   * rebuild a large mailbox index.
   */
  async getMessageStatus({ messageId = "" } = {}) {
    const id = String(messageId || "")
      .trim()
      .slice(0, 2000);
    if (!id) {
      return {
        messageId: "",
        found: false,
        passageCount: 0,
        current: false,
      };
    }
    await AIStorage.init();
    const connection = await this._open();
    const [row] = await connection.executeCached(
      `SELECT COUNT(*) AS passage_count
         FROM rag_chunks
        WHERE message_id = :messageId`,
      { messageId: id }
    );
    const indexedGeneration = Number(await this._meta("recordGeneration"));
    const sourceGeneration = AIStorage.getRecordGeneration();
    const passageCount = Number(row?.getResultByName("passage_count")) || 0;
    return {
      messageId: id,
      found: passageCount > 0,
      passageCount,
      current:
        passageCount > 0 &&
        indexedGeneration >= sourceGeneration &&
        Number(await this._meta("schemaVersion")) == SCHEMA_VERSION,
    };
  },

  async _writeRecord(
    connection,
    messageId,
    record,
    { replaceExisting = true } = {}
  ) {
    if (replaceExisting) {
      await connection.executeCached(
        "DELETE FROM rag_record_rollups WHERE message_id = :messageId",
        { messageId }
      );
      await connection.executeCached(
        "DELETE FROM rag_exact_entities WHERE message_id = :messageId",
        { messageId }
      );
      await connection.executeCached(
        `DELETE FROM rag_vector_buckets
          WHERE chunk_id IN (
            SELECT chunk_id FROM rag_chunks WHERE message_id = :messageId
          )`,
        { messageId }
      );
      await connection.executeCached(
        "DELETE FROM rag_chunks WHERE message_id = :messageId",
        { messageId }
      );
    }
    if (replaceExisting && this._ftsAvailable) {
      await connection.executeCached(
        "DELETE FROM rag_chunks_fts WHERE message_id = :messageId",
        { messageId }
      );
    }
    if (!record) {
      await connection.executeCached(
        "DELETE FROM rag_records WHERE message_id = :messageId",
        { messageId }
      );
      return;
    }
    const text = searchText(record);
    const recordWriteSQL = replaceExisting
      ? `INSERT INTO rag_records(
         message_id, account_key, folder_uri, date_ms, search_text,
         record_json
       ) VALUES(
         :messageId, :accountKey, :folderURI, :dateMs, :searchText,
         :recordJSON
       ) ON CONFLICT(message_id) DO UPDATE SET
         account_key = excluded.account_key,
         folder_uri = excluded.folder_uri,
         date_ms = excluded.date_ms,
         search_text = excluded.search_text,
         record_json = excluded.record_json`
      : `INSERT INTO rag_records(
         message_id, account_key, folder_uri, date_ms, search_text,
         record_json
       ) VALUES(
         :messageId, :accountKey, :folderURI, :dateMs, :searchText,
         :recordJSON
       )`;
    await connection.executeCached(recordWriteSQL, {
      messageId,
      accountKey: String(record.accountKey || ""),
      folderURI: String(record.folderURI || ""),
      dateMs: Number(record.date) || 0,
      searchText: text,
      recordJSON: JSON.stringify(indexedRecord(record)),
    });
    const rollup = recordRollupValues(record);
    await connection.executeCached(
      `INSERT INTO rag_record_rollups(
         message_id, account_key, folder_uri, date_ms, month_bucket,
         category, status, priority, sender, sender_domain, template_family, thread_key,
         needs_reply, high_priority, action_count, risk_count, security_verdict
       ) VALUES(
         :messageId, :accountKey, :folderURI, :dateMs, :monthBucket,
         :category, :status, :priority, :sender, :senderDomain, :templateFamily, :threadKey,
         :needsReply, :highPriority, :actionCount, :riskCount, :securityVerdict
       )`,
      { messageId, ...rollup }
    );
    for (const entity of exactEntityRows(record)) {
      await connection.executeCached(
        `INSERT OR IGNORE INTO rag_exact_entities(
           message_id, entity_type, normalized_value
         ) VALUES(:messageId, :entityType, :normalizedValue)`,
        {
          messageId,
          entityType: entity.type,
          normalizedValue: entity.value,
        }
      );
    }
    const chunks = contextualChunks(record);
    for (let index = 0; index < chunks.length; index++) {
      const chunkId = `${messageId}:chunk:${index}`;
      const chunk = chunks[index];
      const embedding = localPassageEmbedding(chunk.contextualText);
      await connection.executeCached(
        `INSERT INTO rag_chunks(
           chunk_id, message_id, chunk_index, account_key, folder_uri,
           date_ms, chunk_text, passage_text, section_label, start_offset, end_offset,
           source_field, context_schema_version, input_hash,
           embedding_model, embedding_source_id, embedding_dimension, redaction_policy,
           embedding_json
         ) VALUES(
           :chunkId, :messageId, :chunkIndex, :accountKey, :folderURI,
           :dateMs, :chunkText, :passageText, :sectionLabel, :startOffset, :endOffset,
           :sourceField, :contextSchemaVersion, :inputHash,
           :embeddingModel, :embeddingSourceId, :embeddingDimension, :redactionPolicy,
           :embeddingJSON
         )`,
        {
          chunkId,
          messageId,
          chunkIndex: index,
          accountKey: String(record.accountKey || ""),
          folderURI: String(record.folderURI || ""),
          dateMs: Number(record.date) || 0,
          chunkText: chunk.contextualText,
          passageText: chunk.passageText,
          sectionLabel: chunk.sectionLabel,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          sourceField: chunk.sourceField,
          contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
          inputHash: stableTextHash(chunk.contextualText),
          embeddingModel: LOCAL_PASSAGE_EMBEDDING_MODEL,
          embeddingSourceId: "",
          embeddingDimension: embedding.length,
          redactionPolicy: chunk.redactionPolicy,
          embeddingJSON: JSON.stringify(embedding),
        }
      );
      await writeVectorBuckets(connection, {
        chunkId,
        embeddingModel: LOCAL_PASSAGE_EMBEDDING_MODEL,
        embedding,
      });
      if (this._ftsAvailable) {
        await connection.executeCached(
          `INSERT INTO rag_chunks_fts(
             chunk_id, message_id, chunk_text
           ) VALUES(:chunkId, :messageId, :chunkText)`,
          { chunkId, messageId, chunkText: chunk.contextualText }
        );
      }
    }
  },

  async _applyPending(sourceGeneration) {
    const connection = await this._open();
    const ids = Array.from(this._pendingIds);
    this._pendingIds.clear();
    this._pendingStartGeneration = 0;
    this._pendingEndGeneration = 0;
    await connection.executeTransaction(async () => {
      for (const id of ids) {
        const sourceRecord = AIStorage.getMessage(id);
        // Only cached scopes that actually contained this message become
        // stale. Unrelated folder/account/all-selected cache entries remain
        // valid across the global source-generation increment.
        await connection.executeCached(
          `DELETE FROM rag_scope_overviews
            WHERE cache_key IN (
              SELECT cache_key
                FROM rag_scope_overview_dependencies
               WHERE message_id = :messageId
            )`,
          { messageId: id }
        );
        // A newly created mail cannot yet occur in the dependency table, but
        // it must invalidate the durable cache for scopes that include it.
        // Existing updates/deletes were already handled by the dependency
        // invalidation above, including a move out of an old folder.
        if (sourceRecord) {
          await connection.executeCached(
            `DELETE FROM rag_scope_overviews
              WHERE cache_key IN (
                SELECT cache_key
                  FROM rag_scope_overview_scopes
                 WHERE scope_mode = 'all'
                    OR (scope_mode = 'account' AND account_key = :accountKey)
                    OR (scope_mode = 'folder'
                        AND folder_uri = :folderURI
                        AND (account_key = '' OR account_key = :accountKey))
              )`,
            {
              accountKey: String(sourceRecord.accountKey || ""),
              folderURI: String(sourceRecord.folderURI || ""),
            }
          );
        }
        await this._writeRecord(connection, id, sourceRecord);
      }
      // Dependency rows for removed cache entries are no longer useful. This
      // cleanup is bounded to the small overview sidecar, never the corpus.
      await connection.execute(
        `DELETE FROM rag_scope_overview_dependencies
          WHERE cache_key NOT IN (SELECT cache_key FROM rag_scope_overviews)`
      );
      await connection.execute(
        `DELETE FROM rag_scope_overview_scopes
          WHERE cache_key NOT IN (SELECT cache_key FROM rag_scope_overviews)`
      );
      await this._setMeta("recordGeneration", sourceGeneration);
    });
    return {
      rebuilt: false,
      updateMode: "incremental",
      updatedRecords: ids.length,
      sourceGeneration,
      indexedGeneration: sourceGeneration,
      recordCount: AIStorage.getMessageCount(),
    };
  },

  async _rebuild(sourceGeneration) {
    const connection = await this._open();
    const records = AIStorage.getMessagesByDate();
    const startedAt = Date.now();
    this._pendingIds.clear();
    this._pendingStartGeneration = 0;
    this._pendingEndGeneration = 0;
    this._forceRebuild = false;
    await connection.executeTransaction(async () => {
      await connection.execute("DELETE FROM rag_records");
      await connection.execute("DELETE FROM rag_record_rollups");
      await connection.execute("DELETE FROM rag_exact_entities");
      await connection.execute("DELETE FROM rag_vector_buckets");
      await connection.execute("DELETE FROM rag_chunks");
      await connection.execute("DELETE FROM rag_scope_overviews");
      await connection.execute("DELETE FROM rag_scope_overview_dependencies");
      await connection.execute("DELETE FROM rag_scope_overview_scopes");
      if (this._ftsAvailable) {
        await connection.execute("DELETE FROM rag_chunks_fts");
      }
    });
    // Gecko deliberately times out SQLite transactions that remain open for
    // several minutes. Large mailboxes can exceed that limit even though the
    // rebuild is making steady progress, so commit bounded chunks. The source
    // generation is written only after every chunk succeeds; an interrupted
    // rebuild therefore remains stale and is safely rebuilt on the next use.
    for (
      let batchStart = 0;
      batchStart < records.length;
      batchStart += REBUILD_TRANSACTION_SIZE
    ) {
      const batchEnd = Math.min(
        batchStart + REBUILD_TRANSACTION_SIZE,
        records.length
      );
      await connection.executeTransaction(async () => {
        for (let index = batchStart; index < batchEnd; index++) {
          const record = records[index];
          const messageId = messageIdForRecord(record);
          await this._writeRecord(connection, messageId, record, {
            replaceExisting: false,
          });
          if (index && index % INSERT_YIELD_INTERVAL == 0) {
            await yieldToMainThread();
          }
        }
      });
    }
    await connection.executeTransaction(async () => {
      await this._setMeta("schemaVersion", SCHEMA_VERSION);
      await this._setMeta("recordGeneration", sourceGeneration);
      await this._setMeta("rebuiltAt", now());
    });
    this._lastRebuild = {
      at: now(),
      durationMs: Date.now() - startedAt,
      recordCount: records.length,
    };
    return {
      rebuilt: true,
      sourceGeneration,
      indexedGeneration: sourceGeneration,
      recordCount: records.length,
      durationMs: this._lastRebuild.durationMs,
    };
  },

  async getOverview({
    scope = { scopeMode: "all" },
    scopeCoverage = null,
    redactionRequired = false,
    build,
  } = {}) {
    const indexState = await this.ensureCurrent();
    const selected = scope.scopeMode == "selected";
    const cacheKey = JSON.stringify({
      scope: scopeKey(scope),
      coverage: coverageKey(scopeCoverage),
      redactionRequired: !!redactionRequired,
    });
    const connection = await this._open();
    if (!selected) {
      const rows = await connection.executeCached(
        `SELECT built_at, payload_json FROM rag_scope_overviews
         WHERE cache_key = :cacheKey`,
        { cacheKey }
      );
      if (rows.length) {
        const payload = JSON.parse(rows[0].getResultByName("payload_json"));
        return this._withDiagnostics(payload, indexState, {
          cacheHit: true,
          builtAt: rows[0].getResultByName("built_at"),
          recordsScanned: 0,
        });
      }
    }
    const records = AIStorage.getMessagesByDate(scope);
    const payload = build(records);
    const builtAt = now();
    if (!selected) {
      await connection.executeTransaction(async () => {
        await connection.executeCached(
          `INSERT INTO rag_scope_overviews(
             cache_key, source_generation, built_at, payload_json
           ) VALUES(:cacheKey, :generation, :builtAt, :payloadJSON)
           ON CONFLICT(cache_key) DO UPDATE SET
             source_generation = excluded.source_generation,
             built_at = excluded.built_at,
             payload_json = excluded.payload_json`,
          {
            cacheKey,
            generation: indexState.sourceGeneration,
            builtAt,
            payloadJSON: JSON.stringify(payload),
          }
        );
        await connection.executeCached(
          "DELETE FROM rag_scope_overview_dependencies WHERE cache_key = :cacheKey",
          { cacheKey }
        );
        await connection.executeCached(
          `INSERT INTO rag_scope_overview_scopes(
             cache_key, scope_mode, account_key, folder_uri
           ) VALUES(:cacheKey, :scopeMode, :accountKey, :folderURI)
           ON CONFLICT(cache_key) DO UPDATE SET
             scope_mode = excluded.scope_mode,
             account_key = excluded.account_key,
             folder_uri = excluded.folder_uri`,
          {
            cacheKey,
            scopeMode: String(scope.scopeMode || "all"),
            accountKey: String(scope.accountKey || ""),
            folderURI: String(scope.folderURI || ""),
          }
        );
        for (const record of records) {
          const messageId = messageIdForRecord(record);
          if (!messageId) {
            continue;
          }
          await connection.executeCached(
            `INSERT OR IGNORE INTO rag_scope_overview_dependencies(
               cache_key, message_id
             ) VALUES(:cacheKey, :messageId)`,
            { cacheKey, messageId }
          );
        }
      });
    }
    return this._withDiagnostics(payload, indexState, {
      cacheHit: false,
      builtAt,
      recordsScanned: records.length,
    });
  },

  async getScopeRollup({ scope = { scopeMode: "all" }, limit = 12 } = {}) {
    // Return exact, incrementally maintained aggregate inputs for a scope.
    // This deliberately returns counts and deterministic facets only. Callers
    // that need prose, actions, or a conclusion must drill into source
    // messages rather than treating a generated summary as aggregate evidence.
    const indexState = await this.ensureCurrent();
    const diagnostics = {
      backend: "sqlite-record-rollups-v1",
      rowsScanned: 0,
      sourceGeneration: indexState.sourceGeneration,
      indexedGeneration: indexState.indexedGeneration,
      indexRebuilt: indexState.rebuilt,
      indexUpdateMode: indexState.updateMode,
      updatedRecords: indexState.updatedRecords || 0,
    };
    if (scope.scopeMode == "selected" && !scope.messageIds?.length) {
      return {
        totalMessages: 0,
        dateRange: { oldest: "", newest: "" },
        exactSignals: {},
        dimensions: {},
        diagnostics,
      };
    }
    const connection = await this._open();
    const parameters = {};
    const conditions = [];
    if (scope.accountKey) {
      conditions.push("rollups.account_key = :rollupAccountKey");
      parameters.rollupAccountKey = String(scope.accountKey);
    }
    if (scope.folderURI) {
      conditions.push("rollups.folder_uri = :rollupFolderURI");
      parameters.rollupFolderURI = String(scope.folderURI);
    }
    const selectedIds = selectedMessageIdsForScope(scope);
    if (selectedIds.length) {
      const placeholders = [];
      for (let index = 0; index < selectedIds.length; index++) {
        const name = `rollupMessageId${index}`;
        placeholders.push(`:${name}`);
        parameters[name] = selectedIds[index];
      }
      conditions.push(`rollups.message_id IN (${placeholders.join(", ")})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totals = await connection.executeCached(
      `SELECT COUNT(*) AS total_messages,
              MIN(date_ms) AS oldest_date_ms,
              MAX(date_ms) AS newest_date_ms,
              SUM(needs_reply) AS needs_reply,
              SUM(high_priority) AS high_priority,
              SUM(CASE WHEN action_count > 0 THEN 1 ELSE 0 END) AS action_messages,
              SUM(CASE WHEN risk_count > 0 THEN 1 ELSE 0 END) AS risk_messages,
              SUM(CASE WHEN security_verdict = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
              SUM(CASE WHEN security_verdict = 'dangerous' THEN 1 ELSE 0 END) AS dangerous
         FROM rag_record_rollups AS rollups
         ${where}`,
      parameters
    );
    const total = totals[0];
    const dimensionColumns = {
      category: "category",
      folder: "folder_uri",
      sender: "sender",
      senderDomain: "sender_domain",
      status: "status",
      priority: "priority",
      month: "month_bucket",
      templateFamily: "template_family",
      thread: "thread_key",
    };
    const dimensions = {};
    const groupLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    for (const [name, column] of Object.entries(dimensionColumns)) {
      const dimensionConditions = conditions.slice();
      if (column == "template_family" || column == "thread_key") {
        dimensionConditions.push(`${column} != ''`);
      }
      const dimensionWhere = dimensionConditions.length
        ? `WHERE ${dimensionConditions.join(" AND ")}`
        : "";
      const rows = await connection.executeCached(
        `SELECT ${column} AS value, COUNT(*) AS count
           FROM rag_record_rollups AS rollups
           ${dimensionWhere}
          GROUP BY ${column}
          ORDER BY count DESC, value ASC
          LIMIT :rollupDimensionLimit`,
        { ...parameters, rollupDimensionLimit: groupLimit }
      );
      dimensions[name] = rows.map(row => ({
        value: String(row.getResultByName("value") || ""),
        count: Number(row.getResultByName("count")) || 0,
      }));
    }
    const rangeValue = name => Number(total?.getResultByName(name)) || 0;
    const asISO = dateMs => (dateMs ? new Date(dateMs).toISOString() : "");
    return {
      totalMessages: Number(total?.getResultByName("total_messages")) || 0,
      dateRange: {
        oldest: asISO(rangeValue("oldest_date_ms")),
        newest: asISO(rangeValue("newest_date_ms")),
      },
      exactSignals: {
        needsReply: rangeValue("needs_reply"),
        highPriority: rangeValue("high_priority"),
        actionMessages: rangeValue("action_messages"),
        riskMessages: rangeValue("risk_messages"),
        suspicious: rangeValue("suspicious"),
        dangerous: rangeValue("dangerous"),
      },
      dimensions,
      diagnostics,
    };
  },

  async getScopeAggregate({
    scope = { scopeMode: "all" },
    groupBy = "category",
    limit = 12,
    sampleLimit = 12,
  } = {}) {
    // Exact, source-linked aggregate drill-down. This is intentionally a
    // narrow API instead of exposing arbitrary SQL: every grouping dimension
    // is a canonical per-message field and every returned aggregate carries
    // a bounded set of leaf message ids for citation and inspection.
    const groupColumns = {
      category: "category",
      sender: "sender",
      domain: "sender_domain",
      folder: "folder_uri",
      month: "month_bucket",
      status: "status",
      priority: "priority",
    };
    const normalizedGroupBy = Object.hasOwn(groupColumns, groupBy)
      ? groupBy
      : "category";
    const column = groupColumns[normalizedGroupBy];
    const indexState = await this.ensureCurrent();
    const diagnostics = {
      backend: "sqlite-record-rollups-v1",
      rowsScanned: 0,
      sourceGeneration: indexState.sourceGeneration,
      indexedGeneration: indexState.indexedGeneration,
      indexRebuilt: indexState.rebuilt,
      indexUpdateMode: indexState.updateMode,
      updatedRecords: indexState.updatedRecords || 0,
    };
    if (scope.scopeMode == "selected" && !scope.messageIds?.length) {
      return {
        groupBy: normalizedGroupBy,
        examinedMessages: 0,
        groups: [],
        diagnostics,
      };
    }
    const connection = await this._open();
    const parameters = {};
    const conditions = [];
    if (scope.accountKey) {
      conditions.push("rollups.account_key = :aggregateAccountKey");
      parameters.aggregateAccountKey = String(scope.accountKey);
    }
    if (scope.folderURI) {
      conditions.push("rollups.folder_uri = :aggregateFolderURI");
      parameters.aggregateFolderURI = String(scope.folderURI);
    }
    const selectedIds = Array.isArray(scope.messageIds)
      ? scope.messageIds.map(String).filter(Boolean).slice(0, 500)
      : [];
    if (selectedIds.length) {
      const placeholders = [];
      for (let index = 0; index < selectedIds.length; index++) {
        const name = `aggregateMessageId${index}`;
        placeholders.push(`:${name}`);
        parameters[name] = selectedIds[index];
      }
      conditions.push(`rollups.message_id IN (${placeholders.join(", ")})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    // Keep the public value format consistent with the legacy JS tool: blank
    // canonical values are represented as "unknown", never silently merged
    // into another group.
    const valueExpression = `COALESCE(NULLIF(rollups.${column}, ''), 'unknown')`;
    const groupLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    const leafLimit = Math.max(1, Math.min(Number(sampleLimit) || 12, 20));
    const rows = await connection.executeCached(
      `SELECT ${valueExpression} AS value, COUNT(*) AS count
         FROM rag_record_rollups AS rollups
         ${where}
        GROUP BY ${valueExpression}
        ORDER BY count DESC, value ASC
        LIMIT :aggregateGroupLimit`,
      { ...parameters, aggregateGroupLimit: groupLimit }
    );
    const totalRows = await connection.executeCached(
      `SELECT COUNT(*) AS total_messages
         FROM rag_record_rollups AS rollups
         ${where}`,
      parameters
    );
    const groups = [];
    for (const row of rows) {
      const value = String(row.getResultByName("value") || "unknown");
      const leafRows = await connection.executeCached(
        `SELECT rollups.message_id
           FROM rag_record_rollups AS rollups
           ${where ? `${where} AND` : "WHERE"}
             ${valueExpression} = :aggregateGroupValue
          ORDER BY rollups.date_ms DESC, rollups.message_id ASC
          LIMIT :aggregateLeafLimit`,
        {
          ...parameters,
          aggregateGroupValue: value,
          aggregateLeafLimit: leafLimit,
        }
      );
      groups.push({
        [normalizedGroupBy]: value,
        count: Number(row.getResultByName("count")) || 0,
        messageIds: leafRows.map(leaf =>
          String(leaf.getResultByName("message_id") || "")
        ),
      });
    }
    return {
      groupBy: normalizedGroupBy,
      examinedMessages:
        Number(totalRows[0]?.getResultByName("total_messages")) || 0,
      groups,
      diagnostics,
    };
  },

  async searchExact({
    constraints = {},
    scope = { scopeMode: "all" },
    limit = 8,
  } = {}) {
    const requirements = [
      ...(constraints.identifiers || []).map(value => ({
        type: "identifier",
        value: normalizedIdentifier(value),
      })),
      ...(constraints.amounts || []).map(amount => ({
        type: "amount",
        value:
          amount?.currency && Number.isFinite(Number(amount?.minorUnits))
            ? `${String(amount.currency).toLocaleUpperCase()}:${Number(
                amount.minorUnits
              )}`
            : "",
      })),
      ...(constraints.dates || []).map(date => ({
        type: "date",
        value: String(date?.iso || ""),
      })),
    ].filter(requirement => requirement.value);
    if (!requirements.length) {
      return {
        records: [],
        diagnostics: {
          backend: "sqlite",
          mode: "empty-exact-query",
          resultCount: 0,
          constraintCount: 0,
        },
      };
    }
    if (scope.scopeMode == "selected" && !scope.messageIds?.length) {
      return {
        records: [],
        diagnostics: {
          backend: "sqlite",
          mode: "exact-entities",
          resultCount: 0,
          constraintCount: requirements.length,
        },
      };
    }
    const indexState = await this.ensureCurrent();
    const connection = await this._open();
    const parameters = {
      limit: Math.max(1, Math.min(Number(limit) || 8, 50)),
    };
    const conditions = [];
    appendScopeConditions(scope, conditions, parameters);
    const selectedIds = Array.isArray(scope.messageIds)
      ? scope.messageIds.map(String).filter(Boolean).slice(0, 500)
      : [];
    if (selectedIds.length) {
      const placeholders = [];
      for (let index = 0; index < selectedIds.length; index++) {
        const name = `exactMessageId${index}`;
        placeholders.push(`:${name}`);
        parameters[name] = selectedIds[index];
      }
      conditions.push(`records.message_id IN (${placeholders.join(", ")})`);
    }
    for (let index = 0; index < requirements.length; index++) {
      const requirement = requirements[index];
      const typeName = `exactType${index}`;
      const valueName = `exactValue${index}`;
      parameters[typeName] = requirement.type;
      parameters[valueName] = requirement.value;
      conditions.push(`EXISTS (
        SELECT 1 FROM rag_exact_entities AS exact_${index}
         WHERE exact_${index}.message_id = records.message_id
           AND exact_${index}.entity_type = :${typeName}
           AND exact_${index}.normalized_value = :${valueName}
      )`);
    }
    const rows = await connection.executeCached(
      `SELECT records.record_json
         FROM rag_records AS records
        WHERE ${conditions.join(" AND ")}
        ORDER BY records.date_ms DESC
        LIMIT :limit`,
      parameters
    );
    const records = rows.map(row =>
      JSON.parse(row.getResultByName("record_json"))
    );
    return {
      records,
      diagnostics: {
        backend: "sqlite",
        mode: "exact-entities",
        resultCount: records.length,
        constraintCount: requirements.length,
        sourceGeneration: indexState.sourceGeneration,
        indexedGeneration: indexState.indexedGeneration,
        indexRebuilt: indexState.rebuilt,
        indexUpdateMode: indexState.updateMode,
        updatedRecords: indexState.updatedRecords || 0,
      },
    };
  },

  async search({
    query = "",
    queryEmbedding = null,
    queryEmbeddingModel = "",
    queryEmbeddingSourceId = "",
    scope = { scopeMode: "all" },
    limit = 8,
  } = {}) {
    const terms = searchTerms(query);
    if (!terms.length) {
      return {
        records: [],
        diagnostics: {
          backend: "sqlite",
          mode: "empty-query",
          resultCount: 0,
        },
      };
    }
    const indexState = await this.ensureCurrent();
    const connection = await this._open();
    const resultLimit = Math.max(1, Math.min(Number(limit) || 8, 50));
    const parameters = {
      rowLimit: Math.min(resultLimit * 4, 200),
    };
    const conditions = [];
    if (scope.accountKey) {
      conditions.push("records.account_key = :accountKey");
      parameters.accountKey = String(scope.accountKey);
    }
    if (scope.folderURI) {
      conditions.push("records.folder_uri = :folderURI");
      parameters.folderURI = String(scope.folderURI);
    }
    const selectedIds = Array.isArray(scope.messageIds)
      ? scope.messageIds.map(String).filter(Boolean).slice(0, 500)
      : [];
    if (selectedIds.length) {
      const placeholders = [];
      for (let index = 0; index < selectedIds.length; index++) {
        const name = `messageId${index}`;
        placeholders.push(`:${name}`);
        parameters[name] = selectedIds[index];
      }
      conditions.push(`records.message_id IN (${placeholders.join(", ")})`);
    }

    const baseConditions = conditions.slice();
    const denseParameters = { ...parameters };
    delete denseParameters.rowLimit;
    let lexicalRows;
    let mode;
    if (this._ftsAvailable) {
      parameters.match = terms.map(term => `"${term}"*`).join(" OR ");
      const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
      lexicalRows = await connection.executeCached(
        `SELECT records.record_json, chunks.chunk_id, chunks.chunk_index,
                chunks.chunk_text, chunks.passage_text, chunks.section_label,
                chunks.start_offset, chunks.end_offset, chunks.source_field,
                chunks.context_schema_version, chunks.input_hash,
                chunks.embedding_model, chunks.embedding_source_id,
                chunks.embedding_dimension,
                chunks.redaction_policy, chunks.embedding_json
           FROM rag_chunks_fts AS fts
           JOIN rag_chunks AS chunks ON chunks.chunk_id = fts.chunk_id
           JOIN rag_records AS records
             ON records.message_id = fts.message_id
          WHERE rag_chunks_fts MATCH :match ${where}
          ORDER BY bm25(rag_chunks_fts), records.date_ms DESC
          LIMIT :rowLimit`,
        parameters
      );
      mode = "fts5";
    } else {
      const lexical = [];
      for (let index = 0; index < terms.length; index++) {
        const name = `term${index}`;
        lexical.push(`chunks.chunk_text LIKE :${name} ESCAPE '\\'`);
        parameters[name] = `%${terms[index]}%`;
      }
      conditions.push(`(${lexical.join(" OR ")})`);
      lexicalRows = await connection.executeCached(
        `SELECT records.record_json, chunks.chunk_id, chunks.chunk_index,
                chunks.chunk_text, chunks.passage_text, chunks.section_label,
                chunks.start_offset, chunks.end_offset, chunks.source_field,
                chunks.context_schema_version, chunks.input_hash,
                chunks.embedding_model, chunks.embedding_source_id,
                chunks.embedding_dimension,
                chunks.redaction_policy, chunks.embedding_json
           FROM rag_chunks AS chunks
           JOIN rag_records AS records
             ON records.message_id = chunks.message_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY records.date_ms DESC
          LIMIT :rowLimit`,
        parameters
      );
      mode = "sqlite-like";
    }

    const localQueryEmbedding = localPassageEmbedding(query);
    const denseRows = lexicalRows.filter(
      row =>
        row.getResultByName("embedding_model") == LOCAL_PASSAGE_EMBEDDING_MODEL
    );
    let endpointDenseRows = [];
    let denseProbeCount = 0;
    const endpointDenseLimit = MAX_ENDPOINT_DENSE_CANDIDATES;
    const endpointQueryModel = String(queryEmbeddingModel || "").trim();
    const endpointQuerySourceId = String(queryEmbeddingSourceId || "").trim();
    const normalizedQueryEmbedding = normalizeEmbeddingVector(queryEmbedding);
    const endpointDenseEnabled = endpointDenseQueryIsUsable({
      embedding: normalizedQueryEmbedding,
      model: endpointQueryModel,
      sourceId: endpointQuerySourceId,
    });
    if (endpointDenseEnabled) {
      denseParameters.queryModel = endpointQueryModel;
      denseParameters.querySourceId = endpointQuerySourceId;
      denseParameters.queryDimension = normalizedQueryEmbedding.length;
      denseParameters.denseRowLimit = endpointDenseLimit;
      const bucketKeys = vectorBucketKeys(normalizedQueryEmbedding, {
        includeNeighbors: true,
      });
      denseProbeCount = bucketKeys.length;
      const bucketPlaceholders = [];
      for (let index = 0; index < bucketKeys.length; index++) {
        const name = `denseBucket${index}`;
        bucketPlaceholders.push(`:${name}`);
        denseParameters[name] = bucketKeys[index];
      }
      const endpointConditions = [
        ...baseConditions,
        "chunks.embedding_model = :queryModel",
        "chunks.embedding_source_id = :querySourceId",
        "chunks.embedding_dimension = :queryDimension",
        "chunks.chunk_id IN (SELECT buckets.chunk_id FROM rag_vector_buckets AS buckets WHERE buckets.embedding_model = :queryModel AND buckets.embedding_source_id = :querySourceId AND buckets.embedding_dimension = :queryDimension AND buckets.bucket_key IN (" +
          bucketPlaceholders.join(", ") +
          "))",
      ];
      endpointDenseRows = await connection.executeCached(
        `SELECT records.record_json, chunks.chunk_id, chunks.chunk_index,
                chunks.chunk_text, chunks.passage_text, chunks.section_label,
                chunks.start_offset, chunks.end_offset, chunks.source_field,
                chunks.context_schema_version, chunks.input_hash,
                chunks.embedding_model, chunks.embedding_source_id,
                chunks.embedding_dimension,
                chunks.redaction_policy, chunks.embedding_json
           FROM rag_chunks AS chunks
           JOIN rag_records AS records ON records.message_id = chunks.message_id
          WHERE ${endpointConditions.join(" AND ")}
          ORDER BY chunks.date_ms DESC
          LIMIT :denseRowLimit`,
        denseParameters
      );
      denseRows.push(...endpointDenseRows);
    }
    const denseMatches = [];
    for (const row of denseRows) {
      let embedding = [];
      try {
        embedding = JSON.parse(row.getResultByName("embedding_json"));
      } catch {}
      const model = row.getResultByName("embedding_model");
      if (
        model == LOCAL_PASSAGE_EMBEDDING_MODEL &&
        !terms.some(term =>
          String(row.getResultByName("chunk_text"))
            .toLocaleLowerCase()
            .includes(term)
        )
      ) {
        continue;
      }
      let candidateQuery = [];
      if (model == LOCAL_PASSAGE_EMBEDDING_MODEL) {
        candidateQuery = localQueryEmbedding;
      } else if (normalizedQueryEmbedding.length) {
        candidateQuery = normalizedQueryEmbedding;
      }
      const score = cosineSimilarity(candidateQuery, embedding);
      if (score > 0) {
        denseMatches.push({ row, score });
      }
    }
    denseMatches.sort((left, right) => right.score - left.score);

    const rowRecord = (row, channels, denseScore = 0) => {
      const record = JSON.parse(row.getResultByName("record_json"));
      const messageId = messageIdForRecord(record);
      const sourceField = row.getResultByName("source_field");
      const derivedHint = ["derived-hints", "englishBody"].includes(
        sourceField
      );
      record.retrievalMatch = {
        unit: "child-chunk",
        chunkId: derivedHint ? "" : row.getResultByName("chunk_id"),
        chunkIndex: row.getResultByName("chunk_index"),
        parentMessageId: messageId,
        // Derived model output may rank a record, but never enters the
        // answer/citation evidence pack as a purported mail passage.
        text: derivedHint ? "" : row.getResultByName("chunk_text"),
        passageText: derivedHint ? "" : row.getResultByName("passage_text"),
        sectionLabel: row.getResultByName("section_label"),
        startOffset: derivedHint ? 0 : row.getResultByName("start_offset"),
        endOffset: derivedHint ? 0 : row.getResultByName("end_offset"),
        sourceField: derivedHint ? "" : sourceField,
        rankingSourceField: sourceField,
        derivedHint,
        contextSchemaVersion: row.getResultByName("context_schema_version"),
        inputHash: row.getResultByName("input_hash"),
        embeddingModel: row.getResultByName("embedding_model"),
        embeddingSourceId: row.getResultByName("embedding_source_id"),
        embeddingDimension: row.getResultByName("embedding_dimension"),
        redactionPolicy: row.getResultByName("redaction_policy"),
        channels,
        denseScore,
      };
      record.retrievalChannels = channels.slice();
      record.similarity = denseScore;
      return record;
    };
    const uniqueParents = source => {
      const seen = new Set();
      const records = [];
      for (const item of source) {
        const row = item.row || item;
        const record = JSON.parse(row.getResultByName("record_json"));
        const messageId = messageIdForRecord(record);
        if (seen.has(messageId)) {
          continue;
        }
        seen.add(messageId);
        records.push({ row, score: Number(item.score) || 0, messageId });
        if (records.length >= Math.min(resultLimit * 4, 200)) {
          break;
        }
      }
      return records;
    };
    const lexicalParents = uniqueParents(lexicalRows);
    const denseParents = uniqueParents(denseMatches);
    const fused = new Map();
    const addChannel = (item, channel, rank) => {
      let candidate = fused.get(item.messageId);
      if (!candidate) {
        candidate = {
          row: item.row,
          score: 0,
          denseScore: 0,
          channels: [],
        };
        fused.set(item.messageId, candidate);
      }
      candidate.score += 1 / (60 + rank + 1);
      candidate.denseScore = Math.max(candidate.denseScore, item.score);
      if (!candidate.channels.includes(channel)) {
        candidate.channels.push(channel);
      }
      if (channel == "passage-dense") {
        candidate.row = item.row;
      }
    };
    lexicalParents.forEach((item, rank) =>
      addChannel(item, "passage-lexical", rank)
    );
    denseParents.forEach((item, rank) =>
      addChannel(item, "passage-dense", rank)
    );
    const records = Array.from(fused.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, resultLimit)
      .map(candidate =>
        rowRecord(candidate.row, candidate.channels, candidate.denseScore)
      );
    const endpointDenseMatches = denseParents.filter(
      item =>
        item.row.getResultByName("embedding_model") !=
        LOCAL_PASSAGE_EMBEDDING_MODEL
    ).length;
    const localDenseMatches = denseParents.length - endpointDenseMatches;
    if (denseParents.length) {
      mode = `${mode}+dense`;
    }
    return {
      records,
      diagnostics: {
        backend: "sqlite",
        mode,
        resultCount: records.length,
        queryTermCount: terms.length,
        retrievalUnit: "child-chunk",
        matchedChunkCount: lexicalRows.length + denseMatches.length,
        uniqueParentCount: records.length,
        lexicalParentCount: lexicalParents.length,
        denseParentCount: denseParents.length,
        endpointDenseParentCount: endpointDenseMatches,
        localDenseParentCount: localDenseMatches,
        denseRowsScanned: denseRows.length,
        denseScanLimit: endpointDenseLimit,
        denseScanTruncated: endpointDenseRows.length == endpointDenseLimit,
        denseCandidateIndex: endpointDenseEnabled
          ? "sqlite-lsh-v1"
          : "lexical-local-only",
        denseProbeCount,
        contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
        sourceGeneration: indexState.sourceGeneration,
        indexedGeneration: indexState.indexedGeneration,
        indexRebuilt: indexState.rebuilt,
        indexUpdateMode: indexState.updateMode,
        updatedRecords: indexState.updatedRecords || 0,
      },
    };
  },

  async backfillPassageEmbeddings({
    scope = { scopeMode: "all" },
    limit = 128,
  } = {}) {
    await AIStorage.init();
    const sourceGeneration = AIStorage.getRecordGeneration();
    const accountKey = scope.accountKey || null;
    const hasDedicatedSource = Services.prefs.prefHasUserValue(
      "mail.ai.embedder.source_id"
    );
    const sourceId = Services.prefs
      .getStringPref("mail.ai.embedder.source_id", "")
      .trim();
    if (!hasDedicatedSource || !sourceId) {
      return {
        status: "local-fallback",
        reason:
          "No dedicated passage embedder is selected; deterministic on-device passage vectors remain active.",
        updatedCount: 0,
        model: LOCAL_PASSAGE_EMBEDDING_MODEL,
        sourceGeneration,
      };
    }
    if (!Services.prefs.getBoolPref("mail.ai.endpoint.background", false)) {
      return {
        status: "disabled",
        reason: "Background endpoint use is disabled.",
        updatedCount: 0,
        sourceGeneration,
      };
    }
    const config = AIEndpoint.getConfig(accountKey, {
      role: "embedder",
      sourceId,
    });
    const embeddingModel = String(
      config.model || config.sourceId || sourceId
    ).trim();
    if (
      !embeddingModel ||
      !AIEndpoint.canUseEndpoint(accountKey, {
        background: true,
        role: "embedder",
        sourceId,
      }) ||
      !AIEndpoint.isLoopbackURL(config.endpointURL)
    ) {
      return {
        status: "local-fallback",
        reason:
          "Passage text remains on-device unless the dedicated embedder is a usable loopback source.",
        updatedCount: 0,
        model: LOCAL_PASSAGE_EMBEDDING_MODEL,
        sourceGeneration,
      };
    }
    // Building the local contextual index is demand-driven. Do not start a
    // potentially large SQLite refresh merely because ordinary message
    // analysis completed when no dedicated embedder can run. Once a usable
    // loopback embedder is selected, ensure the passages exist before
    // enriching them with that model.
    const indexState = await this.ensureCurrent();
    const connection = await this._open();
    const resultLimit = Math.max(1, Math.min(Number(limit) || 128, 512));
    const parameters = {
      model: embeddingModel,
      sourceId: String(config.sourceId || sourceId),
      limit: resultLimit,
    };
    const conditions = [
      "(chunks.embedding_model != :model OR chunks.embedding_source_id != :sourceId)",
    ];
    if (scope.accountKey) {
      conditions.push("chunks.account_key = :accountKey");
      parameters.accountKey = String(scope.accountKey);
    }
    if (scope.folderURI) {
      conditions.push("chunks.folder_uri = :folderURI");
      parameters.folderURI = String(scope.folderURI);
    }
    const selectedIds = Array.isArray(scope.messageIds)
      ? scope.messageIds.map(String).filter(Boolean).slice(0, 500)
      : [];
    if (selectedIds.length) {
      const placeholders = [];
      for (let index = 0; index < selectedIds.length; index++) {
        const name = `backfillMessageId${index}`;
        placeholders.push(`:${name}`);
        parameters[name] = selectedIds[index];
      }
      conditions.push(`chunks.message_id IN (${placeholders.join(", ")})`);
    }
    const rows = await connection.executeCached(
      `SELECT chunks.chunk_id, chunks.chunk_text, chunks.input_hash,
              chunks.redaction_policy
         FROM rag_chunks AS chunks
        WHERE ${conditions.join(" AND ")}
        ORDER BY chunks.date_ms DESC, chunks.chunk_index
        LIMIT :limit`,
      parameters
    );
    if (!rows.length) {
      return {
        status: "current",
        reason: "Passage embeddings already use the selected model.",
        updatedCount: 0,
        model: embeddingModel,
        sourceGeneration: indexState.sourceGeneration,
      };
    }
    const updates = [];
    for (let start = 0; start < rows.length; start += 16) {
      const batch = rows.slice(start, start + 16);
      const embeddings = await Promise.all(
        batch.map(row =>
          AIEndpoint.embedText(row.getResultByName("chunk_text"), accountKey, {
            role: "embedder",
            sourceId,
          })
        )
      );
      for (let index = 0; index < batch.length; index++) {
        const embedding = normalizeEmbeddingVector(embeddings[index]);
        if (!embedding.length) {
          continue;
        }
        updates.push({
          chunkId: batch[index].getResultByName("chunk_id"),
          embedding,
          inputHash: batch[index].getResultByName("input_hash"),
          redactionPolicy: batch[index].getResultByName("redaction_policy"),
        });
      }
      await yieldToMainThread();
    }
    let appliedUpdates = 0;
    await connection.executeTransaction(async () => {
      for (const update of updates) {
        const currentRows = await connection.executeCached(
          `SELECT input_hash
             FROM rag_chunks
            WHERE chunk_id = :chunkId`,
          { chunkId: update.chunkId }
        );
        if (currentRows[0]?.getResultByName("input_hash") != update.inputHash) {
          // The canonical source changed while the endpoint was embedding the
          // old passage. Keep the rebuilt local row and let a later backfill
          // embed its new input instead of attaching stale buckets.
          continue;
        }
        await connection.executeCached(
          "DELETE FROM rag_vector_buckets WHERE chunk_id = :chunkId",
          { chunkId: update.chunkId }
        );
        await connection.executeCached(
          `UPDATE rag_chunks
              SET embedding_model = :model,
                  embedding_source_id = :sourceId,
                  embedding_dimension = :dimension,
                  embedding_json = :embeddingJSON,
                  redaction_policy = :redactionPolicy
            WHERE chunk_id = :chunkId AND input_hash = :inputHash`,
          {
            chunkId: update.chunkId,
            inputHash: update.inputHash,
            model: embeddingModel,
            sourceId: String(config.sourceId || sourceId),
            dimension: update.embedding.length,
            embeddingJSON: JSON.stringify(update.embedding),
            redactionPolicy: `loopback:${update.redactionPolicy}`,
          }
        );
        await writeVectorBuckets(connection, {
          chunkId: update.chunkId,
          embeddingModel,
          embeddingSourceId: String(config.sourceId || sourceId),
          embedding: update.embedding,
        });
        appliedUpdates++;
      }
    });
    return {
      status: appliedUpdates == rows.length ? "updated" : "partial",
      reason: `Updated ${appliedUpdates} contextual passage embedding(s).`,
      updatedCount: appliedUpdates,
      requestedCount: rows.length,
      model: embeddingModel,
      sourceId: config.sourceId || "",
      dimension: updates[0]?.embedding.length || 0,
      sourceGeneration: indexState.sourceGeneration,
    };
  },

  schedulePassageEmbeddingBackfill(options = {}) {
    const requestedLimit = Math.max(
      1,
      Math.min(Number(options.limit) || 128, 512)
    );
    const requestedScope = options.scope || { scopeMode: "all" };
    const pendingScope = this._passageBackfillOptions?.scope || null;
    this._passageBackfillOptions = {
      limit: Math.max(
        requestedLimit,
        Number(this._passageBackfillOptions?.limit) || 0
      ),
      scope:
        !pendingScope ||
        JSON.stringify(pendingScope) == JSON.stringify(requestedScope)
          ? requestedScope
          : { scopeMode: "all" },
    };
    this._passageBackfillRequested = true;
    this._passageBackfillStopRequested = false;
    if (this._passageBackfillPromise) {
      return this._passageBackfillPromise;
    }
    this._passageBackfillPromise = (async () => {
      let result = {
        status: "cancelled",
        reason: "Passage embedding backfill stopped.",
        updatedCount: 0,
      };
      while (
        this._passageBackfillRequested &&
        !this._passageBackfillStopRequested
      ) {
        this._passageBackfillRequested = false;
        const batchOptions = this._passageBackfillOptions || {};
        this._passageBackfillOptions = null;
        await new Promise(resolve =>
          ChromeUtils.idleDispatch(resolve, { timeout: 250 })
        );
        if (this._passageBackfillStopRequested) {
          break;
        }
        result = await this.backfillPassageEmbeddings(batchOptions);
        const limit = Math.max(
          1,
          Math.min(Number(batchOptions.limit) || 128, 512)
        );
        if (
          ["updated", "partial"].includes(result.status) &&
          Number(result.updatedCount) > 0 &&
          Number(result.requestedCount) >= limit
        ) {
          this._passageBackfillRequested = true;
          this._passageBackfillOptions ||= batchOptions;
        }
      }
      return result;
    })()
      .catch(error => ({
        status: "failed",
        reason: String(error?.message || error),
        updatedCount: 0,
      }))
      .finally(() => {
        this._passageBackfillPromise = null;
        this._passageBackfillOptions = null;
      });
    return this._passageBackfillPromise;
  },

  _withDiagnostics(payload, indexState, cache) {
    return {
      ...payload,
      schemaVersion: SCHEMA_VERSION,
      freshness: {
        exact: "fresh",
        semantic: "not-requested",
        sourceGeneration: indexState.sourceGeneration,
        indexedGeneration: indexState.indexedGeneration,
        statsUpdatedAt: cache.builtAt,
      },
      cacheDiagnostics: {
        backend: "sqlite",
        cacheHit: cache.cacheHit,
        recordsScanned: cache.recordsScanned,
        indexRebuilt: indexState.rebuilt,
        indexUpdateMode: indexState.updateMode,
        updatedRecords: indexState.updatedRecords || 0,
        ftsAvailable: this._ftsAvailable,
      },
    };
  },

  async getStatus() {
    await AIStorage.init();
    const sourceGeneration = AIStorage.getRecordGeneration();
    if (
      !this._connection &&
      !(await IOUtils.exists(AIRuntimePaths.ragIndexFilePath()))
    ) {
      return {
        backend: "sqlite",
        path: AIRuntimePaths.ragIndexFilePath(),
        state: "not-built",
        sourceGeneration,
        indexedGeneration: 0,
        fresh: sourceGeneration == 0,
        rebuilding: false,
        ftsAvailable: false,
        passageEmbeddings: {
          total: 0,
          dedicated: 0,
          localFallback: 0,
          contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
        },
        rebuiltAt: "",
        lastRebuild: null,
      };
    }
    let indexedGeneration = 0;
    let rebuiltAt = "";
    let passageEmbeddings = {
      total: 0,
      dedicated: 0,
      localFallback: 0,
      contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    };
    try {
      indexedGeneration = Number(await this._meta("recordGeneration"));
      rebuiltAt = await this._meta("rebuiltAt");
      const connection = await this._open();
      const rows = await connection.executeCached(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN embedding_model = :localModel THEN 0 ELSE 1 END)
                  AS dedicated
           FROM rag_chunks`,
        { localModel: LOCAL_PASSAGE_EMBEDDING_MODEL }
      );
      const total = Number(rows[0]?.getResultByName("total")) || 0;
      const dedicated = Number(rows[0]?.getResultByName("dedicated")) || 0;
      passageEmbeddings = {
        total,
        dedicated,
        localFallback: Math.max(0, total - dedicated),
        contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
      };
    } catch {}
    return {
      backend: "sqlite",
      path: AIRuntimePaths.ragIndexFilePath(),
      state: sourceGeneration == indexedGeneration ? "ready" : "stale",
      sourceGeneration,
      indexedGeneration,
      fresh: sourceGeneration == indexedGeneration,
      rebuilding: !!this._rebuildPromise,
      ftsAvailable: this._ftsAvailable,
      passageEmbeddings,
      rebuiltAt,
      lastRebuild: this._lastRebuild,
    };
  },

  async close() {
    this._passageBackfillStopRequested = true;
    this._passageBackfillRequested = false;
    if (this._passageBackfillPromise) {
      await this._passageBackfillPromise;
    }
    const connection = this._connection;
    this._connection = null;
    this._connectionPath = "";
    if (connection) {
      await connection.close();
    }
    this._passageBackfillStopRequested = false;
  },

  async clear() {
    await this.close();
    await IOUtils.remove(AIRuntimePaths.ragIndexFilePath(), {
      ignoreAbsent: true,
    });
    this._lastRebuild = null;
    this._ftsAvailable = false;
    this._pendingIds.clear();
    this._pendingStartGeneration = 0;
    this._pendingEndGeneration = 0;
    this._forceRebuild = false;
    this._passageBackfillRequested = false;
    this._passageBackfillOptions = null;
  },
};

Services.obs.addObserver(AIRAGIndex, AI_STORAGE_RECORD_CHANGED_TOPIC);
