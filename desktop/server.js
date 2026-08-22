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
const AUTH_TOKEN_FILE = path.join(DATA_DIR, "auth-token");
const PAIRED_ORIGINS_FILE = path.join(DATA_DIR, "paired-origins.json");
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
const SCHEMA_VERSION = 9;
const BACKUP_RETENTION = { daily: 7, manual: 10, "pre-restore": 5 };
const MIXED_VERSION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const APP_VERSION = process.env.AI_KNOWLEDGE_APP_VERSION || "1.6.0";
const BUILD_VERSION = process.env.AI_KNOWLEDGE_BUILD_VERSION || "development";
const PROTOCOL_VERSION = "1.0.0";
const PAIRING_TTL_MS = Math.max(
  100,
  Number(process.env.AI_KNOWLEDGE_PAIRING_TTL_MS || 5 * 60 * 1000)
);
const PAIRING_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.AI_KNOWLEDGE_PAIRING_MAX_ATTEMPTS || 5)
);
const PAIRING_RATE_WINDOW_MS = 60 * 1000;
const PAIRING_RATE_LIMIT = 12;
const AUTH_CHALLENGE_DOMAIN = "AIKnowledgeInbox.LocalAPI.AuthChallenge";
const AUTH_CHALLENGE_PROTOCOL = 1;
const AUTH_CHALLENGE_RATE_LIMIT = Math.max(
  1,
  Number(process.env.AI_KNOWLEDGE_CHALLENGE_RATE_LIMIT || 120)
);
const BODY_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.AI_KNOWLEDGE_BODY_TIMEOUT_MS || 5000)
);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}

function loadOrCreateAuthToken() {
  if (fs.existsSync(AUTH_TOKEN_FILE)) {
    const existing = fs.readFileSync(AUTH_TOKEN_FILE, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) {
      throw new Error("Local API authentication token file is invalid");
    }

    try { fs.chmodSync(AUTH_TOKEN_FILE, 0o600); } catch {}
    return existing;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(AUTH_TOKEN_FILE, `${token}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  try { fs.chmodSync(AUTH_TOKEN_FILE, 0o600); } catch {}
  return token;
}

const AUTH_TOKEN = loadOrCreateAuthToken();
const pairedOrigins = new Set();
try {
  const savedOrigins = JSON.parse(fs.readFileSync(PAIRED_ORIGINS_FILE, "utf8"));
  if (Array.isArray(savedOrigins)) {
    for (const origin of savedOrigins) {
      if (typeof origin === "string" && isExtensionOrigin(origin)) pairedOrigins.add(origin);
    }
  }
} catch {}

let activePairing = null;
const pairingRate = new Map();
const challengeRate = new Map();
const recentErrors = [];

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
  },
  {
    version: 3,
    sql: `
      ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'raw'
        CHECK(status IN ('raw', 'draft', 'verified', 'deprecated'));
      ALTER TABLE entries ADD COLUMN confidence REAL
        CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
      ALTER TABLE entries ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE entries ADD COLUMN agent_run_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE entries ADD COLUMN approved_by TEXT NOT NULL DEFAULT '';
      ALTER TABLE entries ADD COLUMN approved_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE entries ADD COLUMN supersedes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE entries ADD COLUMN relations_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        output_format TEXT NOT NULL,
        output_mode TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('browser', 'ollama')),
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN (
          'planned', 'running', 'completed', 'failed', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL DEFAULT '{}',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        permission_scope_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_agent_runs_created_at
        ON agent_runs(created_at DESC);

      CREATE TABLE knowledge_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT NOT NULL DEFAULT '',
        approved_entry_id TEXT NOT NULL DEFAULT '',
        approved_by TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        undone_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_knowledge_proposals_run
        ON knowledge_proposals(run_id, created_at);

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'agent_run', 'proposal', 'approval', 'rejection', 'write', 'undo'
        )),
        actor TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        proposal_id TEXT NOT NULL DEFAULT '',
        entry_id TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created_at ON audit_log(created_at DESC);
      CREATE TRIGGER audit_log_no_update
        BEFORE UPDATE ON audit_log BEGIN
          SELECT RAISE(ABORT, 'audit_log is immutable');
        END;
      CREATE TRIGGER audit_log_no_delete
        BEFORE DELETE ON audit_log BEGIN
          SELECT RAISE(ABORT, 'audit_log is immutable');
        END;
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE operations ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE knowledge_proposals
        ADD COLUMN source_versions_json TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 5,
    sql: `
      ALTER TABLE agent_runs ADD COLUMN source_pins_json TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE knowledge_proposals
        ADD COLUMN approval_entry_ids_json TEXT NOT NULL DEFAULT '[]';
      UPDATE knowledge_proposals
        SET approval_entry_ids_json = json_array(approved_entry_id)
        WHERE approved_entry_id <> '';
    `
  },
  {
    version: 7,
    sql: `
      UPDATE entries
        SET content_key = 'deprecated:' || id || ':' || content_key
        WHERE status = 'deprecated' AND content_key NOT LIKE 'deprecated:%';
    `
  },
  {
    version: 8,
    sql: `
      ALTER TABLE entries ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 1
        CHECK(semantic_revision >= 1);
    `
  },
  {
    version: 9,
    sql: `
      ALTER TABLE knowledge_proposals
        ADD COLUMN canonical_content_hash TEXT NOT NULL DEFAULT '';
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
    entryCount: db.prepare("SELECT COUNT(*) AS count FROM entries"),
    find: db.prepare("SELECT * FROM entries WHERE id = ?"),
    findByContent: db.prepare("SELECT id, title FROM entries WHERE content_key = ?"),
    listTombstones: db.prepare("SELECT id, deleted_at FROM tombstones"),
    tombstoneCount: db.prepare("SELECT COUNT(*) AS count FROM tombstones"),
    findTombstone: db.prepare("SELECT deleted_at FROM tombstones WHERE id = ?"),
    insert: db.prepare(`
      INSERT INTO entries (
        id, title, content, content_key, source, project, tags_json, summary,
        created_at, updated_at, view_count, last_viewed_at, status, confidence,
        provenance_json, agent_run_id, approved_by, approved_at,
        supersedes_json, relations_json, semantic_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE entries
      SET title = ?, content = ?, content_key = ?, source = ?, project = ?,
          tags_json = ?, summary = ?, updated_at = ?, status = ?, confidence = ?,
          provenance_json = ?, agent_run_id = ?, approved_by = ?, approved_at = ?,
          supersedes_json = ?, relations_json = ?,
          semantic_revision = semantic_revision + 1
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
        created_at, updated_at, view_count, last_viewed_at, status, confidence,
        provenance_json, agent_run_id, approved_by, approved_at,
        supersedes_json, relations_json, semantic_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        last_viewed_at = excluded.last_viewed_at,
        status = excluded.status,
        confidence = excluded.confidence,
        provenance_json = excluded.provenance_json,
        agent_run_id = excluded.agent_run_id,
        approved_by = excluded.approved_by,
        approved_at = excluded.approved_at,
        supersedes_json = excluded.supersedes_json,
        relations_json = excluded.relations_json,
        semantic_revision = excluded.semantic_revision
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
        entry_json, created_at, imported_at, payload_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ),
    insertAgentRun: db.prepare(`
      INSERT INTO agent_runs (
        id, goal, output_format, output_mode, provider, model, status, created_at,
        plan_json, source_ids_json, permission_scope_json, source_pins_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)
    `),
    listAgentRuns: db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC"),
    findAgentRun: db.prepare("SELECT * FROM agent_runs WHERE id = ?"),
    updateRunSourcePins: db.prepare(
      "UPDATE agent_runs SET source_pins_json = ? WHERE id = ?"
    ),
    insertImportedAgentRun: db.prepare(`
      INSERT OR IGNORE INTO agent_runs (
        id, goal, output_format, output_mode, provider, model, status, created_at,
        started_at, completed_at, plan_json, source_ids_json, result, error,
        permission_scope_json, source_pins_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateImportedAgentRun: db.prepare(`
      UPDATE agent_runs SET status = ?, started_at = ?, completed_at = ?,
        result = ?, error = ? WHERE id = ?
    `),
    startAgentRun: db.prepare(`
      UPDATE agent_runs SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'planned'
    `),
    completeAgentRun: db.prepare(`
      UPDATE agent_runs SET status = 'completed', completed_at = ?, result = ?
      WHERE id = ? AND status = 'running'
    `),
    failAgentRun: db.prepare(`
      UPDATE agent_runs SET status = 'failed', completed_at = ?, error = ?
      WHERE id = ? AND status = 'running'
    `),
    cancelAgentRun: db.prepare(`
      UPDATE agent_runs SET status = 'cancelled', completed_at = ?
      WHERE id = ? AND status IN ('planned', 'running')
    `),
    insertProposal: db.prepare(`
      INSERT INTO knowledge_proposals (
        id, run_id, title, content, summary, project, tags_json, source_ids_json,
        confidence, rationale, status, created_at, source_versions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `),
    listProposals: db.prepare(`
      SELECT * FROM knowledge_proposals WHERE run_id = ? ORDER BY created_at, id
    `),
    findProposal: db.prepare("SELECT * FROM knowledge_proposals WHERE id = ?"),
    updateProposalSourceVersions: db.prepare(
      "UPDATE knowledge_proposals SET source_versions_json = ? WHERE id = ?"
    ),
    insertImportedProposal: db.prepare(`
      INSERT OR IGNORE INTO knowledge_proposals (
        id, run_id, title, content, summary, project, tags_json, source_ids_json,
        confidence, rationale, status, created_at, decided_at, approved_entry_id,
        approved_by, idempotency_key, undone_at, source_versions_json,
        approval_entry_ids_json, canonical_content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    `),
    updateImportedProposal: db.prepare(`
      UPDATE knowledge_proposals SET status = ?, decided_at = ?,
        approved_entry_id = ?, approved_by = ?, undone_at = ?,
        approval_entry_ids_json = ?, canonical_content_hash = ? WHERE id = ?
    `),
    approveProposal: db.prepare(`
      UPDATE knowledge_proposals
      SET status = 'approved', decided_at = ?, approved_entry_id = ?,
          approved_by = ?, idempotency_key = ?, approval_entry_ids_json = ?
      WHERE id = ? AND status = 'pending'
    `),
    rejectProposal: db.prepare(`
      UPDATE knowledge_proposals SET status = 'rejected', decided_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    markProposalUndone: db.prepare(`
      UPDATE knowledge_proposals SET undone_at = ?
      WHERE id = ? AND status = 'approved' AND undone_at = ''
    `),
    deprecateEntry: db.prepare(`
      UPDATE entries SET status = 'deprecated', updated_at = ?,
        semantic_revision = semantic_revision + 1,
        content_key = CASE
          WHEN content_key LIKE 'deprecated:%' THEN content_key
          ELSE 'deprecated:' || id || ':' || content_key
        END
      WHERE id = ?
    `),
    insertAudit: db.prepare(`
      INSERT INTO audit_log (
        id, event_type, actor, run_id, proposal_id, entry_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertImportedAudit: db.prepare(`
      INSERT OR IGNORE INTO audit_log (
        id, event_type, actor, run_id, proposal_id, entry_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    findAudit: db.prepare("SELECT * FROM audit_log WHERE id = ?"),
    listAudit: db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC, id DESC")
    ,
    findActiveApprovalReference: db.prepare(`
      SELECT p.id FROM knowledge_proposals p
      WHERE p.status = 'approved' AND p.undone_at = '' AND p.id <> ?
        AND (
          p.approved_entry_id = ? OR EXISTS (
            SELECT 1 FROM json_each(p.approval_entry_ids_json)
            WHERE value = ?
          )
        )
      LIMIT 1
    `),
    findAnyActiveApprovalReference: db.prepare(`
      SELECT p.* FROM knowledge_proposals p
      WHERE p.status = 'approved' AND p.undone_at = ''
        AND (
          p.approved_entry_id = ? OR EXISTS (
            SELECT 1 FROM json_each(p.approval_entry_ids_json)
            WHERE value = ?
          )
        )
      ORDER BY p.id LIMIT 1
    `),
    findProposalByApprovedEntry: db.prepare(`
      SELECT * FROM knowledge_proposals
      WHERE status = 'approved' AND undone_at = '' AND approved_entry_id = ?
      LIMIT 1
    `)
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
  running: null,
  suppressedDeletes: []
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

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && !Array.isArray(parsed) && typeof parsed === "object"
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeStringArray(value, limit = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => String(item || "").trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function boundedText(value, field, maximum, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw apiError(400, `${field} 不能为空`);
  if (text.length > maximum) throw apiError(400, `${field} 超过长度限制`);
  return text;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw apiError(400, `${label} 必须是对象`);
  }
  return value;
}

function normalizeLifecycle(input, existing = {}) {
  const status = input.status ?? existing.status ?? "raw";
  if (!["raw", "draft", "verified", "deprecated"].includes(status)) {
    throw apiError(400, "知识状态不正确");
  }
  const confidenceValue = input.confidence ?? existing.confidence ?? null;
  const confidence = confidenceValue === null || confidenceValue === ""
    ? null
    : Number(confidenceValue);
  if (confidence !== null && (!Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1)) {
    throw apiError(400, "confidence 必须在 0 到 1 之间");
  }
  const provenance = parseJsonObject(input.provenance ?? existing.provenance ?? {}, null);
  if (!provenance || JSON.stringify(provenance).length > 12000) {
    throw apiError(400, "provenance 必须是有效且有界的对象");
  }
  return {
    status,
    confidence,
    provenance,
    agentRunId: boundedText(input.agentRunId ?? existing.agentRunId, "agentRunId", 100),
    approvedBy: boundedText(input.approvedBy ?? existing.approvedBy, "approvedBy", 200),
    approvedAt: boundedText(input.approvedAt ?? existing.approvedAt, "approvedAt", 80),
    supersedes: normalizeStringArray(input.supersedes ?? existing.supersedes, 50),
    relations: normalizeStringArray(input.relations ?? existing.relations, 100)
  };
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

function storedContentKey(id, content, status) {
  const key = contentKey(content);
  return status === "deprecated" ? `deprecated:${id}:${key}` : key;
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
    lastViewedAt: row.last_viewed_at,
    status: row.status || "raw",
    confidence: row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
    provenance: parseJsonObject(row.provenance_json, {}),
    agentRunId: row.agent_run_id || "",
    approvedBy: row.approved_by || "",
    approvedAt: row.approved_at || "",
    supersedes: normalizeStringArray(safeJson(row.supersedes_json || "[]", []), 50),
    relations: normalizeStringArray(safeJson(row.relations_json || "[]", []), 100),
    semanticRevision: Number.isSafeInteger(row.semantic_revision)
      ? row.semantic_revision
      : 1
  };
}

function normalizeInput(input, existing = {}, lifecycleMode = "preserve") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw apiError(400, "知识内容必须是对象");
  }
  const content = boundedText(input.content ?? existing.content, "content", 200000, {
    required: true
  });
  if (!content) throw apiError(400, "内容不能为空");
  const source = boundedText(input.source ?? existing.source, "source", 2000);
  const title = boundedText(input.title ?? existing.title, "title", 300) || deriveTitle(content);
  const suppliedTags = input.tags ?? existing.tags ?? [];
  const tags = normalizeTags(suppliedTags);
  const lifecycle = lifecycleMode === "trusted"
    ? normalizeLifecycle(input, existing)
    : lifecycleMode === "raw"
      ? normalizeLifecycle({}, {})
      : normalizeLifecycle({}, existing);
  return {
    title,
    content,
    source,
    project: boundedText(input.project ?? existing.project, "project", 200),
    tags: tags.length || lifecycleMode === "trusted"
      ? tags
      : suggestTags(content, title, source),
    summary: boundedText(input.summary ?? existing.summary, "summary", 4000),
    ...lifecycle
  };
}

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function activeApprovalForEntry(entryId) {
  return statements.findAnyActiveApprovalReference.get(entryId, entryId) || null;
}

const PROTECTED_ENTRY_FIELDS = new Set([
  "status", "confidence", "provenance", "agentRunId", "approvedBy",
  "approvedAt", "supersedes", "relations"
]);

function rejectProtectedEntryFields(input) {
  requireObject(input, "知识内容");
  const protectedFields = Object.keys(input).filter(key => PROTECTED_ENTRY_FIELDS.has(key));
  if (protectedFields.length) {
    throw apiError(403, `通用知识接口不能修改受保护字段：${protectedFields.join(", ")}`);
  }
}

function replaceEntryRaw(entry, preserveMissingLifecycle = false) {
  const existingRow = statements.find.get(entry.id);
  const existing = existingRow ? rowToEntry(existingRow) : {};
  let normalized = normalizeInput(
    entry,
    preserveMissingLifecycle ? existing : entry,
    "trusted"
  );
  if (existing.status === "deprecated" && normalized.status !== "deprecated") {
    normalized = {
      ...normalized,
      status: "deprecated",
      confidence: existing.confidence,
      provenance: existing.provenance,
      agentRunId: existing.agentRunId,
      approvedBy: existing.approvedBy,
      approvedAt: existing.approvedAt,
      supersedes: existing.supersedes,
      relations: existing.relations
    };
  }
  const approvedAgentEntry = existing.agentRunId &&
    existing.provenance?.origin === "agent" && existing.approvedAt;
  const incomingSubstantiveChange = approvedAgentEntry && (
    ["title", "content", "summary", "source", "project"]
      .some(field => normalized[field] !== existing[field]) ||
    canonicalJson(normalized.tags) !== canonicalJson(existing.tags)
  );
  if (incomingSubstantiveChange) {
    normalized = {
      ...normalized,
      title: existing.title,
      content: existing.content,
      summary: existing.summary,
      source: existing.source,
      project: existing.project,
      tags: existing.tags,
      status: existing.status,
      confidence: existing.confidence,
      provenance: existing.provenance,
      agentRunId: existing.agentRunId,
      approvedBy: existing.approvedBy,
      approvedAt: existing.approvedAt,
      supersedes: existing.supersedes,
      relations: existing.relations
    };
  }
  if (existingRow && activeApprovalForEntry(entry.id) &&
      normalized.status !== "deprecated") {
    normalized = {
      ...normalized,
      status: existing.status,
      confidence: existing.confidence,
      provenance: existing.provenance,
      agentRunId: existing.agentRunId,
      approvedBy: existing.approvedBy,
      approvedAt: existing.approvedAt,
      supersedes: existing.supersedes,
      relations: existing.relations
    };
  }
  const duplicate = normalized.status === "deprecated"
    ? null
    : statements.findByContent.get(contentKey(normalized.content));
  if (duplicate && duplicate.id !== entry.id) {
    throw new Error(`同步内容与已有知识重复：${duplicate.title}`);
  }
  statements.replaceEntry.run(
    entry.id,
    normalized.title,
    normalized.content,
    storedContentKey(entry.id, normalized.content, normalized.status),
    normalized.source,
    normalized.project,
    JSON.stringify(normalized.tags),
    normalized.summary,
    entry.createdAt || new Date().toISOString(),
    entry.updatedAt || "",
    Number.isInteger(entry.viewCount) ? entry.viewCount : 0,
    entry.lastViewedAt || "",
    normalized.status,
    normalized.confidence,
    JSON.stringify(normalized.provenance),
    normalized.agentRunId,
    normalized.approvedBy,
    normalized.approvedAt,
    JSON.stringify(normalized.supersedes),
    JSON.stringify(normalized.relations),
    Math.max(
      Number.isSafeInteger(existing.semanticRevision) ? existing.semanticRevision : 1,
      Number.isSafeInteger(entry.semanticRevision) ? entry.semanticRevision : 1
    )
  );
  statements.removeTombstone.run(entry.id);
}

function findDuplicateEntry(entry) {
  if (!entry) return null;
  if (entry.status === "deprecated") return null;
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
    payloadVersion: Number(row.payload_version || 1),
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
  const payloadVersion = raw.payloadVersion === undefined ? 1 : Number(raw.payloadVersion);
  if (![1, 2].includes(payloadVersion)) {
    throw new Error(`操作 ${raw.opId} 的 payloadVersion 不受支持`);
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
    payloadVersion,
    opId: raw.opId,
    deviceId: raw.deviceId,
    counter: raw.counter,
    entityId: raw.entityId,
    kind: raw.kind,
    vector,
    entry: raw.kind === "upsert" ? (() => {
      const lifecycleFields = [
        "status", "confidence", "provenance", "agentRunId", "approvedBy",
        "approvedAt", "supersedes", "relations"
      ];
      const hasCompleteLifecycle = lifecycleFields.every(field =>
        Object.hasOwn(raw.entry, field)
      );
      if (payloadVersion === 2 && !hasCompleteLifecycle) {
        throw new Error(`操作 ${raw.opId} 缺少 v2 生命周期字段`);
      }
      const normalized = {
        ...raw.entry,
        tags: normalizeTags(raw.entry.tags),
        summary: String(raw.entry.summary || "").slice(0, 4000),
        updatedAt: String(raw.entry.updatedAt || ""),
        viewCount: Number.isInteger(raw.entry.viewCount) ? raw.entry.viewCount : 0,
        lastViewedAt: String(raw.entry.lastViewedAt || "")
      };
      const lifecycle = normalizeLifecycle(raw.entry, {});
      for (const field of lifecycleFields) {
        if (Object.hasOwn(raw.entry, field)) normalized[field] = lifecycle[field];
      }
      return normalized;
    })() : null,
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
    new Date().toISOString(),
    operation.payloadVersion || 1
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
    payloadVersion: 2,
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
    replaceEntryRaw(operation.entry, operation.payloadVersion < 2);
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
  if (operation.kind === "delete" && activeApprovalForEntry(operation.entityId)) {
    const row = statements.find.get(operation.entityId);
    if (!row) throw new Error("有效审批知识缺失，无法抑制删除");
    const preserved = rowToEntry(row);
    const correction = nextLocalOperation(
      "upsert",
      operation.entityId,
      preserved,
      mergeVectors(operation.vector, currentOperation?.vector || {})
    );
    persistOperation(correction);
    applyOperationPayload(correction);
    advanceObservedFrontier(correction);
    statements.insertConflict.run(
      conflictId(currentOperation || correction, operation),
      operation.entityId,
      JSON.stringify(currentOperation || correction),
      JSON.stringify(operation),
      correction.opId,
      new Date().toISOString()
    );
    const auditId = crypto.createHash("sha256")
      .update(`suppress-approved-delete\n${operation.opId}\n${correction.opId}`)
      .digest("hex");
    statements.insertImportedAudit.run(
      auditId, "write", "sync", preserved.agentRunId,
      preserved.provenance?.proposalId || "", preserved.id,
      JSON.stringify({
        action: "suppress-active-approval-delete",
        rejectedOperationId: operation.opId,
        correctionOperationId: correction.opId
      }),
      correction.createdAt
    );
    syncState.suppressedDeletes.push({
      entityId: operation.entityId,
      operationId: operation.opId,
      correctionOperationId: correction.opId
    });
    return false;
  }
  const duplicate = operation.kind === "upsert"
    ? findDuplicateEntry(operation.entry)
    : null;
  if (duplicate) {
    recordDuplicateConflict(operation, duplicate, currentOperation);
    return false;
  }
  const priorEntry = statements.find.get(operation.entityId);
  const preserveDeprecation = operation.kind === "upsert" &&
    priorEntry?.status === "deprecated" &&
    operation.entry.status !== "deprecated";
  const preserveApproval = operation.kind === "upsert" &&
    operation.entry.status !== "deprecated" &&
    Boolean(activeApprovalForEntry(operation.entityId));
  applyOperationPayload(operation);
  if (preserveDeprecation || preserveApproval) {
    const deprecated = rowToEntry(statements.find.get(operation.entityId));
    const correction = nextLocalOperation(
      "upsert",
      operation.entityId,
      deprecated,
      mergeVectors(operation.vector, currentOperation?.vector || {})
    );
    persistOperation(correction);
    applyOperationPayload(correction);
    resolveCoveredConflicts(correction);
    advanceObservedFrontier(correction);
  }
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
backfillRunSourcePins();

function createEntry(input, preserve = {}, options = {}) {
  const normalized = normalizeInput(
    input,
    options.trustedLifecycle ? preserve : {},
    options.trustedLifecycle ? "trusted" : "raw"
  );
  const key = contentKey(normalized.content);
  const duplicate = normalized.status === "deprecated"
    ? null
    : statements.findByContent.get(key);
  if (duplicate) throw apiError(409, `这段内容已经保存过：${duplicate.title}`);

  const action = () => {
    const createdAt = preserve.createdAt || new Date().toISOString();
    const id = preserve.id || crypto.randomUUID();
    statements.insert.run(
      id,
      normalized.title,
      normalized.content,
      storedContentKey(id, normalized.content, normalized.status),
      normalized.source,
      normalized.project,
      JSON.stringify(normalized.tags),
      normalized.summary,
      createdAt,
      preserve.updatedAt || "",
      Number.isInteger(preserve.viewCount) ? preserve.viewCount : 0,
      preserve.lastViewedAt || "",
      normalized.status,
      normalized.confidence,
      JSON.stringify(normalized.provenance),
      normalized.agentRunId,
      normalized.approvedBy,
      normalized.approvedAt,
      JSON.stringify(normalized.supersedes),
      JSON.stringify(normalized.relations),
      Number.isSafeInteger(preserve.semanticRevision) ? preserve.semanticRevision : 1
    );
    statements.removeTombstone.run(id);
    const entry = rowToEntry(statements.find.get(id));
    appendLocalState("upsert", id, entry);
    scheduleSync();
    return entry;
  };
  return options.inTransaction ? action() : runTransaction(action);
}

function updateEntry(id, input) {
  const currentRow = statements.find.get(id);
  if (!currentRow) throw apiError(404, "知识不存在");
  const current = rowToEntry(currentRow);
  const normalized = normalizeInput(input, current, "preserve");
  const substantiveChanged = [
    "title", "content", "summary", "source", "project"
  ].some(field => normalized[field] !== current[field]) ||
    canonicalJson(normalized.tags) !== canonicalJson(current.tags);
  if (substantiveChanged && activeApprovalForEntry(id)) {
    throw apiError(
      409,
      "Agent 审批知识不能通过通用编辑修改；请创建新的候选知识并审批"
    );
  }
  const key = contentKey(normalized.content);
  const duplicate = normalized.status === "deprecated"
    ? null
    : statements.findByContent.get(key);
  if (duplicate && duplicate.id !== id) {
    throw apiError(409, `这段内容已经保存过：${duplicate.title}`);
  }

  return runTransaction(() => {
    statements.update.run(
      normalized.title,
      normalized.content,
      storedContentKey(id, normalized.content, normalized.status),
      normalized.source,
      normalized.project,
      JSON.stringify(normalized.tags),
      normalized.summary,
      new Date().toISOString(),
      normalized.status,
      normalized.confidence,
      JSON.stringify(normalized.provenance),
      normalized.agentRunId,
      normalized.approvedBy,
      normalized.approvedAt,
      JSON.stringify(normalized.supersedes),
      JSON.stringify(normalized.relations),
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
    const row = statements.find.get(id);
    if (!row) throw apiError(404, "知识不存在");
    const entry = rowToEntry(row);
    if (activeApprovalForEntry(id)) {
      throw apiError(
        409,
        "Agent 审批知识不能直接删除；请通过对应候选知识执行撤销审批"
      );
    }
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

function safeJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stripSensitiveKeys(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|secret|password|credential|api[_-]?key)/i.test(key))
    .map(([key, item]) => [key, stripSensitiveKeys(item)]));
}

function portablePermissionScope(value) {
  const scope = safeJson(value, {});
  return {
    mode: "propose-only",
    project: String(scope.project || "").slice(0, 200),
    startAt: String(scope.startAt || "").slice(0, 80),
    endAt: String(scope.endAt || "").slice(0, 80),
    externalSupplementation: false
  };
}

function rowToAgentRun(row) {
  return {
    id: row.id,
    goal: row.goal,
    outputFormat: row.output_format,
    outputMode: row.output_mode,
    provider: row.provider,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    plan: stripSensitiveKeys(safeJson(row.plan_json, {})),
    sourceIds: normalizeStringArray(safeJson(row.source_ids_json, []), 20),
    sourcePins: safeJson(row.source_pins_json, []),
    result: row.result,
    error: row.error,
    permissionScope: portablePermissionScope(row.permission_scope_json)
  };
}

function rowToProposal(row) {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    project: row.project,
    tags: normalizeTags(safeJson(row.tags_json, [])),
    sourceIds: normalizeStringArray(safeJson(row.source_ids_json, []), 20),
    sourceVersions: safeJson(row.source_versions_json, []),
    confidence: Number(row.confidence),
    rationale: row.rationale,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    approvedEntryId: row.approved_entry_id,
    approvalEntryIds: normalizeStringArray(
      safeJson(row.approval_entry_ids_json, []),
      20
    ),
    canonicalContentHash: row.canonical_content_hash ||
      (row.status === "approved" && row.approved_entry_id &&
       row.approved_entry_id !== proposalEntryId(row.id)
        ? contentKey(row.content)
        : ""),
    approvedBy: row.approved_by,
    undoneAt: row.undone_at
  };
}

function rowToAudit(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    runId: row.run_id,
    proposalId: row.proposal_id,
    entryId: row.entry_id,
    details: safeJson(row.details_json, {}),
    createdAt: row.created_at
  };
}

function exportAgentLedger() {
  return {
    version: 3,
    runs: statements.listAgentRuns.all().map(rowToAgentRun),
    proposals: statements.listAgentRuns.all().flatMap(run =>
      statements.listProposals.all(run.id).map(rowToProposal)
    ),
    audit: statements.listAudit.all().map(rowToAudit)
  };
}

function validateLedgerRun(raw) {
  requireObject(raw, "ledger run");
  const statuses = ["planned", "running", "completed", "failed", "cancelled"];
  if (!statuses.includes(raw.status) || !["browser", "ollama"].includes(raw.provider)) {
    throw apiError(400, "ledger run 状态或 provider 不正确");
  }
  const permissionScope = requireObject(raw.permissionScope, "ledger permissionScope");
  if (permissionScope.mode !== "propose-only" ||
      permissionScope.externalSupplementation !== false) {
    throw apiError(400, "ledger permissionScope 不安全");
  }
  const sourceIds = validateRequiredSourceIds(raw.sourceIds, "run sourceIds");
  const sourcePins = Array.isArray(raw.sourcePins)
    ? raw.sourcePins.map(validateSourcePin)
    : [];
  if ((sourcePins.length !== 0 && sourcePins.length !== sourceIds.length) ||
      sourcePins.some(pin => !sourceIds.includes(pin.id))) {
    throw apiError(400, "ledger run 来源固定信息不完整");
  }
  const normalizedScope = portablePermissionScope(permissionScope);
  sourcePins.forEach(pin => validatePinScope(pin, normalizedScope));
  return {
    id: boundedText(raw.id, "run id", 100, { required: true }),
    goal: boundedText(raw.goal, "goal", 1200, { required: true }),
    outputFormat: boundedText(raw.outputFormat, "outputFormat", 80, { required: true }),
    outputMode: raw.outputMode === "propose-only" ? raw.outputMode :
      (() => { throw apiError(400, "ledger outputMode 不正确"); })(),
    provider: raw.provider,
    model: boundedText(raw.model, "model", 100),
    status: raw.status,
    createdAt: boundedText(raw.createdAt, "createdAt", 80, { required: true }),
    startedAt: boundedText(raw.startedAt, "startedAt", 80),
    completedAt: boundedText(raw.completedAt, "completedAt", 80),
    plan: stripSensitiveKeys(requireObject(raw.plan, "ledger plan")),
    sourceIds,
    sourcePins,
    result: boundedText(raw.result, "result", 200000),
    error: boundedText(raw.error, "error", 4000),
    permissionScope: normalizedScope
  };
}

function validateSourcePin(pin) {
  requireObject(pin, "source version pin");
  const lifecycle = String(pin.lifecycle || "");
  if (!["raw", "draft", "verified", "deprecated"].includes(lifecycle)) {
    throw apiError(400, "source lifecycle 不正确");
  }
  const sourceAt = boundedText(pin.sourceAt, "pin sourceAt", 80, { required: true });
  if (!Number.isFinite(validatedTimestamp(sourceAt))) {
    throw apiError(400, "pin sourceAt 必须是 ISO 8601 时间");
  }
  const content = boundedText(pin.content, "pin content", 200000, { required: true });
  const contentHash = /^[a-f0-9]{64}$/.test(String(pin.contentHash || ""))
    ? pin.contentHash
    : (() => { throw apiError(400, "source contentHash 不正确"); })();
  if (crypto.createHash("sha256").update(content).digest("hex") !== contentHash) {
    throw apiError(400, "source pin 内容哈希不匹配");
  }
  const normalized = {
    id: boundedText(pin.id, "pin id", 100, { required: true }),
    opId: boundedText(pin.opId, "pin opId", 300, { required: true }),
    contentHash,
    semanticRevision: Number(pin.semanticRevision),
    semanticHash: /^[a-f0-9]{64}$/.test(String(pin.semanticHash || ""))
      ? pin.semanticHash
      : (() => { throw apiError(400, "source semanticHash 不正确"); })(),
    lifecycle,
    title: boundedText(pin.title, "pin title", 300, { required: true }),
    content,
    summary: boundedText(pin.summary, "pin summary", 4000),
    source: boundedText(pin.source, "pin source", 2000),
    project: boundedText(pin.project, "pin project", 200),
    tags: validateLedgerStringArray(pin.tags, "pin tags", 20),
    createdAt: boundedText(pin.createdAt, "pin createdAt", 80, { required: true }),
    updatedAt: boundedText(pin.updatedAt, "pin updatedAt", 80),
    sourceAt
  };
  if (!Number.isSafeInteger(normalized.semanticRevision) ||
      normalized.semanticRevision < 1 ||
      semanticEntryHash({
        title: normalized.title,
        content: normalized.content,
        summary: normalized.summary,
        source: normalized.source,
        project: normalized.project,
        tags: normalized.tags,
        status: normalized.lifecycle
      }) !== normalized.semanticHash) {
    throw apiError(400, "source semantic revision/hash 不正确");
  }
  return normalized;
}

function validatePinScope(pin, scope) {
  if (scope.project && pin.project !== scope.project) {
    throw apiError(400, `source pin 超出项目权限范围：${pin.id}`);
  }
  if (scope.startAt && Date.parse(pin.sourceAt) < Date.parse(scope.startAt)) {
    throw apiError(400, `source pin 早于时间权限范围：${pin.id}`);
  }
  if (scope.endAt && Date.parse(pin.sourceAt) > Date.parse(scope.endAt)) {
    throw apiError(400, `source pin 晚于时间权限范围：${pin.id}`);
  }
}

function validateLedgerProposal(raw, runMap, ledgerVersion) {
  requireObject(raw, "ledger proposal");
  const associatedRun = runMap.get(raw.runId);
  if (!associatedRun) throw apiError(400, "ledger proposal 缺少关联 run");
  if (!["pending", "approved", "rejected"].includes(raw.status) ||
      typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1) {
    throw apiError(400, "ledger proposal 状态或 confidence 不正确");
  }
  const sourceIds = validateRequiredSourceIds(raw.sourceIds, "proposal sourceIds");
  if (sourceIds.some(id => !associatedRun.sourceIds.includes(id))) {
    throw apiError(400, "ledger proposal 来源超出关联 run");
  }
  const sourceVersions = Array.isArray(raw.sourceVersions)
    ? raw.sourceVersions.map(validateSourcePin)
    : [];
  const expectedPins = sourceIds.map(id =>
    associatedRun.sourcePins.find(pin => pin.id === id)
  );
  if (sourceVersions.length !== sourceIds.length ||
      canonicalJson(sourceVersions) !== canonicalJson(expectedPins)) {
    throw apiError(400, "ledger proposal 来源版本不完整");
  }
  const project = boundedText(raw.project, "project", 200);
  if (associatedRun.permissionScope.project &&
      project !== associatedRun.permissionScope.project) {
    throw apiError(400, "ledger proposal 超出关联 run 项目权限");
  }
  const approvedEntryId = boundedText(
    raw.approvedEntryId,
    "approvedEntryId",
    100
  );
  const approvalEntryIds = raw.approvalEntryIds === undefined
    ? (approvedEntryId ? [approvedEntryId] : [])
    : validateLedgerStringArray(
        raw.approvalEntryIds,
        "proposal approvalEntryIds",
        20
      );
  let canonicalContentHash = String(raw.canonicalContentHash || "");
  if (raw.status === "approved" &&
      (!approvedEntryId || !approvalEntryIds.includes(approvedEntryId))) {
    throw apiError(400, "approved proposal 缺少审批知识关联");
  }
  if (raw.status === "approved" &&
      approvedEntryId !== proposalEntryId(raw.id)) {
    if (ledgerVersion < 3) {
      throw apiError(400, "approved proposal 必须使用确定性 canonical entry ID");
    }
    canonicalContentHash = canonicalContentHash ||
      contentKey(String(raw.content || ""));
  }
  return {
    id: boundedText(raw.id, "proposal id", 100, { required: true }),
    runId: raw.runId,
    title: boundedText(raw.title, "title", 300, { required: true }),
    content: boundedText(raw.content, "content", 200000, { required: true }),
    summary: boundedText(raw.summary, "summary", 4000),
    project,
    tags: validateLedgerStringArray(raw.tags, "proposal tags", 20),
    sourceIds,
    sourceVersions,
    confidence: raw.confidence,
    rationale: boundedText(raw.rationale, "rationale", 4000, { required: true }),
    status: raw.status,
    createdAt: boundedText(raw.createdAt, "createdAt", 80, { required: true }),
    decidedAt: boundedText(raw.decidedAt, "decidedAt", 80),
    approvedEntryId,
    approvalEntryIds,
    canonicalContentHash,
    approvedBy: boundedText(raw.approvedBy, "approvedBy", 200),
    undoneAt: boundedText(raw.undoneAt, "undoneAt", 80)
  };
}

function validateLedgerStringArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum ||
      value.some(item => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw apiError(400, `${label} 格式不正确`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function validateLedgerAudit(raw, runIds, proposalIds) {
  requireObject(raw, "ledger audit");
  if (!["agent_run", "proposal", "approval", "rejection", "write", "undo"]
    .includes(raw.eventType)) {
    throw apiError(400, "ledger audit eventType 不正确");
  }
  if (raw.runId && !runIds.has(raw.runId)) throw apiError(400, "audit 缺少关联 run");
  if (raw.proposalId && !proposalIds.has(raw.proposalId)) {
    throw apiError(400, "audit 缺少关联 proposal");
  }
  return {
    id: boundedText(raw.id, "audit id", 100, { required: true }),
    eventType: raw.eventType,
    actor: boundedText(raw.actor, "actor", 200, { required: true }),
    runId: boundedText(raw.runId, "runId", 100),
    proposalId: boundedText(raw.proposalId, "proposalId", 100),
    entryId: boundedText(raw.entryId, "entryId", 100),
    details: requireObject(raw.details, "audit details"),
    createdAt: boundedText(raw.createdAt, "createdAt", 80, { required: true })
  };
}

function normalizeAgentLedger(raw) {
  requireObject(raw, "agentLedger");
  if (![1, 2, 3].includes(raw.version) || !Array.isArray(raw.runs) ||
      !Array.isArray(raw.proposals) || !Array.isArray(raw.audit) ||
      raw.runs.length > 5000 || raw.proposals.length > 20000 ||
      raw.audit.length > 100000) {
    throw apiError(400, "agentLedger 版本或大小不正确");
  }

  const runs = raw.runs.map(validateLedgerRun);
  const runIds = new Set(runs.map(run => run.id));
  if (runIds.size !== runs.length) throw apiError(400, "agentLedger run ID 重复");
  const runMap = new Map(runs.map(run => [run.id, run]));
  const proposals = raw.proposals.map(item =>
    validateLedgerProposal(item, runMap, raw.version)
  );
  const proposalIds = new Set(proposals.map(proposal => proposal.id));
  if (proposalIds.size !== proposals.length) throw apiError(400, "agentLedger proposal ID 重复");
  const audit = raw.audit.map(item => validateLedgerAudit(item, runIds, proposalIds));
  return { version: raw.version, runs, proposals, audit };
}

function validateImportedEntryAssertions(entries, ledger) {
  const managed = entries.filter(item =>
    item && (
      item.status && item.status !== "raw" ||
      item.confidence !== null && item.confidence !== undefined ||
      item.agentRunId || item.approvedBy || item.approvedAt ||
      item.provenance && Object.keys(item.provenance).length
    )
  );
  if (!managed.length) return;
  if (!ledger) {
    throw apiError(400, "包含 Agent 生命周期的知识必须携带完整 agentLedger");
  }
  const proposals = new Map(ledger.proposals.map(item => [item.id, item]));
  for (const item of managed) {
    const proposalId = item.provenance?.proposalId;
    const proposal = proposals.get(proposalId);
    const canonicalizedLegacy = item.status === "deprecated" &&
      ledger.audit.some(event =>
        event.details?.action === "canonicalize-duplicate-approved-content" &&
        event.details?.originalTarget === item.id
      );
    const supersededDeterministicTarget = proposal &&
      item.id === proposalEntryId(proposal.id) &&
      proposal.approvedEntryId !== item.id;
    const historicalDeprecatedTarget = proposal?.status === "approved" &&
      item.status === "deprecated";
    if (canonicalizedLegacy || supersededDeterministicTarget ||
        historicalDeprecatedTarget) continue;
    if (!proposal || proposal.status !== "approved" ||
        !proposal.approvalEntryIds.includes(item.id) ||
        proposal.approvedEntryId !== item.id ||
        item.provenance?.origin !== "agent" ||
        item.provenance?.runId !== proposal.runId ||
        item.agentRunId !== proposal.runId ||
        item.title !== proposal.title ||
        item.content !== proposal.content ||
        String(item.summary || "") !== proposal.summary ||
        String(item.project || "") !== proposal.project ||
        canonicalJson(normalizeTags(item.tags)) !== canonicalJson(proposal.tags) ||
        String(item.source || "") !== `agent://${proposal.runId}` ||
        Number(item.confidence) !== proposal.confidence) {
      throw apiError(400, `Agent 知识 ${item.id || ""} 与 ledger 审批不匹配`);
    }
    const events = ledger.audit.filter(event =>
      event.proposalId === proposal.id
    );
    const sharedCanonicalEntry = item.id === contentCanonicalEntryId(item.content) &&
      proposal.canonicalContentHash === contentKey(item.content);
    if (!events.some(event => event.eventType === "approval") ||
        (!sharedCanonicalEntry && !(events.some(event => event.eventType === "write" &&
            event.entryId === item.id) ||
          ledger.audit.some(event => event.eventType === "write" &&
            event.details?.canonicalTarget === item.id))) ||
        (proposal.undoneAt && !events.some(event => event.eventType === "undo"))) {
      throw apiError(400, `Agent 知识 ${item.id} 缺少完整审批审计`);
    }
  }
}

function runStateRank(status) {
  return { planned: 0, running: 1, completed: 2, failed: 2, cancelled: 2 }[status];
}

function shouldAdvanceRun(existing, incoming) {
  const existingRank = runStateRank(existing.status);
  const incomingRank = runStateRank(incoming.status);
  if (incomingRank !== existingRank) return incomingRank > existingRank;
  if (incomingRank < 2) return false;
  return `${incoming.completedAt}\u0000${incoming.status}` >
    `${existing.completed_at}\u0000${existing.status}`;
}

function shouldAdvanceProposal(existing, incoming) {
  if (existing.status === "pending") return incoming.status !== "pending";
  if (existing.status === "approved" && !existing.undone_at && incoming.undoneAt) {
    return true;
  }
  if (existing.status !== incoming.status && incoming.status !== "pending") {
    return `${incoming.decidedAt}\u0000${incoming.status}` >
      `${existing.decided_at}\u0000${existing.status}`;
  }
  return false;
}

function deprecateLinkedEntries(entryIds, proposalId = "") {
  for (const entryId of entryIds) {
    if (proposalId && statements.findActiveApprovalReference.get(
      proposalId, entryId, entryId
    )) continue;
    const row = statements.find.get(entryId);
    if (!row || row.status === "deprecated") continue;
    statements.deprecateEntry.run(new Date().toISOString(), entryId);
    const deprecated = rowToEntry(statements.find.get(entryId));
    appendLocalState("upsert", entryId, deprecated);
  }
}

function writeApprovalMergeAudit(
  proposalId,
  runId,
  entryIds,
  canonicalId,
  undone,
  createdAt
) {
  const id = crypto.createHash("sha256")
    .update(`approval-merge\n${proposalId}\n${entryIds.join("\n")}\n${canonicalId}\n${undone}`)
    .digest("hex");
  statements.insertImportedAudit.run(
    id,
    "undo",
    "sync",
    runId,
    proposalId,
    canonicalId,
    JSON.stringify({
      action: undone ? "merge-undone-approvals" : "canonicalize-approvals",
      approvalEntryIds: entryIds,
      canonicalEntryId: canonicalId
    }),
    createdAt
  );
}

function writeDecisionConflictAudit(approved, rejected, approvalEntryIds) {
  const orderedDecisions = [
    `approved:${approved.decidedAt}:${approved.approvedBy}`,
    `rejected:${rejected.decidedAt}`
  ].sort();
  const id = crypto.createHash("sha256")
    .update(`proposal-decision-conflict\n${approved.id}\n${orderedDecisions.join("\n")}`)
    .digest("hex");
  const createdAt = [approved.decidedAt, rejected.decidedAt]
    .filter(Boolean)
    .sort()
    .at(-1) || approved.createdAt;
  statements.insertImportedAudit.run(
    id,
    "rejection",
    "sync",
    approved.runId,
    approved.id,
    approved.approvedEntryId,
    JSON.stringify({
      action: "competing-rejection-preserved-approval",
      approvedEntryId: approved.approvedEntryId,
      approvalEntryIds,
      approvedAt: approved.decidedAt,
      rejectedAt: rejected.decidedAt
    }),
    createdAt
  );
}

function ledgerDeferred(message) {
  const error = apiError(409, message);
  error.code = "ledger_deferred";
  return error;
}

function validateApprovalTargets(proposal, stagedProposals = new Map()) {
  if (proposal.status !== "approved") return [];
  let entryIds = [...new Set([
    ...proposal.approvalEntryIds,
    proposal.approvedEntryId
  ].filter(Boolean))];
  if (proposal.canonicalContentHash &&
      proposal.approvedEntryId !== proposalEntryId(proposal.id)) {
    entryIds = [proposal.approvedEntryId];
    proposal.approvalEntryIds = entryIds;
  }
  if (!entryIds.length || !entryIds.includes(proposal.approvedEntryId)) {
    throw apiError(400, "approved proposal 缺少有效审批知识关联");
  }
  const expectedId = proposalEntryId(proposal.id);
  const sharedCanonicalTargetId = contentCanonicalEntryId(proposal.content);
  if (!entryIds.includes(expectedId) &&
      !entryIds.includes(sharedCanonicalTargetId)) {
    throw apiError(409, "审批知识确定性 ID 与 proposal 不匹配");
  }
  const rows = entryIds.map(entryId => {
    const row = statements.find.get(entryId);
    if (!row) {
      throw ledgerDeferred(`审批知识 ${entryId} 尚未同步，ledger 已延后`);
    }
    const entry = rowToEntry(row);
    const directTarget = entryId === expectedId;
    const sharedCanonical = entryId === sharedCanonicalTargetId;
    const owner = directTarget ? null : (
      stagedProposals.get(entry.provenance?.proposalId || "") ||
      statements.findProposal.get(entry.provenance?.proposalId || "") ||
      [...stagedProposals.values()].find(item =>
        item.status === "approved" && item.approvedEntryId === entryId
      ) ||
      statements.findProposalByApprovedEntry.get(entryId)
    );
    const expectedSourceRunId = directTarget
      ? proposal.runId
      : (entry.provenance?.runId || owner?.runId || owner?.run_id);
    if ((directTarget && (
          entry.agentRunId !== proposal.runId ||
          entry.provenance?.runId !== proposal.runId ||
          entry.provenance?.proposalId !== proposal.id
        )) ||
        (!directTarget && (
          !sharedCanonical
        )) ||
        (directTarget && entry.provenance?.origin !== "agent") ||
        entry.title !== proposal.title ||
        entry.content !== proposal.content ||
        entry.summary !== proposal.summary ||
        entry.project !== proposal.project ||
        canonicalJson(entry.tags) !== canonicalJson(proposal.tags) ||
        entry.source !== `agent://${expectedSourceRunId}` ||
        entry.confidence !== proposal.confidence) {
      const fields = [];
      if (entry.title !== proposal.title) fields.push("title");
      if (entry.content !== proposal.content) fields.push("content");
      if (entry.summary !== proposal.summary) fields.push("summary");
      if (entry.project !== proposal.project) fields.push("project");
      if (canonicalJson(entry.tags) !== canonicalJson(proposal.tags)) fields.push("tags");
      if (entry.source !== `agent://${expectedSourceRunId}`) fields.push("source");
      if (entry.confidence !== proposal.confidence) fields.push("confidence");
      if (!fields.length) fields.push("provenance");
      throw apiError(409, `审批知识 ${entryId} 与 proposal 不匹配：${fields.join(",")}`);
    }
    if (proposal.undoneAt) {
      const sharedActiveReference = statements.findActiveApprovalReference.get(
        proposal.id, entryId, entryId
      );
      if (entry.status !== "deprecated" && !sharedActiveReference) {
        throw ledgerDeferred(`撤销知识 ${entryId} 的 deprecated 状态尚未同步`);
      }
    } else if (!["draft", "verified"].includes(entry.status)) {
      throw apiError(409, `审批知识 ${entryId} 生命周期不正确`);
    }
    return row;
  });
  return rows;
}

function canonicalizeDuplicateApprovalTarget(proposal, stagedProposals = new Map()) {
  const currentTarget = proposal.status === "approved"
    ? statements.find.get(proposal.approvedEntryId)
    : null;
  if (proposal.status !== "approved" ||
      (currentTarget && currentTarget.status !== "deprecated")) return false;
  const duplicate = statements.findByContent.get(contentKey(proposal.content));
  if (!duplicate) return false;
  const row = statements.find.get(duplicate.id);
  const entry = rowToEntry(row);
  const owner = statements.findProposalByApprovedEntry.get(duplicate.id) ||
    [...stagedProposals.values()].find(item =>
      item.status === "approved" && item.approvedEntryId === duplicate.id
    );
  const ownerId = owner?.id;
  const ownerRunId = owner?.runId || owner?.run_id;
  if (!owner || entry.provenance?.origin !== "agent" ||
      entry.provenance?.proposalId !== ownerId ||
      entry.provenance?.runId !== ownerRunId ||
      entry.title !== proposal.title ||
      entry.content !== proposal.content ||
      !["draft", "verified"].includes(entry.status)) {
    throw apiError(409, "重复内容审批目标与现有 canonical 知识不兼容");
  }
  const sharedId = contentCanonicalEntryId(proposal.content);
  if (!statements.find.get(sharedId)) {
    statements.deprecateEntry.run(new Date().toISOString(), duplicate.id);
    appendLocalState(
      "upsert",
      duplicate.id,
      rowToEntry(statements.find.get(duplicate.id))
    );
    const sharedEntry = {
      ...entry,
      id: sharedId,
      status: entry.status,
      provenance: {
        ...entry.provenance,
        contentCanonicalizedFrom: duplicate.id
      },
      updatedAt: new Date().toISOString()
    };
    replaceEntryRaw(sharedEntry);
    appendLocalState("upsert", sharedId, rowToEntry(statements.find.get(sharedId)));
  }
  const ownerEntries = [sharedId];
  statements.updateImportedProposal.run(
    "approved", owner.decidedAt || owner.decided_at, sharedId,
    owner.approvedBy || owner.approved_by, owner.undoneAt || owner.undone_at || "",
    JSON.stringify(ownerEntries), contentKey(proposal.content), ownerId
  );
  const originalTarget = proposal.approvedEntryId;
  proposal.approvedEntryId = sharedId;
  proposal.approvalEntryIds = [sharedId];
  proposal.canonicalContentHash = contentKey(proposal.content);
  return { originalTarget, canonicalTarget: sharedId };
}

function writeContentCanonicalizationAudit(proposal, mapping) {
  const id = crypto.createHash("sha256")
    .update(`content-canonicalization\n${proposal.id}\n${mapping.originalTarget}\n${mapping.canonicalTarget}`)
    .digest("hex");
  statements.insertImportedAudit.run(
    id, "write", "sync", proposal.runId, proposal.id, mapping.canonicalTarget,
    JSON.stringify({
      action: "canonicalize-duplicate-approved-content",
      originalTarget: mapping.originalTarget,
      canonicalTarget: mapping.canonicalTarget,
      contentHash: proposal.canonicalContentHash
    }),
    proposal.decidedAt || proposal.createdAt
  );
}

function importAgentLedger(rawLedger, options = {}) {
  const ledger = options.normalized ? rawLedger : normalizeAgentLedger(rawLedger);
  const action = () => {
    const deferredProposalIds = new Set();
    const stagedProposals = new Map(
      ledger.proposals.map(proposal => [proposal.id, proposal])
    );
    for (const run of ledger.runs) {
      const priorRun = statements.findAgentRun.get(run.id);
      if (priorRun) {
        const existingRun = rowToAgentRun(priorRun);
        const immutableExisting = {
          goal: existingRun.goal, outputFormat: existingRun.outputFormat,
          outputMode: existingRun.outputMode, provider: existingRun.provider,
          model: existingRun.model, createdAt: existingRun.createdAt,
          plan: existingRun.plan, sourceIds: existingRun.sourceIds,
          sourcePins: existingRun.sourcePins,
          permissionScope: existingRun.permissionScope
        };
        const immutableIncoming = {
          goal: run.goal, outputFormat: run.outputFormat, outputMode: run.outputMode,
          provider: run.provider, model: run.model, createdAt: run.createdAt,
          plan: run.plan, sourceIds: run.sourceIds, sourcePins: run.sourcePins,
          permissionScope: run.permissionScope
        };
        if (canonicalJson(immutableExisting) !== canonicalJson(immutableIncoming)) {
          const fields = Object.keys(immutableExisting).filter(key =>
            canonicalJson(immutableExisting[key]) !== canonicalJson(immutableIncoming[key])
          );
          throw apiError(409, `agent run ${run.id} 的不可变字段冲突：${fields.join(", ")}`);
        }
      }
      statements.insertImportedAgentRun.run(
        run.id, run.goal, run.outputFormat, run.outputMode, run.provider, run.model,
        run.status, run.createdAt, run.startedAt, run.completedAt,
        JSON.stringify(run.plan), JSON.stringify(run.sourceIds), run.result, run.error,
        JSON.stringify(run.permissionScope), JSON.stringify(run.sourcePins)
      );
      const existing = statements.findAgentRun.get(run.id);
      if (existing && shouldAdvanceRun(existing, run)) {
        statements.updateImportedAgentRun.run(
          run.status, run.startedAt, run.completedAt, run.result, run.error, run.id
        );
      }
    }
    for (const proposal of ledger.proposals) {
      const priorProposal = statements.findProposal.get(proposal.id);
      if (priorProposal?.undone_at && !proposal.undoneAt) continue;
      const contentCanonicalization =
        canonicalizeDuplicateApprovalTarget(proposal, stagedProposals);
      try {
        validateApprovalTargets(proposal, stagedProposals);
      } catch (error) {
        if (error.code !== "ledger_deferred" &&
            !(options.deferInvalidTargets && error.status === 409)) throw error;
        deferredProposalIds.add(proposal.id);
        continue;
      }
      if (priorProposal) {
        const existingProposal = rowToProposal(priorProposal);
        const immutableExisting = {
          runId: existingProposal.runId, title: existingProposal.title,
          content: existingProposal.content, summary: existingProposal.summary,
          project: existingProposal.project, tags: existingProposal.tags,
          sourceIds: existingProposal.sourceIds,
          sourceVersions: existingProposal.sourceVersions,
          confidence: existingProposal.confidence, rationale: existingProposal.rationale,
          createdAt: existingProposal.createdAt
        };
        const immutableIncoming = {
          runId: proposal.runId, title: proposal.title, content: proposal.content,
          summary: proposal.summary, project: proposal.project, tags: proposal.tags,
          sourceIds: proposal.sourceIds, sourceVersions: proposal.sourceVersions,
          confidence: proposal.confidence, rationale: proposal.rationale,
          createdAt: proposal.createdAt
        };
        if (canonicalJson(immutableExisting) !== canonicalJson(immutableIncoming)) {
          throw apiError(409, `proposal ${proposal.id} 的不可变字段冲突`);
        }
      }
      statements.insertImportedProposal.run(
        proposal.id, proposal.runId, proposal.title, proposal.content, proposal.summary,
        proposal.project, JSON.stringify(proposal.tags), JSON.stringify(proposal.sourceIds),
        proposal.confidence, proposal.rationale, proposal.status, proposal.createdAt,
        proposal.decidedAt, proposal.approvedEntryId, proposal.approvedBy,
        proposal.undoneAt, JSON.stringify(proposal.sourceVersions),
        JSON.stringify(proposal.approvalEntryIds), proposal.canonicalContentHash
      );
      if (contentCanonicalization) {
        writeContentCanonicalizationAudit(proposal, contentCanonicalization);
      }
      const existing = statements.findProposal.get(proposal.id);
      if (priorProposal &&
          new Set([priorProposal.status, proposal.status]).size === 2 &&
          [priorProposal.status, proposal.status].every(status =>
            ["approved", "rejected"].includes(status)
          )) {
        const prior = rowToProposal(priorProposal);
        const approved = prior.status === "approved" ? prior : proposal;
        const rejected = prior.status === "rejected" ? prior : proposal;
        const approvalEntryIds = [...new Set([
          ...approved.approvalEntryIds,
          approved.approvedEntryId
        ].filter(Boolean))].sort();
        if (!approved.approvedEntryId || !approvalEntryIds.length) {
          throw apiError(409, "竞争审批缺少已批准知识关联");
        }
        statements.updateImportedProposal.run(
          "approved",
          approved.decidedAt,
          approved.approvedEntryId,
          approved.approvedBy,
          approved.undoneAt,
          JSON.stringify(approvalEntryIds),
          approved.canonicalContentHash,
          proposal.id
        );
        if (approved.undoneAt) {
          deprecateLinkedEntries(approvalEntryIds, proposal.id);
        }
        writeDecisionConflictAudit(approved, rejected, approvalEntryIds);
        continue;
      }
      if (priorProposal && priorProposal.status === "approved" &&
          proposal.status === "approved") {
        const prior = rowToProposal(priorProposal);
        const approvalEntryIds = [...new Set([
          ...prior.approvalEntryIds,
          prior.approvedEntryId,
          ...proposal.approvalEntryIds,
          proposal.approvedEntryId
        ].filter(Boolean))].sort();
        const convergentId = proposalEntryId(proposal.id);
        const sharedRecord = [prior, proposal].find(item =>
          item.canonicalContentHash === contentKey(item.content) &&
          item.approvedEntryId
        );
        const canonicalId = sharedRecord?.approvedEntryId ||
          (approvalEntryIds.includes(convergentId)
            ? convergentId
            : approvalEntryIds[0]);
        const canonicalContentHash = sharedRecord?.canonicalContentHash || "";
        const mergedApprovalEntryIds = sharedRecord
          ? [canonicalId]
          : approvalEntryIds;
        const decisions = [prior, proposal].sort((left, right) =>
          `${left.decidedAt}\u0000${left.approvedBy}\u0000${left.approvedEntryId}`
            .localeCompare(
              `${right.decidedAt}\u0000${right.approvedBy}\u0000${right.approvedEntryId}`
            )
        );
        const undoneAt = [prior.undoneAt, proposal.undoneAt]
          .filter(Boolean)
          .sort()[0] || "";
        statements.updateImportedProposal.run(
          "approved",
          decisions[0].decidedAt,
          canonicalId,
          decisions[0].approvedBy,
          undoneAt,
          JSON.stringify(mergedApprovalEntryIds),
          canonicalContentHash,
          proposal.id
        );
        const losingIds = undoneAt
          ? mergedApprovalEntryIds
          : approvalEntryIds.filter(entryId => entryId !== canonicalId);
        const canonicalSeedRow = statements.find.get(canonicalId) || approvalEntryIds
          .map(entryId => statements.find.get(entryId))
          .find(Boolean);
        const canonicalSeed = canonicalSeedRow ? rowToEntry(canonicalSeedRow) : null;
        deprecateLinkedEntries(losingIds, proposal.id);
        if (!undoneAt && !statements.find.get(canonicalId) && canonicalSeed) {
          const canonicalEntry = {
            ...canonicalSeed,
            id: canonicalId,
            status: canonicalSeed.status === "deprecated" ? "draft" : canonicalSeed.status,
            provenance: {
              ...canonicalSeed.provenance,
              canonicalizedFrom: canonicalSeed.id,
              proposalId: proposal.id
            },
            updatedAt: new Date().toISOString()
          };
          replaceEntryRaw(canonicalEntry);
          appendLocalState("upsert", canonicalId, rowToEntry(statements.find.get(canonicalId)));
        }
        if (approvalEntryIds.length > 1 ||
            prior.approvedBy !== proposal.approvedBy ||
            prior.decidedAt !== proposal.decidedAt ||
            undoneAt) {
          writeApprovalMergeAudit(
            proposal.id,
            proposal.runId,
            mergedApprovalEntryIds,
            canonicalId,
            undoneAt,
            decisions[0].decidedAt
          );
        }
        continue;
      }
      const canAdvance = existing && shouldAdvanceProposal(existing, proposal);
      if (canAdvance) {
        statements.updateImportedProposal.run(
          proposal.status, proposal.decidedAt, proposal.approvedEntryId,
          proposal.approvedBy, proposal.undoneAt,
          JSON.stringify(proposal.approvalEntryIds),
          proposal.canonicalContentHash, proposal.id
        );
      }
    }
    for (const event of ledger.audit) {
      if (event.proposalId && deferredProposalIds.has(event.proposalId)) continue;
      const priorAudit = statements.findAudit.get(event.id);
      if (priorAudit && canonicalJson(rowToAudit(priorAudit)) !== canonicalJson(event)) {
        throw apiError(409, `audit ${event.id} 的不可变记录冲突`);
      }
      statements.insertImportedAudit.run(
        event.id, event.eventType, event.actor, event.runId, event.proposalId,
        event.entryId, JSON.stringify(event.details), event.createdAt
      );
    }
    return {
      runs: ledger.runs.length,
      proposals: ledger.proposals.length - deferredProposalIds.size,
      audit: ledger.audit.filter(event =>
        !event.proposalId || !deferredProposalIds.has(event.proposalId)
      ).length,
      deferredProposalIds: [...deferredProposalIds]
    };
  };
  return options.inTransaction ? action() : runTransaction(action);
}

function writeAudit(eventType, fields = {}) {
  statements.insertAudit.run(
    crypto.randomUUID(),
    eventType,
    boundedText(fields.actor || "system", "actor", 200, { required: true }),
    fields.runId || "",
    fields.proposalId || "",
    fields.entryId || "",
    JSON.stringify(fields.details || {}),
    new Date().toISOString()
  );
}

function sourceVersionPin(id) {
  const row = statements.find.get(id);
  const version = statements.findEntityVersion.get(id);
  if (!row || !version) return null;
  const entry = rowToEntry(row);
  return {
    id,
    opId: version.op_id,
    contentHash: crypto.createHash("sha256").update(row.content).digest("hex"),
    semanticRevision: entry.semanticRevision,
    semanticHash: semanticEntryHash(entry),
    lifecycle: row.status || "raw",
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: row.source,
    project: row.project || "",
    tags: normalizeTags(safeJson(row.tags_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceAt: row.updated_at || row.created_at
  };
}

function semanticEntryHash(entry) {
  return crypto.createHash("sha256").update(canonicalJson({
    title: entry.title,
    content: entry.content,
    summary: entry.summary,
    source: entry.source,
    project: entry.project,
    tags: entry.tags,
    status: entry.status
  })).digest("hex");
}

function backfillRunSourcePins() {
  runTransaction(() => {
    for (const runRow of statements.listAgentRuns.all()) {
      const existingPins = safeJson(runRow.source_pins_json, []);
      const sourceIds = normalizeStringArray(
        safeJson(runRow.source_ids_json, []),
        20
      );
      let completeExistingPins = false;
      try {
        completeExistingPins = Array.isArray(existingPins) &&
          existingPins.length === sourceIds.length &&
          existingPins.every((pin, index) =>
            validateSourcePin(pin).id === sourceIds[index]
          );
      } catch {
        completeExistingPins = false;
      }
      if (completeExistingPins) continue;
      const proposals = statements.listProposals.all(runRow.id);
      const historicalPins = proposals.flatMap(row =>
        safeJson(row.source_versions_json, [])
      );
      const scope = portablePermissionScope(runRow.permission_scope_json);
      const pins = sourceIds.map(sourceId => {
        const current = sourceVersionPin(sourceId);
        if (current) {
          return {
            ...current,
            project: scope.project || current.project,
            sourceAt: scope.startAt && current.sourceAt < scope.startAt
              ? scope.startAt
              : scope.endAt && current.sourceAt > scope.endAt
                ? scope.endAt
                : current.sourceAt
          };
        }
        const historical = historicalPins.find(pin => pin.id === sourceId);
        const unavailableContent = `Unavailable legacy source ${sourceId}`;
        const fallbackSnapshot = {
          title: "Deprecated legacy source",
          content: unavailableContent,
          summary: "",
          source: "",
          project: scope.project,
          tags: [],
          status: "deprecated"
        };
        return {
          id: sourceId,
          opId: String(historical?.opId || `legacy-missing:${sourceId}`),
          contentHash: crypto.createHash("sha256")
            .update(unavailableContent)
            .digest("hex"),
          semanticRevision: 1,
          semanticHash: semanticEntryHash(fallbackSnapshot),
          lifecycle: "deprecated",
          title: fallbackSnapshot.title,
          content: fallbackSnapshot.content,
          summary: fallbackSnapshot.summary,
          source: fallbackSnapshot.source,
          project: fallbackSnapshot.project,
          tags: fallbackSnapshot.tags,
          createdAt: runRow.created_at,
          updatedAt: "",
          sourceAt: runRow.created_at
        };
      });
      statements.updateRunSourcePins.run(JSON.stringify(pins), runRow.id);
      for (const proposalRow of proposals) {
        const proposalIds = normalizeStringArray(
          safeJson(proposalRow.source_ids_json, []),
          20
        );
        const proposalPins = proposalIds.map(sourceId =>
          pins.find(pin => pin.id === sourceId)
        ).filter(Boolean);
        statements.updateProposalSourceVersions.run(
          JSON.stringify(proposalPins),
          proposalRow.id
        );
      }
    }
  });
}

function staleSourceError(id, reason) {
  const error = apiError(
    409,
    `候选知识来源已过期（${id}：${reason}），请重新运行 Agent 生成候选`
  );
  error.code = "stale_source";
  return error;
}

function proposalEntryId(proposalId) {
  return `agent-entry-${crypto.createHash("sha256")
    .update(`AIKnowledgeInbox.ProposalEntry\n${proposalId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function contentCanonicalEntryId(content) {
  return `agent-content-${contentKey(content).slice(0, 32)}`;
}

function pinsForRunSources(run, sourceIds) {
  if (sourceIds.some(id => !run.sourceIds.includes(id))) {
    throw apiError(400, "候选知识来源超出关联 run");
  }
  const pins = sourceIds.map(id => run.sourcePins.find(pin => pin.id === id));
  if (pins.some(pin => !pin)) {
    throw staleSourceError("run", "运行未固定完整来源版本");
  }
  return pins;
}

function assertProposalMatchesRun(proposal, run) {
  const expectedPins = pinsForRunSources(run, proposal.sourceIds);
  if (canonicalJson(proposal.sourceVersions) !== canonicalJson(expectedPins)) {
    throw staleSourceError("run", "候选来源固定信息与运行计划不一致");
  }
  if (run.permissionScope.project &&
      proposal.project !== run.permissionScope.project) {
    throw apiError(400, "候选知识超出关联 run 项目权限");
  }
  expectedPins.forEach(pin => validatePinScope(pin, run.permissionScope));
  return expectedPins;
}

function revalidateSourcePins(pins) {
  for (const pin of pins) {
    const source = statements.find.get(pin.id);
    if (!source) throw staleSourceError(pin.id, "已删除");
    if (source.status === "deprecated") throw staleSourceError(pin.id, "已废弃");
    const entry = rowToEntry(source);
    if (entry.semanticRevision !== pin.semanticRevision ||
        semanticEntryHash(entry) !== pin.semanticHash ||
        source.status !== pin.lifecycle ||
        source.project !== pin.project ||
        crypto.createHash("sha256").update(source.content).digest("hex") !==
          pin.contentHash) {
      throw staleSourceError(pin.id, "内容、范围或生命周期已变化");
    }
  }
}

function validateSourceIds(value, allowedIds = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some(id => typeof id !== "string" || !id.trim() || id.length > 100)) {
    throw apiError(400, "sourceIds 必须包含 1 到 20 个有效字符串");
  }
  if (new Set(value.map(id => id.trim())).size !== value.length) {
    throw apiError(400, "sourceIds 不能重复");
  }
  const sourceIds = normalizeStringArray(value, 20);
  if (!sourceIds.length) throw apiError(400, "至少需要一个 sourceId");
  for (const id of sourceIds) {
    if (allowedIds && !allowedIds.has(id)) {
      throw apiError(400, `sourceId 不在本次运行范围内：${id}`);
    }

    const source = statements.find.get(id);
    if (!source) throw apiError(400, `sourceId 不存在：${id}`);
    if (source.status === "deprecated") {
      throw apiError(400, `sourceId 已废弃：${id}`);
    }
  }
  return sourceIds;
}

function validateRequiredSourceIds(value, label) {
  const sourceIds = validateLedgerStringArray(value, label, 20);
  if (!sourceIds.length || sourceIds.length !== value.length) {
    throw apiError(400, `${label} 必须包含至少一个且不能重复`);
  }
  return sourceIds;
}

function createAgentRun(input) {
  requireObject(input, "Agent 运行参数");
  if (typeof input.goal !== "string" ||
      (input.outputFormat !== undefined && typeof input.outputFormat !== "string") ||
      (input.model !== undefined && typeof input.model !== "string")) {
    throw apiError(400, "Agent 运行字段类型不正确");
  }
  const goal = boundedText(input.goal, "goal", 1200, { required: true });
  const outputFormat = boundedText(input.outputFormat || "report", "outputFormat", 80, {
    required: true
  });
  if (!["report", "brief", "actions", "comparison"].includes(outputFormat)) {
    throw apiError(400, "outputFormat 不受支持");
  }
  const provider = input.provider === "ollama"
    ? "ollama"
    : input.provider === "browser" ? "browser" : "";
  if (!provider) throw apiError(400, "provider 仅支持 browser 或 ollama");
  if (input.externalSupplementation ||
      (input.permissionScope && input.permissionScope.externalSupplementation)) {
    throw apiError(400, "外部补充尚未实现，必须保持关闭");
  }
  const sourceIds = validateSourceIds(input.sourceIds);
  const scope = input.permissionScope === undefined ? {} :
    requireObject(input.permissionScope, "permissionScope");
  const permissionScope = {
    mode: "propose-only",
    project: boundedText(scope.project ?? input.project, "project", 200),
    startAt: boundedText(scope.startAt ?? input.startAt, "startAt", 80),
    endAt: boundedText(scope.endAt ?? input.endAt, "endAt", 80),
    externalSupplementation: false
  };
  for (const field of ["startAt", "endAt"]) {
    if (permissionScope[field] &&
        !Number.isFinite(validatedTimestamp(permissionScope[field]))) {
      throw apiError(400, `${field} 必须是 ISO 8601 时间`);
    }
  }
  if (permissionScope.startAt && permissionScope.endAt &&
      Date.parse(permissionScope.startAt) > Date.parse(permissionScope.endAt)) {
    throw apiError(400, "startAt 不能晚于 endAt");
  }
  const plan = input.plan === undefined ? {} : requireObject(input.plan, "plan");
  if (canonicalJson(stripSensitiveKeys(plan)) !== canonicalJson(plan)) {
    throw apiError(400, "plan 不能包含凭据或密钥字段");
  }
  if (JSON.stringify(plan).length > 20000) throw apiError(400, "plan 格式不正确");
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  return runTransaction(() => {
    const sourcePins = sourceIds.map(sourceId => {
      const pin = sourceVersionPin(sourceId);
      if (!pin) throw apiError(409, `无法固定 sourceId 版本：${sourceId}`);
      if (pin.lifecycle === "deprecated") {
        throw apiError(400, `sourceId 已废弃：${sourceId}`);
      }
      validatePinScope(pin, permissionScope);
      return pin;
    });
    statements.insertAgentRun.run(
      id,
      goal,
      outputFormat,
      "propose-only",
      provider,
      boundedText(input.model, "model", 100),
      createdAt,
      JSON.stringify(plan),
      JSON.stringify(sourceIds),
      JSON.stringify(permissionScope),
      JSON.stringify(sourcePins)
    );
    writeAudit("agent_run", {
      runId: id,
      actor: "user",
      details: { action: "created", provider, sourceIds, sourcePins, permissionScope }
    });
    return rowToAgentRun(statements.findAgentRun.get(id));
  });
}

function transitionAgentRun(id, action, input = {}) {
  requireObject(input, "Agent 状态参数");
  if (action === "complete" && typeof input.result !== "string") {
    throw apiError(400, "result 必须是字符串");
  }
  if (action === "fail" && typeof input.error !== "string") {
    throw apiError(400, "error 必须是字符串");
  }
  const row = statements.findAgentRun.get(id);
  if (!row) throw apiError(404, "Agent 运行不存在");
  return runTransaction(() => {
    const now = new Date().toISOString();
    let result;
    if (action === "start") {
      const runRecord = rowToAgentRun(statements.findAgentRun.get(id));
      const pins = pinsForRunSources(runRecord, runRecord.sourceIds);
      revalidateSourcePins(pins);
      result = statements.startAgentRun.run(now, id);
    } else if (action === "complete") {
      const text = boundedText(input.result, "result", 200000, { required: true });
      result = statements.completeAgentRun.run(now, text, id);
    } else if (action === "fail") {
      result = statements.failAgentRun.run(
        now,
        boundedText(input.error, "error", 4000, { required: true }),
        id
      );
    } else if (action === "cancel") {
      result = statements.cancelAgentRun.run(now, id);
    } else {
      throw apiError(400, "未知 Agent 状态变更");
    }
    if (!result.changes) {
      const current = statements.findAgentRun.get(id);
      if (action === "cancel" && current.status === "cancelled") {
        return rowToAgentRun(current);
      }
      throw apiError(409, `无法从 ${current.status} 执行 ${action}`);
    }
    writeAudit("agent_run", { runId: id, actor: "user", details: { action } });
    return rowToAgentRun(statements.findAgentRun.get(id));
  });
}

function createProposal(runId, input) {
  requireObject(input, "候选知识");
  if (typeof input.title !== "string" || typeof input.content !== "string" ||
      typeof input.summary !== "string" ||
      typeof input.project !== "string" ||
      typeof input.rationale !== "string" ||
      typeof input.confidence !== "number" ||
      !Array.isArray(input.tags) || input.tags.length > 20 ||
      input.tags.some(tag => typeof tag !== "string" || tag.length > 80)) {
    throw apiError(400, "候选知识字段类型不正确");
  }
  const run = statements.findAgentRun.get(runId);
  if (!run) throw apiError(404, "Agent 运行不存在");
  if (run.status !== "running") throw apiError(409, "只能为运行中的 Agent 创建候选知识");
  const runRecord = rowToAgentRun(run);
  const sourceIds = validateRequiredSourceIds(input.sourceIds, "proposal sourceIds");
  const sourceVersions = pinsForRunSources(runRecord, sourceIds);
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw apiError(400, "confidence 必须在 0 到 1 之间");
  }
  const proposal = {
    id: crypto.randomUUID(),
    title: boundedText(input.title, "title", 300, { required: true }),
    content: boundedText(input.content, "content", 200000, { required: true }),
    summary: boundedText(input.summary, "summary", 4000),
    project: boundedText(input.project, "project", 200),
    tags: normalizeTags(input.tags),
    sourceIds,
    sourceVersions,
    confidence,
    rationale: boundedText(input.rationale, "rationale", 4000, { required: true }),
    createdAt: new Date().toISOString()
  };
  return runTransaction(() => {
    assertProposalMatchesRun(proposal, runRecord);
    revalidateSourcePins(sourceVersions);
    statements.insertProposal.run(
      proposal.id,
      runId,
      proposal.title,
      proposal.content,
      proposal.summary,
      proposal.project,
      JSON.stringify(proposal.tags),
      JSON.stringify(proposal.sourceIds),
      proposal.confidence,
      proposal.rationale,
      proposal.createdAt,
      JSON.stringify(proposal.sourceVersions)
    );
    writeAudit("proposal", {
      runId,
      proposalId: proposal.id,
      actor: "agent",
      details: { sourceIds, confidence }
    });
    return rowToProposal(statements.findProposal.get(proposal.id));
  });
}

function approveProposal(id, input = {}) {
  requireObject(input, "审批参数");
  if (typeof input.approvedBy !== "string" ||
      (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string") ||
      (input.entryStatus !== undefined && typeof input.entryStatus !== "string")) {
    throw apiError(400, "审批字段类型不正确");
  }
  const proposalRow = statements.findProposal.get(id);
  if (!proposalRow) throw apiError(404, "候选知识不存在");
  if (proposalRow.status === "approved") {
    if (input.idempotencyKey &&
        input.idempotencyKey === proposalRow.idempotency_key &&
        !proposalRow.undone_at) {
      const approvedEntry = statements.find.get(proposalRow.approved_entry_id);
      if (!approvedEntry) throw apiError(409, "审批创建的知识不存在");
      return {
        proposal: rowToProposal(proposalRow),
        entry: rowToEntry(approvedEntry),
        idempotent: true
      };
    }
    throw apiError(409, "候选知识已经审批");
  }
  if (proposalRow.status !== "pending") throw apiError(409, "已拒绝的候选知识不能审批");
  const run = statements.findAgentRun.get(proposalRow.run_id);
  if (!run || run.status !== "completed") {
    throw apiError(409, "只有已完成运行的候选知识可以审批");
  }
  const actor = boundedText(input.approvedBy, "approvedBy", 200, { required: true });
  const idempotencyKey = boundedText(
    input.idempotencyKey || crypto.randomUUID(),
    "idempotencyKey",
    120,
    { required: true }
  );
  const entryStatus = input.entryStatus || "draft";
  if (!["draft", "verified"].includes(entryStatus)) {
    throw apiError(400, "审批写入状态只能是 draft 或 verified");
  }
  const proposal = rowToProposal(proposalRow);
  const runRecord = rowToAgentRun(run);
  const key = contentKey(proposal.content);
  const duplicate = statements.findByContent.get(key);
  const entryId = proposalEntryId(proposal.id);
  if (duplicate && duplicate.id !== entryId) {
    throw apiError(409, `这段内容已经保存过：${duplicate.title}`);
  }
  const now = new Date().toISOString();
  const provenance = {
    origin: "agent",
    runId: run.id,
    proposalId: proposal.id,
    sourceIds: proposal.sourceIds,
    provider: run.provider,
    model: run.model,
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    createdAt: proposal.createdAt,
    approvedBy: actor,
    approvedAt: now,
    status: entryStatus
  };
  const entry = runTransaction(() => {
    const pins = assertProposalMatchesRun(proposal, runRecord);
    revalidateSourcePins(pins);
    let created;
    const existingEntry = statements.find.get(entryId);
    if (existingEntry) {
      created = rowToEntry(existingEntry);
      if (contentKey(created.content) !== key || created.agentRunId !== run.id) {
        throw apiError(409, "确定性审批知识 ID 与现有知识冲突");
      }
    } else {
      statements.insert.run(
        entryId, proposal.title, proposal.content, key, `agent://${run.id}`,
        proposal.project, JSON.stringify(proposal.tags), proposal.summary, now, "",
        0, "", entryStatus, proposal.confidence, JSON.stringify(provenance), run.id,
        actor, now, "[]", "[]", 1
      );
      statements.removeTombstone.run(entryId);
      created = rowToEntry(statements.find.get(entryId));
      appendLocalState("upsert", entryId, created);
    }
    const decision = statements.approveProposal.run(
      now, entryId, actor, idempotencyKey, JSON.stringify([entryId]), id
    );
    if (!decision.changes) throw apiError(409, "候选知识审批状态已改变");
    writeAudit("approval", {
      actor, runId: run.id, proposalId: id, entryId,
      details: { entryStatus, idempotencyKey }
    });
    writeAudit("write", {
      actor, runId: run.id, proposalId: id, entryId,
      details: { provenance, status: entryStatus }
    });
    return created;
  });
  scheduleSync();
  return { proposal: rowToProposal(statements.findProposal.get(id)), entry, idempotent: false };
}

function rejectProposal(id, input = {}) {
  requireObject(input, "拒绝参数");
  if ((input.rejectedBy !== undefined && typeof input.rejectedBy !== "string") ||
      (input.reason !== undefined && typeof input.reason !== "string")) {
    throw apiError(400, "拒绝字段类型不正确");
  }
  const row = statements.findProposal.get(id);
  if (!row) throw apiError(404, "候选知识不存在");
  if (row.status !== "pending") throw apiError(409, "只能拒绝待审批候选知识");
  const actor = boundedText(input.rejectedBy || "user", "rejectedBy", 200, {
    required: true
  });
  return runTransaction(() => {
    const now = new Date().toISOString();
    if (!statements.rejectProposal.run(now, id).changes) {
      throw apiError(409, "候选知识审批状态已改变");
    }
    writeAudit("rejection", {
      actor, runId: row.run_id, proposalId: id,
      details: { reason: boundedText(input.reason, "reason", 1000) }
    });
    return rowToProposal(statements.findProposal.get(id));
  });
}

function undoProposal(id, input = {}) {
  requireObject(input, "撤销参数");
  if (input.actor !== undefined && typeof input.actor !== "string") {
    throw apiError(400, "actor 必须是字符串");
  }
  const row = statements.findProposal.get(id);
  if (!row) throw apiError(404, "候选知识不存在");
  if (row.status !== "approved" || !row.approved_entry_id) {
    throw apiError(409, "只能撤销已审批写入");
  }
  if (row.undone_at) throw apiError(409, "该写入已经撤销");
  const actor = boundedText(input.actor || "user", "actor", 200, { required: true });
  validateApprovalTargets(rowToProposal(row));
  const linkedEntryIds = [...new Set([
    ...normalizeStringArray(safeJson(row.approval_entry_ids_json, []), 20),
    row.approved_entry_id
  ].filter(Boolean))];
  const linkedRows = linkedEntryIds
    .map(entryId => statements.find.get(entryId))
    .filter(Boolean);
  if (!linkedRows.length) throw apiError(409, "审批创建的知识不存在");
  const now = new Date().toISOString();
  const entry = runTransaction(() => {
    if (!statements.markProposalUndone.run(now, id).changes) {
      throw apiError(409, "该写入已经撤销");
    }
    const deprecatedEntries = [];
    for (const linkedRow of linkedRows) {
      const stillReferenced = statements.findActiveApprovalReference.get(
        id,
        linkedRow.id,
        linkedRow.id
      );
      if (stillReferenced) {
        deprecatedEntries.push(rowToEntry(linkedRow));
        continue;
      }
      statements.deprecateEntry.run(now, linkedRow.id);
      const deprecated = rowToEntry(statements.find.get(linkedRow.id));
      appendLocalState("upsert", deprecated.id, deprecated);
      deprecatedEntries.push(deprecated);
    }
    const canonical = deprecatedEntries.find(item => item.id === row.approved_entry_id) ||
      deprecatedEntries[0];
    writeAudit("undo", {
      actor, runId: row.run_id, proposalId: id, entryId: canonical.id,
      details: {
        policy: "deprecate-tombstone",
        approvalEntryIds: linkedEntryIds,
        previousStatuses: Object.fromEntries(
          linkedRows.map(item => [item.id, item.status || "raw"])
        )
      }
    });
    return canonical;
  });
  scheduleSync();
  return { proposal: rowToProposal(statements.findProposal.get(id)), entry };
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
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code) || !fs.existsSync(target)) {
        throw error;
      }
      fs.rmSync(target);
      fs.renameSync(temporary, target);
    }
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
      const agentLedger = parsed.agentLedger === undefined
        ? null
        : normalizeAgentLedger(parsed.agentLedger);
      validFiles.push({ name: file.name, path: filePath, operations, agentLedger });
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
    const currentEntryRow = statements.find.get(entityId);
    const reconciledEntry = remote.kind === "upsert"
      ? {
          ...remote.entry,
          ...normalizeLifecycle(
            remote.entry,
            currentEntryRow ? rowToEntry(currentEntryRow) : {}
          )
        }
      : null;
    const reconciled = nextLocalOperation(
      remote.kind,
      entityId,
      reconciledEntry,
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
    operations: statements.listOwnOperations.all(DEVICE_ID).map(operationFromRow),
    agentLedger: exportAgentLedger()
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
    syncState.suppressedDeletes = [];
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
    for (const file of remote.files) {
      if (!file.agentLedger) continue;
      try {
        const ledgerResult = importAgentLedger(file.agentLedger, {
          deferInvalidTargets: true
        });
        if (ledgerResult.deferredProposalIds.length) {
          degraded.push({
            name: file.name,
            path: file.path,
            error: `Agent ledger 等待审批知识：${ledgerResult.deferredProposalIds.join(", ")}`,
            observedAt: new Date().toISOString()
          });
        }
      } catch (error) {
        degraded.push({
          name: file.name,
          path: file.path,
          error: `Agent ledger: ${error.message}`,
          observedAt: new Date().toISOString()
        });
      }
    }
    for (const item of syncState.suppressedDeletes) {
      degraded.push({
        name: "approved-delete-suppressed",
        path: OPERATIONS_DIR,
        error: `已抑制有效审批知识删除：${item.entityId} (${item.operationId})`,
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
    let priorDeprecatedEntries;
    let priorAgentLedger;
    try {
      priorOperations = rowsToOperations(prior.prepare("SELECT * FROM operations").all());
      priorVersions = prior.prepare("SELECT * FROM entity_versions").all();
      priorConflicts = prior.prepare("SELECT * FROM conflicts").all();
      priorDeprecatedEntries = prior.prepare(
        "SELECT * FROM entries WHERE status = 'deprecated'"
      ).all().map(rowToEntry);
      priorAgentLedger = {
        version: 3,
        runs: prior.prepare("SELECT * FROM agent_runs").all().map(rowToAgentRun),
        proposals: prior.prepare("SELECT * FROM knowledge_proposals").all()
          .map(rowToProposal),
        audit: prior.prepare("SELECT * FROM audit_log").all().map(rowToAudit)
      };
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
    backfillRunSourcePins();

    const desiredEntries = new Map(
      statements.list.all().map(row => [row.id, rowToEntry(row)])
    );
    for (const deprecated of priorDeprecatedEntries) {
      desiredEntries.set(deprecated.id, deprecated);
    }
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
    importAgentLedger(priorAgentLedger);

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
        if (activeApprovalForEntry(dedupCanonicalId)) {
          throw apiError(
            409,
            "不能选择 incoming：重复内容的 canonical 知识仍被有效审批引用"
          );
        }
        const deletion = appendLocalState(
          "delete",
          dedupCanonicalId,
          null,
          mergeVectors(currentVector(dedupCanonicalId), base)
        );
        base = mergeVectors(base, deletion.vector);
      }
    }
    if (kind === "delete" && activeApprovalForEntry(row.entity_id)) {
      throw apiError(
        409,
        "不能接受远端删除：该知识仍被有效审批引用；请先通过候选知识撤销审批"
      );
    }
    if (entry) entry = { ...entry, id: row.entity_id };
    const operation = appendLocalState(kind, row.entity_id, entry, base);
    statements.resolveConflict.run(new Date().toISOString(), operation.opId, id);
    scheduleSync();
    return { conflict: conflictFromRow(statements.findConflict.get(id)), operation };
  });
}

function isExtensionOrigin(origin) {
  return typeof origin === "string" &&
    /^(?:chrome|edge|moz)-extension:\/\/[a-z0-9@._-]{1,128}$/i.test(origin);
}

function allowedOrigin(origin) {
  return !origin || isExtensionOrigin(origin);
}

function tokenMatches(candidate) {
  const expectedDigest = crypto.createHash("sha256").update(AUTH_TOKEN).digest();
  const candidateDigest = crypto.createHash("sha256")
    .update(typeof candidate === "string" ? candidate : "")
    .digest();
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

function requestIsAuthorized(request) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "");
  return Boolean(match && tokenMatches(match[1]));
}

function persistPairedOrigins() {
  atomicWriteJson(PAIRED_ORIGINS_FILE, [...pairedOrigins].sort());
  try { fs.chmodSync(PAIRED_ORIGINS_FILE, 0o600); } catch {}
}

function createPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.randomBytes(8);
  const code = [...random].map(value => alphabet[value % alphabet.length]).join("");
  activePairing = {
    digest: crypto.createHash("sha256").update(code).digest(),
    expiresAt: Date.now() + PAIRING_TTL_MS,
    attempts: 0
  };
  return {
    code,
    expiresAt: new Date(activePairing.expiresAt).toISOString(),
    maxAttempts: PAIRING_MAX_ATTEMPTS
  };
}

function pairingRateAllowed(origin) {
  const now = Date.now();
  const recent = (pairingRate.get(origin) || [])
    .filter(timestamp => now - timestamp < PAIRING_RATE_WINDOW_MS);
  recent.push(now);
  pairingRate.set(origin, recent);
  return recent.length <= PAIRING_RATE_LIMIT;
}

function challengeRateAllowed(request) {
  const key = `${request.headers.origin || "native"}:${request.socket.remoteAddress || "loopback"}`;
  const now = Date.now();
  const recent = (challengeRate.get(key) || [])
    .filter(timestamp => now - timestamp < PAIRING_RATE_WINDOW_MS);
  recent.push(now);
  challengeRate.set(key, recent);
  return recent.length <= AUTH_CHALLENGE_RATE_LIMIT;
}

function createAuthChallenge(request, input) {
  if (!challengeRateAllowed(request)) {
    throw apiError(429, "身份验证请求过于频繁，请稍后再试");
  }
  if (input.protocol !== AUTH_CHALLENGE_PROTOCOL ||
      typeof input.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce)) {
    throw apiError(400, "身份验证随机数格式不正确");
  }
  const message = [
    AUTH_CHALLENGE_DOMAIN,
    String(AUTH_CHALLENGE_PROTOCOL),
    input.nonce
  ].join("\n");
  const proof = crypto.createHmac("sha256", AUTH_TOKEN)
    .update(message)
    .digest("hex");
  return {
    domain: AUTH_CHALLENGE_DOMAIN,
    protocol: AUTH_CHALLENGE_PROTOCOL,
    nonce: input.nonce,
    proof
  };
}

function exchangePairingCode(origin, input) {
  if (!pairingRateAllowed(origin)) {
    throw apiError(429, "配对尝试过于频繁，请稍后再试");
  }
  if (!activePairing || Date.now() >= activePairing.expiresAt) {
    activePairing = null;
    throw apiError(410, "配对码已过期，请在桌面伴侣中重新生成");
  }
  activePairing.attempts += 1;
  const supplied = String(input.code || "").trim().toUpperCase();
  const suppliedDigest = crypto.createHash("sha256").update(supplied).digest();
  const matched = crypto.timingSafeEqual(activePairing.digest, suppliedDigest);
  if (!matched) {
    const exhausted = activePairing.attempts >= PAIRING_MAX_ATTEMPTS;
    if (exhausted) activePairing = null;
    throw apiError(
      exhausted ? 429 : 401,
      exhausted ? "配对尝试次数已用完，请重新生成配对码" : "配对码不正确"
    );
  }
  activePairing = null;
  pairedOrigins.add(origin);
  persistPairedOrigins();
  return { token: AUTH_TOKEN };
}

function redactPath(value) {
  if (!value) return "";
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(value);
  const relative = path.relative(home, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join("<home>", relative);
  }
  return resolved;
}

function sanitizedError(value) {
  let text = String(value || "Unknown error");
  const home = os.homedir();
  if (home) text = text.split(home).join("<home>");
  text = text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>");
  return text.slice(0, 240);
}

function recordDiagnosticError(area, error) {
  recentErrors.unshift({
    at: new Date().toISOString(),
    area,
    summary: sanitizedError(error?.message || error)
  });
  recentErrors.length = Math.min(recentErrors.length, 10);
}

function diagnostics() {
  const status = syncStatus();
  return {
    app: {
      name: "AI Knowledge Inbox",
      version: APP_VERSION,
      build: BUILD_VERSION
    },
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version
    },
    storage: "sqlite",
    sync: {
      enabled: status.enabled,
      status: status.status,
      lastSyncAt: status.lastSyncAt,
      lastError: sanitizedError(status.lastError),
      degradedFileCount: status.degradedFiles.length
    },
    providers: {
      browserAI: "client-managed",
      ollama: "client-managed"
    },
    counts: {
      entries: Number(statements.entryCount.get().count),
      tombstones: Number(statements.tombstoneCount.get().count),
      operations: status.operationCount,
      conflicts: status.conflictCount,
      backups: listBackups().length
    },
    paths: {
      data: redactPath(DATA_DIR),
      database: redactPath(DB_PATH),
      sync: redactPath(SYNC_DIR),
      backups: redactPath(BACKUP_DIR)
    },
    recentErrors: [...recentErrors]
  };
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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
    "/agent-runs",
    "/backups/restore",
    "/pairing/exchange",
    "/auth/challenge"
  ].includes(pathname)) ||
    (method === "PUT" && /^\/entries\/[^/]+$/.test(pathname)) ||
    (method === "POST" && (
      /^\/sync\/conflicts\/[^/]+\/resolve$/.test(pathname) ||
      /^\/agent-runs\/[^/]+\/(?:start|complete|fail|cancel|proposals)$/.test(pathname) ||
      /^\/knowledge-proposals\/[^/]+\/(?:approve|reject|undo)$/.test(pathname)
    ));
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
  const authorized = requestIsAuthorized(request);
  if (request.method === "GET" && url.pathname === "/health" && !authorized) {
    sendJson(response, 200, {
      status: "ok",
      app: "AI Knowledge Inbox",
      version: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authRequired: true
    });
    return;
  }
  const pairingExchange =
    request.method === "POST" && url.pathname === "/pairing/exchange";
  const authChallenge =
    request.method === "POST" && url.pathname === "/auth/challenge";
  if (!pairingExchange && !authChallenge && !authorized) {
    response.setHeader("WWW-Authenticate", "Bearer");
    sendJson(response, 401, { error: "需要配对桌面伴侣" });
    return;
  }
  if (request.headers.origin && !pairingExchange && !authChallenge &&
      !pairedOrigins.has(request.headers.origin)) {
    sendJson(response, 403, { error: "扩展尚未与此桌面伴侣配对" });
    return;
  }
  if (pairingExchange && !isExtensionOrigin(request.headers.origin)) {
    sendJson(response, 403, { error: "配对交换仅允许浏览器扩展" });
    return;
  }
  const selfGated = request.method === "POST" && url.pathname === "/sync";
  let requestBody;
  let releaseGate;
  try {
    if (requestNeedsJson(request.method, url.pathname)) {
      requestBody = await readJson(request);
    }
    if (shuttingDown) throw apiError(503, "服务正在关闭");
    if (authChallenge) {
      sendJson(response, 200, createAuthChallenge(request, requestBody));
      return;
    }
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
        app: {
          name: "AI Knowledge Inbox",
          version: APP_VERSION,
          build: BUILD_VERSION
        },
        protocolVersion: PROTOCOL_VERSION,
        storage: "sqlite",
        database: DB_PATH,
        cloud: syncStatus()
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/pairing/code") {
      sendJson(response, 201, createPairingCode());
      return;
    }
    if (pairingExchange) {
      sendJson(response, 200, exchangePairingCode(request.headers.origin, requestBody));
      return;
    }
    if (request.method === "GET" && url.pathname === "/diagnostics") {
      sendJson(response, 200, diagnostics());
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
    if (request.method === "GET" && url.pathname === "/export") {
      sendJson(response, 200, {
        app: "AI Knowledge Inbox",
        version: 2,
        exportedAt: new Date().toISOString(),
        entries: statements.list.all().map(rowToEntry),
        agentLedger: exportAgentLedger()
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/entries") {
      rejectProtectedEntryFields(requestBody);
      sendJson(response, 201, { entry: createEntry(requestBody) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/import") {
      if (!Array.isArray(requestBody.entries)) throw apiError(400, "entries 必须是数组");
      const ledger = requestBody.agentLedger === undefined
        ? null
        : normalizeAgentLedger(requestBody.agentLedger);
      validateImportedEntryAssertions(requestBody.entries, ledger);
      let imported = 0;
      let duplicates = 0;
      let ledgerImported = { runs: 0, proposals: 0, audit: 0 };
      runTransaction(() => {
        for (const item of requestBody.entries) {
          try {
            const existingRow = item && typeof item.id === "string"
              ? statements.find.get(item.id)
              : null;
            if (existingRow) {
              const existing = rowToEntry(existingRow);
              const incoming = normalizeInput(item, item, "trusted");
              const sharedCanonical = item.id.startsWith("agent-content-") &&
                existing.content === incoming.content &&
                existing.title === incoming.title;
              if (!sharedCanonical && (
                  existing.content !== incoming.content ||
                  existing.title !== incoming.title ||
                  existing.status !== incoming.status ||
                  canonicalJson(existing.provenance) !== canonicalJson(incoming.provenance)
                )) {
                const conflict = apiError(409, `知识 ${item.id} 的不可变导入内容冲突`);
                conflict.importConflict = true;
                throw conflict;
              }
              duplicates += 1;
              continue;
            }
            createEntry(item, item, {
              trustedLifecycle: true,
              inTransaction: true
            });
            imported += 1;
          } catch (error) {
            if (error.status === 409 && !error.importConflict) duplicates += 1;
            else throw error;
          }
        }
        if (ledger) {
          ledgerImported = importAgentLedger(ledger, {
            normalized: true,
            inTransaction: true
          });
        }
      });
      sendJson(response, 200, { imported, duplicates, agentLedger: ledgerImported });
      return;
    }
    if (request.method === "GET" && url.pathname === "/agent-runs") {
      sendJson(response, 200, {
        runs: statements.listAgentRuns.all().map(rowToAgentRun)
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/agent-runs") {
      sendJson(response, 201, { run: createAgentRun(requestBody) });
      return;
    }
    const agentRunMatch = url.pathname.match(/^\/agent-runs\/([^/]+)$/);
    const agentActionMatch = url.pathname.match(
      /^\/agent-runs\/([^/]+)\/(start|complete|fail|cancel)$/
    );
    const runProposalsMatch = url.pathname.match(/^\/agent-runs\/([^/]+)\/proposals$/);
    if (request.method === "GET" && agentRunMatch) {
      const run = statements.findAgentRun.get(decodeURIComponent(agentRunMatch[1]));
      if (!run) throw apiError(404, "Agent 运行不存在");
      sendJson(response, 200, { run: rowToAgentRun(run) });
      return;
    }
    if (request.method === "POST" && agentActionMatch) {
      sendJson(response, 200, {
        run: transitionAgentRun(
          decodeURIComponent(agentActionMatch[1]),
          agentActionMatch[2],
          requestBody
        )
      });
      return;
    }
    if (request.method === "GET" && runProposalsMatch) {
      const runId = decodeURIComponent(runProposalsMatch[1]);
      if (!statements.findAgentRun.get(runId)) throw apiError(404, "Agent 运行不存在");
      sendJson(response, 200, {
        proposals: statements.listProposals.all(runId).map(rowToProposal)
      });
      return;
    }
    if (request.method === "POST" && runProposalsMatch) {
      sendJson(response, 201, {
        proposal: createProposal(
          decodeURIComponent(runProposalsMatch[1]),
          requestBody
        )
      });
      return;
    }
    const proposalActionMatch = url.pathname.match(
      /^\/knowledge-proposals\/([^/]+)\/(approve|reject|undo)$/
    );
    if (request.method === "POST" && proposalActionMatch) {
      const id = decodeURIComponent(proposalActionMatch[1]);
      const action = proposalActionMatch[2];
      const result = action === "approve"
        ? approveProposal(id, requestBody)
        : action === "reject"
          ? { proposal: rejectProposal(id, requestBody) }
          : undoProposal(id, requestBody);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
        throw apiError(400, "limit 必须在 1 到 500 之间");
      }
      sendJson(response, 200, {
        events: statements.listAudit.all().slice(0, requestedLimit).map(rowToAudit)
      });
      return;
    }

    const entryMatch = url.pathname.match(/^\/entries\/([^/]+)$/);
    const viewMatch = url.pathname.match(/^\/entries\/([^/]+)\/view$/);
    if (request.method === "PUT" && entryMatch) {
      rejectProtectedEntryFields(requestBody);
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
    if (status >= 500) {
      recordDiagnosticError("request", error);
      console.error(error);
    }
    sendJson(response, status, {
      error: error.message || "服务内部错误",
      ...(error.code ? { code: error.code } : {})
    });
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
