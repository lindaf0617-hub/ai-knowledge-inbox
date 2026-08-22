"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createHmac, webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "storage.js"),
  "utf8"
);

function createStore({ entries = [], token = "", fetchImpl }) {
  const local = { entries, desktopApiToken: token };
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
    TextEncoder,
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

function challengeResponse(token, options) {
  const input = JSON.parse(options.body);
  const domain = "AIKnowledgeInbox.LocalAPI.AuthChallenge";
  const proof = createHmac("sha256", token)
    .update(`${domain}\n1\n${input.nonce}`)
    .digest("hex");
  return new Response(JSON.stringify({
    domain,
    protocol: 1,
    nonce: input.nonce,
    proof
  }), { status: 200 });
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
    if (url.endsWith("/auth/challenge")) {
      return challengeResponse("paired-token", options);
    }
    if (url.endsWith("/import")) {
      return new Response(JSON.stringify({ imported: 1, duplicates: 0 }), { status: 200 });
    }
    if (url.endsWith("/entries")) {
      return new Response(JSON.stringify({ entries: [existing] }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { local, store } = createStore({
    entries: [existing],
    token: "paired-token",
    fetchImpl
  });
  const entries = await store.getEntries();
  assert.equal(store.currentBackend(), "server");
  assert.equal(entries.length, 1);
  assert.equal(local.entries.length, 0);
  assert.ok(calls.some(call => call.url.endsWith("/import")));
  assert.ok(calls.filter(call => !call.url.endsWith("/auth/challenge")).every(call =>
    call.options.headers.Authorization === "Bearer paired-token"
  ));
  assert.equal(calls.filter(call => call.url.endsWith("/auth/challenge")).length, 1);
});

test("storage treats 401 as pairing-required and preserves browser-local data", async () => {
  const existing = {
    id: "local-preserved",
    title: "Keep me",
    content: "Must remain until authenticated migration",
    createdAt: new Date().toISOString()
  };
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "需要配对桌面伴侣" }), { status: 401 });
  const { local, store } = createStore({ entries: [existing], fetchImpl });

  const visible = await store.getEntries();
  assert.equal(visible.length, 1);
  assert.equal(store.currentBackend(), "pairing");
  await assert.rejects(
    store.addEntry({ title: "Blocked", content: "Do not save as fallback" }),
    /配对/
  );
  assert.equal(local.entries.length, 1);
  assert.equal(local.entries[0].id, existing.id);
});

test("minimal unauthenticated health response prompts pairing for a new install", async () => {
  const fetchImpl = async url => {
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({
        status: "ok",
        app: "AI Knowledge Inbox",
        authRequired: true
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { store } = createStore({ fetchImpl });
  assert.equal(await store.getBackendStatus(), "pairing");
});

test("successful pairing stores the token before authenticated migration", async () => {
  const calls = [];
  const existing = {
    id: "pair-migrate",
    title: "Pair migration",
    content: "Migrate only after pairing",
    createdAt: new Date().toISOString()
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/pairing/exchange")) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(JSON.stringify({ token: "new-install-token" }), { status: 200 });
    }
    if (url.endsWith("/auth/challenge")) {
      return challengeResponse("new-install-token", options);
    }
    if (url.endsWith("/import")) {
      assert.equal(options.headers.Authorization, "Bearer new-install-token");
      return new Response(JSON.stringify({ imported: 1, duplicates: 0 }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { local, store } = createStore({ entries: [existing], fetchImpl });
  await store.pairDesktop("ABCDEFGH");
  assert.equal(local.desktopApiToken, "new-install-token");
  assert.equal(local.entries.length, 0);
  assert.ok(calls.some(call => call.url.endsWith("/import")));
});

test("spoofed challenge never receives authorization or knowledge payloads", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/challenge")) {
      const input = JSON.parse(options.body);
      return new Response(JSON.stringify({
        domain: "AIKnowledgeInbox.LocalAPI.AuthChallenge",
        protocol: 1,
        nonce: input.nonce,
        proof: "0".repeat(64)
      }), { status: 200 });
    }
    throw new Error("Authenticated endpoint must not be called");
  };
  const { local, store } = createStore({ token: "real-install-token", fetchImpl });
  await assert.rejects(
    store.addEntry({ title: "Secret", content: "NEVER-SEND-THIS-CONTENT" }),
    error => error.serviceIdentityMismatch === true
  );
  assert.equal(store.currentBackend(), "security");
  assert.equal(local.entries.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.body.includes("NEVER-SEND-THIS-CONTENT"), false);
});

test("pairing verifies service identity before migration", async () => {
  const existing = {
    id: "not-migrated",
    title: "Private",
    content: "Remain browser local",
    createdAt: new Date().toISOString()
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/pairing/exchange")) {
      return new Response(JSON.stringify({ token: "attacker-token" }), { status: 200 });
    }
    if (url.endsWith("/auth/challenge")) {
      const input = JSON.parse(options.body);
      return new Response(JSON.stringify({
        domain: "AIKnowledgeInbox.LocalAPI.AuthChallenge",
        protocol: 1,
        nonce: input.nonce,
        proof: "f".repeat(64)
      }), { status: 200 });
    }
    throw new Error("Migration must not run");
  };
  const { local, store } = createStore({ entries: [existing], fetchImpl });
  await assert.rejects(
    store.pairDesktop("ABCDEFGH"),
    error => error.serviceIdentityMismatch === true
  );
  assert.equal(local.desktopApiToken, "");
  assert.equal(local.entries.length, 1);
  assert.equal(calls.some(call => call.url.endsWith("/import")), false);
});
