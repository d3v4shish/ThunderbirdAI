/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Small, native-JavaScript Drain3-compatible template miner.
 *
 * It deliberately learns only structure (constant tokens plus wildcards), not
 * claim semantics. Callers must keep the original mail text for evidence.
 */

const WILDCARD = "<*>";
const VARIABLE_TOKEN = /^(?:https?:\/\/|[\w.%+-]+@[\w.-]+\.|\d|[a-f\d]{8,})/iu;
// Keep the identifier branch case-sensitive. Applying /i to this shape made
// ordinary structural words such as `security-update` look like IDs, which
// could collapse unrelated sender templates into the same wildcard cluster.
const UPPER_IDENTIFIER_TOKEN = /^[A-Z]{2,}[\d-][A-Z\d-]{3,}$/u;

function tokens(value = "") {
  return String(value)
    .trim()
    .split(/\s+/u)
    .map(token => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}:/@._-]+$/gu, ""))
    .filter(Boolean)
    .map(token =>
      VARIABLE_TOKEN.test(token) || UPPER_IDENTIFIER_TOKEN.test(token)
        ? WILDCARD
        : token.toLocaleLowerCase()
    )
    .slice(0, 80);
}

function similarity(template = [], candidate = []) {
  if (!template.length || !candidate.length) {
    return 0;
  }
  if (template.length != candidate.length) {
    const alignment = longestCommonConstantAlignment(template, candidate);
    const leftConstants = template.filter(token => token != WILDCARD).length;
    const rightConstants = candidate.filter(token => token != WILDCARD).length;
    return alignment.length / Math.max(1, leftConstants, rightConstants);
  }
  let matched = 0;
  for (let index = 0; index < template.length; index++) {
    if (template[index] == WILDCARD || template[index] == candidate[index]) {
      matched++;
    }
  }
  return matched / template.length;
}

function longestCommonConstantAlignment(left = [], right = []) {
  const rows = Array.from(
    { length: left.length + 1 },
    () => new Uint16Array(right.length + 1)
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      if (
        left[leftIndex - 1] != WILDCARD &&
        left[leftIndex - 1] == right[rightIndex - 1]
      ) {
        rows[leftIndex][rightIndex] = rows[leftIndex - 1][rightIndex - 1] + 1;
      } else {
        rows[leftIndex][rightIndex] = Math.max(
          rows[leftIndex - 1][rightIndex],
          rows[leftIndex][rightIndex - 1]
        );
      }
    }
  }
  const alignment = [];
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex && rightIndex) {
    if (
      left[leftIndex - 1] != WILDCARD &&
      left[leftIndex - 1] == right[rightIndex - 1]
    ) {
      alignment.unshift({
        token: left[leftIndex - 1],
        leftIndex: leftIndex - 1,
        rightIndex: rightIndex - 1,
      });
      leftIndex--;
      rightIndex--;
    } else if (
      rows[leftIndex - 1][rightIndex] >= rows[leftIndex][rightIndex - 1]
    ) {
      leftIndex--;
    } else {
      rightIndex--;
    }
  }
  return alignment;
}

function collapseWildcards(template = []) {
  return template.filter(
    (token, index) => token != WILDCARD || template[index - 1] != WILDCARD
  );
}

function mergeTemplate(template = [], candidate = []) {
  if (template.length == candidate.length) {
    return template.map((token, index) =>
      token == candidate[index] ? token : WILDCARD
    );
  }
  const alignment = longestCommonConstantAlignment(template, candidate);
  if (!alignment.length) {
    return [WILDCARD];
  }
  const merged = [];
  let previousLeft = -1;
  let previousRight = -1;
  for (const match of alignment) {
    if (
      match.leftIndex > previousLeft + 1 ||
      match.rightIndex > previousRight + 1
    ) {
      merged.push(WILDCARD);
    }
    merged.push(match.token);
    previousLeft = match.leftIndex;
    previousRight = match.rightIndex;
  }
  if (
    previousLeft < template.length - 1 ||
    previousRight < candidate.length - 1
  ) {
    merged.push(WILDCARD);
  }
  return collapseWildcards(merged);
}

function renderRegex(template = []) {
  const separator = "(?:[\\s\\p{P}\\p{S}]+)";
  return `^\\s*${template
    .map(token =>
      token == WILDCARD
        ? "(?:\\S+(?:\\s+\\S+){0,11})"
        : token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join(separator)}\\s*[.!?]?\\s*$`;
}

/** A bounded, deterministic Drain-style online template miner. */
export class Drain3TemplateMiner {
  constructor({ similarityThreshold = 0.6, maxClusters = 1000 } = {}) {
    this.similarityThreshold = similarityThreshold;
    this.maxClusters = Math.max(1, Number(maxClusters) || 1000);
    this.clusters = new Map();
    this.clusters.set("all", []);
    this.serial = 0;
  }

  observe(value = "") {
    const candidate = tokens(value);
    if (!candidate.length) {
      return null;
    }
    const candidates = this.clusters.get("all");
    let best = null;
    for (const cluster of candidates) {
      const score = similarity(cluster.template, candidate);
      if (!best || score > best.score) {
        best = { cluster, score };
      }
    }
    if (!best || best.score < this.similarityThreshold) {
      if (candidates.length >= this.maxClusters) {
        candidates.sort(
          (left, right) =>
            left.observations - right.observations ||
            left.lastObservedSerial - right.lastObservedSerial
        );
        candidates.shift();
      }
      const cluster = {
        id: `drain-${++this.serial}`,
        template: candidate,
        observations: 1,
        lastObservedSerial: this.serial,
      };
      candidates.push(cluster);
      return this.describe(cluster);
    }
    best.cluster.template = mergeTemplate(best.cluster.template, candidate);
    best.cluster.observations++;
    best.cluster.lastObservedSerial = ++this.serial;
    return this.describe(best.cluster);
  }

  describe(cluster) {
    return {
      id: cluster.id,
      observations: cluster.observations,
      templateTokens: cluster.template.slice(),
      template: cluster.template.join(" "),
      regex: renderRegex(cluster.template),
    };
  }
}

export function mineDrain3Template(values = [], options = {}) {
  const miner = new Drain3TemplateMiner(options);
  let result = null;
  for (const value of values) {
    result = miner.observe(value);
  }
  return result;
}
