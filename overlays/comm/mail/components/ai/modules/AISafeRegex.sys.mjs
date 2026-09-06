/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MAX_PATTERN_LENGTH = 1000;
const MAX_INPUT_LENGTH = 8000;
const MAX_CACHE_ENTRIES = 256;
const gRegexCache = new Map();

function unsafeRegexReason(pattern = "") {
  const source = String(pattern || "");
  if (!source) {
    return "empty pattern";
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_PATTERN_LENGTH} characters`;
  }
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint == 0x7f) {
      return "pattern contains control characters";
    }
  }
  const visible = source.replace(/\\./gu, "x");
  if (/\\(?:[1-9]|k<)/u.test(source)) {
    return "backreferences are not supported";
  }
  if (/\(\?<([=!])/u.test(source)) {
    return "lookbehind assertions are not supported";
  }
  if (
    /\([^()]*(?:\*|\+|\{\d+,?\d*\})[^()]*\)(?:\*|\+|\{\d+,\})/u.test(visible)
  ) {
    return "nested quantifiers are not supported";
  }
  if (/\([^()]*(?:\|)[^()]*\)(?:\*|\+|\{\d+,\})/u.test(visible)) {
    return "quantified alternation is not supported";
  }
  for (const match of visible.matchAll(
    /\([^()]*(?:\*|\+|\{\d+,?\d*\}|\|)[^()]*\)\{\d+,(\d+)\}/gu
  )) {
    if (Number(match[1]) > 16) {
      return "nested quantifier upper bound exceeds 16";
    }
  }
  if (/\.\*[^\n]{0,80}\.\*/u.test(visible)) {
    return "multiple unbounded wildcards are not supported";
  }
  for (const match of visible.matchAll(/\{(\d+),(\d+)\}/gu)) {
    if (Number(match[2]) > 1000) {
      return "quantifier upper bound exceeds 1000";
    }
  }
  return "";
}

function normalizedFlags(flags = "iu") {
  return Array.from(new Set(String(flags).replace(/[gy]/gu, "").split("")))
    .filter(flag => "dimsuv".includes(flag))
    .join("");
}

export function compileSafeRegex(pattern = "", flags = "iu") {
  const source = String(pattern || "");
  const safeFlags = normalizedFlags(flags);
  const reason = unsafeRegexReason(source);
  if (reason) {
    return { ok: false, regex: null, error: reason };
  }
  const cacheKey = `${safeFlags}\n${source}`;
  if (gRegexCache.has(cacheKey)) {
    return { ok: true, regex: gRegexCache.get(cacheKey), error: "" };
  }
  try {
    const regex = new RegExp(source, safeFlags);
    if (gRegexCache.size >= MAX_CACHE_ENTRIES) {
      gRegexCache.delete(gRegexCache.keys().next().value);
    }
    gRegexCache.set(cacheKey, regex);
    return { ok: true, regex, error: "" };
  } catch (error) {
    return {
      ok: false,
      regex: null,
      error: String(error?.message || "invalid regular expression").slice(
        0,
        240
      ),
    };
  }
}

export function safeRegexTest(
  pattern,
  value,
  { flags = "iu", maxInputLength = MAX_INPUT_LENGTH } = {}
) {
  // Template conditions can originate from imported or previously mined
  // configuration. Matching must never abort analysis of a mail when one of
  // those conditions is malformed or a regex engine rejects an input.
  try {
    const compiled = compileSafeRegex(pattern, flags);
    if (!compiled.ok || typeof compiled.regex?.test != "function") {
      return false;
    }
    return compiled.regex.test(
      String(value ?? "").slice(
        0,
        Math.max(1, Number(maxInputLength) || MAX_INPUT_LENGTH)
      )
    );
  } catch {
    return false;
  }
}

export function safeRegexStatus(pattern, flags = "iu") {
  const result = compileSafeRegex(pattern, flags);
  return { ok: result.ok, error: result.error };
}

export function clearSafeRegexCacheForTests() {
  gRegexCache.clear();
}
