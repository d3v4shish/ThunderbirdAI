/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/**
 * Private local-model experiments are deliberately separate from Thunderbird's
 * product model catalog. They accept only a manifest the profile owner has
 * placed on disk and only describe a manually-operated loopback runner.
 *
 * This module never downloads a model, starts a process, or changes release
 * defaults. It exists so a developer build can validate exactly which bytes a
 * private runner is using before an adapter sends it bounded mail-derived
 * input. Product model distribution still uses the Mozilla ML intake path.
 */

const EXPERIMENT_PREF = "mail.ai.private_ml.enabled";
const MANIFEST_PATH_PREF = "mail.ai.private_ml.manifest_path";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNNER_REQUEST_BYTES = 512 * 1024;
const MAX_RUNNER_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RUNNER_TIMEOUT_MS = 15000;
const MAX_QUEUED_REQUESTS_PER_RUNNER = 8;
const HEX_SHA256 = /^[0-9a-f]{64}$/iu;
const SUPPORTED_ROLES = new Set(["gliner-entities", "modernbert-intent"]);

let gFetch = (...args) => fetch(...args);
const gVerifiedManifests = new Map();
const gRunnerLanes = new Map();

function releaseRunnerSlot(endpointURL) {
  const lane = gRunnerLanes.get(endpointURL);
  if (!lane) {
    return;
  }
  lane.active = false;
  while (lane.waiting.length) {
    const waiter = lane.waiting.shift();
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) {
      waiter.reject(new Error("Private model request was cancelled."));
      continue;
    }
    lane.active = true;
    waiter.resolve(() => releaseRunnerSlot(endpointURL));
    return;
  }
  gRunnerLanes.delete(endpointURL);
}

function acquireRunnerSlot(endpointURL, signal = null) {
  let lane = gRunnerLanes.get(endpointURL);
  if (!lane) {
    lane = { active: false, waiting: [] };
    gRunnerLanes.set(endpointURL, lane);
  }
  if (!lane.active) {
    lane.active = true;
    return Promise.resolve(() => releaseRunnerSlot(endpointURL));
  }
  if (lane.waiting.length >= MAX_QUEUED_REQUESTS_PER_RUNNER) {
    return Promise.reject(
      new Error("Private model runner is busy; its bounded queue is full.")
    );
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      signal,
      resolve,
      reject,
      onAbort: null,
    };
    waiter.onAbort = () => {
      const index = lane.waiting.indexOf(waiter);
      if (index >= 0) {
        lane.waiting.splice(index, 1);
      }
      reject(new Error("Private model request was cancelled."));
    };
    if (signal?.aborted) {
      waiter.onAbort();
      return;
    }
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    lane.waiting.push(waiter);
  });
}

function limitedString(value = "", limit = 1000) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

function loopbackURL(value = "") {
  let url;
  try {
    url = new URL(limitedString(value, 2000));
  } catch {
    return null;
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    return null;
  }
  const hostname = url.hostname.toLocaleLowerCase();
  if (
    hostname != "localhost" &&
    hostname != "::1" &&
    hostname != "[::1]" &&
    !/^127(?:\.\d{1,3}){3}$/u.test(hostname)
  ) {
    return null;
  }
  return url.toString();
}

async function validateArtifact(artifact = {}) {
  const path = limitedString(artifact.path, 4096);
  const sha256 = limitedString(artifact.sha256, 80).toLocaleLowerCase();
  const sizeBytes = Number(artifact.sizeBytes);
  const errors = [];
  if (!path || !PathUtils.isAbsolute(path)) {
    errors.push("artifact path must be absolute");
  }
  if (!HEX_SHA256.test(sha256)) {
    errors.push("artifact sha256 must be 64 hexadecimal characters");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    errors.push("artifact sizeBytes must be a positive integer");
  }
  if (errors.length) {
    return { ok: false, path, errors };
  }
  try {
    const stat = await IOUtils.stat(path);
    if (stat.type != "regular") {
      return { ok: false, path, errors: ["artifact is not a regular file"] };
    }
    if (stat.size != sizeBytes) {
      return {
        ok: false,
        path,
        errors: [
          `artifact size mismatch (expected ${sizeBytes}, got ${stat.size})`,
        ],
      };
    }
    // IOUtils hashes on the I/O worker rather than synchronously streaming
    // hundreds of megabytes through Thunderbird's main thread.
    const actualSha256 = await IOUtils.computeHexDigest(path, "sha256");
    if (actualSha256 != sha256) {
      return {
        ok: false,
        path,
        errors: ["artifact sha256 mismatch"],
      };
    }
    return { ok: true, path, sizeBytes, sha256 };
  } catch (error) {
    return {
      ok: false,
      path,
      errors: [limitedString(error?.message || "artifact cannot be read", 240)],
    };
  }
}

async function readManifest(path = "") {
  const stat = await IOUtils.stat(path);
  if (stat.type != "regular" || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Private ML manifest must be a regular file under 1 MiB.");
  }
  return JSON.parse(await IOUtils.readUTF8(path));
}

async function manifestValidationIdentity(path, manifest = {}) {
  const paths = Array.from(
    new Set(
      (Array.isArray(manifest?.models) ? manifest.models : [])
        .flatMap(model =>
          Array.isArray(model?.artifacts) ? model.artifacts : []
        )
        .map(artifact => limitedString(artifact?.path, 4096))
        .filter(Boolean)
    )
  );
  const artifactStats = [];
  for (const artifactPath of paths) {
    try {
      const stat = await IOUtils.stat(artifactPath);
      artifactStats.push([
        artifactPath,
        stat.type,
        stat.size,
        stat.lastModified,
      ]);
    } catch {
      artifactStats.push([artifactPath, "missing", 0, 0]);
    }
  }
  const manifestStat = await IOUtils.stat(path);
  return JSON.stringify({
    path,
    manifestSize: manifestStat.size,
    manifestModified: manifestStat.lastModified,
    manifest,
    artifactStats,
  });
}

async function readBoundedResponseText(response) {
  const contentLength = Number(response.headers?.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RUNNER_RESPONSE_BYTES
  ) {
    throw new Error("Private model runner response exceeds 1 MiB.");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RUNNER_RESPONSE_BYTES) {
      throw new Error("Private model runner response exceeds 1 MiB.");
    }
    return text;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value?.byteLength || 0;
    if (size > MAX_RUNNER_RESPONSE_BYTES) {
      await reader.cancel("response-too-large");
      throw new Error("Private model runner response exceeds 1 MiB.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function validateManifest(manifest = {}) {
  const errors = [];
  if (manifest?.schemaVersion != 1) {
    errors.push("schemaVersion must be 1");
  }
  if (manifest?.privateUseAcknowledged !== true) {
    errors.push("privateUseAcknowledged must be true");
  }
  const entries = Array.isArray(manifest?.models) ? manifest.models : [];
  if (!entries.length) {
    errors.push("models must contain at least one private model");
  }
  const modelIds = new Set();
  const roles = new Set();
  const models = [];
  for (const entry of entries.slice(0, 8)) {
    const modelId = limitedString(entry?.modelId, 120);
    const role = limitedString(entry?.role, 80);
    const endpointURL = loopbackURL(entry?.endpointURL);
    const artifacts = Array.isArray(entry?.artifacts) ? entry.artifacts : [];
    const entryErrors = [];
    if (!modelId) {
      entryErrors.push("modelId is required");
    } else if (modelIds.has(modelId)) {
      entryErrors.push("modelId is duplicated");
    }
    modelIds.add(modelId);
    if (!SUPPORTED_ROLES.has(role)) {
      entryErrors.push("role is not supported for private experiments");
    } else if (roles.has(role)) {
      entryErrors.push("role is duplicated");
    }
    roles.add(role);
    if (limitedString(entry?.runtime, 80) != "external-loopback") {
      entryErrors.push("runtime must be external-loopback");
    }
    if (!endpointURL) {
      entryErrors.push("endpointURL must use localhost or 127.0.0.0/8");
    }
    if (!artifacts.length || artifacts.length > 16) {
      entryErrors.push("artifacts must contain 1 to 16 files");
    }
    const validatedArtifacts = await Promise.all(
      artifacts.slice(0, 16).map(validateArtifact)
    );
    for (const artifact of validatedArtifacts) {
      entryErrors.push(...(artifact.errors || []));
    }
    models.push({
      modelId,
      role,
      endpointURL: endpointURL || "",
      runtime: "external-loopback",
      artifacts: validatedArtifacts.map(artifact => ({
        path: artifact.path,
        sizeBytes: artifact.sizeBytes || 0,
        sha256: artifact.sha256 || "",
        ok: artifact.ok,
      })),
      ok: !entryErrors.length,
      errors: entryErrors,
    });
  }
  if (entries.length > 8) {
    errors.push("private manifests may contain at most 8 models");
  }
  return {
    ok: !errors.length && models.every(model => model.ok),
    errors,
    models,
  };
}

function boundedPrivateText(value = "", limit = 240) {
  const withoutControls = Array.from(String(value ?? ""), character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint == 0x7f ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function normalizePrivateEntityHints(output = {}, sourceText = "") {
  const text = String(sourceText || "");
  const entities = Array.isArray(output?.entities) ? output.entities : [];
  const normalized = [];
  // Python NLP libraries normally report offsets in Unicode code points,
  // while JavaScript String offsets are UTF-16 code units. Build the bounded
  // conversion table once so a non-BMP character before an entity (for
  // example, an emoji) does not make an otherwise exact GLiNER span vanish.
  const codePointToCodeUnit = [0];
  let codeUnitOffset = 0;
  for (const character of text) {
    codeUnitOffset += character.length;
    codePointToCodeUnit.push(codeUnitOffset);
  }
  for (const entity of entities.slice(0, 32)) {
    let start = entity?.start;
    let end = entity?.end;
    const label = boundedPrivateText(entity?.label, 80);
    const reportedText = String(entity?.text ?? "");
    const confidence = Number(entity?.confidence);
    if (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      text.slice(start, end) != reportedText &&
      start >= 0 &&
      end > start &&
      end < codePointToCodeUnit.length
    ) {
      start = codePointToCodeUnit[start];
      end = codePointToCodeUnit[end];
    }
    const sourceValue = text.slice(start, end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length ||
      !label ||
      !reportedText ||
      reportedText.length > 240 ||
      sourceValue != reportedText ||
      (!Number.isNaN(confidence) && (confidence < 0 || confidence > 1))
    ) {
      continue;
    }
    const hint = {
      // Preserve the exact source surface. Normalizing whitespace here would
      // make the returned text disagree with its verified offsets.
      text: sourceValue,
      label,
      start,
      end,
      confidence: Number.isFinite(confidence) ? confidence : null,
    };
    if (
      !normalized.some(
        existing =>
          existing.start == hint.start &&
          existing.end == hint.end &&
          existing.label == hint.label
      )
    ) {
      normalized.push(hint);
    }
  }
  return normalized;
}

export function normalizePrivateIntentHint(output = {}, allowedLabels = []) {
  const candidate =
    output?.intent && typeof output.intent == "object" ? output.intent : output;
  const label = boundedPrivateText(candidate?.label, 80).toLocaleLowerCase();
  const confidence = Number(candidate?.confidence);
  const allowed = new Set(
    Array.isArray(allowedLabels)
      ? allowedLabels
          .map(value => boundedPrivateText(value, 80).toLocaleLowerCase())
          .filter(Boolean)
      : []
  );
  if (
    !label ||
    !allowed.has(label) ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }
  return { label, confidence };
}

export const AIPrivateModelExperiment = {
  isEnabled() {
    return Services.prefs.getBoolPref(EXPERIMENT_PREF, false);
  },

  manifestPath() {
    return limitedString(
      Services.prefs.getStringPref(MANIFEST_PATH_PREF, ""),
      4096
    );
  },

  async inspect() {
    if (!this.isEnabled()) {
      return {
        state: "disabled",
        reason: "Private local-model experiments are disabled.",
        models: [],
      };
    }
    const path = this.manifestPath();
    if (!path || !PathUtils.isAbsolute(path)) {
      return {
        state: "unavailable",
        reason:
          "Set an absolute private ML manifest path before enabling an experiment.",
        models: [],
      };
    }
    try {
      const manifest = await readManifest(path);
      const identity = await manifestValidationIdentity(path, manifest);
      const cached = gVerifiedManifests.get(path);
      if (cached?.identity == identity) {
        return structuredClone(cached.result);
      }
      const result = await validateManifest(manifest);
      const inspected = {
        state: result.ok ? "ready" : "invalid",
        manifestPath: path,
        ...result,
      };
      gVerifiedManifests.set(path, {
        identity,
        result: structuredClone(inspected),
      });
      return {
        ...inspected,
      };
    } catch (error) {
      return {
        state: "unavailable",
        manifestPath: path,
        reason: limitedString(
          error?.message || "Private ML manifest cannot be read.",
          240
        ),
        models: [],
      };
    }
  },

  async getRole(role = "") {
    const normalizedRole = limitedString(role, 80);
    const result = await this.inspect();
    if (result.state != "ready") {
      return null;
    }
    const model =
      result.models.find(candidate => candidate.role == normalizedRole) || null;
    return model;
  },

  async invoke(
    role = "",
    input = {},
    { signal = null, timeoutMs = DEFAULT_RUNNER_TIMEOUT_MS } = {}
  ) {
    const model = await this.getRole(role);
    if (!model) {
      throw new Error(
        `No verified private ${limitedString(role, 80) || "model"} experiment is available.`
      );
    }
    let requestBody;
    try {
      requestBody = JSON.stringify({
        version: 1,
        role: model.role,
        modelId: model.modelId,
        input,
      });
    } catch {
      throw new Error(
        `Private ${model.role} runner input is not serializable.`
      );
    }
    if (
      new TextEncoder().encode(requestBody).byteLength >
      MAX_RUNNER_REQUEST_BYTES
    ) {
      throw new Error("Private model runner request exceeds 512 KiB.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const boundedTimeout = Math.min(
      Math.max(Number(timeoutMs) || DEFAULT_RUNNER_TIMEOUT_MS, 2000),
      60000
    );
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException("Private model request timed out", "TimeoutError")
      );
    }, boundedTimeout);
    let releaseSlot = null;
    try {
      // A single verified loopback process commonly owns the same GPU for
      // both adapters. Serialize calls per endpoint and bound the wait queue
      // so mailbox backfill cannot create an unbounded runner/VRAM pile-up.
      releaseSlot = await acquireRunnerSlot(
        model.endpointURL,
        controller.signal
      );
      const response = await gFetch(model.endpointURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        body: requestBody,
      });
      if (!response?.ok) {
        throw new Error(
          `Private ${model.role} runner returned HTTP ${Number(response?.status) || 0}.`
        );
      }
      const text = await readBoundedResponseText(response);
      return {
        model,
        output: JSON.parse(text),
      };
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `Private ${model.role} runner timed out after ${boundedTimeout} ms.`
        );
      }
      if (signal?.aborted) {
        throw new Error(`Private ${model.role} runner request was cancelled.`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Private ${model.role} runner returned invalid JSON.`);
      }
      throw new Error(
        `Private ${model.role} runner is unavailable: ${limitedString(error?.message, 200)}`
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      releaseSlot?.();
    }
  },

  setTestFetch(callback = null) {
    gFetch = callback || ((...args) => fetch(...args));
  },

  clearVerifiedRoleCache() {
    gVerifiedManifests.clear();
  },
};
