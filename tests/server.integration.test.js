"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const port = 43271;
const base = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-knowledge-inbox-"));
const dataDir = path.join(root, "data");
const oneDrive = path.join(root, "onedrive");
const syncFile = path.join(oneDrive, "Apps", "AI Knowledge Inbox", "knowledge-sync.json");
let child;

async function waitForService() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Service did not start");
}

async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { body, response };
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "desktop", "server.js")], {
    env: {
      ...process.env,
      AI_KNOWLEDGE_DATA_DIR: dataDir,
      AI_KNOWLEDGE_ONEDRIVE: oneDrive,
      AI_KNOWLEDGE_PORT: String(port)
    },
    stdio: "ignore"
  });
  await waitForService();
});

test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await Promise.race([
      exited,
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== "EPERM" || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
});

test("health reports isolated SQLite and sync paths", async () => {
  const { body, response } = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.storage, "sqlite");
  assert.equal(body.cloud.enabled, true);
});

test("CRUD, duplicate prevention, and view tracking work", async () => {
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

test("OneDrive sync imports remote entries and propagates deletion tombstones", async () => {
  await request("/sync", { method: "POST" });
  assert.equal(fs.existsSync(syncFile), true);
  const snapshot = JSON.parse(fs.readFileSync(syncFile, "utf8"));
  const remoteId = crypto.randomUUID();
  snapshot.entries.push({
    id: remoteId,
    title: "Remote entry",
    content: "Unique remote integration content",
    source: "",
    project: "Remote",
    tags: ["Cloud"],
    summary: "",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    viewCount: 0,
    lastViewedAt: ""
  });
  fs.writeFileSync(syncFile, JSON.stringify(snapshot, null, 2));
  await request("/sync", { method: "POST" });

  const listed = await request("/entries");
  assert.ok(listed.body.entries.some(entry => entry.id === remoteId));

  const removed = await request(`/entries/${remoteId}`, { method: "DELETE" });
  assert.equal(removed.response.status, 200);
  await request("/sync", { method: "POST" });
  const after = JSON.parse(fs.readFileSync(syncFile, "utf8"));
  assert.equal(after.entries.some(entry => entry.id === remoteId), false);
  assert.equal(after.tombstones.some(entry => entry.id === remoteId), true);
});

test("normal web origins cannot access the service", async () => {
  const { response } = await request("/entries", {
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(response.status, 403);
});
