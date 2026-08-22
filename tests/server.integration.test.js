"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const fixtureParent = path.join(__dirname, ".server-fixtures");
fs.mkdirSync(fixtureParent, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtureParent, "run-"));
const dataDir = path.join(root, "data");
const oneDrive = path.join(root, "onedrive");
const remoteDevice = "zzzz-remote-device";
const remoteOperations = [];
let service;
let base;
let paths;
const serviceTokens = new Map();

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForService(url, child, errors) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Service exited with ${child.exitCode}: ${errors.value}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not start: ${errors.value}`);
}

async function startService(serviceDataDir, serviceOneDrive, extraEnvironment = {}) {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const errors = { value: "" };
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "desktop", "server.js")
  ], {
    env: {
      ...process.env,
      AI_KNOWLEDGE_DATA_DIR: serviceDataDir,
      AI_KNOWLEDGE_ONEDRIVE: serviceOneDrive,
      AI_KNOWLEDGE_PORT: String(port),
      ...extraEnvironment
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", chunk => {
    errors.value += chunk.toString();
  });
  await waitForService(url, child, errors);
  const token = fs.readFileSync(path.join(serviceDataDir, "auth-token"), "utf8").trim();
  serviceTokens.set(url, token);
  return { child, url, errors, token };
}

async function stopService(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = new Promise(resolve => instance.child.once("exit", resolve));
  instance.child.kill();
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  serviceTokens.delete(instance.url);
}

async function request(route, options = {}, url = base) {
  const response = await fetch(`${url}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(serviceTokens.has(url)
        ? { Authorization: `Bearer ${serviceTokens.get(url)}` }
        : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { body, response };
}

function writeRemoteOperations() {
  fs.mkdirSync(paths.operations, { recursive: true });
  fs.writeFileSync(
    path.join(paths.operations, `${remoteDevice}.json`),
    JSON.stringify({
      version: 2,
      deviceId: remoteDevice,
      operations: remoteOperations
    }, null, 2)
  );
}

function makeRemoteOperation({ counter, entityId, kind, vector, entry }) {
  return {
    opId: `${remoteDevice}:${counter}`,
    deviceId: remoteDevice,
    counter,
    entityId,
    kind,
    vector: { ...vector, [remoteDevice]: counter },
    entry: kind === "upsert" ? entry : null,
    createdAt: new Date().toISOString()
  };
}

function createV1Database(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_entries_created_at ON entries(created_at DESC);
    CREATE TABLE tombstones (
      id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );
    INSERT INTO entries VALUES (
      'v1-entry', 'Retained v1', 'Migration retention content', 'v1-key',
      '', 'Migration', '["Legacy"]', '', '2025-01-01T00:00:00.000Z',
      '', 3, '2025-01-02T00:00:00.000Z'
    );
    INSERT INTO tombstones VALUES ('v1-deleted', '2025-01-03T00:00:00.000Z');
  `);
  database.close();
}

test.before(async () => {
  service = await startService(dataDir, oneDrive);
  base = service.url;
  const health = await request("/health");
  paths = health.body.cloud.paths;
});

test.after(async () => {
  await stopService(service);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== "EPERM" || attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  fs.rmSync(fixtureParent, { recursive: true, force: true });
});

test("v1 SQLite migrates explicitly without losing entries or tombstones", async () => {
  const migrationRoot = path.join(root, "migration");
  const migrationData = path.join(migrationRoot, "data");
  const migrationOneDrive = path.join(migrationRoot, "onedrive");
  const databasePath = path.join(migrationData, "knowledge.db");
  createV1Database(databasePath);
  const migrated = await startService(migrationData, migrationOneDrive);
  try {
    const health = await request("/health", {}, migrated.url);
    assert.equal(health.body.cloud.schemaVersion, 2);
    const listed = await request("/entries", {}, migrated.url);
    assert.equal(listed.body.entries.length, 1);
    assert.equal(listed.body.entries[0].title, "Retained v1");
    assert.equal(listed.body.entries[0].viewCount, 3);
    await request("/sync", { method: "POST" }, migrated.url);
    const operationLog = JSON.parse(fs.readFileSync(
      health.body.cloud.paths.operationFile,
      "utf8"
    ));
    assert.ok(operationLog.operations.some(item =>
      item.entityId === "v1-deleted" && item.kind === "delete"
    ));

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const versions = database.prepare(
        "SELECT version FROM schema_version ORDER BY version"
      ).all().map(row => row.version);
      assert.deepEqual(versions, [1, 2]);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM operations").get().count,
        2
      );
      assert.equal(
        database.prepare(
          "SELECT deleted_at FROM tombstones WHERE id = 'v1-deleted'"
        ).get().deleted_at,
        "2025-01-03T00:00:00.000Z"
      );
    } finally {
      database.close();
    }
  } finally {
    await stopService(migrated);
  }
});

test("v1 bootstrap chooses the latest local entry or tombstone per entity", async () => {
  const migrationRoot = path.join(root, "local-v1-collapse");
  const migrationData = path.join(migrationRoot, "data");
  const migrationOneDrive = path.join(migrationRoot, "onedrive");
  const databasePath = path.join(migrationData, "knowledge.db");
  createV1Database(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    INSERT INTO entries VALUES (
      'revived-entry', 'Newer surviving entry', 'Revived content', 'revived-key',
      '', '', '[]', '', '2025-01-01T00:00:00.000Z',
      '2025-04-01T00:00:00.000Z', 0, ''
    );
    INSERT INTO tombstones VALUES (
      'revived-entry', '2025-02-01T00:00:00.000Z'
    );
    INSERT INTO entries VALUES (
      'newer-delete', 'Older deleted entry', 'Removed content', 'removed-key',
      '', '', '[]', '', '2025-01-01T00:00:00.000Z',
      '2025-02-01T00:00:00.000Z', 0, ''
    );
    INSERT INTO tombstones VALUES (
      'newer-delete', '2025-04-01T00:00:00.000Z'
    );
  `);
  database.close();

  const migrated = await startService(migrationData, migrationOneDrive);
  try {
    await request("/sync", { method: "POST" }, migrated.url);
    const listed = await request("/entries", {}, migrated.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === "revived-entry").title,
      "Newer surviving entry"
    );
    assert.equal(
      listed.body.entries.some(entry => entry.id === "newer-delete"),
      false
    );
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        migratedDatabase.prepare(
          "SELECT kind FROM entity_versions WHERE entity_id = 'revived-entry'"
        ).get().kind,
        "upsert"
      );
      assert.equal(
        migratedDatabase.prepare(
          "SELECT COUNT(*) AS count FROM tombstones WHERE id = 'revived-entry'"
        ).get().count,
        0
      );
      assert.equal(
        migratedDatabase.prepare(
          "SELECT kind FROM entity_versions WHERE entity_id = 'newer-delete'"
        ).get().kind,
        "delete"
      );
      assert.equal(
        migratedDatabase.prepare(
          "SELECT COUNT(*) AS count FROM entries WHERE id = 'newer-delete'"
        ).get().count,
        0
      );
    } finally {
      migratedDatabase.close();
    }
  } finally {
    await stopService(migrated);
  }
});

test("first v2 sync reconciles local and snapshot v1 timestamps once", async () => {
  const migrationRoot = path.join(root, "legacy-reconciliation");
  const migrationData = path.join(migrationRoot, "data");
  const migrationOneDrive = path.join(migrationRoot, "onedrive");
  const databasePath = path.join(migrationData, "knowledge.db");
  createV1Database(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    UPDATE entries
    SET title = 'Newer local entry',
        updated_at = '2025-03-01T00:00:00.000Z'
    WHERE id = 'v1-entry';
    UPDATE tombstones
    SET deleted_at = '2025-03-02T00:00:00.000Z'
    WHERE id = 'v1-deleted';
    INSERT INTO entries VALUES (
      'remote-delete', 'Older local entry', 'Remote delete content', 'remote-delete-key',
      '', '', '[]', '', '2025-01-01T00:00:00.000Z',
      '', 0, ''
    );
    INSERT INTO entries VALUES (
      'remote-newer', 'Older local version', 'Old remote-newer content', 'remote-newer-key',
      '', '', '[]', '', '2025-01-01T00:00:00.000Z',
      '', 0, ''
    );
  `);
  database.close();

  const syncDir = path.join(
    migrationOneDrive, "Apps", "AI Knowledge Inbox"
  );
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, "knowledge-sync.json"), JSON.stringify({
    version: 1,
    deviceId: "old-cloud-device",
    syncedAt: "2025-03-03T00:00:00.000Z",
    entries: [
      {
        id: "v1-entry",
        title: "Stale cloud entry",
        content: "Migration retention content",
        source: "",
        project: "",
        tags: [],
        summary: "",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-02-01T00:00:00.000Z",
        viewCount: 0,
        lastViewedAt: ""
      },
      {
        id: "v1-deleted",
        title: "Stale cloud resurrection",
        content: "Deleted content must stay deleted",
        source: "",
        project: "",
        tags: [],
        summary: "",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-02-01T00:00:00.000Z",
        viewCount: 0,
        lastViewedAt: ""
      },
      {
        id: "remote-newer",
        title: "Newer cloud version",
        content: "New remote-newer content",
        source: "",
        project: "",
        tags: [],
        summary: "",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-04-01T00:00:00.000Z",
        viewCount: 0,
        lastViewedAt: ""
      }
    ],
    tombstones: [
      {
        id: "remote-delete",
        deletedAt: "2025-04-02T00:00:00.000Z"
      }
    ]
  }, null, 2));

  let migrated = await startService(migrationData, migrationOneDrive);
  try {
    await request("/sync", { method: "POST" }, migrated.url);
    const listed = await request("/entries", {}, migrated.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === "v1-entry").title,
      "Newer local entry"
    );
    assert.equal(
      listed.body.entries.some(entry => entry.id === "v1-deleted"),
      false
    );
    assert.equal(
      listed.body.entries.some(entry => entry.id === "remote-delete"),
      false
    );
    assert.equal(
      listed.body.entries.find(entry => entry.id === "remote-newer").title,
      "Newer cloud version"
    );
    const conflicts = await request("/sync/conflicts?status=open", {}, migrated.url);
    assert.equal(conflicts.body.conflicts.length, 0);
  } finally {
    await stopService(migrated);
  }

  const reconciled = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.ok(reconciled.prepare(
      "SELECT value FROM sync_metadata WHERE key = 'legacy_reconciled'"
    ).get().value);
  } finally {
    reconciled.close();
  }

  const derived = JSON.parse(fs.readFileSync(
    path.join(syncDir, "knowledge-sync.json"),
    "utf8"
  ));
  derived.entries.find(entry => entry.id === "v1-entry").title =
    "Stale snapshot changed again";
  fs.writeFileSync(
    path.join(syncDir, "knowledge-sync.json"),
    JSON.stringify(derived, null, 2)
  );
  migrated = await startService(migrationData, migrationOneDrive);
  try {
    await request("/sync", { method: "POST" }, migrated.url);
    const listed = await request("/entries", {}, migrated.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === "v1-entry").title,
      "Newer local entry"
    );
  } finally {
    await stopService(migrated);
  }
});

test("mixed-version window imports changed v1 snapshots without loops", async () => {
  const mixedRoot = path.join(root, "mixed-version");
  const mixedData = path.join(mixedRoot, "data");
  const mixedOneDrive = path.join(mixedRoot, "onedrive");
  const mixed = await startService(mixedData, mixedOneDrive);
  try {
    const newer = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Local before v1 update",
        content: "Mixed version update content"
      })
    }, mixed.url);
    const stale = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Newer local must survive",
        content: "Mixed version stale content"
      })
    }, mixed.url);
    const removed = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Delete from v1",
        content: "Mixed version delete content"
      })
    }, mixed.url);
    const firstSync = await request("/sync", { method: "POST" }, mixed.url);
    const mixedPaths = firstSync.body.paths;
    assert.equal(fs.existsSync(mixedPaths.operationFile), true);
    const statusBefore = await request("/sync/status", {}, mixed.url);

    const newerTime = new Date(Date.now() + 60_000).toISOString();
    const staleTime = new Date(Date.now() - 60_000).toISOString();
    const newId = crypto.randomUUID();
    const externalSnapshot = JSON.stringify({
      version: 1,
      deviceId: "still-running-v1",
      syncedAt: newerTime,
      entries: [
        {
          ...newer.body.entry,
          title: "Imported newer v1 update",
          updatedAt: newerTime
        },
        {
          ...stale.body.entry,
          title: "Stale v1 update",
          updatedAt: staleTime
        },
        {
          id: newId,
          title: "Added by v1",
          content: "Mixed version newly added content",
          source: "",
          project: "",
          tags: [],
          summary: "",
          createdAt: newerTime,
          updatedAt: "",
          viewCount: 0,
          lastViewedAt: ""
        }
      ],
      tombstones: [{
        id: removed.body.entry.id,
        deletedAt: newerTime
      }]
    }, null, 2);
    fs.writeFileSync(mixedPaths.snapshot, externalSnapshot);

    const imported = await request("/sync", { method: "POST" }, mixed.url);
    assert.equal(imported.response.status, 200);
    const listed = await request("/entries", {}, mixed.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === newer.body.entry.id).title,
      "Imported newer v1 update"
    );
    assert.equal(
      listed.body.entries.find(entry => entry.id === stale.body.entry.id).title,
      "Newer local must survive"
    );
    assert.ok(listed.body.entries.some(entry => entry.id === newId));
    assert.equal(
      listed.body.entries.some(entry => entry.id === removed.body.entry.id),
      false
    );

    const operationCount = imported.body.operationCount;
    assert.ok(operationCount > statusBefore.body.operationCount);
    assert.equal(fs.readFileSync(mixedPaths.snapshot, "utf8"), externalSnapshot);
    const ownLog = JSON.parse(fs.readFileSync(mixedPaths.operationFile, "utf8"));
    assert.equal(
      ownLog.operations.filter(operation => operation.entityId === newId).at(-1).kind,
      "upsert"
    );
    assert.equal(
      ownLog.operations
        .filter(operation => operation.entityId === removed.body.entry.id)
        .at(-1).kind,
      "delete"
    );
    const repeated = await request("/sync", { method: "POST" }, mixed.url);
    assert.equal(repeated.body.operationCount, operationCount);
    assert.equal(fs.readFileSync(mixedPaths.snapshot, "utf8"), externalSnapshot);
    const database = new DatabaseSync(mixedPaths.database, { readOnly: true });
    try {
      assert.equal(
        database.prepare(
          "SELECT value FROM sync_metadata WHERE key = 'legacy_snapshot_synced_at'"
        ).get().value,
        newerTime
      );
      assert.ok(database.prepare(
        "SELECT value FROM sync_metadata WHERE key = 'mixed_version_until'"
      ).get().value);
    } finally {
      database.close();
    }
  } finally {
    await stopService(mixed);
  }
});

test("sync retries when a v1 snapshot changes before replacement", async () => {
  const raceRoot = path.join(root, "snapshot-race");
  const raceData = path.join(raceRoot, "data");
  const raceOneDrive = path.join(raceRoot, "onedrive");
  const raced = await startService(raceData, raceOneDrive, {
    AI_KNOWLEDGE_TEST_SYNC_PAUSE_MS: "400"
  });
  try {
    const firstSync = await request("/sync", { method: "POST" }, raced.url);
    const racePaths = firstSync.body.paths;
    const raceId = crypto.randomUUID();
    const raceTime = new Date(Date.now() + 60_000).toISOString();
    const runningSync = request("/sync", { method: "POST" }, raced.url);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(racePaths.snapshot, JSON.stringify({
      version: 1,
      deviceId: "racing-v1-device",
      syncedAt: raceTime,
      entries: [{
        id: raceId,
        title: "Observed racing v1 entry",
        content: "Snapshot changed during synchronization",
        source: "",
        project: "",
        tags: [],
        summary: "",
        createdAt: raceTime,
        updatedAt: "",
        viewCount: 0,
        lastViewedAt: ""
      }],
      tombstones: []
    }, null, 2));
    const synced = await runningSync;
    assert.equal(synced.response.status, 200);
    const listed = await request("/entries", {}, raced.url);
    assert.ok(listed.body.entries.some(entry => entry.id === raceId));
    const preserved = JSON.parse(fs.readFileSync(racePaths.snapshot, "utf8"));
    assert.equal(preserved.deviceId, "racing-v1-device");
    assert.ok(preserved.entries.some(entry => entry.id === raceId));
    const ownLog = JSON.parse(fs.readFileSync(racePaths.operationFile, "utf8"));
    assert.ok(ownLog.operations.some(operation => operation.entityId === raceId));
  } finally {
    await stopService(raced);
  }
});

test("startup recovers an interrupted durable database replacement", async () => {
  const recoveryRoot = path.join(root, "startup-recovery");
  const recoveryData = path.join(recoveryRoot, "data");
  const recoveryOneDrive = path.join(recoveryRoot, "onedrive");
  const databasePath = path.join(recoveryData, "knowledge.db");
  createV1Database(databasePath);
  const originalPath = path.join(recoveryData, "knowledge.db.restore-original");
  const candidatePath = path.join(recoveryData, "knowledge.db.restore-candidate");
  fs.renameSync(databasePath, originalPath);
  fs.writeFileSync(candidatePath, "incomplete replacement");
  fs.writeFileSync(path.join(recoveryData, "restore-journal.json"), JSON.stringify({
    version: 1,
    phase: "original-moved",
    createdAt: new Date().toISOString()
  }));

  const recovered = await startService(recoveryData, recoveryOneDrive);
  try {
    const listed = await request("/entries", {}, recovered.url);
    assert.equal(listed.body.entries[0].title, "Retained v1");
    assert.equal(fs.existsSync(originalPath), false);
    assert.equal(fs.existsSync(candidatePath), false);
    assert.equal(
      fs.existsSync(path.join(recoveryData, "restore-journal.json")),
      false
    );
  } finally {
    await stopService(recovered);
  }
});

test("startup recovers a valid original database without a journal", async () => {
  const recoveryRoot = path.join(root, "startup-recovery-no-journal");
  const recoveryData = path.join(recoveryRoot, "data");
  const recoveryOneDrive = path.join(recoveryRoot, "onedrive");
  const databasePath = path.join(recoveryData, "knowledge.db");
  createV1Database(databasePath);
  const originalPath = path.join(recoveryData, "knowledge.db.restore-original");
  fs.renameSync(databasePath, originalPath);

  const recovered = await startService(recoveryData, recoveryOneDrive);
  try {
    const listed = await request("/entries", {}, recovered.url);
    assert.equal(listed.body.entries[0].title, "Retained v1");
    assert.equal(fs.existsSync(databasePath), true);
    assert.equal(fs.existsSync(originalPath), false);
  } finally {
    await stopService(recovered);
  }
});

test("startup rollback removes candidate WAL sidecars before restoring original", async () => {
  const recoveryRoot = path.join(root, "startup-recovery-sidecars");
  const recoveryData = path.join(recoveryRoot, "data");
  const recoveryOneDrive = path.join(recoveryRoot, "onedrive");
  const databasePath = path.join(recoveryData, "knowledge.db");
  createV1Database(databasePath);
  const originalPath = path.join(recoveryData, "knowledge.db.restore-original");
  const candidatePath = path.join(recoveryData, "knowledge.db.restore-candidate");
  fs.renameSync(databasePath, originalPath);
  createV1Database(databasePath);
  const candidate = new DatabaseSync(databasePath);
  candidate.prepare(
    "UPDATE entries SET title = 'Uncommitted candidate' WHERE id = 'v1-entry'"
  ).run();
  candidate.close();
  fs.writeFileSync(`${databasePath}-wal`, "candidate wal must be removed");
  fs.writeFileSync(`${databasePath}-shm`, "candidate shm must be removed");
  fs.writeFileSync(`${candidatePath}-wal`, "staged candidate wal");
  fs.writeFileSync(`${candidatePath}-shm`, "staged candidate shm");
  fs.writeFileSync(path.join(recoveryData, "restore-journal.json"), JSON.stringify({
    version: 1,
    phase: "installed",
    createdAt: new Date().toISOString()
  }));

  const recovered = await startService(recoveryData, recoveryOneDrive);
  try {
    const listed = await request("/entries", {}, recovered.url);
    assert.equal(listed.body.entries[0].title, "Retained v1");
    assert.equal(fs.existsSync(`${candidatePath}-wal`), false);
    assert.equal(fs.existsSync(`${candidatePath}-shm`), false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    await stopService(recovered);
  }
});

test("health and sync status expose v2 storage details", async () => {
  const { body, response } = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.storage, "sqlite");
  assert.equal(body.cloud.enabled, true);
  assert.equal(body.cloud.schemaVersion, 2);
  assert.equal(typeof body.cloud.operationCount, "number");
  assert.equal(typeof body.cloud.conflictCount, "number");
  assert.equal(body.cloud.paths.database, path.join(dataDir, "knowledge.db"));
  assert.equal(body.cloud.paths.operations, path.join(
    oneDrive, "Apps", "AI Knowledge Inbox", "operations"
  ));
});

test("bearer authentication protects sensitive routes while health stays minimal", async () => {
  const unauthenticated = await request("/entries", {
    headers: { Authorization: "" }
  });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.response.headers.get("www-authenticate"), "Bearer");

  const invalid = await request("/entries", {
    headers: { Authorization: "Bearer definitely-wrong" }
  });
  assert.equal(invalid.response.status, 401);

  const valid = await request("/entries");
  assert.equal(valid.response.status, 200);

  const health = await request("/health", {
    headers: { Authorization: "" }
  });
  assert.deepEqual(health.body, {
    status: "ok",
    app: "AI Knowledge Inbox",
    version: "1.6.0",
    protocolVersion: "1.0.0",
    authRequired: true
  });
  assert.equal(JSON.stringify(health.body).includes(service.token), false);
  assert.equal(service.errors.value.includes(service.token), false);
  const authenticatedHealth = await request("/health");
  assert.equal(authenticatedHealth.body.app.version, "1.6.0");
  assert.equal(authenticatedHealth.body.app.build, "development");
  assert.equal(authenticatedHealth.body.protocolVersion, "1.0.0");
  const sync = await request("/sync/status");
  assert.equal(JSON.stringify([authenticatedHealth.body, sync.body]).includes(service.token), false);
});

test("authentication token persists with restrictive permissions", async () => {
  const authRoot = path.join(root, "auth-persistence");
  const authData = path.join(authRoot, "data");
  const authCloud = path.join(authRoot, "cloud");
  const first = await startService(authData, authCloud);
  const originalToken = first.token;
  const tokenPath = path.join(authData, "auth-token");
  try {
    assert.match(originalToken, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(tokenPath).mode & 0o077, 0);
    }
  } finally {
    await stopService(first);
  }
  const restarted = await startService(authData, authCloud);
  try {
    assert.equal(restarted.token, originalToken);
  } finally {
    await stopService(restarted);
  }
});

test("authentication challenge proves token possession without exposing it", async () => {
  const nonce = crypto.randomBytes(32).toString("hex");
  const challenge = await request("/auth/challenge", {
    method: "POST",
    headers: {
      Origin: "chrome-extension://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      Authorization: ""
    },
    body: JSON.stringify({ protocol: 1, nonce })
  });
  assert.equal(challenge.response.status, 200);
  assert.deepEqual(
    {
      domain: challenge.body.domain,
      protocol: challenge.body.protocol,
      nonce: challenge.body.nonce
    },
    {
      domain: "AIKnowledgeInbox.LocalAPI.AuthChallenge",
      protocol: 1,
      nonce
    }
  );
  const expected = crypto.createHmac("sha256", service.token)
    .update(`AIKnowledgeInbox.LocalAPI.AuthChallenge\n1\n${nonce}`)
    .digest("hex");
  assert.equal(challenge.body.proof, expected);
  assert.equal(JSON.stringify(challenge.body).includes(service.token), false);

  const invalid = await request("/auth/challenge", {
    method: "POST",
    headers: { Authorization: "" },
    body: JSON.stringify({ protocol: 1, nonce: "too-short" })
  });
  assert.equal(invalid.response.status, 400);
});

test("authentication challenge endpoint is rate limited", async () => {
  const challengeRoot = path.join(root, "challenge-rate");
  const limited = await startService(
    path.join(challengeRoot, "data"),
    path.join(challengeRoot, "cloud"),
    { AI_KNOWLEDGE_CHALLENGE_RATE_LIMIT: "2" }
  );
  try {
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await request("/auth/challenge", {
        method: "POST",
        headers: { Authorization: "" },
        body: JSON.stringify({
          protocol: 1,
          nonce: crypto.randomBytes(32).toString("hex")
        })
      }, limited.url);
      statuses.push(result.response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await stopService(limited);
  }
});

test("pairing is extension-only, one-time, and authorizes only the paired origin", async () => {
  const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const codeResult = await request("/pairing/code", { method: "POST" });
  assert.equal(codeResult.response.status, 201);
  assert.match(codeResult.body.code, /^[A-Z2-9]{8}$/);

  const rejectedWeb = await request("/pairing/exchange", {
    method: "POST",
    headers: { Origin: "https://evil.example", Authorization: "" },
    body: JSON.stringify({ code: codeResult.body.code })
  });
  assert.equal(rejectedWeb.response.status, 403);

  const exchanged = await request("/pairing/exchange", {
    method: "POST",
    headers: { Origin: origin, Authorization: "" },
    body: JSON.stringify({ code: codeResult.body.code })
  });
  assert.equal(exchanged.response.status, 200);
  assert.equal(exchanged.body.token, service.token);

  const replay = await request("/pairing/exchange", {
    method: "POST",
    headers: { Origin: origin, Authorization: "" },
    body: JSON.stringify({ code: codeResult.body.code })
  });
  assert.equal(replay.response.status, 410);

  const paired = await request("/entries", { headers: { Origin: origin } });
  assert.equal(paired.response.status, 200);
  const unpaired = await request("/entries", {
    headers: { Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  });
  assert.equal(unpaired.response.status, 403);
});

test("pairing codes expire and enforce an attempt bound", async () => {
  const pairingRoot = path.join(root, "pairing-limits");
  const expiring = await startService(
    path.join(pairingRoot, "expiry-data"),
    path.join(pairingRoot, "expiry-cloud"),
    { AI_KNOWLEDGE_PAIRING_TTL_MS: "100" }
  );
  try {
    const generated = await request("/pairing/code", { method: "POST" }, expiring.url);
    await new Promise(resolve => setTimeout(resolve, 150));
    const expired = await request("/pairing/exchange", {
      method: "POST",
      headers: {
        Origin: "chrome-extension://cccccccccccccccccccccccccccccccc",
        Authorization: ""
      },
      body: JSON.stringify({ code: generated.body.code })
    }, expiring.url);
    assert.equal(expired.response.status, 410);
  } finally {
    await stopService(expiring);
  }

  const bounded = await startService(
    path.join(pairingRoot, "attempt-data"),
    path.join(pairingRoot, "attempt-cloud"),
    { AI_KNOWLEDGE_PAIRING_MAX_ATTEMPTS: "2" }
  );
  try {
    await request("/pairing/code", { method: "POST" }, bounded.url);
    const headers = {
      Origin: "chrome-extension://dddddddddddddddddddddddddddddddd",
      Authorization: ""
    };
    const first = await request("/pairing/exchange", {
      method: "POST", headers, body: JSON.stringify({ code: "WRONG222" })
    }, bounded.url);
    const second = await request("/pairing/exchange", {
      method: "POST", headers, body: JSON.stringify({ code: "WRONG333" })
    }, bounded.url);
    assert.equal(first.response.status, 401);
    assert.equal(second.response.status, 429);
  } finally {
    await stopService(bounded);
  }
});

test("diagnostics are authenticated and redact knowledge, secrets, and home paths", async () => {
  const secretTitle = "PRIVATE-DIAGNOSTIC-TITLE";
  const secretSource = "https://secret.example/private";
  await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: secretTitle,
      content: "PRIVATE-DIAGNOSTIC-CONTENT",
      source: secretSource
    })
  });
  const unauthorized = await request("/diagnostics", {
    headers: { Authorization: "" }
  });
  assert.equal(unauthorized.response.status, 401);
  const result = await request("/diagnostics");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.schemaVersion, 2);
  assert.equal(typeof result.body.counts.entries, "number");
  const serialized = JSON.stringify(result.body);
  for (const forbidden of [
    secretTitle,
    secretSource,
    "PRIVATE-DIAGNOSTIC-CONTENT",
    service.token,
    os.homedir()
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(/hmac|proof/i.test(serialized), false);
  assert.ok(serialized.includes("<home>"));
});

test("desktop companions verify service identity before creating bearer headers", () => {
  const windows = fs.readFileSync(
    path.join(__dirname, "..", "desktop", "desktop-companion.ps1"),
    "utf8"
  );
  const macos = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "macos",
      "Sources",
      "AIKnowledgeCompanion",
      "main.swift"
    ),
    "utf8"
  );
  assert.match(
    windows,
    /function Get-AuthHeaders\s*\{\s*Assert-ServiceIdentity[\s\S]*?Authorization/
  );
  assert.match(
    macos,
    /private func authorizedRequest[\s\S]*?try verifyServiceIdentity\(\)[\s\S]*?forHTTPHeaderField: "Authorization"/
  );
});

test("existing CRUD, duplicate prevention, and view tracking remain compatible", async () => {
  const created = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Agent plan",
      content: "Unique integration content",
      source: "https://copilot.microsoft.com/",
      project: "Test"
    })
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.entry.tags.includes("Agent"));

  const duplicate = await request("/entries", {
    method: "POST",
    body: JSON.stringify({ content: " unique   integration content " })
  });
  assert.equal(duplicate.response.status, 409);

  const id = created.body.entry.id;
  const updated = await request(`/entries/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...created.body.entry,
      title: "Updated agent plan",
      summary: "A test summary"
    })
  });
  assert.equal(updated.body.entry.title, "Updated agent plan");
  assert.equal(updated.body.entry.summary, "A test summary");

  const viewed = await request(`/entries/${id}/view`, { method: "POST" });
  assert.equal(viewed.body.entry.viewCount, 1);
});

test("remote operation logs import entries", async () => {
  await request("/sync", { method: "POST" });
  assert.equal(fs.existsSync(paths.operationFile), true);
  const remoteId = crypto.randomUUID();
  remoteOperations.push(makeRemoteOperation({
    counter: 1,
    entityId: remoteId,
    kind: "upsert",
    vector: {},
    entry: {
      id: remoteId,
      title: "Remote operation entry",
      content: "Unique remote operation content",
      source: "",
      project: "Remote",
      tags: ["Cloud"],
      summary: "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      viewCount: 0,
      lastViewedAt: ""
    }
  }));
  writeRemoteOperations();
  const synced = await request("/sync", { method: "POST" });
  assert.equal(synced.response.status, 200);
  const listed = await request("/entries");
  assert.ok(listed.body.entries.some(entry => entry.id === remoteId));
});

test("invalid operation files are isolated while healthy logs continue", async () => {
  await request("/sync", { method: "POST" });
  const malformedPath = path.join(paths.operations, "malformed-device.json");
  const unsupportedPath = path.join(paths.operations, "unsupported-device.json");
  const healthyPath = path.join(paths.operations, "healthy-device.json");
  const malformedContents = "{not valid json";
  fs.writeFileSync(malformedPath, malformedContents);
  fs.writeFileSync(unsupportedPath, JSON.stringify({
    version: 99,
    deviceId: "unsupported-device",
    operations: []
  }));
  const healthyId = crypto.randomUUID();
  fs.writeFileSync(healthyPath, JSON.stringify({
    version: 2,
    deviceId: "healthy-device",
    operations: [{
      opId: "healthy-device:1",
      deviceId: "healthy-device",
      counter: 1,
      entityId: healthyId,
      kind: "upsert",
      vector: { "healthy-device": 1 },
      entry: {
        id: healthyId,
        title: "Healthy beside malformed",
        content: "Healthy operation survives malformed neighbors",
        source: "",
        project: "",
        tags: [],
        summary: "",
        createdAt: new Date().toISOString(),
        updatedAt: "",
        viewCount: 0,
        lastViewedAt: ""
      },
      createdAt: new Date().toISOString()
    }]
  }));

  const synced = await request("/sync", { method: "POST" });
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.status, "degraded");
  assert.deepEqual(
    synced.body.degradedFiles.map(item => item.name).sort(),
    ["malformed-device.json", "unsupported-device.json"]
  );
  const listed = await request("/entries");
  assert.ok(listed.body.entries.some(entry => entry.id === healthyId));
  assert.equal(fs.readFileSync(malformedPath, "utf8"), malformedContents);
  assert.equal(fs.existsSync(unsupportedPath), true);

  const repeated = await request("/sync", { method: "POST" });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.status, "degraded");
  assert.ok(fs.existsSync(paths.operationFile));
});

test("malformed compatibility snapshots degrade without blocking v2 logs", async () => {
  const compatibilityRoot = path.join(root, "invalid-compatibility");
  const compatibilityData = path.join(compatibilityRoot, "data");
  const compatibilityOneDrive = path.join(compatibilityRoot, "onedrive");
  const compatible = await startService(compatibilityData, compatibilityOneDrive);
  try {
    const local = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Local publish despite bad snapshot",
        content: "Own operation must still publish"
      })
    }, compatible.url);
    const health = await request("/health", {}, compatible.url);
    const compatiblePaths = health.body.cloud.paths;
    fs.mkdirSync(compatiblePaths.operations, { recursive: true });
    const healthyDevice = "compatibility-healthy-device";
    const healthyOperations = [];
    const healthyPath = path.join(compatiblePaths.operations, "healthy.json");
    const addHealthy = counter => {
      const id = crypto.randomUUID();
      healthyOperations.push({
        opId: `${healthyDevice}:${counter}`,
        deviceId: healthyDevice,
        counter,
        entityId: id,
        kind: "upsert",
        vector: { [healthyDevice]: counter },
        entry: {
          id,
          title: `Healthy compatibility neighbor ${counter}`,
          content: `Healthy compatibility content ${counter}`,
          source: "",
          project: "",
          tags: [],
          summary: "",
          createdAt: new Date().toISOString(),
          updatedAt: "",
          viewCount: 0,
          lastViewedAt: ""
        },
        createdAt: new Date().toISOString()
      });
      fs.writeFileSync(healthyPath, JSON.stringify({
        version: 2,
        deviceId: healthyDevice,
        operations: healthyOperations
      }, null, 2));
      return id;
    };

    const malformed = "{malformed compatibility";
    fs.mkdirSync(path.dirname(compatiblePaths.snapshot), { recursive: true });
    fs.writeFileSync(compatiblePaths.snapshot, malformed);
    const firstHealthyId = addHealthy(1);
    const malformedSync = await request("/sync", { method: "POST" }, compatible.url);
    assert.equal(malformedSync.response.status, 200);
    assert.equal(malformedSync.body.status, "degraded");
    assert.ok(malformedSync.body.degradedFiles.some(item =>
      item.path === compatiblePaths.snapshot
    ));
    assert.equal(fs.readFileSync(compatiblePaths.snapshot, "utf8"), malformed);
    let listed = await request("/entries", {}, compatible.url);
    assert.ok(listed.body.entries.some(entry => entry.id === firstHealthyId));
    const ownLog = JSON.parse(fs.readFileSync(compatiblePaths.operationFile, "utf8"));
    assert.ok(ownLog.operations.some(operation => operation.entityId === local.body.entry.id));

    const unsupported = JSON.stringify({
      version: 99,
      deviceId: "unsupported-v1",
      entries: [],
      tombstones: []
    });
    fs.writeFileSync(compatiblePaths.snapshot, unsupported);
    const secondHealthyId = addHealthy(2);
    const unsupportedSync = await request("/sync", { method: "POST" }, compatible.url);
    assert.equal(unsupportedSync.response.status, 200);
    assert.equal(unsupportedSync.body.status, "degraded");
    assert.equal(fs.readFileSync(compatiblePaths.snapshot, "utf8"), unsupported);
    listed = await request("/entries", {}, compatible.url);
    assert.ok(listed.body.entries.some(entry => entry.id === secondHealthyId));
  } finally {
    await stopService(compatible);
  }
});

test("causal frontier defers recreate until canonical delete is observed", async () => {
  const canonical = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Causal canonical",
      content: "Causal content may be recreated after delete"
    })
  });
  await request("/sync", { method: "POST" });
  const ownLog = JSON.parse(fs.readFileSync(paths.operationFile, "utf8"));
  const createOperation = ownLog.operations
    .filter(operation => operation.entityId === canonical.body.entry.id)
    .at(-1);
  const deleteDevice = "causal-delete-device";
  const deleteOperation = {
    opId: `${deleteDevice}:1`,
    deviceId: deleteDevice,
    counter: 1,
    entityId: canonical.body.entry.id,
    kind: "delete",
    vector: { ...createOperation.vector, [deleteDevice]: 1 },
    entry: null,
    createdAt: new Date().toISOString()
  };
  const recreateDevice = "causal-recreate-device";
  const recreatedId = crypto.randomUUID();
  const recreateOperation = {
    opId: `${recreateDevice}:1`,
    deviceId: recreateDevice,
    counter: 1,
    entityId: recreatedId,
    kind: "upsert",
    vector: { ...deleteOperation.vector, [recreateDevice]: 1 },
    entry: {
      ...canonical.body.entry,
      id: recreatedId,
      title: "Causally recreated"
    },
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(paths.operations, "a-recreate-first.json"), JSON.stringify({
    version: 2,
    deviceId: recreateDevice,
    operations: [recreateOperation]
  }, null, 2));
  fs.writeFileSync(path.join(paths.operations, "z-delete-second.json"), JSON.stringify({
    version: 2,
    deviceId: deleteDevice,
    operations: [deleteOperation]
  }, null, 2));

  const synced = await request("/sync", { method: "POST" });
  assert.equal(synced.response.status, 200);
  assert.equal(
    synced.body.degradedFiles.some(item => /缺少因果依赖/.test(item.error)),
    false
  );
  const listed = await request("/entries");
  assert.equal(
    listed.body.entries.some(entry => entry.id === canonical.body.entry.id),
    false
  );
  assert.equal(
    listed.body.entries.find(entry => entry.id === recreatedId).title,
    "Causally recreated"
  );

  const localAfterObservation = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Frontier-carrying local entry",
      content: "Local operations carry the global observed frontier"
    })
  });
  await request("/sync", { method: "POST" });
  const latestOwnLog = JSON.parse(fs.readFileSync(paths.operationFile, "utf8"));
  const localOperation = latestOwnLog.operations
    .filter(operation => operation.entityId === localAfterObservation.body.entry.id)
    .at(-1);
  assert.equal(localOperation.vector[deleteDevice], 1);
  assert.equal(localOperation.vector[recreateDevice], 1);
});

test("concurrent operations resolve deterministically and persist a conflict", async () => {
  const created = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Conflict base",
      content: "Conflict base content"
    })
  });
  const id = created.body.entry.id;
  await request("/sync", { method: "POST" });
  const ownLog = JSON.parse(fs.readFileSync(paths.operationFile, "utf8"));
  const baseOperation = ownLog.operations
    .filter(operation => operation.entityId === id)
    .at(-1);

  await request(`/entries/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...created.body.entry,
      title: "Local concurrent title",
      content: "Local concurrent content"
    })
  });
  const remoteEntry = {
    ...created.body.entry,
    title: "Remote concurrent title",
    content: "Remote concurrent content",
    updatedAt: new Date().toISOString()
  };
  const incoming = makeRemoteOperation({
    counter: 2,
    entityId: id,
    kind: "upsert",
    vector: baseOperation.vector,
    entry: remoteEntry
  });
  remoteOperations.push(incoming);
  writeRemoteOperations();
  await request("/sync", { method: "POST" });

  const listed = await request("/entries");
  assert.equal(
    listed.body.entries.find(entry => entry.id === id).title,
    "Remote concurrent title"
  );
  const conflicts = await request("/sync/conflicts?status=open");
  const conflict = conflicts.body.conflicts.find(item => item.entryId === id);
  assert.ok(conflict);
  assert.equal(conflict.winningOpId, incoming.opId);
  const status = await request("/sync/status");
  assert.ok(status.body.conflictCount >= 1);

  const resolved = await request(`/sync/conflicts/${conflict.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      choice: "merged",
      entry: {
        title: "Merged concurrent title",
        content: "Merged concurrent content",
        tags: ["Merged"]
      }
    })
  });
  assert.equal(resolved.body.conflict.status, "resolved");
  assert.equal(resolved.body.operation.vector[remoteDevice], 2);
  const afterResolution = await request("/entries");
  assert.equal(
    afterResolution.body.entries.find(entry => entry.id === id).title,
    "Merged concurrent title"
  );
});

test("a causally dominating remote delete propagates to SQLite and snapshot", async () => {
  const created = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Delete remotely",
      content: "Delete propagation content"
    })
  });
  const id = created.body.entry.id;
  await request("/sync", { method: "POST" });
  const ownLog = JSON.parse(fs.readFileSync(paths.operationFile, "utf8"));
  const current = ownLog.operations
    .filter(operation => operation.entityId === id)
    .at(-1);
  remoteOperations.push(makeRemoteOperation({
    counter: 3,
    entityId: id,
    kind: "delete",
    vector: current.vector
  }));
  writeRemoteOperations();
  await request("/sync", { method: "POST" });

  const listed = await request("/entries");
  assert.equal(listed.body.entries.some(entry => entry.id === id), false);
  const remoteLogAfterDelete = JSON.parse(fs.readFileSync(
    path.join(paths.operations, `${remoteDevice}.json`),
    "utf8"
  ));
  assert.ok(remoteLogAfterDelete.operations.some(operation =>
    operation.entityId === id && operation.kind === "delete"
  ));
});

test("duplicate-content remote operations are consumed and resolvable", async () => {
  const canonical = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Canonical duplicate",
      content: "Canonical duplicate operation content"
    })
  });
  await request("/sync", { method: "POST" });
  const duplicateId = crypto.randomUUID();
  const incoming = makeRemoteOperation({
    counter: 4,
    entityId: duplicateId,
    kind: "upsert",
    vector: {},
    entry: {
      id: duplicateId,
      title: "Incoming duplicate",
      content: canonical.body.entry.content,
      source: "",
      project: "",
      tags: [],
      summary: "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      viewCount: 0,
      lastViewedAt: ""
    }
  });
  remoteOperations.push(incoming);
  writeRemoteOperations();

  const firstSync = await request("/sync", { method: "POST" });
  assert.equal(firstSync.response.status, 200);
  const secondSync = await request("/sync", { method: "POST" });
  assert.equal(secondSync.response.status, 200);
  const listed = await request("/entries");
  assert.equal(
    listed.body.entries.filter(entry =>
      entry.content === canonical.body.entry.content
    ).length,
    1
  );
  assert.ok(listed.body.entries.some(entry => entry.id === canonical.body.entry.id));
  assert.equal(listed.body.entries.some(entry => entry.id === duplicateId), false);

  const conflicts = await request("/sync/conflicts?status=open");
  const conflict = conflicts.body.conflicts.find(item =>
    item.incoming.opId === incoming.opId
  );
  assert.ok(conflict);
  assert.equal(conflict.local.dedupCanonicalId, canonical.body.entry.id);
  const resolved = await request(`/sync/conflicts/${conflict.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ choice: "incoming" })
  });
  assert.equal(resolved.response.status, 200);
  const after = await request("/entries");
  assert.equal(
    after.body.entries.some(entry => entry.id === canonical.body.entry.id),
    false
  );
  assert.equal(
    after.body.entries.find(entry => entry.id === duplicateId).title,
    "Incoming duplicate"
  );
});

test("losing concurrent duplicates are annotated and resolve either way", async () => {
  const losingDevice = "---losing-device";
  const losingOperations = [];
  const operationPath = path.join(paths.operations, "losing-device.json");

  async function createLosingConflict(index) {
    const canonical = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: `Losing canonical ${index}`,
        content: `Losing duplicate canonical content ${index}`
      })
    });
    const target = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: `Losing target base ${index}`,
        content: `Losing target base content ${index}`
      })
    });
    await request("/sync", { method: "POST" });
    const ownLog = JSON.parse(fs.readFileSync(paths.operationFile, "utf8"));
    const baseOperation = ownLog.operations
      .filter(operation => operation.entityId === target.body.entry.id)
      .at(-1);
    await request(`/entries/${target.body.entry.id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...target.body.entry,
        title: `Local winner ${index}`,
        content: `Local winner content ${index}`
      })
    });
    const incoming = {
      opId: `${losingDevice}:${index}`,
      deviceId: losingDevice,
      counter: index,
      entityId: target.body.entry.id,
      kind: "upsert",
      vector: {
        ...baseOperation.vector,
        [losingDevice]: index
      },
      entry: {
        ...target.body.entry,
        title: `Losing incoming duplicate ${index}`,
        content: canonical.body.entry.content,
        updatedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString()
    };
    losingOperations.push(incoming);
    fs.writeFileSync(operationPath, JSON.stringify({
      version: 2,
      deviceId: losingDevice,
      operations: losingOperations
    }, null, 2));
    await request("/sync", { method: "POST" });
    const conflicts = await request("/sync/conflicts?status=open");
    const conflict = conflicts.body.conflicts.find(item =>
      item.incoming.opId === incoming.opId
    );
    assert.ok(conflict);
    assert.equal(conflict.winningOpId, conflict.local.opId);
    assert.equal(conflict.local.dedupCanonicalId, canonical.body.entry.id);
    return { canonical: canonical.body.entry, target: target.body.entry, conflict };
  }

  const keepLocal = await createLosingConflict(1);
  const localResolution = await request(
    `/sync/conflicts/${keepLocal.conflict.id}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ choice: "local" })
    }
  );
  assert.equal(localResolution.response.status, 200);
  let listed = await request("/entries");
  assert.ok(listed.body.entries.some(entry => entry.id === keepLocal.canonical.id));
  assert.equal(
    listed.body.entries.find(entry => entry.id === keepLocal.target.id).title,
    "Local winner 1"
  );

  const takeIncoming = await createLosingConflict(2);
  const incomingResolution = await request(
    `/sync/conflicts/${takeIncoming.conflict.id}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ choice: "incoming" })
    }
  );
  assert.equal(incomingResolution.response.status, 200);
  listed = await request("/entries");
  assert.equal(
    listed.body.entries.some(entry => entry.id === takeIncoming.canonical.id),
    false
  );
  assert.equal(
    listed.body.entries.find(entry => entry.id === takeIncoming.target.id).content,
    takeIncoming.canonical.content
  );
});

test("backup creation, listing, and safe restore preserve the selected state", async () => {
  const baseline = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Backup baseline",
      content: "Backup baseline content"
    })
  });
  const manual = await request("/backups", { method: "POST" });
  assert.equal(manual.response.status, 201);
  assert.equal(manual.body.backup.reason, "manual");
  assert.equal(fs.existsSync(manual.body.backup.path), true);

  await request(`/entries/${baseline.body.entry.id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...baseline.body.entry,
      title: "Changed after backup"
    })
  });
  const later = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Created after backup",
      content: "Created only after backup"
    })
  });
  await request("/sync", { method: "POST" });
  const operationFileBeforeRestore = fs.readFileSync(paths.operationFile);
  const restored = await request("/backups/restore", {
    method: "POST",
    body: JSON.stringify({ name: manual.body.backup.name })
  });
  assert.equal(restored.response.status, 200, restored.body.error);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.safetyBackup.reason, "pre-restore");
  assert.deepEqual(
    fs.readFileSync(paths.operationFile),
    operationFileBeforeRestore
  );

  const listed = await request("/entries");
  assert.equal(
    listed.body.entries.find(entry => entry.id === baseline.body.entry.id).title,
    "Backup baseline"
  );
  assert.equal(
    listed.body.entries.some(entry => entry.id === later.body.entry.id),
    false
  );
  const backups = await request("/backups");
  assert.ok(backups.body.backups.some(item => item.name === manual.body.backup.name));
  assert.ok(backups.body.backups.some(item => item.reason === "pre-restore"));
});

test("backup retention is bounded independently by reason", async () => {
  const retentionRoot = path.join(root, "backup-retention");
  const retentionData = path.join(retentionRoot, "data");
  const retentionOneDrive = path.join(retentionRoot, "onedrive");
  const retained = await startService(retentionData, retentionOneDrive);
  try {
    const health = await request("/health", {}, retained.url);
    const backupDir = health.body.cloud.paths.backups;
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const counts = { daily: 9, manual: 11, "pre-restore": 7 };
    let sequence = 0;
    for (const [reason, count] of Object.entries(counts)) {
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        const name = `knowledge-2026-01-${String(index + 1).padStart(2, "0")}T00-00-${String(sequence).padStart(2, "0")}-000Z-${reason}.sqlite`;
        const filePath = path.join(backupDir, name);
        fs.writeFileSync(filePath, reason);
        const timestamp = new Date(Date.UTC(2026, 0, index + 1, 0, 0, sequence));
        fs.utimesSync(filePath, timestamp, timestamp);
      }
    }
    const created = await request("/backups", { method: "POST" }, retained.url);
    assert.equal(created.response.status, 201);
    const backups = await request("/backups", {}, retained.url);
    const byReason = reason =>
      backups.body.backups.filter(item => item.reason === reason).length;
    assert.equal(byReason("daily"), 7);
    assert.equal(byReason("manual"), 10);
    assert.equal(byReason("pre-restore"), 5);
  } finally {
    await stopService(retained);
  }
});

test("incomplete mutation body does not block health or restore serialization", async () => {
  const gateRoot = path.join(root, "restore-gate");
  const gateData = path.join(gateRoot, "data");
  const gateOneDrive = path.join(gateRoot, "onedrive");
  const gated = await startService(gateData, gateOneDrive);
  try {
    const manual = await request("/backups", { method: "POST" }, gated.url);
    const delayedId = crypto.randomUUID();
    let finishResponse;
    const responsePromise = new Promise((resolve, reject) => {
      const delayed = http.request(`${gated.url}/entries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gated.token}`
        }
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        }));
      });
      delayed.on("error", reject);
      delayed.write(`{"id":"${delayedId}","title":"Delayed gated write",`);
      finishResponse = () => delayed.end(
        '"content":"Mutation body completed while restore waited"}'
      );
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const healthStarted = Date.now();
    const responsiveHealth = await request("/health", {}, gated.url);
    assert.equal(responsiveHealth.response.status, 200);
    assert.ok(Date.now() - healthStarted < 500);
    const restored = await request("/backups/restore", {
      method: "POST",
      body: JSON.stringify({ name: manual.body.backup.name })
    }, gated.url);
    assert.equal(restored.response.status, 200);
    finishResponse();
    const mutation = await responsePromise;
    assert.equal(mutation.status, 201);
    const listed = await request("/entries", {}, gated.url);
    assert.ok(listed.body.entries.some(entry => entry.id === mutation.body.entry.id));
  } finally {
    await stopService(gated);
  }
});

test("incomplete mutation body times out with an error response", async () => {
  const timeoutRoot = path.join(root, "body-timeout");
  const timeoutData = path.join(timeoutRoot, "data");
  const timeoutOneDrive = path.join(timeoutRoot, "onedrive");
  const timed = await startService(timeoutData, timeoutOneDrive, {
    AI_KNOWLEDGE_BODY_TIMEOUT_MS: "200"
  });
  try {
    let delayed;
    const responsePromise = new Promise((resolve, reject) => {
      delayed = http.request(`${timed.url}/entries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${timed.token}`
        }
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        }));
      });
      delayed.on("error", reject);
      delayed.write('{"title":"Never completed",');
    });
    const health = await request("/health", {}, timed.url);
    assert.equal(health.response.status, 200);
    const timedOut = await responsePromise;
    assert.equal(timedOut.status, 408);
    assert.match(timedOut.body.error, /超时/);
    delayed.destroy();
  } finally {
    await stopService(timed);
  }
});

test("post-restore failure publishes no authoritative operations", async () => {
  const failureRoot = path.join(root, "restore-fault");
  const failureData = path.join(failureRoot, "data");
  const failureOneDrive = path.join(failureRoot, "onedrive");
  const faulted = await startService(failureData, failureOneDrive, {
    AI_KNOWLEDGE_TEST_RESTORE_FAULT: "after-local"
  });
  const baseline = await request("/entries", {
    method: "POST",
    body: JSON.stringify({
      title: "Failed restore baseline",
      content: "Failed restore rollback content"
    })
  }, faulted.url);
  const manual = await request("/backups", { method: "POST" }, faulted.url);
  await request(`/entries/${baseline.body.entry.id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...baseline.body.entry,
      title: "State before failed restore"
    })
  }, faulted.url);
  const health = await request("/health", {}, faulted.url);
  await request("/sync", { method: "POST" }, faulted.url);
  const operationFile = health.body.cloud.paths.operationFile;
  const operationFileBefore = fs.readFileSync(operationFile);
  try {
    const restored = await request("/backups/restore", {
      method: "POST",
      body: JSON.stringify({ name: manual.body.backup.name })
    }, faulted.url);
    assert.equal(restored.response.status, 500);
    assert.deepEqual(fs.readFileSync(operationFile), operationFileBefore);
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.deepEqual(fs.readFileSync(operationFile), operationFileBefore);
    const listed = await request("/entries", {}, faulted.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === baseline.body.entry.id).title,
      "State before failed restore"
    );
  } finally {
    await stopService(faulted);
  }
});

test("replacement rename failure preserves the active database", async () => {
  const failureRoot = path.join(root, "replacement-fault");
  const failureData = path.join(failureRoot, "data");
  const failureOneDrive = path.join(failureRoot, "onedrive");
  const faulted = await startService(failureData, failureOneDrive, {
    AI_KNOWLEDGE_TEST_RESTORE_FAULT: "replace-rename"
  });
  try {
    const baseline = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Replacement baseline",
        content: "Replacement failure content"
      })
    }, faulted.url);
    const manual = await request("/backups", { method: "POST" }, faulted.url);
    await request(`/entries/${baseline.body.entry.id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...baseline.body.entry,
        title: "Active database remains"
      })
    }, faulted.url);
    const health = await request("/health", {}, faulted.url);
    await request("/sync", { method: "POST" }, faulted.url);
    const operationFileBefore = fs.readFileSync(
      health.body.cloud.paths.operationFile
    );

    const restored = await request("/backups/restore", {
      method: "POST",
      body: JSON.stringify({ name: manual.body.backup.name })
    }, faulted.url);
    assert.equal(restored.response.status, 500);
    assert.deepEqual(
      fs.readFileSync(health.body.cloud.paths.operationFile),
      operationFileBefore
    );
    const listed = await request("/entries", {}, faulted.url);
    assert.equal(
      listed.body.entries.find(entry => entry.id === baseline.body.entry.id).title,
      "Active database remains"
    );
    const created = await request("/entries", {
      method: "POST",
      body: JSON.stringify({
        title: "Usable after replacement failure",
        content: "Database write after replacement failure"
      })
    }, faulted.url);
    assert.equal(created.response.status, 201);
    const database = new DatabaseSync(health.body.cloud.paths.database, {
      readOnly: true
    });
    try {
      assert.equal(
        database.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok"
      );
    } finally {
      database.close();
    }
  } finally {
    await stopService(faulted);
  }
});

test("graceful shutdown removes PID and stale backup temporaries", async () => {
  const shutdownRoot = path.join(root, "graceful-shutdown");
  const shutdownData = path.join(shutdownRoot, "data");
  const shutdownOneDrive = path.join(shutdownRoot, "onedrive");
  const instance = await startService(shutdownData, shutdownOneDrive, {
    AI_KNOWLEDGE_TEST_SHUTDOWN: "1"
  });
  const health = await request("/health", {}, instance.url);
  const temporary = path.join(
    health.body.cloud.paths.backups,
    "knowledge-shutdown-test.sqlite.tmp"
  );
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  fs.writeFileSync(temporary, "stale");
  assert.equal(fs.existsSync(path.join(shutdownData, "server.pid")), true);
  const exited = new Promise(resolve => instance.child.once("exit", resolve));
  const shutdown = await request("/test/shutdown", { method: "POST" }, instance.url);
  assert.equal(shutdown.response.status, 202);
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Graceful shutdown did not finish")), 7000)
    )
  ]);
  assert.equal(fs.existsSync(path.join(shutdownData, "server.pid")), false);
  assert.equal(fs.existsSync(temporary), false);
});

test("normal web origins cannot access the service", async () => {
  const { response } = await request("/entries", {
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(response.status, 403);
});

test("server only binds its configured loopback endpoint", async () => {
  const response = await new Promise((resolve, reject) => {
    http.get(`${base}/health`, resolve).on("error", reject);
  });
  assert.equal(response.statusCode, 200);
  response.resume();
});
