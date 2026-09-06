/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AIService } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIService.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;

add_task(async function test_cold_profile_panes_wait_for_ai_storage() {
  const messages = [];
  const listener = {
    observe(message) {
      messages.push(String(message?.message || message));
    },
  };
  Services.console.registerListener(listener);
  Services.prefs.setBoolPref("mail.ai.backfill.enabled", false);
  Services.prefs.setBoolPref("mail.ai.enabled", true);

  try {
    await AIService.uninit();
    await AIService.init();
    const runtime = await AIService.getRuntimeStatus();
    Assert.ok(
      runtime.active,
      "AI service should finish cold-profile initialization"
    );

    const panelIds = new Map([
      ["assistant", "aiAssistantChat"],
      ["triage", "aiTriageCenter"],
      ["email", "aiEmailDomain"],
      ["data", "aiDataGovernance"],
      ["timeline", "aiMessageTimeline"],
      ["debug", "aiConversationDebug"],
    ]);
    for (const [tab, panelId] of panelIds) {
      about3Pane.aiAssistantPane.show(tab);
      await BrowserTestUtils.waitForCondition(
        () => !about3Pane.document.getElementById(panelId).hidden,
        `${tab} should open from a cold profile`
      );
      await TestUtils.waitForTick();
    }

    const storageWarnings = messages.filter(message =>
      message.includes("AI storage is not ready")
    );
    Assert.deepEqual(
      storageWarnings,
      [],
      "Cold-profile pane initialization should not read AI storage early"
    );
  } finally {
    Services.console.unregisterListener(listener);
    about3Pane.aiAssistantPane.hide();
    Services.prefs.clearUserPref("mail.ai.enabled");
    Services.prefs.clearUserPref("mail.ai.backfill.enabled");
  }
});
