/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AttachmentClamAV } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentClamAV.sys.mjs"
);

const PREF_DATABASE_PATH = "mail.attachments.security.clamav.database_path";
const PREF_LAST_UPDATE = "mail.attachments.security.signatures.last_update";
const PREF_MAJOR_EPOCH = "mail.attachments.security.signatures.major_epoch";
const PREF_LAST_RESULT = "mail.attachments.security.signatures.last_result";
const PREF_LAST_ERROR = "mail.attachments.security.signatures.last_error";
const DATABASE_NAMES = ["main.cvd", "daily.cvd"];

let databasePath;
let originalMethods;

function hashBytes(bytes, algorithm) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(algorithm == "md5" ? hash.MD5 : hash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function makeCVD(version, name, { corruptChecksum = false } = {}) {
  const body = new TextEncoder().encode(
    `${name} production signature payload version ${version}\n`.repeat(20)
  );
  const checksum = corruptChecksum
    ? "00000000000000000000000000000000"
    : hashBytes(body, "md5");
  const headerText =
    `ClamAV-VDB:19 Aug 2026 00-00 +0000:${version}:1000:90:` +
    `${checksum}:signed-test-fixture:Thunderbird:test`;
  const header = new TextEncoder().encode(headerText);
  Assert.less(header.length, 512, "the synthetic CVD header must fit");
  const bytes = new Uint8Array(512 + body.length);
  bytes.set(header);
  bytes.set(body, 512);
  return bytes;
}

function installDownloader(version, options = {}) {
  let callCount = 0;
  AttachmentClamAV._downloadSignatureFile = async (_url, destinationPath) => {
    callCount++;
    if (options.interruptAt == callCount) {
      await IOUtils.write(destinationPath, new Uint8Array([1, 2, 3]));
      throw new Error("simulated interrupted download");
    }
    const bytes = options.truncateAt == callCount
      ? new Uint8Array(32)
      : makeCVD(version, PathUtils.filename(destinationPath), {
          corruptChecksum: options.corruptAt == callCount,
        });
    await IOUtils.write(destinationPath, bytes);
    return {
      name: PathUtils.filename(destinationPath),
      path: destinationPath,
      bytes: bytes.length,
      sha256: hashBytes(bytes, "sha256"),
    };
  };
}

async function validateSyntheticDatabase(path) {
  for (const name of DATABASE_NAMES) {
    await AttachmentClamAV._inspectCVDFile(PathUtils.join(path, name));
  }
  return { valid: true, signatures: 2000 };
}

async function activeHashes() {
  const hashes = {};
  for (const name of DATABASE_NAMES) {
    const bytes = await IOUtils.read(PathUtils.join(databasePath, name));
    hashes[name] = hashBytes(bytes, "sha256");
  }
  return hashes;
}

add_setup(async function () {
  databasePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "attachment-clamav-update"
  );
  originalMethods = {
    usesBundledHelper: AttachmentClamAV._usesBundledHelper,
    downloadSignatureFile: AttachmentClamAV._downloadSignatureFile,
    validateDatabaseDirectory: AttachmentClamAV._validateDatabaseDirectory,
    sendHelperCommand: AttachmentClamAV._sendHelperCommand,
    resolveHelperPath: AttachmentClamAV.resolveHelperPath,
  };
  AttachmentClamAV._usesBundledHelper = () => true;
  AttachmentClamAV._validateDatabaseDirectory = validateSyntheticDatabase;
  Services.prefs.setStringPref(PREF_DATABASE_PATH, databasePath);
  Services.prefs.setStringPref(PREF_LAST_UPDATE, "0");
  Services.prefs.setStringPref(PREF_MAJOR_EPOCH, "initial");
  Services.prefs.setStringPref(PREF_LAST_RESULT, "never");
  Services.prefs.setStringPref(PREF_LAST_ERROR, "");

  registerCleanupFunction(async () => {
    AttachmentClamAV.terminate();
    AttachmentClamAV._usesBundledHelper = originalMethods.usesBundledHelper;
    AttachmentClamAV._downloadSignatureFile =
      originalMethods.downloadSignatureFile;
    AttachmentClamAV._validateDatabaseDirectory =
      originalMethods.validateDatabaseDirectory;
    AttachmentClamAV._sendHelperCommand = originalMethods.sendHelperCommand;
    AttachmentClamAV.resolveHelperPath = originalMethods.resolveHelperPath;
    AttachmentClamAV._helperCommandQueue = Promise.resolve();
    AttachmentClamAV._databaseStatusCache = null;
    Services.prefs.clearUserPref(PREF_DATABASE_PATH);
    Services.prefs.clearUserPref(PREF_LAST_UPDATE);
    Services.prefs.clearUserPref(PREF_MAJOR_EPOCH);
    Services.prefs.clearUserPref(PREF_LAST_RESULT);
    Services.prefs.clearUserPref(PREF_LAST_ERROR);
    await IOUtils.remove(databasePath, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
});

add_task(async function test_successful_atomic_update_and_unchanged_result() {
  installDownloader(1);
  const first = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(first.updated, "a validated candidate should activate");
  const firstEpoch = Services.prefs.getStringPref(PREF_MAJOR_EPOCH);
  Assert.notEqual(firstEpoch, "initial", "activation should advance the epoch");

  const status = await AttachmentClamAV.getDatabaseStatus({
    forceRefresh: true,
  });
  Assert.equal(status.protectionState, "production-ready");
  Assert.equal(status.productionFileCount, 2);
  Assert.equal(status.productionSignatureCount, 2000);
  Assert.ok(!status.seedOnly);

  installDownloader(1);
  const unchanged = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(!unchanged.updated);
  Assert.equal(unchanged.reason, "fresh");
  Assert.equal(
    Services.prefs.getStringPref(PREF_MAJOR_EPOCH),
    firstEpoch,
    "an unchanged validated database must not invalidate scan cache entries"
  );
});

add_task(async function test_corrupt_candidate_preserves_active_database() {
  const before = await activeHashes();
  const epoch = Services.prefs.getStringPref(PREF_MAJOR_EPOCH);
  installDownloader(2, { corruptAt: 2 });
  const result = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(!result.updated);
  Assert.equal(result.reason, "error");
  Assert.deepEqual(await activeHashes(), before);
  Assert.equal(Services.prefs.getStringPref(PREF_MAJOR_EPOCH), epoch);
  Assert.equal(Services.prefs.getStringPref(PREF_LAST_RESULT), "update-failed");
  Assert.ok(Services.prefs.getStringPref(PREF_LAST_ERROR).includes("checksum"));
});

add_task(async function test_truncated_candidate_preserves_active_database() {
  const before = await activeHashes();
  const epoch = Services.prefs.getStringPref(PREF_MAJOR_EPOCH);
  installDownloader(3, { truncateAt: 1 });
  const result = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(!result.updated);
  Assert.equal(result.reason, "error");
  Assert.deepEqual(await activeHashes(), before);
  Assert.equal(Services.prefs.getStringPref(PREF_MAJOR_EPOCH), epoch);
});

add_task(async function test_interrupted_download_preserves_active_database() {
  const before = await activeHashes();
  const epoch = Services.prefs.getStringPref(PREF_MAJOR_EPOCH);
  installDownloader(4, { interruptAt: 2 });
  const result = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(!result.updated);
  Assert.equal(result.reason, "error");
  Assert.deepEqual(await activeHashes(), before);
  Assert.equal(Services.prefs.getStringPref(PREF_MAJOR_EPOCH), epoch);
});

add_task(async function test_reload_failure_rolls_back_both_files() {
  const before = await activeHashes();
  const epoch = Services.prefs.getStringPref(PREF_MAJOR_EPOCH);
  installDownloader(5);
  AttachmentClamAV._helperProc = {};
  let reloads = 0;
  AttachmentClamAV._sendHelperCommand = async command => {
    Assert.equal(command, "RELOAD");
    reloads++;
    return reloads == 1
      ? { kind: "error", message: "simulated reload rejection" }
      : { kind: "ok", status: "reloaded" };
  };
  const result = await AttachmentClamAV.updateDatabaseNow();
  Assert.ok(!result.updated);
  Assert.equal(result.reason, "error");
  Assert.equal(reloads, 2, "the old database should be reloaded after rollback");
  Assert.deepEqual(await activeHashes(), before);
  Assert.equal(Services.prefs.getStringPref(PREF_MAJOR_EPOCH), epoch);
  AttachmentClamAV._helperProc = null;
  AttachmentClamAV._sendHelperCommand = originalMethods.sendHelperCommand;
});

add_task(async function test_zero_byte_database_rejected_before_helper_launch() {
  const candidate = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "attachment-clamav-zero"
  );
  try {
    await IOUtils.write(PathUtils.join(candidate, "main.cvd"), new Uint8Array());
    await IOUtils.write(
      PathUtils.join(candidate, "daily.cvd"),
      makeCVD(6, "daily.cvd")
    );
    let helperLookups = 0;
    AttachmentClamAV.resolveHelperPath = async () => {
      helperLookups++;
      return "should-not-run";
    };
    AttachmentClamAV._validateDatabaseDirectory =
      originalMethods.validateDatabaseDirectory;
    await Assert.rejects(
      AttachmentClamAV._validateDatabaseDirectory(candidate),
      /empty, truncated, or oversized/
    );
    Assert.equal(helperLookups, 0, "invalid files are rejected before launch");
  } finally {
    AttachmentClamAV.resolveHelperPath = originalMethods.resolveHelperPath;
    AttachmentClamAV._validateDatabaseDirectory = validateSyntheticDatabase;
    await IOUtils.remove(candidate, { recursive: true, ignoreAbsent: true });
  }
});

add_task(async function test_database_status_distinguishes_all_protection_states() {
  Services.prefs.setStringPref(
    PREF_LAST_UPDATE,
    String(Date.now() - 48 * 60 * 60 * 1000)
  );
  Services.prefs.setStringPref(PREF_LAST_RESULT, "success");
  let status = await AttachmentClamAV.getDatabaseStatus({ forceRefresh: true });
  Assert.equal(status.protectionState, "stale");

  Services.prefs.setStringPref(PREF_LAST_RESULT, "update-failed");
  status = await AttachmentClamAV.getDatabaseStatus({ forceRefresh: true });
  Assert.equal(status.protectionState, "update-failed");

  for (const name of DATABASE_NAMES) {
    await IOUtils.remove(PathUtils.join(databasePath, name));
  }
  Services.prefs.setStringPref(PREF_LAST_RESULT, "success");
  status = await AttachmentClamAV.getDatabaseStatus({ forceRefresh: true });
  Assert.equal(status.protectionState, "seed-only");
});
