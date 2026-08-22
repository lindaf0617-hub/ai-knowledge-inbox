"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "retrieval.js"),
  "utf8"
);
const context = {};
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.__value = RetrievalGrounding;`, context);
const retrieval = context.__value;

function entry(overrides = {}) {
  return {
    title: "Agent security plan",
    project: "Security",
    tags: ["agent", "zero-trust"],
    summary: "",
    content: "Before deployment, apply least privilege and review every tool permission.",
    createdAt: "2026-08-20T00:00:00Z",
    ...overrides
  };
}

test("retrieval preserves normalized scores and matching excerpts", () => {
  const results = retrieval.retrieve(
    "least privilege",
    [entry()],
    () => 0.8
  );
  assert.equal(results.length, 1);
  assert.ok(results[0].score >= 0 && results[0].score <= 1);
  assert.match(results[0].excerpt, /least privilege/);
});

test("excerpt is exact source text around a late query term", () => {
  const content = `${"intro ".repeat(80)}MATCHING PHRASE${" tail".repeat(80)}`;
  const result = retrieval.excerpt(
    "matching phrase",
    entry({ content }),
    120
  );
  assert.match(result, /MATCHING PHRASE/);
  assert.ok(result.startsWith("…"));
  assert.ok(result.endsWith("…"));
});

test("highlight segments identify query text without changing it", () => {
  const segments = retrieval.highlightSegments("Use Least Privilege now.", "least privilege");
  assert.deepEqual(
    JSON.parse(JSON.stringify(segments.filter(item => item.match).map(item => item.text))),
    ["Least", "Privilege"]
  );
  assert.equal(segments.map(item => item.text).join(""), "Use Least Privilege now.");
});

test("normalized retrieval score is bounded", () => {
  assert.equal(retrieval.normalizeScore(-1, -5), 0);
  assert.equal(retrieval.normalizeScore(4, 100), 1);
});

test("retrieval truncates overlong questions before similarity", () => {
  const observed = [];
  retrieval.retrieve(
    `security ${"x".repeat(retrieval.MAX_QUERY_LENGTH * 2)}`,
    [entry()],
    question => {
      observed.push(question);
      return 0.5;
    }
  );
  assert.equal(observed.length, 1);
  assert.equal(observed[0].length, retrieval.MAX_QUERY_LENGTH);
});

test("Chinese bigram expansion stays bounded", () => {
  const question = "知识安全".repeat(retrieval.MAX_QUERY_LENGTH);
  const terms = retrieval.queryTerms(question);
  assert.ok(terms.length <= retrieval.MAX_QUERY_TERMS);
  assert.ok(terms.every(term => term.length <= retrieval.MAX_QUERY_LENGTH));
  assert.equal(retrieval.normalizeQuery(question).length, retrieval.MAX_QUERY_LENGTH);
});
