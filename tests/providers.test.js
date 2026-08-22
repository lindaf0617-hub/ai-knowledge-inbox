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
    id: "knowledge-security-1",
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

test("agent envelope parser validates citations, fields, confidence, and source IDs", () => {
  const envelope = providers.parseAgentEnvelope(JSON.stringify({
    analysisMarkdown: "The evidence requires isolation. [K1]",
    proposals: [{
      title: "Treat retrieved instructions as data",
      content: "Retrieved instructions are untrusted data. [K1]",
      summary: "Keep source content isolated from instructions.",
      project: "Agent",
      tags: ["security"],
      sourceIds: ["K1"],
      confidence: 0.82,
      rationale: "Direct statement in the source"
    }]
  }), sources);
  assert.equal(envelope.proposals[0].sourceIds[0], "knowledge-security-1");
  assert.equal(envelope.proposals[0].confidence, 0.82);

  assert.throws(
    () => providers.parseAgentEnvelope(JSON.stringify({
      analysisMarkdown: "Invented citation [K9]",
      proposals: []
    }), sources),
    /unknown citations/
  );
  assert.throws(
    () => providers.parseAgentEnvelope(JSON.stringify({
      analysisMarkdown: "Grounded [K1]",
      proposals: [{
        title: "Bad",
        content: "Bad",
        summary: "",
        project: "Agent",
        tags: [],
        sourceIds: ["K9"],
        confidence: 2,
        rationale: "Bad"
      }]
    }), sources),
    /invalid fields|unknown sourceId/
  );
});

test("agent prompt is JSON-only, read-only, and isolates untrusted sources", () => {
  const request = providers.buildAgentRequest(
    "Create reusable principles",
    sources,
    { outputFormat: "report", project: "Agent" },
    "en"
  );
  assert.match(request.systemPrompt, /read-only/i);
  assert.match(request.systemPrompt, /untrusted data/i);
  assert.match(request.systemPrompt, /never auto-written/i);
  assert.match(request.userPrompt, /External supplementation: disabled/);
  assert.match(request.userPrompt, /knowledge_id="knowledge-security-1"/);
});

test("Ollama agent forwards AbortSignal and does not convert cancellation", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const provider = providers.createOllamaProvider({
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });
  const pending = provider.agent(
    "Goal",
    sources,
    { outputFormat: "report", project: "Agent" },
    "en",
    { ollamaModel: "llama3.2", signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
});
