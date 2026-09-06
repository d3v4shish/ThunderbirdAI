/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { AttachmentClamAV } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentClamAV.sys.mjs"
);
const { AttachmentScanCache } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentScanCache.sys.mjs"
);
const { AttachmentScanScheduler } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentScanScheduler.sys.mjs"
);

const PREF_DATABASE_PATH = "mail.attachments.security.clamav.database_path";
const PREF_NATIVE_ENABLED = "mail.attachments.security.native.enabled";
const TEST_FILE_PARTS = [
  "TVpQAAIAAAAEAA8A//8AALgAAAAhAAAAQAAaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAALtxEEAAM8BQUIvzU1NQsClAMARmrHn5ujEAeA2tUP9mcA4fvjEA6eX/tAnNIbRMzSFiDAoBAnB2FwIeTgwEL9rMEAAAAAAAAAAAAAAAAAAAwBAAAIAQAAAAAAAAAAAAAAAAAADaEAAA9BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAS0VSTkVMMzIuRExMAABFeGl0UHJvY2VzcwBVU0VSMzIuRExMAENMQU1lc3NhZ2VCb3hBAOYQAAAAAAAAPz8/P1BFAABMAQEAYUNhQgAAAAA=",
  "AAAAAOAAjoELAQIZAAQAAAAGAAAAAAAAQBAAAAAQAABAAAAAAABAAAAQAAAAAgAAAQAAAAAAAAADAAoAAAAAAAAgAAAABAAAAAAAAAIAAAAAABAAACAAAAAAEAAAEAAAAAAAABAAAAAAAAAAAAAAAIQQAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFtDTEFNQVZdABAAAAAQAAAAAgAAAQAAAAAAAAAAAAAAAAAAAAAAAMA=",
];

let databasePath;
let account;

function decodeTestFile() {
  const parts = TEST_FILE_PARTS.map(value => atob(value));
  const binary = parts.join("");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function md5(bytes) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(hash.MD5);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

add_setup(async function () {
  Assert.equal(Services.appinfo.OS, "Linux");
  databasePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "attachment-clamav-integration"
  );
  Services.prefs.setStringPref(PREF_DATABASE_PATH, databasePath);
  Services.prefs.setBoolPref(PREF_NATIVE_ENABLED, true);
  AttachmentClamAV.terminate();
  AttachmentClamAV._helperPathSearchResult = null;
  AttachmentClamAV._databaseStatusCache = null;

  registerCleanupFunction(async () => {
    AttachmentScanScheduler._currentItem = null;
    AttachmentClamAV.terminate();
    if (account) {
      MailServices.accounts.removeAccount(account, false);
      account = null;
    }
    Services.prefs.clearUserPref(PREF_DATABASE_PATH);
    Services.prefs.clearUserPref(PREF_NATIVE_ENABLED);
    await IOUtils.remove(databasePath, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
});

add_task(async function test_packaged_helper_scan_reload_and_restart() {
  const helperPath = await AttachmentClamAV.resolveHelperPath(true);
  Assert.ok(helperPath, "the packaged Linux helper should be discoverable");
  Assert.ok(await IOUtils.exists(helperPath));

  const infectedBytes = decodeTestFile();
  Assert.equal(infectedBytes.length, 544);
  Assert.equal(md5(infectedBytes), "aa15bcf478d165efd2065190eb473bcb");

  const cleanPath = PathUtils.join(databasePath, "clean.txt");
  const infectedPath = PathUtils.join(databasePath, "clamav-test-file.exe");
  await IOUtils.writeUTF8(cleanPath, "This is a clean attachment.");
  await IOUtils.write(infectedPath, infectedBytes);

  let result = await AttachmentClamAV.scanFile(cleanPath);
  Assert.equal(result.verdict, "clean");

  result = await AttachmentClamAV.scanFile(infectedPath);
  Assert.equal(result.verdict, "infected");
  Assert.ok(result.virusName.includes("ClamAV-Test-File"));

  const reload = await AttachmentClamAV.reloadEngine();
  Assert.ok(reload.reloaded, "the running helper should reload its database");

  const restart = await AttachmentClamAV.restartHelper();
  Assert.ok(restart.restarted, "the packaged helper should restart cleanly");
  Assert.equal(AttachmentClamAV.helperState, "running");
});

add_task(async function test_scheduler_records_native_infected_verdict() {
  account = MailServices.accounts.createLocalMailAccount();
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const folder = rootFolder
    .createLocalSubfolder("attachmentClamAVIntegration")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const binary = Array.from(decodeTestFile(), byte =>
    String.fromCharCode(byte)
  ).join("");
  folder.addMessage(
    new MessageGenerator()
      .makeMessage({
        subject: "Native AV scheduler integration",
        attachments: [
          {
            filename: "clamav-test-file.exe",
            contentType: "application/octet-stream",
            encoding: "base64",
            charset: null,
            body: btoa(binary),
            format: null,
          },
        ],
      })
      .toMessageString()
  );
  const [msgHdr] = [...folder.messages];
  AttachmentScanScheduler._currentItem = {
    id: `${folder.URI}#${msgHdr.messageKey}`,
    attachmentName: "",
  };

  const state = await AttachmentScanScheduler._scanMessage(msgHdr, true);
  Assert.equal(state.summary, "infected");
  Assert.equal(state.attachments.length, 1);
  Assert.ok(
    state.attachments[0].virusName.includes("ClamAV-Test-File"),
    "the scheduler should persist the native helper's virus name"
  );
  Assert.equal(AttachmentScanCache.getState(msgHdr).summary, "infected");
});
