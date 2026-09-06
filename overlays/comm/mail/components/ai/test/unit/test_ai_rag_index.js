/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const { AIChat } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIChat.sys.mjs"
);
const { AIRAGIndex } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIRAGIndex.sys.mjs"
);
const { AIEndpoint } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIEndpoint.sys.mjs"
);
const { AIRuntimePaths } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIRuntimePaths.sys.mjs"
);
const { AIStorage } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIStorage.sys.mjs"
);

add_setup(async function () {
  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
  registerCleanupFunction(async () => {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  });
});

function addRecord(messageKey, overrides = {}) {
  const folderURI = overrides.folderURI || "folder://inbox";
  AIStorage.setMessage(`${folderURI}#${messageKey}`, {
    accountKey: "server1",
    folderURI,
    messageKey,
    date: messageKey * 100,
    subject: `Message ${messageKey}`,
    author: `Sender ${messageKey} <sender${messageKey}@example.com>`,
    summary: `Summary ${messageKey}`,
    category: "finance",
    status: "new",
    ...overrides,
  });
}

add_task(
  async function test_corrupt_disposable_index_rebuilds_from_canonical_rows() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(991, {
      folderURI: "folder://recovery",
      subject: "Recoverable invoice",
      localText: "The recovery invoice is due Friday.",
    });

    const indexPath = AIRuntimePaths.ragIndexFilePath();
    await IOUtils.makeDirectory(AIRuntimePaths.aiDataRootDir(), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(indexPath, "this is not a SQLite database");

    const search = await AIRAGIndex.search({
      query: "recovery invoice",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://recovery",
      },
      limit: 4,
    });
    Assert.equal(search.records.length, 1);
    Assert.equal(search.records[0].messageKey, 991);
    Assert.equal(search.diagnostics.indexRebuilt, true);
    Assert.equal(
      AIStorage.getMessage("folder://recovery#991").subject,
      "Recoverable invoice",
      "Recovery must rebuild the derived index without changing canonical data"
    );

    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(async function test_exact_index_excludes_generated_model_hints() {
  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
  addRecord(993, {
    folderURI: "folder://exact-source-boundary",
    subject: "Routine generated hint",
    originalBody: "The canonical mail contains no transaction reference.",
    summary: "Model claims reference TXN-FABRICATED-9001 on 19 Sep 2026.",
    actionItems: ["Review TXN-FABRICATED-9001"],
    retrievalEntityHints: ["TXN-FABRICATED-9001"],
  });
  addRecord(994, {
    folderURI: "folder://exact-source-boundary",
    subject: "Canonical transaction",
    originalBody: "Reference TXN-REAL-9001 was approved on 18 Sep 2026.",
  });

  const fabricated = await AIRAGIndex.searchExact({
    constraints: { identifiers: ["TXN-FABRICATED-9001"] },
    scope: {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://exact-source-boundary",
    },
  });
  Assert.deepEqual(
    fabricated.records,
    [],
    "derived summaries and retrieval hints cannot manufacture exact matches"
  );

  const canonical = await AIRAGIndex.searchExact({
    constraints: { identifiers: ["TXN-REAL-9001"] },
    scope: {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://exact-source-boundary",
    },
  });
  Assert.deepEqual(
    canonical.records.map(record => record.messageKey),
    [994]
  );
});

add_task(
  async function test_removed_source_is_deleted_from_derived_index_and_cache() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(992, {
      folderURI: "folder://deletion",
      subject: "Delete this invoice",
      localText:
        "The ephemeral-orchid marker must disappear from derived RAG data.",
    });
    addRecord(993, {
      folderURI: "folder://deletion",
      subject: "Keep this invoice",
      localText: "A retained invoice remains in canonical and derived data.",
    });

    const scope = {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://deletion",
    };
    const before = await AIRAGIndex.search({
      query: "ephemeral orchid",
      scope,
      limit: 4,
    });
    Assert.equal(before.records.length, 1);
    Assert.equal(before.records[0].messageKey, 992);
    const warmOverview = await AIChat.getMailboxOverview(scope);
    Assert.equal(warmOverview.coverage.analyzedMessages, 2);

    AIStorage.removeMessage("folder://deletion#992");
    const after = await AIRAGIndex.search({
      query: "ephemeral orchid",
      scope,
      limit: 4,
    });
    Assert.equal(after.records.length, 0);
    Assert.equal(after.diagnostics.indexUpdateMode, "incremental");
    Assert.equal(after.diagnostics.updatedRecords, 1);
    Assert.equal(AIStorage.getMessage("folder://deletion#992"), null);

    const rebuiltOverview = await AIChat.getMailboxOverview(scope);
    Assert.equal(
      rebuiltOverview.coverage.analyzedMessages,
      1,
      "A cache that depended on a deleted source must not survive the update"
    );
    Assert.equal(rebuiltOverview.cacheDiagnostics.cacheHit, false);

    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(
  async function test_interrupted_index_rebuild_is_retried_from_canonical_rows() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(994, {
      folderURI: "folder://interrupted-rebuild",
      localText: "The first orchid recovery record is canonical.",
    });
    addRecord(995, {
      folderURI: "folder://interrupted-rebuild",
      localText: "The second orchid recovery record is canonical.",
    });
    const scope = {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://interrupted-rebuild",
    };
    const writeRecord = AIRAGIndex._writeRecord;
    let writes = 0;
    AIRAGIndex._writeRecord = async function (...args) {
      writes++;
      if (writes == 2) {
        throw new Error("simulated interrupted derived-index rebuild");
      }
      return writeRecord.call(this, ...args);
    };
    try {
      await Assert.rejects(
        AIRAGIndex.search({ query: "orchid recovery", scope, limit: 4 }),
        /simulated interrupted derived-index rebuild/
      );
    } finally {
      AIRAGIndex._writeRecord = writeRecord;
    }

    const recovered = await AIRAGIndex.search({
      query: "orchid recovery",
      scope,
      limit: 4,
    });
    Assert.equal(recovered.records.length, 2);
    Assert.equal(recovered.diagnostics.indexRebuilt, true);
    Assert.equal(
      AIStorage.getMessage("folder://interrupted-rebuild#994").messageKey,
      994,
      "An interrupted sidecar rebuild must leave canonical records unchanged"
    );
    Assert.equal(
      AIStorage.getMessage("folder://interrupted-rebuild#995").messageKey,
      995
    );

    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(async function test_current_derived_index_survives_close_and_reopen() {
  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
  addRecord(996, {
    folderURI: "folder://reopen",
    localText: "The reopened derived index retains the lavender marker.",
  });
  const scope = {
    scopeMode: "folder",
    accountKey: "server1",
    folderURI: "folder://reopen",
  };
  const first = await AIRAGIndex.search({
    query: "lavender marker",
    scope,
    limit: 4,
  });
  Assert.equal(first.records.length, 1);
  Assert.equal(first.diagnostics.indexRebuilt, true);

  await AIRAGIndex.close();
  const reopened = await AIRAGIndex.search({
    query: "lavender marker",
    scope,
    limit: 4,
  });
  Assert.equal(reopened.records.length, 1);
  Assert.equal(reopened.records[0].messageKey, 996);
  Assert.equal(
    reopened.diagnostics.indexRebuilt,
    false,
    "A current derived index must reopen without rebuilding canonical rows"
  );
  Assert.equal(reopened.diagnostics.indexUpdateMode, "current");

  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
});

add_task(
  async function test_contextual_passages_preserve_source_heading_hierarchy() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(77, {
      folderURI: "folder://documents",
      subject: "Migration runbook",
      localText: [
        "Introduction",
        "General project context.",
        "2. Rollback Plan",
        "The rollback verification key is cobalt-lantern-742.",
        "3. Contacts",
        "Escalate to the operations team.",
      ].join("\n"),
    });
    const search = await AIRAGIndex.search({
      query: "cobalt lantern rollback verification",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://documents",
      },
      limit: 4,
    });
    Assert.equal(search.records.length, 1);
    Assert.equal(
      search.records[0].retrievalMatch.sectionLabel,
      "Rollback Plan",
      "retrieval keeps the locally observed document section for a passage"
    );
    Assert.ok(
      search.records[0].retrievalMatch.text.includes("Section: Rollback Plan"),
      "the parent/section/passage context is supplied together"
    );
    const outline = await AIRAGIndex.getDocumentOutline({
      messageId: "folder://documents#77",
    });
    Assert.ok(
      outline.found,
      "the local index should expose the document outline"
    );
    Assert.ok(
      outline.sections.some(section => section.label == "Rollback Plan"),
      "the outline retains a source-derived rollback section"
    );
    Assert.ok(
      !outline.sections.some(section =>
        section.label.includes("cobalt-lantern")
      ),
      "the outline must not synthesize labels from the document body"
    );
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(
  async function test_english_derivative_is_a_retrieval_surface_not_citation_text() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(88, {
      folderURI: "folder://translated",
      subject: "Aprobación de Atlas",
      originalBody: "La aprobación final de Atlas es el 18 de septiembre.",
      englishBody: "The final Atlas approval is on 18 September.",
      localText: "The final Atlas approval is on 18 September.",
    });

    const search = await AIRAGIndex.search({
      query: "final Atlas approval",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://translated",
      },
      limit: 4,
    });
    Assert.equal(search.records.length, 1);
    Assert.equal(search.records[0].messageKey, 88);
    Assert.equal(
      search.records[0].retrievalMatch.rankingSourceField,
      "englishBody",
      "English text is indexed as a distinct derived retrieval surface"
    );
    Assert.equal(
      search.records[0].retrievalMatch.sourceField,
      "",
      "derived translation is not exposed as citation evidence"
    );
    Assert.equal(search.records[0].retrievalMatch.chunkId, "");
    Assert.equal(
      AIStorage.getMessage("folder://translated#88").originalBody,
      "La aprobación final de Atlas es el 18 de septiembre.",
      "the original source remains available for citations"
    );
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(async function test_scope_overview_is_cached_and_invalidated() {
  addRecord(1, {
    actionItems: ["Approve invoice"],
    priority: "high",
  });
  addRecord(2, { category: "travel" });
  addRecord(3, { folderURI: "folder://archive" });

  const first = await AIChat.getMailboxOverview({ scopeMode: "all" });
  Assert.equal(first.coverage.analyzedMessages, 3);
  Assert.equal(first.exactSignals.highPriority, 1);
  Assert.equal(first.exactSignals.actionMessages, 1);
  Assert.equal(first.freshness.exact, "fresh");
  Assert.equal(first.cacheDiagnostics.backend, "sqlite");
  Assert.ok(first.cacheDiagnostics.indexRebuilt);
  Assert.equal(first.cacheDiagnostics.cacheHit, false);
  Assert.equal(first.cacheDiagnostics.recordsScanned, 3);
  Assert.equal(first.typedRollup.totalMessages, 3);
  Assert.equal(
    first.typedRollup.diagnostics.backend,
    "sqlite-record-rollups-v1",
    "the mailbox overview exposes source-backed aggregate inputs separately"
  );

  const warm = await AIChat.getMailboxOverview({ scopeMode: "all" });
  Assert.equal(warm.coverage.analyzedMessages, 3);
  Assert.equal(warm.cacheDiagnostics.cacheHit, true);
  Assert.equal(warm.cacheDiagnostics.recordsScanned, 0);
  Assert.equal(
    warm.freshness.sourceGeneration,
    warm.freshness.indexedGeneration
  );

  const search = await AIRAGIndex.search({
    query: "approve invoice",
    scope: { scopeMode: "all" },
    limit: 5,
  });
  Assert.equal(search.records.length, 1);
  Assert.equal(search.records[0].messageKey, 1);
  const indexStatus = await AIRAGIndex.getStatus();
  Assert.equal(
    search.diagnostics.mode,
    indexStatus.ftsAvailable ? "fts5+dense" : "sqlite-like+dense"
  );
  info(
    `Local RAG search backend: ${search.diagnostics.mode}; FTS5 available: ${indexStatus.ftsAvailable}`
  );

  AIStorage.setMailboxDigest("test-all-scope", {
    scopeMode: "all",
    scope: {},
    recordGeneration: AIStorage.getRecordGeneration(),
    status: "complete",
    generatedAt: "2026-08-26T00:00:00.000Z",
    executiveSummary: "Finance and travel mail are represented.",
    themes: ["Finance", "Travel"],
    citations: [{ messageId: "folder://inbox#1", subject: "Private" }],
    coverage: { totalMessages: 3, summarizedMessages: 3, complete: true },
  });
  const semantic = await AIChat.getMailboxOverview({ scopeMode: "all" });
  Assert.equal(semantic.freshness.semantic, "fresh");
  Assert.equal(
    semantic.semanticSummary.executiveSummary,
    "Finance and travel mail are represented."
  );
  Assert.deepEqual(semantic.semanticSummary.citations, [
    { messageId: "folder://inbox#1" },
  ]);

  addRecord(4, { category: "security" });
  const rebuilt = await AIChat.getMailboxOverview({ scopeMode: "all" });
  Assert.equal(rebuilt.coverage.analyzedMessages, 4);
  Assert.equal(rebuilt.cacheDiagnostics.indexRebuilt, false);
  Assert.equal(rebuilt.cacheDiagnostics.indexUpdateMode, "incremental");
  Assert.equal(rebuilt.cacheDiagnostics.updatedRecords, 1);
  Assert.equal(rebuilt.cacheDiagnostics.cacheHit, false);
  Assert.equal(rebuilt.cacheDiagnostics.recordsScanned, 4);
  Assert.equal(rebuilt.freshness.semantic, "stale");
});

add_task(async function test_scope_and_selected_overviews_stay_exact() {
  const folder = await AIChat.getMailboxOverview({
    scopeMode: "folder",
    folderURI: "folder://inbox",
  });
  Assert.equal(folder.coverage.analyzedMessages, 3);
  Assert.equal(folder.scope.mode, "folder");

  const selected = await AIChat.getMailboxOverview({
    scopeMode: "selected",
    messageIds: ["folder://inbox#2"],
  });
  Assert.equal(selected.coverage.analyzedMessages, 1);
  Assert.equal(selected.topCategories[0].category, "travel");
  Assert.equal(selected.cacheDiagnostics.cacheHit, false);
});

add_task(
  async function test_overview_cache_only_invalidates_dependent_scopes() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(1, { folderURI: "folder://one", category: "finance" });
    addRecord(2, { folderURI: "folder://two", category: "travel" });

    const one = { scopeMode: "folder", folderURI: "folder://one" };
    const two = { scopeMode: "folder", folderURI: "folder://two" };
    await AIChat.getMailboxOverview(one);
    await AIChat.getMailboxOverview(two);
    Assert.equal(
      (await AIChat.getMailboxOverview(one)).cacheDiagnostics.cacheHit,
      true,
      "the first scope should be warm before an unrelated update"
    );
    Assert.equal(
      (await AIChat.getMailboxOverview(two)).cacheDiagnostics.cacheHit,
      true,
      "the second scope should be warm before an unrelated update"
    );

    addRecord(1, { folderURI: "folder://one", category: "security" });
    const changed = await AIChat.getMailboxOverview(one);
    const unchanged = await AIChat.getMailboxOverview(two);
    Assert.equal(changed.cacheDiagnostics.cacheHit, false);
    Assert.equal(changed.topCategories[0].category, "security");
    Assert.equal(
      unchanged.cacheDiagnostics.cacheHit,
      true,
      "an update in another folder must not discard this source-backed cache"
    );
    const rollup = await AIRAGIndex.getScopeRollup({
      scope: { scopeMode: "folder", folderURI: "folder://one" },
    });
    Assert.equal(rollup.diagnostics.backend, "sqlite-record-rollups-v1");
    Assert.equal(rollup.diagnostics.rowsScanned, 0);
    Assert.equal(rollup.totalMessages, 1);
    Assert.equal(rollup.exactSignals.highPriority, 0);
    Assert.deepEqual(rollup.dimensions.category, [
      { value: "security", count: 1 },
    ]);
    Assert.equal(rollup.dimensions.folder[0].value, "folder://one");
  }
);

add_task(
  async function test_scope_aggregate_is_exact_bounded_and_source_linked() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(1, {
      folderURI: "folder://aggregate",
      category: "finance",
      priority: "normal",
      author: "Billing <billing@example.test>",
      date: Date.UTC(2026, 7, 1),
    });
    addRecord(2, {
      folderURI: "folder://aggregate",
      category: "finance",
      priority: "high",
      author: "Billing <billing@example.test>",
      date: Date.UTC(2026, 7, 2),
    });
    addRecord(3, {
      folderURI: "folder://aggregate",
      category: "work",
      priority: "urgent",
      author: "Atlas <atlas@northwind.test>",
      date: Date.UTC(2026, 8, 1),
    });
    addRecord(4, {
      folderURI: "folder://outside-aggregate",
      category: "finance",
      priority: "high",
      date: Date.UTC(2026, 8, 2),
    });

    const scope = {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://aggregate",
    };
    const categories = await AIRAGIndex.getScopeAggregate({
      scope,
      groupBy: "category",
      limit: 2,
      sampleLimit: 2,
    });
    Assert.equal(categories.diagnostics.backend, "sqlite-record-rollups-v1");
    Assert.equal(categories.diagnostics.rowsScanned, 0);
    Assert.equal(categories.examinedMessages, 3);
    Assert.deepEqual(categories.groups, [
      {
        category: "finance",
        count: 2,
        messageIds: ["folder://aggregate#2", "folder://aggregate#1"],
      },
      {
        category: "work",
        count: 1,
        messageIds: ["folder://aggregate#3"],
      },
    ]);

    const priorities = await AIRAGIndex.getScopeAggregate({
      scope,
      groupBy: "priority",
      limit: 3,
    });
    Assert.deepEqual(
      priorities.groups.map(group => [group.priority, group.count]),
      [
        ["high", 1],
        ["normal", 1],
        ["urgent", 1],
      ]
    );
    const selected = await AIRAGIndex.getScopeAggregate({
      scope: {
        scopeMode: "selected",
        accountKey: "server1",
        messageIds: ["folder://aggregate#1", "folder://aggregate#3"],
      },
      groupBy: "domain",
    });
    Assert.deepEqual(selected.groups, [
      {
        domain: "example.test",
        count: 1,
        messageIds: ["folder://aggregate#1"],
      },
      {
        domain: "northwind.test",
        count: 1,
        messageIds: ["folder://aggregate#3"],
      },
    ]);
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
  }
);

add_task(async function test_exact_entity_index_is_scoped_and_incremental() {
  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
  addRecord(1, {
    folderURI: "folder://banking",
    subject: "Debit Card transaction of INR 805 at Book Nook",
    originalBody:
      "INR 805 was debited at Book Nook on 24 Aug 2026. Reference: TXN-HC-100005.",
    summary:
      "INR 805 was debited at Book Nook on 24 Aug 2026. Reference: TXN-HC-100005.",
    extractedEntities: {
      amounts: ["INR 805"],
      dates: ["24 Aug 2026"],
      transactionIds: ["Reference: TXN-HC-100005"],
    },
  });
  addRecord(2, {
    folderURI: "folder://banking",
    subject: "Debit Card transaction of INR 9,421 at Book Nook",
    originalBody:
      "INR 9,421 was debited at Book Nook on 19 Aug 2026. Reference: TXN-HC-100473.",
    summary:
      "INR 9,421 was debited at Book Nook on 19 Aug 2026. Reference: TXN-HC-100473.",
    extractedEntities: {
      amounts: ["INR 9,421"],
      dates: ["19 Aug 2026"],
      transactionIds: ["Reference: TXN-HC-100473"],
    },
  });

  const exact = await AIRAGIndex.searchExact({
    constraints: {
      identifiers: ["txn-hc-100005"],
      amounts: [{ currency: "INR", minorUnits: 80500 }],
      dates: [{ iso: "2026-08-24" }],
    },
    scope: {
      scopeMode: "folder",
      accountKey: "server1",
      folderURI: "folder://banking",
    },
  });
  Assert.equal(exact.diagnostics.mode, "exact-entities");
  Assert.equal(exact.diagnostics.constraintCount, 3);
  Assert.equal(exact.records.length, 1);
  Assert.equal(exact.records[0].messageKey, 1);

  addRecord(1, {
    folderURI: "folder://banking",
    subject: "Corrected transaction",
    originalBody: "Reference: TXN-HC-200005 on 24 Aug 2026 for INR 805.",
    summary: "Reference: TXN-HC-200005 on 24 Aug 2026 for INR 805.",
    extractedEntities: {
      amounts: ["INR 805"],
      dates: ["24 Aug 2026"],
      transactionIds: ["TXN-HC-200005"],
    },
  });
  const oldReference = await AIRAGIndex.searchExact({
    constraints: { identifiers: ["TXN-HC-100005"] },
    scope: { scopeMode: "folder", folderURI: "folder://banking" },
  });
  const newReference = await AIRAGIndex.searchExact({
    constraints: { identifiers: ["TXN-HC-200005"] },
    scope: { scopeMode: "folder", folderURI: "folder://banking" },
  });
  Assert.equal(oldReference.records.length, 0);
  Assert.equal(oldReference.diagnostics.indexUpdateMode, "incremental");
  Assert.equal(newReference.records.length, 1);
  Assert.equal(newReference.records[0].messageKey, 1);
  Assert.equal(newReference.diagnostics.indexUpdateMode, "current");
});

add_task(
  async function test_long_messages_retrieve_child_chunk_and_cite_parent() {
    await AIRAGIndex.clear();
    await AIStorage.clearGeneratedData();
    addRecord(41, {
      folderURI: "folder://projects",
      subject: "Orion migration notes",
      summary: "A long set of migration notes.",
      localText: [
        "Routine planning details. ".repeat(90),
        "The final rollback passphrase is cobalt-lantern-742 and it is valid only for the staged Orion migration.",
        "Additional routine follow-up details. ".repeat(90),
      ].join(" "),
    });
    addRecord(42, {
      folderURI: "folder://projects",
      subject: "Unrelated project notes",
      summary: "General status notes.",
      localText: "Routine planning details only.",
    });

    const search = await AIRAGIndex.search({
      query: "cobalt lantern 742 rollback",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://projects",
      },
      limit: 8,
    });

    Assert.equal(search.records.length, 1);
    Assert.equal(search.records[0].messageKey, 41);
    Assert.equal(search.records[0].retrievalMatch.unit, "child-chunk");
    Assert.equal(
      search.records[0].retrievalMatch.parentMessageId,
      "folder://projects#41"
    );
    Assert.ok(
      search.records[0].retrievalMatch.text.includes("cobalt-lantern-742")
    );
    Assert.greater(
      search.records[0].retrievalMatch.endOffset,
      search.records[0].retrievalMatch.startOffset
    );
    Assert.equal(search.records[0].retrievalMatch.sourceField, "localText");
    Assert.equal(search.records[0].retrievalMatch.contextSchemaVersion, 5);
    Assert.equal(search.records[0].retrievalMatch.embeddingDimension, 32);
    Assert.equal(
      search.records[0].retrievalMatch.embeddingModel,
      "deterministic-local-v1"
    );
    Assert.equal(search.records[0].retrievalMatch.inputHash.length, 16);
    Assert.ok(
      search.records[0].retrievalMatch.channels.includes("passage-lexical")
    );
    Assert.ok(
      search.records[0].retrievalMatch.channels.includes("passage-dense")
    );
    Assert.equal(search.diagnostics.retrievalUnit, "child-chunk");
    Assert.equal(search.diagnostics.contextSchemaVersion, 5);
    Assert.equal(search.diagnostics.uniqueParentCount, 1);
    Assert.greaterOrEqual(search.diagnostics.matchedChunkCount, 1);
    const status = await AIRAGIndex.getStatus();
    Assert.greaterOrEqual(status.passageEmbeddings.total, 2);
    Assert.equal(status.passageEmbeddings.dedicated, 0);
    Assert.equal(
      status.passageEmbeddings.localFallback,
      status.passageEmbeddings.total
    );
  }
);

add_task(async function test_dedicated_passage_embedder_backfill_and_search() {
  await AIRAGIndex.clear();
  await AIStorage.clearGeneratedData();
  addRecord(51, {
    folderURI: "folder://passage-dense",
    subject: "Kestrel workshop",
    summary: "Workshop transcript.",
    localText:
      "The procurement group selected the zirconium failover appliance for Project Kestrel.",
  });
  addRecord(52, {
    folderURI: "folder://passage-dense",
    subject: "Garden notes",
    summary: "Tomato planting notes.",
    localText: "Compost and tomato seedlings need water.",
  });
  await AIRAGIndex.ensureCurrent();

  const originalGetConfig = AIEndpoint.getConfig;
  const originalCanUse = AIEndpoint.canUseEndpoint;
  const originalIsLoopback = AIEndpoint.isLoopbackURL;
  const originalEmbedText = AIEndpoint.embedText;
  Services.prefs.setStringPref(
    "mail.ai.embedder.source_id",
    "dedicated-passage-test"
  );
  Services.prefs.setBoolPref("mail.ai.endpoint.background", true);
  AIEndpoint.getConfig = () => ({
    sourceId: "dedicated-passage-test",
    endpointURL: "http://127.0.0.1:11434/v1/embeddings",
    model: "test-passage-embedder",
  });
  AIEndpoint.canUseEndpoint = () => true;
  AIEndpoint.isLoopbackURL = () => true;
  AIEndpoint.embedText = async text =>
    String(text).includes("zirconium") ? [1, 0, 0, 0] : [0, 1, 0, 0];
  try {
    const backfill = await AIRAGIndex.backfillPassageEmbeddings({
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://passage-dense",
      },
      limit: 20,
    });
    Assert.equal(backfill.status, "updated");
    Assert.greaterOrEqual(backfill.updatedCount, 2);
    Assert.equal(backfill.model, "test-passage-embedder");
    Assert.equal(backfill.dimension, 4);

    const search = await AIRAGIndex.search({
      query: "resilient procurement hardware",
      queryEmbedding: [1, 0, 0, 0],
      queryEmbeddingModel: "test-passage-embedder",
      queryEmbeddingSourceId: "dedicated-passage-test",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://passage-dense",
      },
      limit: 8,
    });
    Assert.equal(search.records[0].messageKey, 51);
    Assert.ok(
      search.records[0].retrievalMatch.channels.includes("passage-dense")
    );
    Assert.equal(
      search.records[0].retrievalMatch.embeddingModel,
      "test-passage-embedder"
    );
    Assert.equal(
      search.records[0].retrievalMatch.embeddingSourceId,
      "dedicated-passage-test"
    );
    Assert.greater(search.diagnostics.endpointDenseParentCount, 0);
    Assert.equal(search.diagnostics.denseScanTruncated, false);
    Assert.equal(search.diagnostics.denseCandidateIndex, "sqlite-lsh-v1");
    Assert.lessOrEqual(
      search.diagnostics.denseProbeCount,
      36,
      "dedicated embeddings must use bounded LSH probes rather than a full vector scan"
    );
    const incompatibleSearch = await AIRAGIndex.search({
      query: "concepts absent from the lexical passages",
      queryEmbedding: [1, 0, 0, 0],
      queryEmbeddingModel: "different-four-dimensional-model",
      queryEmbeddingSourceId: "dedicated-passage-test",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://passage-dense",
      },
      limit: 8,
    });
    Assert.equal(
      incompatibleSearch.diagnostics.endpointDenseParentCount,
      0,
      "equal dimensions must not make different embedding models comparable"
    );
    Assert.ok(
      incompatibleSearch.records.every(
        record => !record.retrievalMatch.channels.includes("passage-dense")
      ),
      "lexical fallback may still return mail, but incompatible LSH rows must not contribute"
    );
    const incompatibleSourceSearch = await AIRAGIndex.search({
      query: "concepts absent from the lexical passages",
      queryEmbedding: [1, 0, 0, 0],
      queryEmbeddingModel: "test-passage-embedder",
      queryEmbeddingSourceId: "a-different-endpoint-source",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://passage-dense",
      },
      limit: 8,
    });
    Assert.equal(
      incompatibleSourceSearch.diagnostics.endpointDenseParentCount,
      0,
      "equal model names from different endpoint sources are distinct embedding spaces"
    );
    const malformedQuerySearch = await AIRAGIndex.search({
      query: "concepts absent from the lexical passages",
      queryEmbedding: [1, "0", 0, 0],
      queryEmbeddingModel: "test-passage-embedder",
      queryEmbeddingSourceId: "dedicated-passage-test",
      scope: {
        scopeMode: "folder",
        accountKey: "server1",
        folderURI: "folder://passage-dense",
      },
      limit: 8,
    });
    Assert.equal(
      malformedQuerySearch.diagnostics.endpointDenseParentCount,
      0,
      "a type-invalid query vector must not enter dense retrieval"
    );
    Assert.equal(
      malformedQuerySearch.diagnostics.denseProbeCount,
      0,
      "a malformed vector must not probe embedding buckets"
    );
    const status = await AIRAGIndex.getStatus();
    Assert.greaterOrEqual(status.passageEmbeddings.dedicated, 2);
  } finally {
    AIEndpoint.getConfig = originalGetConfig;
    AIEndpoint.canUseEndpoint = originalCanUse;
    AIEndpoint.isLoopbackURL = originalIsLoopback;
    AIEndpoint.embedText = originalEmbedText;
    Services.prefs.clearUserPref("mail.ai.embedder.source_id");
    Services.prefs.clearUserPref("mail.ai.endpoint.background");
  }
});

add_task(
  async function test_passage_backfill_scheduler_coalesces_and_replays() {
    const originalBackfill = AIRAGIndex.backfillPassageEmbeddings;
    let releaseFirstBatch;
    let markFirstBatchStarted;
    const firstBatchStarted = new Promise(resolve => {
      markFirstBatchStarted = resolve;
    });
    const firstBatchRelease = new Promise(resolve => {
      releaseFirstBatch = resolve;
    });
    const calls = [];
    AIRAGIndex.backfillPassageEmbeddings = async options => {
      calls.push(options);
      if (calls.length == 1) {
        markFirstBatchStarted();
        await firstBatchRelease;
        return {
          status: "updated",
          updatedCount: 1,
          requestedCount: 1,
        };
      }
      return {
        status: "current",
        updatedCount: 0,
        requestedCount: 0,
      };
    };
    try {
      const first = AIRAGIndex.schedulePassageEmbeddingBackfill({ limit: 1 });
      await firstBatchStarted;
      const second = AIRAGIndex.schedulePassageEmbeddingBackfill({ limit: 2 });
      Assert.equal(
        first,
        second,
        "concurrent requests should share one scheduler promise"
      );
      releaseFirstBatch();
      const result = await first;
      Assert.equal(result.status, "current");
      Assert.equal(calls.length, 2, "a coalesced request must be replayed");
      Assert.equal(calls[0].limit, 1);
      Assert.equal(calls[1].limit, 2);
    } finally {
      releaseFirstBatch?.();
      AIRAGIndex.backfillPassageEmbeddings = originalBackfill;
    }
  }
);
