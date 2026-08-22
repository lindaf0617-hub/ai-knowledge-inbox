"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "storage.js"),
  "utf8"
);

function createStore({ entries = [], fetchImpl }) {
  const local = { entries };
  const context = {
    AbortController,
    Array,
    Date,
    Error,
    Intl,
    JSON,
    Map,
    RegExp,
    Set,
    String,
    URL,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: fetchImpl,
    setTimeout,
    chrome: {
      storage: {
        local: {
          get: async defaults => ({ ...defaults, ...local }),
          set: async values => Object.assign(local, values)
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__store = KnowledgeStore;`, context);
  return { local, store: context.__store };
}

test("storage falls back locally when desktop service is unavailable", async () => {
  const { local, store } = createStore({
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const created = await store.addEntry({
    title: "Offline",
    content: "Local fallback content"
  });
  assert.equal(store.currentBackend(), "local");
  assert.equal(local.entries.length, 1);
  assert.equal(created.title, "Offline");
});

test("storage blocks duplicate local content", async () => {
  const { store } = createStore({
    fetchImpl: async () => { throw new Error("offline"); }
  });
  await store.addEntry({ content: "Same content" });
  await assert.rejects(
    store.addEntry({ content: " same   content " }),
    /已经保存过/
  );
});

test("storage migrates browser-local entries into shared service", async () => {
  const calls = [];
  const existing = {
    id: "local-1",
    title: "Existing",
    content: "Existing browser knowledge",
    createdAt: new Date().toISOString()
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/import")) {
      return new Response(JSON.stringify({ imported: 1, duplicates: 0 }), { status: 200 });
    }
    if (url.endsWith("/entries")) {
      return new Response(JSON.stringify({ entries: [existing] }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { local, store } = createStore({ entries: [existing], fetchImpl });
  const entries = await store.getEntries();
  assert.equal(store.currentBackend(), "server");
  assert.equal(entries.length, 1);
  assert.equal(local.entries.length, 0);
  assert.ok(calls.some(call => call.url.endsWith("/import")));
});
