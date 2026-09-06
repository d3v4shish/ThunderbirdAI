/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A deliberately small, open-world Datalog-style fact layer. Facts are only
// emitted when a bounded source span matches a deterministic rule. Absence of
// a fact means "unknown", never false. This is not a language model and it
// must never recover or infer an omitted relationship.

const MAX_FACTS = 24;
const MAX_VALUE = 360;

function clean(value = "", limit = MAX_VALUE) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function clausesForRecord(record = {}) {
  const fields = [
    ["originalSubject", record.originalSubject || record.subject, 0],
  ];
  const sourceSegments = Array.isArray(record.textSegments)
    ? record.textSegments.filter(segment => segment?.includedForAI)
    : [];
  if (sourceSegments.length) {
    for (const segment of sourceSegments) {
      fields.push([
        "originalBody",
        segment.sourceText || segment.text,
        Math.max(0, Number(segment.sourceStartOffset) || 0),
      ]);
    }
  } else {
    // A translated/derived analysis body is useful for retrieval, but its
    // offsets do not identify source-mail spans. Prefer decoded source fields
    // and use analysisBody only for legacy records that have no source body.
    fields.push([
      "originalBody",
      record.originalBody || record.body || record.analysisBody,
      0,
    ]);
  }
  const clauses = [];
  for (const [sourceField, source, sourceBaseOffset] of fields) {
    const rawSource = String(source || "");
    // Relationship facts frequently arrive in a single prose paragraph. Split
    // only at sentence/semicolon/newline boundaries, retain the exact source
    // clause for citation, and use a normalized copy solely for matching.
    for (const match of rawSource.matchAll(/[^.!?;\r\n]+[.!?;]?/gu)) {
      const rawClause = match[0];
      const sourceText = rawClause.trim();
      if (!sourceText) {
        continue;
      }
      const leadingWhitespace = rawClause.length - rawClause.trimStart().length;
      clauses.push({
        sourceField,
        text: clean(sourceText),
        sourceText,
        startOffset: sourceBaseOffset + match.index + leadingWhitespace,
      });
    }
  }
  return clauses;
}

function fact({ predicate, subject = "", object = "", line }) {
  const normalizedSubject = clean(subject, 160);
  const normalizedObject = clean(object);
  if (!predicate || !normalizedObject) {
    return null;
  }
  return {
    predicate,
    subject: normalizedSubject,
    object: normalizedObject,
    sourceField: line.sourceField,
    startOffset: line.startOffset,
    endOffset: line.startOffset + line.sourceText.length,
    text: line.sourceText,
    evidenceLevel: "source-span",
  };
}

function addMatch(facts, definition, line) {
  const match = definition.pattern.exec(line.text);
  if (!match) {
    return;
  }
  const next = fact({
    predicate: definition.predicate,
    subject: match.groups?.subject || definition.subject || "",
    object: match.groups?.object || line.text,
    line,
  });
  if (next) {
    facts.push(next);
  }
}

const FACT_PATTERNS = [
  {
    predicate: "owns",
    pattern:
      /^(?<subject>[\p{L}][\p{L} .'-]{1,80}?)\s+(?:owns|is owner of)\s+(?<object>.+?)(?:\.|$)/iu,
  },
  {
    predicate: "owns",
    pattern:
      /^(?<object>.+?)\s+(?:is|was)\s+owned\s+by\s+(?<subject>[\p{L}][\p{L} .'-]{1,80}?)(?:\.|$)/iu,
  },
  {
    predicate: "deadline",
    pattern:
      /^(?<subject>[\p{L}][\p{L} .'-]{1,80}?)\s+(?:must|needs? to|shall)\s+(?<object>.+?\b(?:by|before)\b.+?)(?:\.|$)/iu,
  },
  {
    // Thunderbird's action extractor and human-authored status mail both use
    // this compact assignment form. It is still emitted only when the clause
    // carries a concrete due phrase.
    predicate: "deadline",
    pattern:
      /^(?<subject>[\p{L}][\p{L} .'-]{1,80}?)\s*:\s*(?<object>.+?\b(?:by|before)\b.+?)(?:\.|$)/iu,
  },
  {
    predicate: "proposed",
    pattern:
      /^(?<subject>.+?)\s+(?:is |was )?proposed\s+(?<object>.+?)(?:\.|$)/iu,
  },
  {
    predicate: "approved",
    pattern:
      /^(?<subject>.+?)\s+(?:is |was |has been )?approved\s*(?<object>.*?)(?:\.|$)/iu,
  },
  {
    predicate: "rollback-condition",
    subject: "",
    pattern: /^(?:rollback|roll back)\s+(?:if|when)\s+(?<object>.+?)(?:\.|$)/iu,
  },
];

function sameFact(left, right) {
  return (
    left.predicate == right.predicate &&
    left.subject.toLocaleLowerCase() == right.subject.toLocaleLowerCase() &&
    left.object.toLocaleLowerCase() == right.object.toLocaleLowerCase() &&
    left.sourceField == right.sourceField
  );
}

export const AIDatalog = {
  extractFacts(record = {}) {
    const facts = [];
    for (const line of clausesForRecord(record)) {
      for (const definition of FACT_PATTERNS) {
        addMatch(facts, definition, line);
        if (facts.length >= MAX_FACTS) {
          break;
        }
      }
      if (facts.length >= MAX_FACTS) {
        break;
      }
    }
    return facts.filter(
      (candidate, index) =>
        !facts.slice(0, index).some(item => sameFact(item, candidate))
    );
  },

  // Conjunctive query over explicit facts only. Callers may use this to find
  // evidence, but must cite the returned source span rather than the query.
  query(records = [], query = {}) {
    const predicate = clean(query.predicate, 80).toLocaleLowerCase();
    const subject = clean(query.subject, 160).toLocaleLowerCase();
    const object = clean(query.object).toLocaleLowerCase();
    const matches = [];
    for (const record of records) {
      for (const item of Array.isArray(record.deterministicFacts)
        ? record.deterministicFacts
        : this.extractFacts(record)) {
        if (predicate && item.predicate != predicate) {
          continue;
        }
        if (subject && item.subject.toLocaleLowerCase() != subject) {
          continue;
        }
        if (object && !item.object.toLocaleLowerCase().includes(object)) {
          continue;
        }
        matches.push({
          messageId: `${record.folderURI || ""}#${record.messageKey ?? ""}`,
          ...item,
        });
      }
    }
    return matches.slice(0, MAX_FACTS);
  },
};
