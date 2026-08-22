"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");

const HOST = "127.0.0.1";
const PORT = Number(process.env.AI_KNOWLEDGE_PORT || 43127);
const DATA_DIR =
  process.env.AI_KNOWLEDGE_DATA_DIR ||
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "AIKnowledgeInbox"
      )
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "AIKnowledgeInbox")
      : path.join(os.homedir(), ".local", "share", "AIKnowledgeInbox"));
const DB_PATH = path.join(DATA_DIR, "knowledge.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const RESTORE_JOURNAL = path.join(DATA_DIR, "restore-journal.json");
const RESTORE_ORIGINAL = path.join(DATA_DIR, "knowledge.db.restore-original");
const RESTORE_CANDIDATE = path.join(DATA_DIR, "knowledge.db.restore-candidate");
const SERVER_PID_FILE = path.join(DATA_DIR, "server.pid");
const ONEDRIVE_ROOT =
  process.env.AI_KNOWLEDGE_ONEDRIVE ||
  process.env.OneDriveCommercial ||
  process.env.OneDrive ||
  process.env.OneDriveConsumer ||
  "";
const SYNC_DIR = ONEDRIVE_ROOT
  ? path.join(ONEDRIVE_ROOT, "Apps", "AI Knowledge Inbox")
  : "";
const SYNC_FILE = SYNC_DIR ? path.join(SYNC_DIR, "knowledge-sync.json") : "";
const OPERATIONS_DIR = SYNC_DIR ? path.join(SYNC_DIR, "operations") : "";
const DEVICE_FILE = path.join(DATA_DIR, "device-id.txt");
const SCHEMA_VERSION = 2;
const BACKUP_RETENTION = { daily: 7, manual: 10, "pre-restore": 5 };
const MIXED_VERSION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.AI_KNOWLEDGE_BODY_TIMEOUT_MS || 5000)
);

fs.mkdirSync(DATA_DIR, { recursive: true });

function fsyncDirectory(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, "r");
    fs.fsyncSync(handle);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function validSqliteFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  try {
    const candidate = new DatabaseSync(filePath, { readOnly: true });
    try {
      return candidate.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok";
    } finally {
      candidate.close();
    }
  } catch {
    return false;
  }
}

function removeDatabaseSidecars(databasePath) {
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
}

function recoverInterruptedRestore() {
  if (!fs.existsSync(RESTORE_JOURNAL)) {
    if (!fs.existsSync(DB_PATH) && validSqliteFile(RESTORE_ORIGINAL)) {
      removeDatabaseSidecars(DB_PATH);
      removeDatabaseSidecars(RESTORE_CANDIDATE);
      fs.renameSync(RESTORE_ORIGINAL, DB_PATH);
      fsyncDirectory(DATA_DIR);
    }
    fs.rmSync(RESTORE_CANDIDATE, { force: true });
    removeDatabaseSidecars(RESTORE_CANDIDATE);
    return;
  }
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(RESTORE_JOURNAL, "utf8"));
  } catch {
    journal = null;
  }
  if (journal?.version !== 1 ||
      !["prepared", "original-moved", "installed"].includes(journal.phase)) {
    throw new Error("恢复日志损坏，无法安全打开数据库");
  }
  removeDatabaseSidecars(RESTORE_CANDIDATE);
  if (fs.existsSync(RESTORE_ORIGINAL)) {
    removeDatabaseSidecars(DB_PATH);
    fs.rmSync(DB_PATH, { force: true });
    fs.renameSync(RESTORE_ORIGINAL, DB_PATH);
    fsyncDirectory(DATA_DIR);
  } else if (!fs.existsSync(DB_PATH)) {
    throw new Error("恢复中断且原数据库缺失");
  }
  fs.rmSync(RESTORE_CANDIDATE, { force: true });
  removeDatabaseSidecars(RESTORE_CANDIDATE);
  fs.rmSync(RESTORE_JOURNAL, { force: true });
  fsyncDirectory(DATA_DIR);
}

recoverInterruptedRestore();

const DEVICE_ID = fs.existsSync(DEVICE_FILE)
  ? fs.readFileSync(DEVICE_FILE, "utf8").trim()
  : crypto.randomUUID();
if (!fs.existsSync(DEVICE_FILE)) fs.writeFileSync(DEVICE_FILE, DEVICE_ID, "utf8");
const OPERATION_FILE = OPERATIONS_DIR
  ? path.join(OPERATIONS_DIR, `${DEVICE_ID.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)
  : "";
fs.writeFileSync(SERVER_PID_FILE, String(process.pid), "ascii");

const migrations = [
  {
    version: 1,
    sql: `
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
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE operations (
        op_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        counter INTEGER NOT NULL,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('upsert', 'delete')),
        vector_json TEXT NOT NULL,
        entry_json TEXT,
        created_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(device_id, counter)
      );
      CREATE INDEX idx_operations_device_counter
        ON operations(device_id, counter);
      CREATE INDEX idx_operations_entity
        ON operations(entity_id);
      CREATE TABLE entity_versions (
        entity_id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        counter INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('upsert', 'delete')),
        vector_json TEXT NOT NULL
      );
      CREATE TABLE conflicts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        local_op_json TEXT NOT NULL,
        incoming_op_json TEXT NOT NULL,
        winning_op_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        resolved_at TEXT NOT NULL DEFAULT '',
        resolution_op_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_conflicts_status
        ON conflicts(status, created_at DESC);
    `
  }
];

let db;
let statements;
let schemaVersion = 0;
let restoring = false;

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function migrateDatabase(database) {
  const hasVersionTable = tableExists(database, "schema_version");
  if (!hasVersionTable) {
    database.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  }

  let current = Number(
    database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version").get().version
  );
  if (current === 0 &&
      tableExists(database, "entries") &&
      tableExists(database, "tombstones")) {
    database.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (1, ?)"
    ).run(new Date().toISOString());
    current = 1;
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
      current = migration.version;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(`数据库架构版本 ${current} 高于此服务支持的版本 ${SCHEMA_VERSION}`);
  }
  return current;
}

function openDatabase() {
  const database = new DatabaseSync(DB_PATH);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    schemaVersion = migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function prepareStatements() {
  statements = {
    list: db.prepare("SELECT * FROM entries ORDER BY created_at DESC"),
    find: db.prepare("SELECT * FROM entries WHERE id = ?"),
    findByContent: db.prepare("SELECT id, title FROM entries WHERE content_key = ?"),
    listTombstones: db.prepare("SELECT id, deleted_at FROM tombstones"),
    findTombstone: db.prepare("SELECT deleted_at FROM tombstones WHERE id = ?"),
    insert: db.prepare(`
      INSERT INTO entries (
        id, title, content, content_key, source, project, tags_json, summary,
        created_at, updated_at, view_count, last_viewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE entries
      SET title = ?, content = ?, content_key = ?, source = ?, project = ?,
          tags_json = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `),
    remove: db.prepare("DELETE FROM entries WHERE id = ?"),
    upsertTombstone: db.prepare(`
      INSERT INTO tombstones (id, deleted_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at
    `),
    removeTombstone: db.prepare("DELETE FROM tombstones WHERE id = ?"),
    replaceEntry: db.prepare(`
      INSERT INTO entries (
        id, title, content, content_key, source, project, tags_json, summary,
        created_at, updated_at, view_count, last_viewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        content_key = excluded.content_key,
        source = excluded.source,
        project = excluded.project,
        tags_json = excluded.tags_json,
        summary = excluded.summary,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        view_count = excluded.view_count,
        last_viewed_at = excluded.last_viewed_at
    `),
    recordView: db.prepare(`
      UPDATE entries
      SET view_count = view_count + 1, last_viewed_at = ?
      WHERE id = ?
    `),
    getMetadata: db.prepare("SELECT value FROM sync_metadata WHERE key = ?"),
    setMetadata: db.prepare(`
      INSERT INTO sync_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    insertOperation: db.prepare(`
      INSERT OR IGNORE INTO operations (
        op_id, device_id, counter, entity_id, kind, vector_json,
        entry_json, created_at, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    findOperation: db.prepare("SELECT * FROM operations WHERE op_id = ?"),
    listOperations: db.prepare(
      "SELECT * FROM operations ORDER BY device_id, counter, op_id"
    ),
    listOwnOperations: db.prepare(
      "SELECT * FROM operations WHERE device_id = ? ORDER BY counter, op_id"
    ),
    operationCount: db.prepare("SELECT COUNT(*) AS count FROM operations"),
    maxOwnCounter: db.prepare(
      "SELECT COALESCE(MAX(counter), 0) AS counter FROM operations WHERE device_id = ?"
    ),
    findEntityVersion: db.prepare("SELECT * FROM entity_versions WHERE entity_id = ?"),
    listEntityVersions: db.prepare("SELECT * FROM entity_versions"),
    setEntityVersion: db.prepare(`
      INSERT INTO entity_versions (
        entity_id, op_id, device_id, counter, kind, vector_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        op_id = excluded.op_id,
        device_id = excluded.device_id,
        counter = excluded.counter,
        kind = excluded.kind,
        vector_json = excluded.vector_json
    `),
    insertConflict: db.prepare(`
      INSERT OR IGNORE INTO conflicts (
        id, entity_id, local_op_json, incoming_op_json, winning_op_id,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)
    `),
    listConflicts: db.prepare(
      "SELECT * FROM conflicts ORDER BY created_at DESC, id"
    ),
    listOpenConflicts: db.prepare(
      "SELECT * FROM conflicts WHERE status = 'open' ORDER BY created_at DESC, id"
    ),
    listEntityOpenConflicts: db.prepare(
      "SELECT * FROM conflicts WHERE entity_id = ? AND status = 'open'"
    ),
    findConflict: db.prepare("SELECT * FROM conflicts WHERE id = ?"),
    resolveConflict: db.prepare(`
      UPDATE conflicts
      SET status = 'resolved', resolved_at = ?, resolution_op_id = ?
      WHERE id = ? AND status = 'open'
    `),
    conflictCount: db.prepare(
      "SELECT COUNT(*) AS count FROM conflicts WHERE status = 'open'"
    )
  };
}

function runTransaction(action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

let databaseGateTail = Promise.resolve();
let shuttingDown = false;

async function acquireDatabaseGate() {
  let release;
  const previous = databaseGateTail;
  databaseGateTail = new Promise(resolve => {
    release = resolve;
  });
  await previous;
  return release;
}

async function withDatabaseGate(action) {
  const release = await acquireDatabaseGate();
  try {
    return await action();
  } finally {
    release();
  }
}

db = openDatabase();
prepareStatements();

const syncState = {
  enabled: Boolean(SYNC_FILE),
  path: SYNC_FILE,
  status: SYNC_FILE ? "idle" : "disabled",
  lastSyncAt: "",
  lastError: "",
  degradedFiles: [],
  timer: null,
  running: null
};
const backupState = { running: null, timer: null };

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || "").split(/[,，]/);
  const seen = new Set();
  return values
    .map(tag => String(tag).trim())
    .filter(tag => {
      const key = tag.toLocaleLowerCase("zh-CN");
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function suggestTags(content, title, source) {
  const text = `${title}\n${content}\n${source}`.toLocaleLowerCase("zh-CN");
  const rules = [
    ["Agent", /\bagents?\b|智能体|代理工作流/],
    ["AI", /\bai\b|人工智能|大模型|llm|生成式/],
    ["产品", /产品|需求|用户体验|\bmvp\b|原型|路线图/],
    ["代码", /代码|编程|开发|调试|重构|api|typescript|javascript|python|github/],
    ["安全", /安全|漏洞|权限|合规|攻击|防护|security|zero trust/],
    ["研究", /研究|调研|分析|洞察|报告|论文/],
    ["写作", /写作|文案|文章|摘要|润色|翻译/],
    ["会议", /会议|纪要|讨论|行动项|meeting/],
    ["销售", /客户|销售|商机|报价|合同|方案/],
    ["数据", /数据|指标|报表|数据库|sql|excel/]
  ];
  const tags = rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  if (/copilot|github/.test(text)) tags.push("Copilot");
  if (/chatgpt|openai/.test(text)) tags.push("ChatGPT");
  if (/claude|anthropic/.test(text)) tags.push("Claude");
  return normalizeTags(tags).slice(0, 5);
}

function contentKey(content) {
  const comparable = String(content || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
  return crypto.createHash("sha256").update(comparable).digest("hex");
}

function deriveTitle(content) {
  const firstLine = String(content || "").split(/\r?\n/).find(line => line.trim());
  return (firstLine || "未命名知识").trim().slice(0, 60);
}

function rowToEntry(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    source: row.source,
    project: row.project,
    tags: normalizeTags(JSON.parse(row.tags_json || "[]")),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at
  };
}

function normalizeInput(input, existing = {}) {
  const content = String(input.content ?? existing.content ?? "").trim();
  if (!content) throw apiError(400, "内容不能为空");
  const source = String(input.source ?? existing.source ?? "").trim();
  const title = String(input.title ?? existing.title ?? "").trim() || deriveTitle(content);
  const suppliedTags = input.tags ?? existing.tags ?? [];
  const tags = normalizeTags(suppliedTags);
  return {
    title,
    content,
    source,
    project: String(input.project ?? existing.project ?? "").trim(),
    tags: tags.length ? tags : suggestTags(content, title, source),
    summary: String(input.summary ?? existing.summary ?? "").trim()
  };
}

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function replaceEntryRaw(entry) {
  const normalized = normalizeInput(entry, entry);
  const duplicate = statements.findByContent.get(contentKey(normalized.content));
  if (duplicate && duplicate.id !== entry.id) {
    throw new Error(`同步内容与已有知识重复：${duplicate.title}`);
  }
  statements.replaceEntry.run(
    entry.id,
    normalized.title,
    normalized.content,
    contentKey(normalized.content),
    normalized.source,
    normalized.project,
    JSON.stringify(normalized.tags),
    normalized.summary,
    entry.createdAt || new Date().toISOString(),
    entry.updatedAt || "",
    Number.isInteger(entry.viewCount) ? entry.viewCount : 0,
    entry.lastViewedAt || ""
  );
  statements.removeTombstone.run(entry.id);
}

function findDuplicateEntry(entry) {
  if (!entry) return null;
  const duplicate = statements.findByContent.get(contentKey(entry.content));
  return duplicate && duplicate.id !== entry.id ? duplicate : null;
}

function parseVector(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("操作版本向量格式不正确");
  }
  const vector = {};
  for (const [deviceId, counter] of Object.entries(parsed)) {
    if (!deviceId || !Number.isSafeInteger(counter) || counter < 0) {
      throw new Error("操作版本向量包含无效计数");
    }
    if (counter) vector[deviceId] = counter;
  }
  return vector;
}

function observedFrontier() {
  const value = statements.getMetadata.get("observed_frontier")?.value;
  return value ? parseVector(value) : {};
}

function advanceObservedFrontier(operation) {
  const frontier = mergeVectors(observedFrontier(), operation.vector);
  frontier[operation.deviceId] = Math.max(
    frontier[operation.deviceId] || 0,
    operation.counter
  );
  statements.setMetadata.run("observed_frontier", JSON.stringify(frontier));
}

function missingOperationDependencies(operation) {
  const frontier = observedFrontier();
  const missing = [];
  for (const [deviceId, counter] of Object.entries(operation.vector)) {
    if (deviceId.startsWith("legacy-")) continue;
    const required = deviceId === operation.deviceId
      ? Math.max(0, counter - 1)
      : counter;
    if ((frontier[deviceId] || 0) < required) {
      missing.push(`${deviceId}:${required}`);
    }
  }
  return missing;
}

function mergeVectors(...vectors) {
  const merged = {};
  for (const vectorValue of vectors) {
    const vector = parseVector(vectorValue || {});
    for (const [deviceId, counter] of Object.entries(vector)) {
      merged[deviceId] = Math.max(merged[deviceId] || 0, counter);
    }
  }
  return merged;
}

function vectorCovers(leftValue, rightValue) {
  const left = parseVector(leftValue);
  const right = parseVector(rightValue);
  return Object.entries(right).every(
    ([deviceId, counter]) => (left[deviceId] || 0) >= counter
  );
}

function compareVectors(left, right) {
  const leftCovers = vectorCovers(left, right);
  const rightCovers = vectorCovers(right, left);
  if (leftCovers && rightCovers) return "equal";
  if (leftCovers) return "dominates";
  if (rightCovers) return "dominated";
  return "concurrent";
}

function operationFromRow(row) {
  return {
    opId: row.op_id,
    deviceId: row.device_id,
    counter: row.counter,
    entityId: row.entity_id,
    kind: row.kind,
    vector: parseVector(row.vector_json),
    entry: row.entry_json ? JSON.parse(row.entry_json) : null,
    createdAt: row.created_at
  };
}

function validateOperation(raw) {
  if (!raw || typeof raw !== "object" ||
      typeof raw.opId !== "string" || !raw.opId ||
      typeof raw.deviceId !== "string" || !raw.deviceId ||
      !Number.isSafeInteger(raw.counter) || raw.counter < 1 ||
      typeof raw.entityId !== "string" || !raw.entityId ||
      !["upsert", "delete"].includes(raw.kind) ||
      typeof raw.createdAt !== "string") {
    throw new Error("OneDrive 操作记录格式不正确");
  }
  const vector = parseVector(raw.vector);
  if (vector[raw.deviceId] !== raw.counter) {
    throw new Error(`操作 ${raw.opId} 的逻辑计数与版本向量不一致`);
  }
  if (raw.kind === "upsert" &&
      (!isValidSyncEntry(raw.entry) || raw.entry.id !== raw.entityId)) {
    throw new Error(`操作 ${raw.opId} 缺少有效知识内容`);
  }
  return {
    opId: raw.opId,
    deviceId: raw.deviceId,
    counter: raw.counter,
    entityId: raw.entityId,
    kind: raw.kind,
    vector,
    entry: raw.kind === "upsert" ? {
      ...raw.entry,
      tags: normalizeTags(raw.entry.tags),
      summary: String(raw.entry.summary || ""),
      updatedAt: String(raw.entry.updatedAt || ""),
      viewCount: Number.isInteger(raw.entry.viewCount) ? raw.entry.viewCount : 0,
      lastViewedAt: String(raw.entry.lastViewedAt || "")
    } : null,
    createdAt: raw.createdAt
  };
}

function persistOperation(operation) {
  const result = statements.insertOperation.run(
    operation.opId,
    operation.deviceId,
    operation.counter,
    operation.entityId,
    operation.kind,
    JSON.stringify(operation.vector),
    operation.entry ? JSON.stringify(operation.entry) : null,
    operation.createdAt,
    new Date().toISOString()
  );
  if (!result.changes && !statements.findOperation.get(operation.opId)) {
    throw new Error(`无法保存操作 ${operation.opId}`);
  }
}

function setEntityVersion(operation) {
  statements.setEntityVersion.run(
    operation.entityId,
    operation.opId,
    operation.deviceId,
    operation.counter,
    operation.kind,
    JSON.stringify(operation.vector)
  );
}

function currentVector(entityId) {
  const row = statements.findEntityVersion.get(entityId);
  return row ? parseVector(row.vector_json) : {};
}

function nextLocalOperation(
  kind,
  entityId,
  entry,
  baseVector = currentVector(entityId),
  createdAt = new Date().toISOString()
) {
  const vector = mergeVectors(observedFrontier(), baseVector);
  const storedCounter = Number(statements.getMetadata.get("logical_counter")?.value || 0);
  const databaseCounter = Number(statements.maxOwnCounter.get(DEVICE_ID).counter || 0);
  const counter = Math.max(storedCounter, databaseCounter, vector[DEVICE_ID] || 0) + 1;
  vector[DEVICE_ID] = counter;
  statements.setMetadata.run("logical_counter", String(counter));
  return {
    opId: `${DEVICE_ID}:${counter}`,
    deviceId: DEVICE_ID,
    counter,
    entityId,
    kind,
    vector,
    entry: kind === "upsert" ? entry : null,
    createdAt
  };
}

function applyOperationPayload(operation) {
  if (operation.kind === "delete") {
    statements.remove.run(operation.entityId);
    statements.upsertTombstone.run(operation.entityId, operation.createdAt);
  } else {
    replaceEntryRaw(operation.entry);
  }
  setEntityVersion(operation);
}

function recordDuplicateConflict(operation, duplicate, currentOperation = null) {
  const canonicalVersion = statements.findEntityVersion.get(duplicate.id);
  const canonicalOperation = canonicalVersion
    ? operationFromRow(statements.findOperation.get(canonicalVersion.op_id))
    : null;
  const localAlternative = currentOperation
    ? { ...currentOperation }
    : {
        opId: `dedup-preserve:${duplicate.id}`,
        deviceId: "dedup",
        counter: 1,
        entityId: operation.entityId,
        kind: "delete",
        vector: {},
        entry: null,
        createdAt: operation.createdAt
      };
  localAlternative.dedupCanonicalId = duplicate.id;
  localAlternative.canonicalOperation = canonicalOperation;
  statements.insertConflict.run(
    conflictId(localAlternative, operation),
    operation.entityId,
    JSON.stringify(localAlternative),
    JSON.stringify(operation),
    localAlternative.opId,
    new Date().toISOString()
  );
}

function applyOperationOrRecordDuplicate(operation, currentOperation = null) {
  const duplicate = operation.kind === "upsert"
    ? findDuplicateEntry(operation.entry)
    : null;
  if (duplicate) {
    recordDuplicateConflict(operation, duplicate, currentOperation);
    return false;
  }
  applyOperationPayload(operation);
  resolveCoveredConflicts(operation);
  return true;
}

function resolveCoveredConflicts(operation) {
  for (const row of statements.listEntityOpenConflicts.all(operation.entityId)) {
    const local = JSON.parse(row.local_op_json);
    const incoming = JSON.parse(row.incoming_op_json);
    if (operation.opId !== local.opId && operation.opId !== incoming.opId &&
        vectorCovers(operation.vector, local.vector) &&
        vectorCovers(operation.vector, incoming.vector)) {
      statements.resolveConflict.run(new Date().toISOString(), operation.opId, row.id);
    }
  }
}

function operationOrder(operation) {
  return `${operation.deviceId}\u0000${String(operation.counter).padStart(16, "0")}\u0000${operation.opId}`;
}

function validatedTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}

function compareRecordTimestamps(left, right) {
  const leftTime = validatedTimestamp(left.createdAt || left.order || "");
  const rightTime = validatedTimestamp(right.createdAt || right.order || "");
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  if (leftValid && leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;
  return 0;
}

function compareTimestampedRecords(left, right) {
  const timestampOrder = compareRecordTimestamps(left, right);
  if (timestampOrder) return timestampOrder;
  if (left.kind !== right.kind) return left.kind === "delete" ? 1 : -1;
  const leftPayload = crypto.createHash("sha256")
    .update(JSON.stringify(left.entry || null))
    .digest("hex");
  const rightPayload = crypto.createHash("sha256")
    .update(JSON.stringify(right.entry || null))
    .digest("hex");
  return leftPayload.localeCompare(rightPayload);
}

function operationTimestamp(record) {
  const value = record.createdAt || record.order || "";
  return Number.isFinite(validatedTimestamp(value)) ? value : new Date(0).toISOString();
}

function conflictId(left, right) {
  const ids = [left.opId, right.opId].sort();
  return crypto.createHash("sha256").update(`${ids[0]}\n${ids[1]}`).digest("hex");
}

function applyIncomingOperation(rawOperation) {
  const operation = validateOperation(rawOperation);
  if (statements.findOperation.get(operation.opId)) {
    advanceObservedFrontier(operation);
    return false;
  }

  const version = statements.findEntityVersion.get(operation.entityId);
  const currentOperation = version
    ? operationFromRow(statements.findOperation.get(version.op_id))
    : null;
  persistOperation(operation);
  try {
    if (!currentOperation) {
      return applyOperationOrRecordDuplicate(operation);
    }

    const relation = compareVectors(operation.vector, currentOperation.vector);
    if (relation === "dominates") {
      return applyOperationOrRecordDuplicate(operation, currentOperation);
    }
    if (relation === "dominated") return false;

    if (relation === "equal" && operation.opId === currentOperation.opId) return false;
    const duplicate = operation.kind === "upsert"
      ? findDuplicateEntry(operation.entry)
      : null;
    if (duplicate) {
      recordDuplicateConflict(operation, duplicate, currentOperation);
      return false;
    }
    const winner = operationOrder(operation) > operationOrder(currentOperation)
      ? operation
      : currentOperation;
    if (winner.opId === operation.opId &&
        !applyOperationOrRecordDuplicate(operation, currentOperation)) {
      return false;
    }
    statements.insertConflict.run(
      conflictId(currentOperation, operation),
      operation.entityId,
      JSON.stringify(currentOperation),
      JSON.stringify(operation),
      winner.opId,
      new Date().toISOString()
    );
    return winner.opId === operation.opId;
  } finally {
    advanceObservedFrontier(operation);
  }
}

function appendLocalState(kind, entityId, entry, baseVector) {
  const operation = nextLocalOperation(kind, entityId, entry, baseVector);
  persistOperation(operation);
  applyOperationPayload(operation);
  resolveCoveredConflicts(operation);
  advanceObservedFrontier(operation);
  return operation;
}

function bootstrapExistingData() {
  runTransaction(() => {
    const records = [
      ...statements.list.all().map(row => ({
        id: row.id,
        kind: "upsert",
        entry: rowToEntry(row),
        order: row.updated_at || row.created_at || ""
      })),
      ...statements.listTombstones.all().map(row => ({
        id: row.id,
        kind: "delete",
        entry: null,
        order: row.deleted_at || ""
      }))
    ];
    const latest = new Map();
    for (const record of records) {
      const current = latest.get(record.id);
      if (!current || compareTimestampedRecords(record, current) > 0) {
        latest.set(record.id, record);
      }
    }
    for (const [entityId, item] of [...latest.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      if (statements.findEntityVersion.get(item.id)) continue;
      if (item.kind === "upsert") {
        statements.removeTombstone.run(entityId);
      } else {
        statements.remove.run(entityId);
      }
      const operation = nextLocalOperation(
        item.kind,
        entityId,
        item.entry,
        {},
        operationTimestamp(item)
      );
      persistOperation(operation);
      setEntityVersion(operation);
      advanceObservedFrontier(operation);
    }
  });
}

bootstrapExistingData();

function createEntry(input, preserve = {}) {
  const normalized = normalizeInput(input);
  const key = contentKey(normalized.content);
  const duplicate = statements.findByContent.get(key);
  if (duplicate) throw apiError(409, `这段内容已经保存过：${duplicate.title}`);

  return runTransaction(() => {
    const createdAt = preserve.createdAt || new Date().toISOString();
    const id = preserve.id || crypto.randomUUID();
    statements.insert.run(
      id,
      normalized.title,
      normalized.content,
      key,
      normalized.source,
      normalized.project,
      JSON.stringify(normalized.tags),
      normalized.summary,
      createdAt,
      preserve.updatedAt || "",
      Number.isInteger(preserve.viewCount) ? preserve.viewCount : 0,
      preserve.lastViewedAt || ""
    );
    statements.removeTombstone.run(id);
    const entry = rowToEntry(statements.find.get(id));
    appendLocalState("upsert", id, entry);
    scheduleSync();
    return entry;
  });
}

function updateEntry(id, input) {
  const currentRow = statements.find.get(id);
  if (!currentRow) throw apiError(404, "知识不存在");
  const current = rowToEntry(currentRow);
  const normalized = normalizeInput(input, current);
  const key = contentKey(normalized.content);
  const duplicate = statements.findByContent.get(key);
  if (duplicate && duplicate.id !== id) {
    throw apiError(409, `这段内容已经保存过：${duplicate.title}`);
  }

  return runTransaction(() => {
    statements.update.run(
      normalized.title,
      normalized.content,
      key,
      normalized.source,
      normalized.project,
      JSON.stringify(normalized.tags),
      normalized.summary,
      new Date().toISOString(),
      id
    );
    const entry = rowToEntry(statements.find.get(id));
    appendLocalState("upsert", id, entry);
    scheduleSync();
    return entry;
  });
}

function deleteEntry(id) {
  return runTransaction(() => {
    if (!statements.find.get(id)) throw apiError(404, "知识不存在");
    appendLocalState("delete", id, null);
    scheduleSync();
  });
}

function recordView(id) {
  return runTransaction(() => {
    const result = statements.recordView.run(new Date().toISOString(), id);
    if (!result.changes) throw apiError(404, "知识不存在");
    const entry = rowToEntry(statements.find.get(id));
    appendLocalState("upsert", id, entry);
    scheduleSync();
    return entry;
  });
}

function isValidSyncEntry(entry) {
  return entry &&
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.content === "string" &&
    typeof entry.createdAt === "string";
}

function atomicWriteFile(target, contents) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents);
  try {
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function atomicWriteJson(target, value) {
  atomicWriteFile(target, JSON.stringify(value, null, 2));
}

function durableWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readOperationFiles() {
  if (!fs.existsSync(OPERATIONS_DIR)) return { files: [], degraded: [] };
  const files = fs.readdirSync(OPERATIONS_DIR, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const validFiles = [];
  const degraded = [];
  for (const file of files) {
    const filePath = path.join(OPERATIONS_DIR, file.name);
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")
      );
      if (!parsed || parsed.version !== 2 || typeof parsed.deviceId !== "string" ||
          !Array.isArray(parsed.operations)) {
        throw new Error("格式或版本不受支持");
      }
      const operations = parsed.operations.map(operation => {
        if (operation.deviceId !== parsed.deviceId) {
          throw new Error("包含其他设备的操作");
        }
        return validateOperation(operation);
      });
      validFiles.push({ name: file.name, path: filePath, operations });
    } catch (error) {
      degraded.push({
        name: file.name,
        path: filePath,
        error: error.message,
        observedAt: new Date().toISOString()
      });
    }
  }
  return { files: validFiles, degraded };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotFingerprint(snapshot) {
  const content = { ...snapshot };
  delete content.snapshotFingerprint;
  return crypto.createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function readCompatibilitySnapshot() {
  if (!fs.existsSync(SYNC_FILE) || !fs.statSync(SYNC_FILE).isFile()) return null;
  const contents = fs.readFileSync(SYNC_FILE, "utf8").replace(/^\uFEFF/, "");
  const rawFingerprint = crypto.createHash("sha256").update(contents).digest("hex");
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || parsed.version !== 1 ||
        !Array.isArray(parsed.entries) || !Array.isArray(parsed.tombstones)) {
      throw new Error("格式或版本不受支持");
    }
    const fingerprint = snapshotFingerprint(parsed);
    const derived = parsed.syncVersion === 2 &&
      parsed.authoritative === "operations/*.json" &&
      typeof parsed.snapshotFingerprint === "string" &&
      parsed.snapshotFingerprint === fingerprint;
    return { parsed, fingerprint, derived, invalid: false };
  } catch (error) {
    return {
      parsed: null,
      fingerprint: rawFingerprint,
      derived: false,
      invalid: true,
      error: error.message
    };
  }
}

function legacySnapshotOperations(snapshot, fingerprint) {
  if (!snapshot) return [];
  const legacyDevice = `legacy-${String(snapshot.deviceId || "snapshot")
    .replace(/[^a-zA-Z0-9._-]/g, "_")}-${fingerprint.slice(0, 12)}`;
  const records = [
    ...snapshot.entries.filter(isValidSyncEntry).map(entry => ({
      kind: "upsert",
      entityId: entry.id,
      entry,
      createdAt: entry.updatedAt || entry.createdAt
    })),
    ...snapshot.tombstones
      .filter(item => item && typeof item.id === "string")
      .map(item => ({
        kind: "delete",
        entityId: item.id,
        entry: null,
        createdAt: item.deletedAt || snapshot.syncedAt || new Date(0).toISOString()
      }))
  ].sort((left, right) =>
    String(left.createdAt).localeCompare(String(right.createdAt)) ||
    left.entityId.localeCompare(right.entityId)
  );
  return records.map((record, index) => {
    const counter = index + 1;
    const digest = crypto.createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");
    return {
      opId: `${legacyDevice}:${counter}:${digest}`,
      deviceId: legacyDevice,
      counter,
      entityId: record.entityId,
      kind: record.kind,
      vector: { [legacyDevice]: counter },
      entry: record.entry,
      createdAt: record.createdAt
    };
  });
}

function latestLegacyOperations(operations) {
  const latest = new Map();
  for (const operation of operations) {
    const current = latest.get(operation.entityId);
    if (!current || compareTimestampedRecords(operation, current) > 0) {
      latest.set(operation.entityId, operation);
    }
  }
  return latest;
}

function mixedVersionWindowOpen() {
  let windowEnd = statements.getMetadata.get("mixed_version_until")?.value || "";
  if (!Number.isFinite(validatedTimestamp(windowEnd))) {
    windowEnd = new Date(Date.now() + MIXED_VERSION_WINDOW_MS).toISOString();
    statements.setMetadata.run("mixed_version_until", windowEnd);
  }
  return Date.now() <= validatedTimestamp(windowEnd);
}

function reconcileLegacySnapshot(snapshotInfo) {
  if (!mixedVersionWindowOpen() || !snapshotInfo ||
      snapshotInfo.derived || snapshotInfo.invalid) return false;
  const lastFingerprint =
    statements.getMetadata.get("legacy_snapshot_fingerprint")?.value || "";
  if (lastFingerprint === snapshotInfo.fingerprint) return false;

  const legacyOperations = legacySnapshotOperations(
    snapshotInfo.parsed,
    snapshotInfo.fingerprint
  );
  const legacyByEntity = latestLegacyOperations(legacyOperations);

  for (const operation of legacyOperations) {
    persistOperation(validateOperation(operation));
  }
  for (const [entityId, remote] of [...legacyByEntity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const localVersion = statements.findEntityVersion.get(entityId);
    const local = localVersion
      ? operationFromRow(statements.findOperation.get(localVersion.op_id))
      : null;
    if (local && compareRecordTimestamps(remote, local) <= 0) continue;
    const base = mergeVectors(local?.vector || {}, remote.vector);
    const reconciled = nextLocalOperation(
      remote.kind,
      entityId,
      remote.entry,
      base,
      operationTimestamp(remote)
    );
    persistOperation(reconciled);
    applyOperationOrRecordDuplicate(reconciled, local);
    advanceObservedFrontier(reconciled);
  }
  statements.setMetadata.run(
    "legacy_snapshot_fingerprint",
    snapshotInfo.fingerprint
  );
  statements.setMetadata.run(
    "legacy_snapshot_synced_at",
    String(snapshotInfo.parsed.syncedAt || "")
  );
  statements.setMetadata.run("legacy_reconciled", snapshotInfo.fingerprint);
  return true;
}

function writeOwnOperationFile() {
  fs.mkdirSync(OPERATIONS_DIR, { recursive: true });
  atomicWriteJson(OPERATION_FILE, {
    version: 2,
    deviceId: DEVICE_ID,
    operations: statements.listOwnOperations.all(DEVICE_ID).map(operationFromRow)
  });
}

function writeSnapshot() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const snapshot = {
    version: 1,
    syncVersion: 2,
    authoritative: "operations/*.json",
    deviceId: DEVICE_ID,
    syncedAt: new Date().toISOString(),
    entries: statements.list.all().map(rowToEntry),
    tombstones: statements.listTombstones.all().map(item => ({
      id: item.id,
      deletedAt: item.deleted_at
    }))
  };
  snapshot.snapshotFingerprint = snapshotFingerprint(snapshot);
  atomicWriteJson(SYNC_FILE, snapshot);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(item => item.isFile() &&
      /^knowledge-\d{4}-\d{2}-\d{2}T[\d-]+Z?-(?:daily|manual|pre-restore)\.sqlite$/.test(item.name))
    .map(item => {
      const filePath = path.join(BACKUP_DIR, item.name);
      const stat = fs.statSync(filePath);
      return {
        name: item.name,
        path: filePath,
        createdAt: stat.mtime.toISOString(),
        size: stat.size,
        reason: item.name.match(/-(daily|manual|pre-restore)\.sqlite$/)?.[1] || ""
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function syncStatus() {
  const backups = listBackups();
  return {
    enabled: syncState.enabled,
    status: syncState.status,
    path: syncState.path,
    lastSyncAt: syncState.lastSyncAt,
    lastError: syncState.lastError,
    degradedFiles: syncState.degradedFiles,
    deviceId: DEVICE_ID,
    operationCount: Number(statements.operationCount.get().count),
    conflictCount: Number(statements.conflictCount.get().count),
    lastBackup: backups[0]?.createdAt || "",
    schemaVersion,
    paths: {
      database: DB_PATH,
      snapshot: SYNC_FILE,
      operations: OPERATIONS_DIR,
      operationFile: OPERATION_FILE,
      backups: BACKUP_DIR
    }
  };
}

async function syncNow() {
  if (!SYNC_FILE) {
    syncState.status = "disabled";
    syncState.lastError = "未检测到 OneDrive 同步目录";
    return syncStatus();
  }
  if (restoring) throw apiError(409, "数据库正在恢复");
  if (syncState.running) return syncState.running;

  syncState.running = withDatabaseGate(async () => {
    syncState.status = "syncing";
    syncState.lastError = "";
    const remote = readOperationFiles();
    const degraded = [...remote.degraded];
    let pending = remote.files.flatMap(file =>
      file.operations.map(operation => ({ file, operation }))
    );
    let progressed = true;
    while (pending.length && progressed) {
      progressed = false;
      const deferred = [];
      for (const item of pending) {
        const missing = statements.findOperation.get(item.operation.opId)
          ? []
          : missingOperationDependencies(item.operation);
        if (missing.length) {
          deferred.push({ ...item, missing });
          continue;
        }
        try {
          runTransaction(() => applyIncomingOperation(item.operation));
          progressed = true;
        } catch (error) {
          degraded.push({
            name: item.file.name,
            path: item.file.path,
            error: error.message,
            observedAt: new Date().toISOString()
          });
        }
      }
      pending = deferred;
    }
    for (const item of pending) {
      degraded.push({
        name: item.file.name,
        path: item.file.path,
        error: `缺少因果依赖：${item.missing.join(", ")}`,
        observedAt: new Date().toISOString()
      });
    }

    let snapshotStable = false;
    let mixedWindow = false;
    let invalidCompatibilitySnapshot = false;
    const reportCompatibilityError = snapshot => {
      if (!snapshot?.invalid) return;
      invalidCompatibilitySnapshot = true;
      if (!degraded.some(item => item.path === SYNC_FILE &&
          item.error === snapshot.error)) {
        degraded.push({
          name: path.basename(SYNC_FILE),
          path: SYNC_FILE,
          error: snapshot.error,
          observedAt: new Date().toISOString()
        });
      }
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = readCompatibilitySnapshot();
      reportCompatibilityError(observed);
      runTransaction(() => {
        mixedWindow = statements.getMetadata.get("mixed_version_complete")?.value !== "1" &&
          mixedVersionWindowOpen();
        reconcileLegacySnapshot(observed);
      });
      if (attempt === 0) {
        const pause = Number(process.env.AI_KNOWLEDGE_TEST_SYNC_PAUSE_MS || 0);
        if (pause > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(pause, 5000)));
        }
      }
      const latest = readCompatibilitySnapshot();
      reportCompatibilityError(latest);
      const observedFingerprint = observed?.fingerprint || "";
      const latestFingerprint = latest?.fingerprint || "";
      if (observedFingerprint !== latestFingerprint) continue;
      snapshotStable = true;
      break;
    }
    if (!snapshotStable) {
      throw new Error("兼容快照持续变化，已保留外部更新并延后写入");
    }
    writeOwnOperationFile();
    if (!mixedWindow && !invalidCompatibilitySnapshot) writeSnapshot();
    syncState.degradedFiles = degraded.filter(item => item.path !== OPERATION_FILE);
    syncState.lastSyncAt = new Date().toISOString();
    syncState.status = syncState.degradedFiles.length ? "degraded" : "synced";
    return syncStatus();
  }).catch(error => {
    syncState.status = "error";
    syncState.lastError = error.message;
    throw error;
  }).finally(() => {
    syncState.running = null;
  });
  return syncState.running;
}

function scheduleSync(delay = 1200) {
  if (!SYNC_FILE || restoring) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => {
    syncNow().catch(error => console.error("OneDrive sync failed:", error.message));
  }, delay);
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function pruneBackups() {
  const backups = listBackups();
  for (const [reason, retention] of Object.entries(BACKUP_RETENTION)) {
    for (const item of backups.filter(backup => backup.reason === reason).slice(retention)) {
      fs.rmSync(item.path, { force: true });
    }
  }
}

async function createBackup(reason = "manual", options = {}) {
  if (!["daily", "manual", "pre-restore"].includes(reason)) {
    throw apiError(400, "备份类型不正确");
  }
  if (backupState.running) {
    await backupState.running;
    return createBackup(reason, options);
  }
  backupState.running = (async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `knowledge-${backupTimestamp()}-${reason}.sqlite`;
    const target = path.join(BACKUP_DIR, name);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await backup(db, temporary);
      fs.renameSync(temporary, target);
      if (options.prune !== false) pruneBackups();
      return listBackups().find(item => item.name === name);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  })().finally(() => {
    backupState.running = null;
  });
  return backupState.running;
}

function validateBackup(filePath) {
  const candidate = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = candidate.prepare("PRAGMA integrity_check").get();
    if (!result || result.integrity_check !== "ok") {
      throw new Error("备份数据库完整性检查失败");
    }
  } finally {
    candidate.close();
  }
}

let replacementFaultInjected = false;

function copyDatabaseIntoPlace(source) {
  fs.rmSync(RESTORE_CANDIDATE, { force: true });
  removeDatabaseSidecars(RESTORE_CANDIDATE);
  fs.rmSync(RESTORE_ORIGINAL, { force: true });
  removeDatabaseSidecars(RESTORE_ORIGINAL);
  fs.copyFileSync(source, RESTORE_CANDIDATE);
  const candidate = fs.openSync(RESTORE_CANDIDATE, "r+");
  try {
    fs.fsyncSync(candidate);
  } finally {
    fs.closeSync(candidate);
  }
  durableWriteJson(RESTORE_JOURNAL, {
    version: 1,
    phase: "prepared",
    createdAt: new Date().toISOString()
  });
  fsyncDirectory(DATA_DIR);
  if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, RESTORE_ORIGINAL);
  fsyncDirectory(DATA_DIR);
  durableWriteJson(RESTORE_JOURNAL, {
    version: 1,
    phase: "original-moved",
    createdAt: new Date().toISOString()
  });
  fsyncDirectory(DATA_DIR);
  if (process.env.AI_KNOWLEDGE_TEST_RESTORE_FAULT === "replace-rename" &&
      !replacementFaultInjected) {
    replacementFaultInjected = true;
    throw new Error("Injected restore replacement failure");
  }
  fs.renameSync(RESTORE_CANDIDATE, DB_PATH);
  fsyncDirectory(DATA_DIR);
  removeDatabaseSidecars(DB_PATH);
  durableWriteJson(RESTORE_JOURNAL, {
    version: 1,
    phase: "installed",
    createdAt: new Date().toISOString()
  });
  fsyncDirectory(DATA_DIR);
}

function rollbackDatabaseReplacement(safetyPath) {
  if (fs.existsSync(RESTORE_ORIGINAL)) {
    removeDatabaseSidecars(DB_PATH);
    fs.rmSync(DB_PATH, { force: true });
    fs.renameSync(RESTORE_ORIGINAL, DB_PATH);
  } else if (!fs.existsSync(DB_PATH)) {
    fs.copyFileSync(safetyPath, DB_PATH);
  }
  fs.rmSync(RESTORE_CANDIDATE, { force: true });
  removeDatabaseSidecars(RESTORE_CANDIDATE);
  fs.rmSync(RESTORE_JOURNAL, { force: true });
  fsyncDirectory(DATA_DIR);
}

function commitDatabaseReplacement() {
  fs.rmSync(RESTORE_ORIGINAL, { force: true });
  removeDatabaseSidecars(RESTORE_ORIGINAL);
  fs.rmSync(RESTORE_CANDIDATE, { force: true });
  removeDatabaseSidecars(RESTORE_CANDIDATE);
  fs.rmSync(RESTORE_JOURNAL, { force: true });
  fsyncDirectory(DATA_DIR);
}

function rowsToOperations(rows) {
  return rows.map(operationFromRow);
}

async function restoreBackup(name) {
  if (restoring) throw apiError(409, "数据库正在恢复");
  if (typeof name !== "string" || path.basename(name) !== name) {
    throw apiError(400, "备份名称不正确");
  }
  const selected = listBackups().find(item => item.name === name);
  if (!selected) throw apiError(404, "备份不存在");
  restoring = true;
  clearTimeout(syncState.timer);
  let safety;
  let rollbackRequired = false;
  try {
    validateBackup(selected.path);
    safety = await createBackup("pre-restore", { prune: false });
    const prior = new DatabaseSync(safety.path, { readOnly: true });
    let priorOperations;
    let priorVersions;
    let priorConflicts;
    let priorCounter;
    try {
      priorOperations = rowsToOperations(prior.prepare("SELECT * FROM operations").all());
      priorVersions = prior.prepare("SELECT * FROM entity_versions").all();
      priorConflicts = prior.prepare("SELECT * FROM conflicts").all();
      priorCounter = Number(
        prior.prepare("SELECT value FROM sync_metadata WHERE key = 'logical_counter'").get()?.value || 0
      );
    } finally {
      prior.close();
    }

    db.close();
    db = null;
    rollbackRequired = true;
    copyDatabaseIntoPlace(selected.path);
    db = openDatabase();
    prepareStatements();
    bootstrapExistingData();

    const desiredEntries = new Map(
      statements.list.all().map(row => [row.id, rowToEntry(row)])
    );
    const desiredDeletes = new Set(
      statements.listTombstones.all().map(row => row.id)
    );
    const restoredVersions = new Map(
      statements.listEntityVersions.all().map(row => [row.entity_id, row])
    );
    const priorVersionMap = new Map(
      priorVersions.map(row => [row.entity_id, row])
    );
    const entityIds = new Set([
      ...desiredEntries.keys(),
      ...desiredDeletes,
      ...priorVersionMap.keys()
    ]);

    runTransaction(() => {
      for (const operation of priorOperations) persistOperation(operation);
      for (const conflict of priorConflicts) {
        db.prepare(`
          INSERT OR IGNORE INTO conflicts (
            id, entity_id, local_op_json, incoming_op_json, winning_op_id,
            status, created_at, resolved_at, resolution_op_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          conflict.id,
          conflict.entity_id,
          conflict.local_op_json,
          conflict.incoming_op_json,
          conflict.winning_op_id,
          conflict.status,
          conflict.created_at,
          conflict.resolved_at,
          conflict.resolution_op_id
        );
      }
      const restoredCounter = Number(
        statements.getMetadata.get("logical_counter")?.value || 0
      );
      statements.setMetadata.run(
        "logical_counter",
        String(Math.max(priorCounter, restoredCounter))
      );

      for (const entityId of [...entityIds].sort()) {
        const base = mergeVectors(
          restoredVersions.get(entityId)?.vector_json || {},
          priorVersionMap.get(entityId)?.vector_json || {}
        );
        if (desiredEntries.has(entityId)) {
          appendLocalState("upsert", entityId, desiredEntries.get(entityId), base);
        } else {
          appendLocalState("delete", entityId, null, base);
        }
      }
    });

    pruneBackups();
    if (process.env.AI_KNOWLEDGE_TEST_RESTORE_FAULT === "after-local") {
      throw new Error("Injected restore failure after local commit");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    commitDatabaseReplacement();
    rollbackRequired = false;
    return { restored: true, backup: selected, safetyBackup: safety };
  } catch (error) {
    if (rollbackRequired) {
      try {
        if (db) db.close();
        db = null;
        rollbackDatabaseReplacement(safety.path);
        db = openDatabase();
        prepareStatements();
        bootstrapExistingData();
      } catch (rollbackError) {
        error.message += `；恢复失败后的回滚也失败：${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    restoring = false;
    if (safety) {
      try {
        pruneBackups();
      } catch (error) {
        console.error("Backup retention failed:", error.message);
      }
    }
  }
}

async function ensureDailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  const exists = listBackups().some(item =>
    item.reason === "daily" && item.createdAt.slice(0, 10) === today
  );
  if (!exists) await createBackup("daily");
}

function conflictFromRow(row) {
  return {
    id: row.id,
    entryId: row.entity_id,
    local: JSON.parse(row.local_op_json),
    incoming: JSON.parse(row.incoming_op_json),
    winningOpId: row.winning_op_id,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolutionOpId: row.resolution_op_id
  };
}

function resolveConflict(id, input) {
  const row = statements.findConflict.get(id);
  if (!row) throw apiError(404, "冲突不存在");
  if (row.status !== "open") throw apiError(409, "冲突已经解决");
  const local = JSON.parse(row.local_op_json);
  const incoming = JSON.parse(row.incoming_op_json);
  const dedupCanonicalId = local.dedupCanonicalId || "";
  const choice = input.choice;
  if (!["local", "incoming", "merged"].includes(choice)) {
    throw apiError(400, "choice 必须是 local、incoming 或 merged");
  }

  return runTransaction(() => {
    let kind;
    let entry;
    if (choice === "merged") {
      if (!input.entry || typeof input.entry !== "object") {
        throw apiError(400, "合并解决方案需要 entry");
      }
      const current = statements.find.get(row.entity_id);
      const existing = current ? rowToEntry(current) : {};
      const normalized = normalizeInput(input.entry, existing);
      entry = {
        ...existing,
        ...normalized,
        id: row.entity_id,
        createdAt: input.entry.createdAt || existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        viewCount: Number.isInteger(input.entry.viewCount)
          ? input.entry.viewCount
          : (existing.viewCount || 0),
        lastViewedAt: input.entry.lastViewedAt || existing.lastViewedAt || ""
      };
      kind = "upsert";
    } else {
      const selected = choice === "local" ? local : incoming;
      kind = selected.kind;
      entry = selected.entry;
    }
    let base = mergeVectors(local.vector, incoming.vector, currentVector(row.entity_id));
    if (dedupCanonicalId && choice !== "local") {
      const duplicate = entry && findDuplicateEntry({
        ...entry,
        id: row.entity_id
      });
      if (duplicate && duplicate.id === dedupCanonicalId) {
        const deletion = appendLocalState(
          "delete",
          dedupCanonicalId,
          null,
          mergeVectors(currentVector(dedupCanonicalId), base)
        );
        base = mergeVectors(base, deletion.vector);
      }
    }
    if (entry) entry = { ...entry, id: row.entity_id };
    const operation = appendLocalState(kind, row.entity_id, entry, base);
    statements.resolveConflict.run(new Date().toISOString(), operation.opId, id);
    scheduleSync();
    return { conflict: conflictFromRow(statements.findConflict.get(id)), operation };
  });
}

function allowedOrigin(origin) {
  return !origin ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("edge-extension://") ||
    origin.startsWith("moz-extension://");
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendJson(response, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        request.resume();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(apiError(413, "请求内容过大"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!chunks.length) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(apiError(400, "JSON 格式不正确"));
      }
    };
    const onError = error => finish(error);
    const onAborted = () => finish(apiError(400, "请求已中止"));
    const timer = setTimeout(
      () => finish(apiError(408, "请求正文读取超时")),
      BODY_TIMEOUT_MS
    );
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function requestNeedsJson(method, pathname) {
  return (method === "POST" && [
    "/entries",
    "/import",
    "/backups/restore"
  ].includes(pathname)) ||
    (method === "PUT" && /^\/entries\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /^\/sync\/conflicts\/[^/]+\/resolve$/.test(pathname));
}

const server = http.createServer(async (request, response) => {
  setCors(request, response);
  if (!allowedOrigin(request.headers.origin)) {
    sendJson(response, 403, { error: "不允许的请求来源" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const selfGated = request.method === "POST" && url.pathname === "/sync";
  let requestBody;
  let releaseGate;
  try {
    if (requestNeedsJson(request.method, url.pathname)) {
      requestBody = await readJson(request);
    }
    if (shuttingDown) throw apiError(503, "服务正在关闭");
    if (!selfGated) releaseGate = await acquireDatabaseGate();
    if (process.env.AI_KNOWLEDGE_TEST_SHUTDOWN === "1" &&
        request.method === "POST" && url.pathname === "/test/shutdown") {
      sendJson(response, 202, { shuttingDown: true });
      releaseGate();
      releaseGate = null;
      setImmediate(() => close().catch(error => console.error(error)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        storage: "sqlite",
        database: DB_PATH,
        cloud: syncStatus()
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/sync/status") {
      sendJson(response, 200, syncStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      sendJson(response, 200, await syncNow());
      return;
    }
    if (request.method === "GET" && url.pathname === "/sync/conflicts") {
      const rows = url.searchParams.get("status") === "open"
        ? statements.listOpenConflicts.all()
        : statements.listConflicts.all();
      sendJson(response, 200, { conflicts: rows.map(conflictFromRow) });
      return;
    }
    const conflictMatch = url.pathname.match(/^\/sync\/conflicts\/([^/]+)\/resolve$/);
    if (request.method === "POST" && conflictMatch) {
      sendJson(response, 200, resolveConflict(
        decodeURIComponent(conflictMatch[1]),
        requestBody
      ));
      return;
    }
    if (request.method === "GET" && url.pathname === "/backups") {
      sendJson(response, 200, { backups: listBackups() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/backups") {
      sendJson(response, 201, { backup: await createBackup("manual") });
      return;
    }
    if (request.method === "POST" && url.pathname === "/backups/restore") {
      const result = await restoreBackup(requestBody.name);
      sendJson(response, 200, result);
      scheduleSync();
      return;
    }
    if (request.method === "GET" && url.pathname === "/entries") {
      sendJson(response, 200, { entries: statements.list.all().map(rowToEntry) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/entries") {
      sendJson(response, 201, { entry: createEntry(requestBody) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/import") {
      if (!Array.isArray(requestBody.entries)) throw apiError(400, "entries 必须是数组");
      let imported = 0;
      let duplicates = 0;
      for (const item of requestBody.entries) {
        try {
          createEntry(item, item);
          imported += 1;
        } catch (error) {
          if (error.status === 409) duplicates += 1;
          else throw error;
        }
      }
      sendJson(response, 200, { imported, duplicates });
      return;
    }

    const entryMatch = url.pathname.match(/^\/entries\/([^/]+)$/);
    const viewMatch = url.pathname.match(/^\/entries\/([^/]+)\/view$/);
    if (request.method === "PUT" && entryMatch) {
      sendJson(response, 200, {
        entry: updateEntry(decodeURIComponent(entryMatch[1]), requestBody)
      });
      return;
    }
    if (request.method === "DELETE" && entryMatch) {
      deleteEntry(decodeURIComponent(entryMatch[1]));
      sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && viewMatch) {
      sendJson(response, 200, {
        entry: recordView(decodeURIComponent(viewMatch[1]))
      });
      return;
    }
    sendJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    sendJson(response, status, { error: error.message || "服务内部错误" });
  } finally {
    if (releaseGate) releaseGate();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Knowledge service listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  if (SYNC_FILE) {
    console.log(`OneDrive operations: ${OPERATIONS_DIR}`);
    scheduleSync(100);
  } else {
    console.log("OneDrive sync disabled: no OneDrive folder detected");
  }
  withDatabaseGate(ensureDailyBackup)
    .catch(error => console.error("Daily backup failed:", error.message));
});

setInterval(() => {
  syncNow().catch(error => console.error("Periodic OneDrive sync failed:", error.message));
}, 60_000).unref();
backupState.timer = setInterval(() => {
  withDatabaseGate(ensureDailyBackup)
    .catch(error => console.error("Daily backup failed:", error.message));
}, 60 * 60_000);
backupState.timer.unref();

let shutdownPromise;

function close() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  clearTimeout(syncState.timer);
  clearInterval(backupState.timer);
  const serverClosed = new Promise(resolve => server.close(resolve));
  const gateDrained = acquireDatabaseGate().then(release => release());
  const backupFinished = backupState.running
    ? backupState.running.catch(() => {})
    : Promise.resolve();
  shutdownPromise = (async () => {
    let timeoutHandle;
    const timeout = new Promise(resolve => {
      timeoutHandle = setTimeout(resolve, 5000, "timeout");
    });
    const drained = Promise.all([gateDrained, backupFinished])
      .then(() => "drained");
    const drainResult = await Promise.race([drained, timeout]);
    clearTimeout(timeoutHandle);
    if (drainResult === "timeout") {
      console.error("Graceful shutdown timed out while draining database work");
    }
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    let closeTimeout;
    await Promise.race([
      serverClosed,
      new Promise(resolve => {
        closeTimeout = setTimeout(resolve, 500);
      })
    ]);
    clearTimeout(closeTimeout);
    if (fs.existsSync(BACKUP_DIR)) {
      for (const item of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith(".tmp")) {
          fs.rmSync(path.join(BACKUP_DIR, item.name), { force: true });
        }
      }
    }
    if (db) {
      db.close();
      db = null;
    }
    fs.rmSync(SERVER_PID_FILE, { force: true });
    process.exitCode = 0;
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => { close().catch(error => console.error(error)); });
process.on("SIGTERM", () => { close().catch(error => console.error(error)); });
process.on("exit", () => fs.rmSync(SERVER_PID_FILE, { force: true }));
