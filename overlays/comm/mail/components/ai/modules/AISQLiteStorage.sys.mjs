/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const SCHEMA_VERSION = 1;
const SAVE_DELAY_MS = 250;
const IMPORT_TRANSACTION_SIZE = 1000;
const RECORD_NAMESPACES = [
  "messages",
  "mailboxDigestMessages",
  "mailboxDigestJobs",
  "mailboxDigests",
  "providerStatus",
  "miningCandidates",
  "miningRematchJobs",
  "graphNodes",
  "graphEdges",
  "graphSources",
];
// These namespaces are changed only through AIStorage's explicit row staging.
// Do not retain a second serialized copy of their contents or reconcile them
// on every deferred save: a graph backfill may have many more edges than mail
// records, and both behaviours would recreate bulk-write amplification.
const EXPLICITLY_STAGED_NAMESPACES = new Set([
  "messages",
  "graphNodes",
  "graphEdges",
  "graphSources",
]);
const RECONCILED_NAMESPACES = RECORD_NAMESPACES.filter(
  namespace => !EXPLICITLY_STAGED_NAMESPACES.has(namespace)
);
const SECTION_KEYS = [
  "version",
  "recordGeneration",
  "analytics",
  "backfill",
  "traces",
  "searches",
  "semanticViews",
  "semanticFeedback",
  "miningState",
  "analysisRecovery",
];

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

function recordMap(data, namespace) {
  if (namespace == "miningCandidates") {
    return data.mining?.candidates || {};
  }
  if (namespace == "miningRematchJobs") {
    return data.mining?.rematchJobs || {};
  }
  return data[namespace] || {};
}

function sectionValue(data, key) {
  if (key == "miningState") {
    return {
      rematchQueue: Array.isArray(data.mining?.rematchQueue)
        ? data.mining.rematchQueue
        : [],
      activeRematchJobId: String(data.mining?.activeRematchJobId || ""),
    };
  }
  return data[key];
}

function setRecordMap(data, namespace, value) {
  if (namespace == "miningCandidates") {
    data.mining ??= {};
    data.mining.candidates = value;
  } else if (namespace == "miningRematchJobs") {
    data.mining ??= {};
    data.mining.rematchJobs = value;
  } else {
    data[namespace] = value;
  }
}

function setSectionValue(data, key, value) {
  if (key == "miningState") {
    data.mining ??= {};
    data.mining.rematchQueue = Array.isArray(value?.rematchQueue)
      ? value.rematchQueue
      : [];
    data.mining.activeRematchJobId = String(value?.activeRematchJobId || "");
    return;
  }
  data[key] = value;
}

function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serialized(value) {
  return JSON.stringify(value ?? null);
}

/** Canonical row-level persistence adapter for generated AI state. */
export class AICanonicalSQLiteStore {
  constructor({ path, dataPostProcessor, beforeSave } = {}) {
    this.path = path;
    this.dataPostProcessor = dataPostProcessor;
    this.beforeSave = beforeSave;
    this.data = null;
    this.dataReady = false;
    this.migratedLegacyData = false;
    this._connection = null;
    this._saveTimer = null;
    this._flushPromise = null;
    this._finalizePromise = null;
    this._dirtySections = new Set();
    this._dirtyRecords = new Map();
    this._dirtyNamespaces = new Set();
    this._persistedRecords = new Map();
    this._shutdownBlockerRegistered = false;
    this.lastWrite = null;
  }

  async init({ initialData = null } = {}) {
    await IOUtils.makeDirectory(PathUtils.parent(this.path), {
      createAncestors: true,
      ignoreExisting: true,
    });
    this._connection = await lazy.Sqlite.openConnection({
      path: this.path,
      sharedMemoryCache: false,
    });
    await this._connection.execute("PRAGMA journal_mode = WAL");
    await this._connection.execute("PRAGMA synchronous = NORMAL");
    await this._createSchema();
    const initialized = await this._meta("initialized");
    if (initialized == "1") {
      this.data = this.dataPostProcessor(await this._readData());
      this._rememberPersistedRecords();
    } else {
      this.data = this.dataPostProcessor(initialData || {});
      try {
        await this._importData();
      } catch (error) {
        await this._connection.close();
        this._connection = null;
        await IOUtils.remove(this.path, { ignoreAbsent: true });
        await IOUtils.remove(`${this.path}-wal`, { ignoreAbsent: true });
        await IOUtils.remove(`${this.path}-shm`, { ignoreAbsent: true });
        throw error;
      }
      this.migratedLegacyData = !!initialData;
      this._rememberPersistedRecords();
    }
    this.dataReady = true;
    if (!this._shutdownBlockerRegistered) {
      lazy.AsyncShutdown.profileBeforeChange.addBlocker(
        "Thunderbird AI canonical SQLite storage close",
        () => this.finalize()
      );
      this._shutdownBlockerRegistered = true;
    }
    return this;
  }

  async _createSchema() {
    await this._connection.execute(`
      CREATE TABLE IF NOT EXISTS ai_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    await this._connection.execute(`
      CREATE TABLE IF NOT EXISTS ai_sections (
        section_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`);
    await this._connection.execute(`
      CREATE TABLE IF NOT EXISTS ai_records (
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(namespace, record_key)
      )`);
    await this._connection.execute(
      "CREATE INDEX IF NOT EXISTS ai_records_namespace " +
        "ON ai_records(namespace, record_key)"
    );
  }

  async _meta(key) {
    const rows = await this._connection.executeCached(
      "SELECT value FROM ai_meta WHERE key = :key",
      { key }
    );
    return rows[0]?.getResultByName("value") || "";
  }

  async _setMeta(key, value) {
    await this._connection.executeCached(
      `INSERT INTO ai_meta(key, value) VALUES(:key, :value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      { key, value: String(value) }
    );
  }

  async _readData() {
    const data = {};
    const sectionRows = await this._connection.execute(
      "SELECT section_key, value_json FROM ai_sections"
    );
    for (const row of sectionRows) {
      const key = row.getResultByName("section_key");
      setSectionValue(
        data,
        key,
        parseJSON(row.getResultByName("value_json"), null)
      );
    }
    for (const namespace of RECORD_NAMESPACES) {
      setRecordMap(data, namespace, {});
    }
    const recordRows = await this._connection.execute(
      "SELECT namespace, record_key, value_json FROM ai_records"
    );
    for (const row of recordRows) {
      const namespace = row.getResultByName("namespace");
      if (!RECORD_NAMESPACES.includes(namespace)) {
        continue;
      }
      recordMap(data, namespace)[row.getResultByName("record_key")] = parseJSON(
        row.getResultByName("value_json"),
        null
      );
    }
    return data;
  }

  async _importData() {
    await this._connection.executeTransaction(async () => {
      await this._connection.execute("DELETE FROM ai_sections");
      await this._connection.execute("DELETE FROM ai_records");
      await this._connection.execute("DELETE FROM ai_meta");
      for (const key of SECTION_KEYS) {
        await this._writeSection(key, sectionValue(this.data, key));
      }
    });
    const rows = [];
    for (const namespace of RECORD_NAMESPACES) {
      for (const [key, value] of Object.entries(
        recordMap(this.data, namespace)
      )) {
        rows.push({ namespace, key, value });
      }
    }
    for (let start = 0; start < rows.length; start += IMPORT_TRANSACTION_SIZE) {
      await this._connection.executeTransaction(async () => {
        for (const row of rows.slice(start, start + IMPORT_TRANSACTION_SIZE)) {
          await this._writeRecord(row.namespace, row.key, row.value);
        }
      });
    }
    await this._connection.executeTransaction(async () => {
      await this._setMeta("schemaVersion", SCHEMA_VERSION);
      await this._setMeta("initialized", 1);
      await this._setMeta("migratedAt", new Date().toISOString());
    });
  }

  _rememberPersistedRecords() {
    this._persistedRecords.clear();
    for (const namespace of RECORD_NAMESPACES) {
      const snapshots = new Map();
      // Explicitly staged maps never need a serialized in-memory shadow.
      // All remaining maps retain one because saveSoon reconciles callers that
      // mutate them directly.
      if (!EXPLICITLY_STAGED_NAMESPACES.has(namespace)) {
        for (const [key, value] of Object.entries(
          recordMap(this.data, namespace)
        )) {
          snapshots.set(key, serialized(value));
        }
      }
      this._persistedRecords.set(namespace, snapshots);
    }
  }

  stageRecord(namespace, key) {
    if (!RECORD_NAMESPACES.includes(namespace) || !key) {
      return;
    }
    if (!this._dirtyRecords.has(namespace)) {
      this._dirtyRecords.set(namespace, new Set());
    }
    this._dirtyRecords.get(namespace).add(String(key));
  }

  markNamespaceDirty(namespace) {
    if (RECORD_NAMESPACES.includes(namespace)) {
      this._dirtyNamespaces.add(namespace);
    }
  }

  markSectionsDirty() {
    for (const key of SECTION_KEYS) {
      this._dirtySections.add(key);
    }
  }

  saveSoon() {
    if (!this.dataReady || this._finalizePromise) {
      return;
    }
    this.markSectionsDirty();
    for (const namespace of RECONCILED_NAMESPACES) {
      this.markNamespaceDirty(namespace);
    }
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.flush().catch(console.error);
      }, SAVE_DELAY_MS);
    }
  }

  async _writeSection(key, value) {
    await this._connection.executeCached(
      `INSERT INTO ai_sections(section_key, value_json)
       VALUES(:key, :value)
       ON CONFLICT(section_key) DO UPDATE SET value_json = excluded.value_json`,
      { key, value: serialized(value) }
    );
  }

  async _writeRecord(namespace, key, value) {
    await this._connection.executeCached(
      `INSERT INTO ai_records(namespace, record_key, value_json)
       VALUES(:namespace, :key, :value)
       ON CONFLICT(namespace, record_key)
       DO UPDATE SET value_json = excluded.value_json`,
      { namespace, key, value: serialized(value) }
    );
  }

  _collectDirtyRecords(dirtyRecords, dirtyNamespaces) {
    for (const namespace of dirtyNamespaces) {
      const current = recordMap(this.data, namespace);
      const previous = this._persistedRecords.get(namespace) || new Map();
      if (!dirtyRecords.has(namespace)) {
        dirtyRecords.set(namespace, new Set());
      }
      const dirty = dirtyRecords.get(namespace);
      for (const [key, value] of Object.entries(current)) {
        if (previous.get(key) != serialized(value)) {
          dirty.add(key);
        }
      }
      for (const key of previous.keys()) {
        if (!(key in current)) {
          dirty.add(key);
        }
      }
    }
  }

  async flush() {
    if (this._flushPromise) {
      await this._flushPromise;
      if (
        this._dirtySections.size ||
        this._dirtyRecords.size ||
        this._dirtyNamespaces.size
      ) {
        return this.flush();
      }
      return this.lastWrite;
    }
    if (!this._connection || !this.dataReady) {
      return null;
    }
    const dirtySections = this._dirtySections;
    const dirtyRecords = this._dirtyRecords;
    const dirtyNamespaces = this._dirtyNamespaces;
    this._dirtySections = new Set();
    this._dirtyRecords = new Map();
    this._dirtyNamespaces = new Set();
    this._collectDirtyRecords(dirtyRecords, dirtyNamespaces);
    if (!dirtySections.size && !dirtyRecords.size) {
      return this.lastWrite;
    }
    const startedAt = Date.now();
    this._flushPromise = this._connection.executeTransaction(async () => {
      let upsertedRows = 0;
      let deletedRows = 0;
      let serializedBytes = 0;
      for (const key of dirtySections) {
        const value = sectionValue(this.data, key);
        serializedBytes += serialized(value).length;
        await this._writeSection(key, value);
        upsertedRows++;
      }
      for (const [namespace, keys] of dirtyRecords) {
        const current = recordMap(this.data, namespace);
        const snapshots = this._persistedRecords.get(namespace) || new Map();
        this._persistedRecords.set(namespace, snapshots);
        for (const key of keys) {
          if (key in current) {
            const valueJSON = serialized(current[key]);
            serializedBytes += valueJSON.length;
            await this._writeRecord(namespace, key, current[key]);
            snapshots.set(key, valueJSON);
            upsertedRows++;
          } else {
            await this._connection.executeCached(
              `DELETE FROM ai_records
               WHERE namespace = :namespace AND record_key = :key`,
              { namespace, key }
            );
            snapshots.delete(key);
            deletedRows++;
          }
        }
      }
      this.lastWrite = {
        upsertedRows,
        deletedRows,
        serializedBytes,
        durationMs: Date.now() - startedAt,
        writtenAt: new Date().toISOString(),
      };
    });
    try {
      await this._flushPromise;
      this.beforeSave?.(this.lastWrite);
      return this.lastWrite;
    } catch (error) {
      for (const key of dirtySections) {
        this._dirtySections.add(key);
      }
      for (const [namespace, keys] of dirtyRecords) {
        if (!this._dirtyRecords.has(namespace)) {
          this._dirtyRecords.set(namespace, new Set());
        }
        for (const key of keys) {
          this._dirtyRecords.get(namespace).add(key);
        }
      }
      throw error;
    } finally {
      this._flushPromise = null;
    }
  }

  finalize() {
    if (!this._finalizePromise) {
      this._finalizePromise = (async () => {
        if (this._saveTimer) {
          clearTimeout(this._saveTimer);
          this._saveTimer = null;
        }
        await this.flush();
        this.dataReady = false;
        const connection = this._connection;
        this._connection = null;
        if (connection) {
          await connection.close();
        }
      })();
    }
    return this._finalizePromise;
  }
}

export async function initCanonicalSQLiteStore(options = {}) {
  const store = new AICanonicalSQLiteStore(options);
  await store.init({ initialData: options.initialData || null });
  return store;
}
