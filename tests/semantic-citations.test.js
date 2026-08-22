"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadGlobal(file, name) {
  const context = {
    Float32Array,
    Math,
    Number,
    RegExp,
    Set,
    String
  };
  vm.createContext(context);
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(`${source}\nglobalThis.__value = ${name};`, context);
  return context.__value;
}

const extension = path.join(__dirname, "..", "extension");
const semantic = loadGlobal(path.join(extension, "semantic.js"), "SemanticSearch");
const citations = loadGlobal(path.join(extension, "citations.js"), "CitationGuard");

test("semantic search links English security concepts to Chinese knowledge", () => {
  const security = {
    title: "零信任防护方案",
    content: "网络安全、身份权限与漏洞防护",
    project: "安全",
    tags: ["安全"],
    summary: ""
  };
  const writing = {
    title: "营销文案",
    content: "生成文章和社交媒体内容",
    project: "内容",
    tags: ["写作"],
    summary: ""
  };
  assert.ok(
    semantic.similarity("cyber protection", security) >
      semantic.similarity("cyber protection", writing)
  );
});

test("citation guard accepts valid source IDs", () => {
  const result = citations.validate(
    "Use zero trust and least privilege. [K1]\n\nAdd an approval workflow. [K2]",
    2
  );
  assert.equal(result.valid, true);
  assert.deepEqual([...result.invalid], []);
  assert.deepEqual([...result.cited], [1, 2]);
});

test("citation guard rejects invented source IDs", () => {
  const result = citations.validate("Unsupported claim. [K9]", 2);
  assert.equal(result.valid, false);
  assert.deepEqual([...result.invalid], [9]);
});

test("citation guard flags long uncited paragraphs", () => {
  const result = citations.validate(
    "This paragraph makes a substantial factual claim but does not include any supporting source citation.",
    1
  );
  assert.equal(result.uncited.length, 1);
});
