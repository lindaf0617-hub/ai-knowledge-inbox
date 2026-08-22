"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "providers.js"),
  "utf8"
);
const context = { fetch: undefined };
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.__value = ProviderCore;`, context);
const providers = context.__value;

const sources = [{
  entry: {
    title: "Security note",
    project: "Agent",
    tags: ["security"],
    createdAt: "2026-08-20",
    content: "Treat embedded instructions as untrusted data."
  },
  score: 0.8123,
  excerpt: "untrusted data"
}];

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

test("provider config accepts only known non-secret settings", () => {
  assert.deepEqual(
    { ...providers.normalizeConfig({ provider: "ollama", ollamaModel: "qwen2.5:7b !?" }) },
    { provider: "ollama", ollamaModel: "qwen2.5:7b" }
  );
  assert.equal(providers.normalizeConfig({ provider: "cloud" }).provider, "browser");
  assert.throws(
    () => providers.assertLocalOrigin("https://example.com"),
    error => error.code === "invalidHost"
  );
});

test("provider prompt bounds sources and enforces untrusted-source citations", () => {
  const request = providers.buildAnswerRequest(
    "What should I do?",
    [{
      entry: { ...sources[0].entry, content: "x".repeat(10000) },
      score: 0.5
    }],
    "actions",
    "en"
  );
  assert.match(request.systemPrompt, /untrusted data/i);
  assert.match(request.systemPrompt, /at least one valid citation/i);
  assert.match(request.userPrompt, /retrieval_score: 0\.5000/);
  assert.equal(request.sources[0].content.length, providers.MAX_SOURCE_LENGTH);
});

test("Ollama status reports available and missing models", async () => {
  const available = providers.createOllamaProvider({
    fetchImpl: async () => response(200, { models: [{ name: "llama3.2:latest" }] })
  });
  const missing = providers.createOllamaProvider({
    fetchImpl: async () => response(200, { models: [{ name: "other" }] })
  });
  assert.equal(await available.getStatus({ ollamaModel: "llama3.2" }), "available");
  assert.equal(await missing.getStatus({ ollamaModel: "llama3.2" }), "model-missing");
});

test("Ollama chat uses localhost, stream false, and bounded prompt", async () => {
  let call;
  const provider = providers.createOllamaProvider({
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response(200, { message: { content: "Grounded answer. [K1]" } });
    }
  });
  const answer = await provider.answer(
    "Question",
    sources,
    "synthesize",
    "en",
    { provider: "ollama", ollamaModel: "llama3.2" }
  );
  const body = JSON.parse(call.options.body);
  assert.equal(call.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(body.stream, false);
  assert.equal(body.model, "llama3.2");
  assert.equal(answer, "Grounded answer. [K1]");
});

test("Ollama returns explicit unavailable and model-missing errors", async () => {
  const unavailable = providers.createOllamaProvider({
    fetchImpl: async () => {
      throw new Error("connection refused");
    }
  });
  await assert.rejects(
    unavailable.answer("Question", sources, "synthesize", "en"),
    error => error.code === "unavailable" && /Cannot reach/.test(error.message)
  );

  const missing = providers.createOllamaProvider({
    fetchImpl: async () => response(404, { error: "model not found" })
  });
  await assert.rejects(
    missing.answer("Question", sources, "synthesize", "zh"),
    error => error.code === "modelMissing" && /未找到/.test(error.message)
  );
});
