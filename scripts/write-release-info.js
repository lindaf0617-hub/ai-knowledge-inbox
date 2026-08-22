"use strict";

const fs = require("node:fs");
const path = require("node:path");
const UpdateCore = require("../extension/update.js");

function normalizeReleaseVersion(value) {
  const version = String(value || "").trim().replace(/^v/, "");
  if (!UpdateCore.parseSemver(version)) throw new TypeError(`Invalid release version: ${value}`);
  return version;
}

function releaseInfoSource(value) {
  const version = normalizeReleaseVersion(value);
  return `globalThis.__AI_KNOWLEDGE_RELEASE_VERSION = ${JSON.stringify(version)};\n`;
}

function writeReleaseInfo(extensionDirectory, value) {
  const destination = path.join(extensionDirectory, "release-info.js");
  fs.writeFileSync(destination, releaseInfoSource(value), "utf8");
  return destination;
}

if (require.main === module) {
  try {
    writeReleaseInfo(path.resolve(process.argv[2]), process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { normalizeReleaseVersion, releaseInfoSource, writeReleaseInfo };
