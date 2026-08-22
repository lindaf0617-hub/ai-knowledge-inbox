"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const HOST = "127.0.0.1";
const PORT = 43127;
const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "AIKnowledgeInbox"
);
const DB_PATH = path.join(DATA_DIR, "knowledge.db");
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
const DEVICE_FILE = path.join(DATA_DIR, "device-id.txt");
const MAX_BODY_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const DEVICE_ID = fs.existsSync(DEVICE_FILE)
  ? fs.readFileSync(DEVICE_FILE, "utf8").trim()
  : crypto.randomUUID();
if (!fs.existsSync(DEVICE_FILE)) fs.writeFileSync(DEVICE_FILE, DEVICE_ID, "utf8");
fs.writeFileSync(SERVER_PID_FILE, String(process.pid), "ascii");

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS entries (
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
  CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
  CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  );
`);

const statements = {
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
    WHERE excluded.deleted_at > tombstones.deleted_at
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
  `)
};

const syncState = {
  enabled: Boolean(SYNC_FILE),
  path: SYNC_FILE,
  status: SYNC_FILE ? "idle" : "disabled",
  lastSyncAt: "",
  lastError: "",
  timer: null,
  running: null
};

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

function entryModifiedAt(entry) {
  return entry.updatedAt || entry.createdAt || "";
}

function replaceEntry(entry) {
  const normalized = normalizeInput(entry, entry);
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

function createEntry(input, preserve = {}) {
  const entry = normalizeInput(input);
  const key = contentKey(entry.content);
  const duplicate = statements.findByContent.get(key);
  if (duplicate) throw apiError(409, `这段内容已经保存过：${duplicate.title}`);

  const createdAt = preserve.createdAt || new Date().toISOString();
  const id = preserve.id || crypto.randomUUID();
  statements.insert.run(
    id,
    entry.title,
    entry.content,
    key,
    entry.source,
    entry.project,
    JSON.stringify(entry.tags),
    entry.summary,
    createdAt,
    preserve.updatedAt || "",
    Number.isInteger(preserve.viewCount) ? preserve.viewCount : 0,
    preserve.lastViewedAt || ""
  );
  statements.removeTombstone.run(id);
  scheduleSync();
  return rowToEntry(statements.find.get(id));
}

function updateEntry(id, input) {
  const currentRow = statements.find.get(id);
  if (!currentRow) throw apiError(404, "知识不存在");
  const current = rowToEntry(currentRow);
  const entry = normalizeInput(input, current);
  const key = contentKey(entry.content);
  const duplicate = statements.findByContent.get(key);
  if (duplicate && duplicate.id !== id) {
    throw apiError(409, `这段内容已经保存过：${duplicate.title}`);
  }
  const updatedAt = new Date().toISOString();
  statements.update.run(
    entry.title,
    entry.content,
    key,
    entry.source,
    entry.project,
    JSON.stringify(entry.tags),
    entry.summary,
    updatedAt,
    id
  );
  scheduleSync();
  return rowToEntry(statements.find.get(id));
}

function syncStatus() {
  return {
    enabled: syncState.enabled,
    status: syncState.status,
    path: syncState.path,
    lastSyncAt: syncState.lastSyncAt,
    lastError: syncState.lastError,
    deviceId: DEVICE_ID
  };
}

function readRemoteSnapshot() {
  if (!fs.existsSync(SYNC_FILE)) return { entries: [], tombstones: [] };
  const contents = fs.readFileSync(SYNC_FILE, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(contents);
  if (!parsed || parsed.version !== 1 ||
      !Array.isArray(parsed.entries) || !Array.isArray(parsed.tombstones)) {
    throw new Error("OneDrive 同步文件格式不正确");
  }
  return parsed;
}

function mergeRemoteSnapshot(snapshot) {
  const remoteTombstones = snapshot.tombstones
    .filter(item => item && typeof item.id === "string" && typeof item.deletedAt === "string");

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const tombstone of remoteTombstones) {
      const localRow = statements.find.get(tombstone.id);
      if (localRow) {
        const localEntry = rowToEntry(localRow);
        if (tombstone.deletedAt >= entryModifiedAt(localEntry)) {
          statements.remove.run(tombstone.id);
        }
      }
      statements.upsertTombstone.run(tombstone.id, tombstone.deletedAt);
    }

    for (const rawEntry of snapshot.entries) {
      if (!isValidSyncEntry(rawEntry)) continue;
      const remote = {
        ...rawEntry,
        tags: normalizeTags(rawEntry.tags),
        summary: String(rawEntry.summary || ""),
        updatedAt: String(rawEntry.updatedAt || ""),
        viewCount: Number.isInteger(rawEntry.viewCount) ? rawEntry.viewCount : 0,
        lastViewedAt: String(rawEntry.lastViewedAt || "")
      };
      const tombstone = statements.findTombstone.get(remote.id);
      if (tombstone && tombstone.deleted_at >= entryModifiedAt(remote)) continue;

      const localRow = statements.find.get(remote.id);
      if (!localRow) {
        const duplicate = statements.findByContent.get(contentKey(remote.content));
        if (!duplicate) replaceEntry(remote);
        continue;
      }

      const local = rowToEntry(localRow);
      if (entryModifiedAt(remote) > entryModifiedAt(local)) {
        const duplicate = statements.findByContent.get(contentKey(remote.content));
        if (!duplicate || duplicate.id === remote.id) replaceEntry(remote);
      } else if (entryModifiedAt(remote) === entryModifiedAt(local) &&
                 (remote.viewCount > local.viewCount ||
                  remote.lastViewedAt > local.lastViewedAt)) {
        replaceEntry({
          ...local,
          viewCount: Math.max(local.viewCount, remote.viewCount),
          lastViewedAt: [local.lastViewedAt, remote.lastViewedAt].sort().pop()
        });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isValidSyncEntry(entry) {
  return entry &&
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.content === "string" &&
    typeof entry.createdAt === "string";
}

function writeSnapshot() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const snapshot = {
    version: 1,
    deviceId: DEVICE_ID,
    syncedAt: new Date().toISOString(),
    entries: statements.list.all().map(rowToEntry),
    tombstones: statements.listTombstones.all().map(item => ({
      id: item.id,
      deletedAt: item.deleted_at
    }))
  };
  const temporary = `${SYNC_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), "utf8");
  fs.copyFileSync(temporary, SYNC_FILE);
  fs.rmSync(temporary, { force: true });
}

async function syncNow() {
  if (!SYNC_FILE) {
    syncState.status = "disabled";
    syncState.lastError = "未检测到 OneDrive 同步目录";
    return syncStatus();
  }
  if (syncState.running) return syncState.running;

  syncState.running = Promise.resolve().then(() => {
    syncState.status = "syncing";
    syncState.lastError = "";
    const remote = readRemoteSnapshot();
    mergeRemoteSnapshot(remote);
    writeSnapshot();
    syncState.lastSyncAt = new Date().toISOString();
    syncState.status = "synced";
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
  if (!SYNC_FILE) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => {
    syncNow().catch(error => console.error("OneDrive sync failed:", error.message));
  }, delay);
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
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw apiError(413, "请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError(400, "JSON 格式不正确");
  }
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
  try {
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
    if (request.method === "GET" && url.pathname === "/entries") {
      sendJson(response, 200, { entries: statements.list.all().map(rowToEntry) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/entries") {
      sendJson(response, 201, { entry: createEntry(await readJson(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/import") {
      const body = await readJson(request);
      if (!Array.isArray(body.entries)) throw apiError(400, "entries 必须是数组");
      let imported = 0;
      let duplicates = 0;
      for (const item of body.entries) {
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
        entry: updateEntry(decodeURIComponent(entryMatch[1]), await readJson(request))
      });
      return;
    }
    if (request.method === "DELETE" && entryMatch) {
      const id = decodeURIComponent(entryMatch[1]);
      const result = statements.remove.run(id);
      if (!result.changes) throw apiError(404, "知识不存在");
      statements.upsertTombstone.run(id, new Date().toISOString());
      scheduleSync();
      sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && viewMatch) {
      const id = decodeURIComponent(viewMatch[1]);
      const result = statements.recordView.run(new Date().toISOString(), id);
      if (!result.changes) throw apiError(404, "知识不存在");
      scheduleSync();
      sendJson(response, 200, { entry: rowToEntry(statements.find.get(id)) });
      return;
    }
    sendJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    sendJson(response, status, { error: error.message || "服务内部错误" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Knowledge service listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  if (SYNC_FILE) {
    console.log(`OneDrive sync file: ${SYNC_FILE}`);
    scheduleSync(100);
  } else {
    console.log("OneDrive sync disabled: no OneDrive folder detected");
  }
});

setInterval(() => {
  syncNow().catch(error => console.error("Periodic OneDrive sync failed:", error.message));
}, 60_000).unref();

function close() {
  clearTimeout(syncState.timer);
  server.close(() => {
    db.close();
    fs.rmSync(SERVER_PID_FILE, { force: true });
    process.exit(0);
  });
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
process.on("exit", () => fs.rmSync(SERVER_PID_FILE, { force: true }));
