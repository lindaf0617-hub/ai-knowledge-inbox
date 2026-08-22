"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  validateExtensionDirectory,
  validateZipEntries
} = require("../scripts/package-validator.js");

test("current extension passes store package source validation", () => {
  const root = path.join(__dirname, "..");
  assert.deepEqual(validateExtensionDirectory(path.join(root, "extension"), {
    permissionsDocument: path.join(root, "store-assets", "PERMISSIONS.md")
  }), []);
});

test("validator rejects remote code, missing icons, and wrapped ZIP roots", () => {
  const fixtureParent = path.join(__dirname, ".package-fixtures");
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "run-"));
  try {
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      icons: { 16: "missing.png" }
    }));
    fs.writeFileSync(path.join(root, "popup.html"), '<script src="https://example.test/app.js"></script>');
    const errors = validateExtensionDirectory(root);
    assert.ok(errors.some(error => error.includes("Missing icon")));
    assert.ok(errors.some(error => error.includes("Remote script")));
    assert.ok(validateZipEntries(["extension/manifest.json"]).some(error => /root/.test(error)));
    assert.deepEqual(validateZipEntries(["manifest.json", "popup.js"]), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fixtureParent, { recursive: true, force: true });
  }
});
