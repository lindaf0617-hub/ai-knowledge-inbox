"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "update.js"), "utf8");
const context = { URL };
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.__updates = UpdateCore;`, context);
const updates = context.__updates;

test("semantic versions compare release and prerelease identifiers", () => {
  assert.equal(updates.compareSemver("1.6.0", "1.5.9") > 0, true);
  assert.equal(updates.compareSemver("1.6.0-beta.2", "1.6.0-beta.10") < 0, true);
  assert.equal(updates.compareSemver("1.6.0", "1.6.0-rc.1") > 0, true);
  assert.equal(updates.parseSemver("1.06.0"), null);
  assert.equal(updates.parseSemver("1.6.0-beta.01"), null);
  assert.equal(updates.compareSemver("1.0.0-Z", "1.0.0-a") < 0, true);
  assert.equal(updates.compareSemver("1.0.0-9", "1.0.0-Z") < 0, true);
  assert.equal(
    updates.compareSemver("1.0.0-99999999999999999999", "1.0.0-100000000000000000000") < 0,
    true
  );
});

test("release channel excludes prereleases unless opted in", () => {
  const releases = [
    { tag_name: "v1.7.0-beta.1", prerelease: true, draft: false, html_url: "https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.7.0-beta.1" },
    { tag_name: "v1.6.1", prerelease: false, draft: false, html_url: "https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.6.1" },
    { tag_name: "v9.0.0", prerelease: false, draft: true, html_url: "https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v9.0.0" }
  ];
  assert.equal(updates.selectLatestRelease(releases, "1.6.0", "stable").release.version, "1.6.1");
  assert.equal(
    updates.selectLatestRelease(releases, "1.6.0", "prerelease").release.version,
    "1.7.0-beta.1"
  );
  assert.equal(updates.normalizeChannel("other"), "stable");
  assert.equal(updates.safeReleaseUrl("javascript:alert(1)"), "");
  assert.equal(updates.releaseChannel("v1.7.0"), "stable");
  assert.equal(updates.releaseChannel("v1.7.0+build.4"), "stable");
  assert.equal(updates.releaseChannel("v1.7.0-beta.1"), "prerelease");
  assert.equal(updates.releaseChannel("v1.07.0"), null);
});

test("protocol compatibility warns only on a major mismatch", () => {
  assert.equal(updates.protocolMajorMismatch("1.2.0", "1.9.0"), false);
  assert.equal(updates.protocolMajorMismatch("1.0.0", "2.0.0"), true);
  assert.equal(updates.protocolMajorMismatch("invalid", "2.0.0"), false);
});

test("prerelease runtime identity compares without downgrade", () => {
  function release(tag, prerelease) {
    return {
      tag_name: tag,
      prerelease,
      draft: false,
      html_url: `https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/${tag}`
    };
  }
  assert.equal(
    updates.selectLatestRelease([release("v1.7.0-beta.2", true)], "1.7.0-beta.1", "prerelease")
      .status,
    "available"
  );
  assert.equal(
    updates.selectLatestRelease([release("v1.7.0", false)], "1.7.0-beta.1", "prerelease").status,
    "available"
  );
  assert.equal(
    updates.selectLatestRelease([release("v1.7.0-beta.1", true)], "1.7.0-beta.2", "prerelease")
      .status,
    "current"
  );
  assert.equal(
    updates.selectLatestRelease([
      release("v1.7.0", false),
      release("v1.8.0-beta.1", true)
    ], "1.7.0", "stable").release.version,
    "1.7.0"
  );
});
