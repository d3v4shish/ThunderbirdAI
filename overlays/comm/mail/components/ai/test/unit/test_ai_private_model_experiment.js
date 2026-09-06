/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const {
  AIPrivateModelExperiment,
  normalizePrivateEntityHints,
  normalizePrivateIntentHint,
} = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIPrivateModelExperiment.sys.mjs"
);
const { sha256HexForByteArray } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIModelDownloads.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ENABLED_PREF = "mail.ai.private_ml.enabled";
const MANIFEST_PREF = "mail.ai.private_ml.manifest_path";
const ARTIFACT_PATH = PathUtils.join(PathUtils.profileDir, "private-model.bin");
const MANIFEST_PATH = PathUtils.join(
  PathUtils.profileDir,
  "private-ml-manifest.json"
);

registerCleanupFunction(async () => {
  AIPrivateModelExperiment.setTestFetch(null);
  Services.prefs.clearUserPref(ENABLED_PREF);
  Services.prefs.clearUserPref(MANIFEST_PREF);
  await IOUtils.remove(ARTIFACT_PATH, { ignoreAbsent: true });
  await IOUtils.remove(MANIFEST_PATH, { ignoreAbsent: true });
});

function manifestFor(artifactBytes, override = {}) {
  return {
    schemaVersion: 1,
    privateUseAcknowledged: true,
    models: [
      {
        modelId: "private-gliner-fixture",
        role: "gliner-entities",
        runtime: "external-loopback",
        endpointURL: "http://127.0.0.1:9901/v1/gliner",
        artifacts: [
          {
            path: ARTIFACT_PATH,
            sizeBytes: artifactBytes.length,
            sha256: sha256HexForByteArray(artifactBytes),
          },
        ],
        ...override,
      },
    ],
  };
}

add_task(async function test_private_experiment_is_disabled_by_default() {
  const status = await AIPrivateModelExperiment.inspect();
  Assert.equal(status.state, "disabled");
  Assert.deepEqual(status.models, []);
});

add_task(
  async function test_private_experiment_requires_local_verified_bytes() {
    const bytes = new TextEncoder().encode("private model fixture");
    await IOUtils.write(ARTIFACT_PATH, bytes);
    await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifestFor(bytes)));
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);

    const status = await AIPrivateModelExperiment.inspect();
    Assert.equal(status.state, "ready");
    Assert.equal(status.models[0].role, "gliner-entities");
    Assert.equal(
      status.models[0].endpointURL,
      "http://127.0.0.1:9901/v1/gliner"
    );
    Assert.ok((await AIPrivateModelExperiment.getRole("gliner-entities"))?.ok);
  }
);

add_task(
  async function test_private_experiment_rejects_nonloopback_and_tampered_bytes() {
    const bytes = new TextEncoder().encode("private model fixture");
    await IOUtils.write(ARTIFACT_PATH, bytes);
    await IOUtils.writeUTF8(
      MANIFEST_PATH,
      JSON.stringify(
        manifestFor(bytes, {
          endpointURL: "https://example.invalid/v1/private-model",
        })
      )
    );
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);
    let status = await AIPrivateModelExperiment.inspect();
    Assert.equal(status.state, "invalid");
    Assert.ok(
      status.models[0].errors.some(error => error.includes("localhost"))
    );

    await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifestFor(bytes)));
    await IOUtils.writeUTF8(ARTIFACT_PATH, "tampered bytes");
    status = await AIPrivateModelExperiment.inspect();
    Assert.equal(status.state, "invalid");
    Assert.ok(
      status.models[0].errors.some(error => error.includes("mismatch"))
    );
  }
);

add_task(
  async function test_private_experiment_posts_only_to_verified_loopback_runner() {
    const bytes = new TextEncoder().encode("private model fixture");
    await IOUtils.write(ARTIFACT_PATH, bytes);
    await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifestFor(bytes)));
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);
    let call = null;
    AIPrivateModelExperiment.setTestFetch(async (url, options) => {
      call = { url, options };
      return new Response(JSON.stringify({ entities: [] }), {
        status: 200,
      });
    });

    const result = await AIPrivateModelExperiment.invoke("gliner-entities", {
      text: "Cited source span.",
    });
    Assert.equal(result.model.modelId, "private-gliner-fixture");
    Assert.deepEqual(result.output, { entities: [] });
    Assert.equal(call.url, "http://127.0.0.1:9901/v1/gliner");
    Assert.equal(JSON.parse(call.options.body).role, "gliner-entities");
  }
);

add_task(async function test_private_experiment_rejects_oversized_requests() {
  const bytes = new TextEncoder().encode("private model fixture");
  await IOUtils.write(ARTIFACT_PATH, bytes);
  await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifestFor(bytes)));
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);
  let called = false;
  AIPrivateModelExperiment.setTestFetch(async () => {
    called = true;
    return new Response(JSON.stringify({ entities: [] }), { status: 200 });
  });

  await Assert.rejects(
    AIPrivateModelExperiment.invoke("gliner-entities", {
      text: "x".repeat(600 * 1024),
    }),
    /request exceeds 512 KiB/
  );
  Assert.ok(!called, "oversized input is rejected before contacting a runner");
});

add_task(async function test_private_experiment_rejects_duplicate_roles() {
  const bytes = new TextEncoder().encode("private model fixture");
  await IOUtils.write(ARTIFACT_PATH, bytes);
  const manifest = manifestFor(bytes);
  manifest.models.push({
    ...manifest.models[0],
    modelId: "second-gliner-fixture",
  });
  await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifest));
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);

  const status = await AIPrivateModelExperiment.inspect();
  Assert.equal(status.state, "invalid");
  Assert.ok(
    status.models[1].errors.some(error => error.includes("duplicated")),
    "one adapter role maps to exactly one verified runner"
  );
});

add_task(async function test_private_runner_serializes_calls_per_endpoint() {
  const bytes = new TextEncoder().encode("private model fixture");
  await IOUtils.write(ARTIFACT_PATH, bytes);
  await IOUtils.writeUTF8(MANIFEST_PATH, JSON.stringify(manifestFor(bytes)));
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  Services.prefs.setStringPref(MANIFEST_PREF, MANIFEST_PATH);
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstBlocked = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let calls = 0;
  AIPrivateModelExperiment.setTestFetch(async () => {
    calls++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (calls == 1) {
      await firstBlocked;
    }
    active--;
    return new Response(JSON.stringify({ entities: [] }), { status: 200 });
  });

  try {
    const first = AIPrivateModelExperiment.invoke("gliner-entities", {
      text: "first",
    });
    await TestUtils.waitForCondition(() => active == 1);
    const second = AIPrivateModelExperiment.invoke("gliner-entities", {
      text: "second",
    });
    await new Promise(resolve => do_timeout(25, resolve));
    Assert.equal(calls, 1, "the second invocation waits for the runner lane");
    Assert.equal(maximumActive, 1);
    releaseFirst();
    await Promise.all([first, second]);
    Assert.equal(calls, 2);
    Assert.equal(maximumActive, 1);
  } finally {
    releaseFirst();
    AIPrivateModelExperiment.setTestFetch(null);
  }
});

add_task(async function test_private_entity_hints_require_exact_source_spans() {
  const sourceText = "Atlas Checkout is ready for review.";
  const atlasStart = sourceText.indexOf("Atlas");
  const hints = normalizePrivateEntityHints(
    {
      entities: [
        {
          text: "Atlas",
          label: "project",
          start: atlasStart,
          end: atlasStart + "Atlas".length,
          confidence: 0.91,
        },
        {
          text: "Invented Project",
          label: "project",
          start: atlasStart,
          end: atlasStart + "Atlas".length,
          confidence: 0.99,
        },
        {
          text: "Checkout",
          label: "project",
          start: -1,
          end: 8,
          confidence: 0.9,
        },
        {
          text: "Atlas",
          label: "project",
          start: atlasStart,
          end: atlasStart + "Atlas".length,
          confidence: 0.91,
        },
        {
          text: "Atlas",
          label: "project",
          start: String(atlasStart),
          end: String(atlasStart + "Atlas".length),
          confidence: 0.91,
        },
      ],
    },
    sourceText
  );

  Assert.deepEqual(hints, [
    {
      text: "Atlas",
      label: "project",
      start: atlasStart,
      end: atlasStart + "Atlas".length,
      confidence: 0.91,
    },
  ]);
});

add_task(
  async function test_private_entity_hints_accept_unicode_code_point_offsets() {
    const sourceText = "Ready 🚀 Atlas Checkout";
    // Python/GLiNER offsets count the rocket as one code point. JavaScript
    // counts it as two UTF-16 code units.
    const codePointStart = Array.from("Ready 🚀 ").length;
    const hints = normalizePrivateEntityHints(
      {
        entities: [
          {
            text: "Atlas",
            label: "project",
            start: codePointStart,
            end: codePointStart + Array.from("Atlas").length,
            confidence: 0.93,
          },
        ],
      },
      sourceText
    );

    Assert.deepEqual(hints, [
      {
        text: "Atlas",
        label: "project",
        start: sourceText.indexOf("Atlas"),
        end: sourceText.indexOf("Atlas") + "Atlas".length,
        confidence: 0.93,
      },
    ]);
  }
);

add_task(async function test_private_intent_hints_use_a_closed_label_set() {
  Assert.deepEqual(
    normalizePrivateIntentHint(
      { intent: { label: "Finance", confidence: 0.87 } },
      ["finance", "newsletter"]
    ),
    { label: "finance", confidence: 0.87 }
  );
  Assert.equal(
    normalizePrivateIntentHint(
      { intent: { label: "invented-category", confidence: 0.99 } },
      ["finance", "newsletter"]
    ),
    null
  );
});
