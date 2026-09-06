/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

add_task(async function test_ai_settings_are_grouped_under_one_sidebar_entry() {
  const { prefsDocument, prefsWindow } = await openNewPrefsTab("paneSources");
  try {
    const categories = prefsDocument.getElementById("categories");
    Assert.equal(
      categories.selectedItem.id,
      "category-ai",
      "A grouped AI view selects the one visible AI sidebar entry"
    );

    for (const id of [
      "category-assistant",
      "category-ai-sources",
      "category-ai-retrieval",
      "category-ai-summaries",
      "category-ai-classification",
      "category-templates",
      "category-training",
      "category-ai-runtime",
    ]) {
      Assert.ok(
        prefsDocument.getElementById(id).hidden,
        `${id} is retained only as a compatibility route`
      );
    }

    const shell = prefsDocument.getElementById("aiSettingsShell");
    Assert.ok(!shell.hidden, "AI settings section navigation is visible");
    Assert.equal(
      shell.querySelector("[aria-selected='true']").dataset.aiSettingsView,
      "processing",
      "The sources route opens the Models and Processing view"
    );
    Assert.ok(
      prefsDocument.getElementById("sourcesCategory").hidden,
      "The repeated Sources heading is replaced by the shared AI heading"
    );
    Assert.ok(
      prefsDocument.getElementById("retrievalCategory").hidden,
      "The repeated Retrieval heading is replaced by the shared AI heading"
    );

    shell.querySelector("[data-ai-settings-view='advanced']").click();
    await TestUtils.waitForCondition(
      () => prefsWindow.gLastCategory.category == "paneRuntime",
      "waiting for the Advanced view to load"
    );
    Assert.equal(
      categories.selectedItem.id,
      "category-ai",
      "Advanced stays under the same AI sidebar entry"
    );
    Assert.equal(
      shell.querySelector("[aria-selected='true']").dataset.aiSettingsView,
      "advanced",
      "The Advanced tab is selected"
    );
    const runtimeDiagnostics = [
      ...prefsDocument.querySelectorAll(".ai-runtime-diagnostics"),
    ];
    Assert.greaterOrEqual(
      runtimeDiagnostics.length,
      5,
      "Runtime diagnostics are grouped behind compact disclosure controls"
    );
    Assert.ok(
      runtimeDiagnostics.every(details => !details.open),
      "Runtime diagnostics are collapsed until the user asks to inspect them"
    );
    Assert.ok(
      prefsDocument.getElementById("resetAIProviderHoldoff"),
      "Provider recovery is available beside the primary runtime actions"
    );
  } finally {
    await closePrefsTab();
  }
});
