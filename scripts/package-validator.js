"use strict";

const fs = require("node:fs");
const path = require("node:path");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
}

function validateZipEntries(entries) {
  const normalized = entries.map(entry => String(entry).replaceAll("\\", "/"));
  const errors = [];
  if (!normalized.includes("manifest.json")) {
    errors.push("Store ZIP must contain manifest.json at its root");
  }
  if (normalized.some(entry => entry.startsWith("/") || /^[A-Za-z]:/.test(entry) ||
      entry.split("/").includes(".."))) {
    errors.push("Store ZIP contains an unsafe path");
  }
  return errors;
}

function validateExtensionDirectory(directory, options = {}) {
  const errors = [];
  const manifestPath = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifestPath)) return ["manifest.json is missing"];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return ["manifest.json is not valid JSON"];
  }
  if (manifest.manifest_version !== 3) errors.push("Extension must use Manifest V3");
  const csp = manifest.content_security_policy?.extension_pages || "";
  if (/unsafe-eval|https?:|data:/i.test(csp)) errors.push("Extension CSP permits unsafe or remote code");

  const iconPaths = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ]);
  for (const icon of iconPaths) {
    if (!fs.existsSync(path.join(directory, icon))) errors.push(`Missing icon: ${icon}`);
  }

  for (const file of walk(directory)) {
    const extension = path.extname(file).toLowerCase();
    if (![".js", ".html", ".htm"].includes(extension)) continue;
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(directory, file);
    if (extension === ".js" &&
        /\beval\s*\(|\bnew\s+Function\s*\(|\bimportScripts\s*\(\s*["']https?:/i.test(source)) {
      errors.push(`Remote or evaluated code found: ${relative}`);
    }
    if ([".html", ".htm"].includes(extension) &&
        /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(source)) {
      errors.push(`Remote script or stylesheet found: ${relative}`);
    }
    if ([".html", ".htm"].includes(extension) && /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(source)) {
      errors.push(`Inline script violates extension CSP: ${relative}`);
    }
  }

  const permissionsDocument = options.permissionsDocument;
  const localhostPermissions = (manifest.host_permissions || [])
    .filter(permission => /^http:\/\/(?:127\.0\.0\.1|localhost):/i.test(permission));
  if (localhostPermissions.length) {
    const rationale = permissionsDocument && fs.existsSync(permissionsDocument)
      ? fs.readFileSync(permissionsDocument, "utf8")
      : "";
    for (const permission of localhostPermissions) {
      const port = new URL(permission.replace("*", "")).port;
      if (!rationale.includes(port)) {
        errors.push(`Localhost permission ${permission} has no documented rationale`);
      }
    }
  }
  return errors;
}

function main() {
  const directory = path.resolve(process.argv[2] || "extension");
  const permissionsDocument = path.resolve(
    process.argv[3] || path.join("store-assets", "PERMISSIONS.md")
  );
  const errors = validateExtensionDirectory(directory, { permissionsDocument });
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Extension package validation passed: ${directory}`);
  }
}

if (require.main === module) main();

module.exports = { validateExtensionDirectory, validateZipEntries };
