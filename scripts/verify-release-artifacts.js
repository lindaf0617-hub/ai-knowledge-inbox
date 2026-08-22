"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const UpdateCore = require("../extension/update.js");

const CONTROL_FILES = new Set([
  "artifact-manifest-windows.json",
  "artifact-manifest-macos.json",
  "SHA256SUMS.txt"
]);

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readManifest(directory, name) {
  return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
}

function safeArtifactName(value) {
  const name = String(value || "");
  return name && path.basename(name) === name && !name.includes("\\") && name !== "." && name !== "..";
}

function collectManifestArtifacts(directory, manifests) {
  const names = new Set();
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
      throw new Error("Artifact manifest has no artifacts");
    }
    for (const artifact of manifest.artifacts) {
      if (!safeArtifactName(artifact.file) || names.has(artifact.file)) {
        throw new Error(`Unsafe or duplicate manifest artifact name: ${artifact.file}`);
      }
      names.add(artifact.file);
      const filePath = path.join(directory, artifact.file);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Manifest artifact is missing: ${artifact.file}`);
      }
      const size = fs.statSync(filePath).size;
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes !== size) {
        throw new Error(`Artifact size mismatch: ${artifact.file}`);
      }
      const hash = hashFile(filePath);
      if (!/^[a-f0-9]{64}$/.test(String(artifact.sha256 || "")) ||
          artifact.sha256 !== hash) {
        throw new Error(`Artifact SHA-256 mismatch: ${artifact.file}`);
      }
    }
  }
  return names;
}

function verifyChecksums(directory, artifactNames) {
  const checksumsPath = path.join(directory, "SHA256SUMS.txt");
  const lines = fs.readFileSync(checksumsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const sums = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-fA-F0-9]{64})  ([^/\\]+)$/);
    if (!match || sums.has(match[2])) throw new Error(`Invalid or duplicate checksum line: ${line}`);
    sums.set(match[2], match[1].toLowerCase());
  }
  const expected = new Set([
    ...artifactNames,
    "artifact-manifest-windows.json",
    "artifact-manifest-macos.json"
  ]);
  if (sums.size !== expected.size ||
      [...sums.keys()].some(name => !expected.has(name))) {
    throw new Error("SHA256SUMS contains missing or unexpected release files");
  }
  for (const name of expected) {
    if (!sums.has(name) || sums.get(name) !== hashFile(path.join(directory, name))) {
      throw new Error(`SHA256SUMS mismatch: ${name}`);
    }
  }
}

function rejectUnexpectedFiles(directory, artifactNames) {
  const allowed = new Set([...CONTROL_FILES, ...artifactNames]);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const actual = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const unexpected = entries
    .filter(entry => !entry.isFile() || !allowed.has(entry.name))
    .map(entry => entry.name);
  const missing = [...allowed].filter(name => !actual.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Release file allowlist mismatch; unexpected=[${unexpected}], missing=[${missing}]`
    );
  }
}

function expectedArtifactNames(version, expectedSigned) {
  const windowsLabel = expectedSigned ? "signed" : "unsigned";
  const macLabel = expectedSigned ? "signed-notarized" : "unsigned";
  return new Set([
    `AI-Knowledge-Inbox-${version}-Windows-${windowsLabel}.zip`,
    `AI-Knowledge-Inbox-Extension-${version}.zip`,
    `AI-Knowledge-Inbox-Store-${version}.zip`,
    `AI-Knowledge-Inbox-${version}-macOS-arm64-${macLabel}.dmg`,
    `AI-Knowledge-Inbox-${version}-macOS-x64-${macLabel}.dmg`
  ]);
}

function verifyReleaseArtifacts(directory, version, prereleaseValue) {
  if (!UpdateCore.parseSemver(version)) throw new Error(`Invalid release version: ${version}`);
  if (!["true", "false"].includes(String(prereleaseValue))) {
    throw new Error("Prerelease flag must be 'true' or 'false'");
  }
  const prerelease = String(prereleaseValue) === "true";
  if ((UpdateCore.releaseChannel(version) === "prerelease") !== prerelease) {
    throw new Error("Release channel does not match version");
  }
  const windows = readManifest(directory, "artifact-manifest-windows.json");
  const macos = readManifest(directory, "artifact-manifest-macos.json");
  if (windows.version !== version || macos.version !== version) {
    throw new Error("Artifact manifest version does not match release tag");
  }
  const expectedSigned = !prerelease;
  if (windows.signed !== expectedSigned ||
      windows.unsigned !== prerelease ||
      windows.payloadVerified !== true ||
      (expectedSigned && windows.signedEntrypoint !== "install.ps1") ||
      (prerelease && windows.signedEntrypoint != null)) {
    throw new Error("Windows signing and payload policy does not match release channel");
  }
  if (macos.signed !== expectedSigned || macos.notarized !== expectedSigned) {
    throw new Error(
      `macOS signed/notarized=${macos.signed}/${macos.notarized}; expected ${expectedSigned}`
    );
  }
  const windowsLabel = expectedSigned ? "-Windows-signed.zip" : "-Windows-unsigned.zip";
  if (!windows.artifacts.some(item => item.file.endsWith(windowsLabel))) {
    throw new Error(`Windows desktop artifact is not clearly labeled ${windowsLabel}`);
  }
  const macLabel = expectedSigned ? "-signed-notarized.dmg" : "-unsigned.dmg";
  if (!macos.artifacts.every(item => item.file.endsWith(macLabel))) {
    throw new Error(`macOS desktop artifacts are not clearly labeled ${macLabel}`);
  }

  const artifactNames = collectManifestArtifacts(directory, [windows, macos]);
  const expectedNames = expectedArtifactNames(version, expectedSigned);
  if (artifactNames.size !== expectedNames.size ||
      [...artifactNames].some(name => !expectedNames.has(name))) {
    throw new Error("Artifact names do not match the release allowlist");
  }
  rejectUnexpectedFiles(directory, artifactNames);
  verifyChecksums(directory, artifactNames);
  return { prerelease, signed: expectedSigned, artifacts: artifactNames.size };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 5) {
      throw new Error(
        "Usage: node scripts/verify-release-artifacts.js DIRECTORY VERSION true|false"
      );
    }
    const result = verifyReleaseArtifacts(
      path.resolve(process.argv[2]),
      process.argv[3],
      process.argv[4]
    );
    console.log(
      `Release artifacts verified: ${result.prerelease ? "prerelease/unsigned" : "stable/signed"}; ` +
      `${result.artifacts} payloads`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  CONTROL_FILES,
  expectedArtifactNames,
  hashFile,
  verifyReleaseArtifacts
};
