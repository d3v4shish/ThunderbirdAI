/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonical text artifacts used by the mail AI pipeline.
 *
 * The MIME layer owns transfer-decoding and charset decoding. This module runs
 * after that layer, keeps its text immutable, and creates derived artifacts
 * that are safe to discard and rebuild. In particular, translated text is
 * never used as citation evidence: `original*` fields remain authoritative.
 */

const MAX_TRANSLATION_CHARS = 12000;
const QUOTED_REPLY_PATTERN =
  /^(?:>|On .+wrote:|From:\s+.+|Begin forwarded message:)/i;
const FORWARDED_MESSAGE_PATTERN =
  /^(?:-+\s*(?:original|forwarded) message\s*-+|Begin forwarded message:)/i;
const SIGNATURE_PATTERN = /^--\s*$/;
const PROTECTED_TOKEN_PATTERN =
  /https?:\/\/[^\s<>()]+|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:[A-Z]{2,}[\d-][A-Z\d-]{3,}|[A-Z]{2,}-\d{2,}-\d{2,}|\d{4}-\d{2}-\d{2})\b|(?:[$€£₹]\s?\d[\d,]*(?:\.\d{1,2})?)/giu;

function cleanText(value = "") {
  return String(value ?? "")
    .split("\u0000")
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Build the disposable normalized representation without losing the decoded
 * source coordinates. Each output character records the exact source range
 * that produced it, including collapsed whitespace and CRLF pairs.
 *
 * @param {string} value
 */
function normalizeTextWithSourceMap(value = "") {
  const sourceText = String(value ?? "");
  const characters = [];
  const ranges = [];
  const append = (character, start, end) => {
    characters.push(character);
    ranges.push({ start, end });
  };
  for (let index = 0; index < sourceText.length; ) {
    const character = sourceText[index];
    if (character == "\u0000") {
      index++;
      continue;
    }
    if (character == "\r") {
      const end = sourceText[index + 1] == "\n" ? index + 2 : index + 1;
      append("\n", index, end);
      index = end;
      continue;
    }
    if (/[\t\f\v]/u.test(character)) {
      const start = index;
      while (index < sourceText.length && /[\t\f\v]/u.test(sourceText[index])) {
        index++;
      }
      append(" ", start, index);
      continue;
    }
    if (character == " ") {
      const start = index;
      while (sourceText[index] == " ") {
        index++;
      }
      append(" ", start, index);
      continue;
    }
    append(character, index, index + 1);
    index++;
  }

  let start = 0;
  let end = characters.length;
  while (start < end && /\s/u.test(characters[start])) {
    start++;
  }
  while (end > start && /\s/u.test(characters[end - 1])) {
    end--;
  }
  return {
    sourceText,
    text: characters.slice(start, end).join(""),
    ranges: ranges.slice(start, end),
  };
}

function stableLanguage(value = "") {
  return (
    String(value || "und")
      .trim()
      .toLocaleLowerCase()
      .split("-")[0] || "und"
  );
}

/**
 * Divide plain text into source-addressable units. Quoted prior messages and
 * signatures are retained in `originalText`, but excluded from AI analysis.
 *
 * @param {string} value
 */
export function segmentMailText(value = "") {
  const normalized = normalizeTextWithSourceMap(value);
  const originalText = normalized.sourceText;
  const normalizedText = normalized.text;
  const segments = [];
  let current = [];
  let currentStart = 0;
  let currentEnd = 0;
  let section = "body";
  const push = () => {
    const text = current.join("\n").trim();
    if (text) {
      const sourceStartOffset = normalized.ranges[currentStart]?.start ?? 0;
      const sourceEndOffset =
        normalized.ranges[Math.max(currentStart, currentEnd - 1)]?.end ??
        sourceStartOffset;
      segments.push({
        id: `segment-${segments.length + 1}`,
        kind: section,
        text,
        sourceText: originalText.slice(sourceStartOffset, sourceEndOffset),
        sourceStartOffset,
        sourceEndOffset,
        includedForAI: section == "body",
      });
    }
    current = [];
  };

  let normalizedOffset = 0;
  for (const line of normalizedText.split("\n")) {
    const lineStart = normalizedOffset;
    const lineEnd = lineStart + line.length;
    if (!current.length) {
      currentStart = lineStart;
    }
    if (
      section != "quoted" &&
      (QUOTED_REPLY_PATTERN.test(line) || FORWARDED_MESSAGE_PATTERN.test(line))
    ) {
      push();
      section = "quoted";
      currentStart = lineStart;
    } else if (section == "body" && SIGNATURE_PATTERN.test(line)) {
      push();
      section = "signature";
      currentStart = lineStart;
    }
    current.push(line);
    currentEnd = lineEnd;
    normalizedOffset = lineEnd + 1;
  }
  push();

  return {
    originalText,
    normalizedText,
    segments,
    analysisText: segments
      .filter(segment => segment.includedForAI)
      .map(segment => segment.text)
      .join("\n")
      .trim(),
  };
}

/**
 * Masks values whose precise spelling must survive local translation. The
 * translator receives only the masked text; restored text is still derived,
 * never evidence in its own right.
 *
 * @param {string} value
 */
export function protectTranslatableTokens(value = "") {
  const source = String(value ?? "");
  let namespace = 0;
  while (source.includes(`[[TB_AI_${namespace}_PROTECTED_`)) {
    namespace++;
  }
  const markerPrefix = `[[TB_AI_${namespace}_PROTECTED_`;
  const tokens = [];
  const text = source.replace(PROTECTED_TOKEN_PATTERN, match => {
    const marker = `${markerPrefix}${tokens.length}]]`;
    tokens.push({ marker, value: match });
    return marker;
  });
  return { text, tokens };
}

export function restoreProtectedTokens(value = "", tokens = []) {
  let restored = String(value ?? "");
  for (const token of tokens) {
    // Translate engines occasionally add spaces inside brackets. Accept that
    // harmless formatting variation without accepting arbitrary substitutions.
    const pattern = new RegExp(
      token.marker
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/_/g, "\\s*_\\s*"),
      "g"
    );
    restored = restored.replace(pattern, token.value);
  }
  return restored;
}

async function deriveEnglishText(text, options) {
  if (!text) {
    return {
      text: "",
      language: "und",
      status: "empty",
      applied: false,
      truncated: false,
      sourceLength: 0,
      processedLength: 0,
    };
  }
  const sourceLength = text.length;
  const processedLength = Math.min(sourceLength, MAX_TRANSLATION_CHARS);
  const truncated = processedLength < sourceLength;
  const resultMetadata = { truncated, sourceLength, processedLength };
  if (!options.translationEnabled) {
    return {
      text: "",
      language: "und",
      status: "disabled",
      applied: false,
      ...resultMetadata,
    };
  }

  let language = "und";
  try {
    language = stableLanguage(await options.detectLanguage(text));
  } catch (error) {
    return {
      text: "",
      language,
      status: "language-detection-failed",
      applied: false,
      ...resultMetadata,
      error: String(error?.message || error),
    };
  }
  if (language == "en") {
    return {
      text,
      language,
      status: "not-required",
      applied: false,
      truncated: false,
      sourceLength,
      processedLength: sourceLength,
    };
  }
  if (language == "und") {
    return {
      text: "",
      language,
      status: "language-unknown",
      applied: false,
      ...resultMetadata,
    };
  }
  if (typeof options.translateText != "function") {
    return {
      text: "",
      language,
      status: "translator-unavailable",
      applied: false,
      ...resultMetadata,
    };
  }

  const protectedText = protectTranslatableTokens(
    text.slice(0, processedLength)
  );
  try {
    const translated = await options.translateText(
      protectedText.text,
      language,
      "en"
    );
    if (!translated) {
      return {
        text: "",
        language,
        status: "translation-cancelled",
        applied: false,
        ...resultMetadata,
      };
    }
    return {
      text: restoreProtectedTokens(translated, protectedText.tokens),
      language,
      status: truncated ? "translated-partial" : "translated",
      applied: true,
      ...resultMetadata,
    };
  } catch (error) {
    return {
      text: "",
      language,
      status: "translation-failed",
      applied: false,
      ...resultMetadata,
      error: String(error?.message || error),
    };
  }
}

/**
 * Create source and derived representations for one decoded non-attachment
 * mail body. Callers may inject detector/translator functions for tests or
 * use the Thunderbird translation runtime in production.
 *
 * @param {object} message
 * @param {object} options
 */
export async function deriveMailText(message = {}, options = {}) {
  const body = segmentMailText(message.body || "");
  const originalSubject = String(message.subject ?? "");
  const analysisSubject = cleanText(originalSubject);
  const translationOptions = {
    translationEnabled: !!options.translationEnabled,
    detectLanguage: options.detectLanguage || (async () => "und"),
    translateText: options.translateText,
  };
  const [englishBody, englishSubject] = await Promise.all([
    deriveEnglishText(body.analysisText, translationOptions),
    deriveEnglishText(analysisSubject, translationOptions),
  ]);
  const nonEmptyDerivations = [englishBody, englishSubject].filter(
    result => result.sourceLength > 0
  );
  const statuses = nonEmptyDerivations.map(result => result.status);
  let status = nonEmptyDerivations[0]?.status || "empty";
  if (statuses.includes("translated-partial")) {
    status = "translated-partial";
  } else if (statuses.includes("translated")) {
    status = "translated";
  } else if (
    nonEmptyDerivations.length &&
    nonEmptyDerivations.every(result => result.status == "not-required")
  ) {
    status = "english";
  }

  return {
    originalSubject,
    originalBody: body.originalText,
    normalizedBody: body.normalizedText,
    segments: body.segments,
    analysisSubject,
    analysisBody: body.analysisText,
    englishSubject: englishSubject.text,
    englishBody: englishBody.text,
    analysisText: [
      englishSubject.text || analysisSubject,
      englishBody.text || body.analysisText,
    ]
      .filter(Boolean)
      .join("\n"),
    translation: {
      status,
      body: englishBody,
      subject: englishSubject,
      sourceIsAuthoritative: true,
      attachmentTextIncluded: false,
    },
  };
}
