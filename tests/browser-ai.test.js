"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const browserAiSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "browser-ai.js"),
  "utf8"
);

function loadBrowserAI(globals) {
  const context = {
    ProviderCore: {
      buildAnswerRequest() {
        return {
          systemPrompt: "trusted system instruction",
          userPrompt: "bounded user prompt"
        };
      }
    },
    ...globals
  };
  vm.createContext(context);
  vm.runInContext(
    `${browserAiSource}\nglobalThis.__browserAI = BrowserAI;`,
    context
  );
  return context.__browserAI;
}

function modelRecorder(answer = "Grounded answer [K1]") {
  const calls = [];
  const model = {
    async availability() {
      return "available";
    },
    async create(options) {
      calls.push(options);
      return {
        async prompt() {
          return answer;
        },
        destroy() {}
      };
    }
  };
  return { calls, model };
}

const sources = [{
  title: "Source",
  content: "Evidence",
  project: "",
  tags: [],
  createdAt: "2026-08-22"
}];

test("modern LanguageModel uses initialPrompts system message", async () => {
  const modern = modelRecorder();
  const legacy = modelRecorder();
  const browserAI = loadBrowserAI({
    LanguageModel: modern.model,
    ai: { languageModel: legacy.model }
  });

  await browserAI.answer("question", sources, "synthesize", "en");

  assert.deepEqual(
    JSON.parse(JSON.stringify(modern.calls[0])),
    {
      initialPrompts: [{
        role: "system",
        content: "trusted system instruction"
      }]
    }
  );
  assert.equal(Object.hasOwn(modern.calls[0], "systemPrompt"), false);
  assert.equal(legacy.calls.length, 0);
});

test("legacy ai.languageModel retains systemPrompt option", async () => {
  const legacy = modelRecorder();
  const browserAI = loadBrowserAI({ ai: { languageModel: legacy.model } });

  await browserAI.answer("question", sources, "synthesize", "en");

  assert.deepEqual(
    JSON.parse(JSON.stringify(legacy.calls[0])),
    { systemPrompt: "trusted system instruction" }
  );
  assert.equal(Object.hasOwn(legacy.calls[0], "initialPrompts"), false);
});
