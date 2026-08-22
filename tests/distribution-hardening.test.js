"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writeReleaseInfo } = require("../scripts/write-release-info.js");
const { verifyReleaseArtifacts } = require("../scripts/verify-release-artifacts.js");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("library version helpers are available at module scope", () => {
  const source = fs.readFileSync(path.join(root, "extension", "library.js"), "utf8");
  const start = source.indexOf("async function refreshSyncStatus()");
  const end = source.indexOf("function updateFilters()", start);
  assert.ok(start >= 0 && end > start);

  const element = {
    addEventListener() {},
    append() {},
    classList: { add() {}, toggle() {} },
    replaceChildren() {},
    textContent: "",
    checked: false,
    disabled: false
  };
  const context = {
    __AI_KNOWLEDGE_RELEASE_VERSION: "1.6.0-beta.2",
    chrome: {
      runtime: { getManifest: () => ({ version: "1.6.0" }) },
      storage: { local: { get: async defaults => defaults, set: async () => {} } }
    },
    document: { createElement: () => ({ ...element }), createTextNode: value => value },
    elements: {
      checkUpdates: { ...element },
      prereleaseChannel: { ...element },
      syncStatus: { ...element },
      updateResult: { ...element },
      versionStatus: { ...element }
    },
    formatSyncStatus() {},
    I18n: { getLanguage: () => "en" },
    KnowledgeStore: {
      getCloudStatus: async () => ({ enabled: false }),
      getVersionStatus: async () => ({
        extensionVersion: "1.6.0",
        desktopVersion: "",
        authState: "unpaired",
        sync: { enabled: false, status: "offline" },
        protocolMismatch: false
      })
    },
    UpdateCore: {
      checkForUpdates: async () => ({ status: "current" }),
      parseSemver: value => value ? {} : null
    }
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}
     globalThis.__helpers = {
       refreshSyncStatus: typeof refreshSyncStatus,
       refreshVersionStatus: typeof refreshVersionStatus,
       loadUpdateChannel: typeof loadUpdateChannel,
       currentReleaseVersion: typeof currentReleaseVersion,
       release: currentReleaseVersion()
     };`,
    context
  );
  assert.deepEqual(
    { ...context.__helpers },
    {
      refreshSyncStatus: "function",
      refreshVersionStatus: "function",
      loadUpdateChannel: "function",
      currentReleaseVersion: "function",
      release: "1.6.0-beta.2"
    }
  );
});

test("macOS Developer ID signing preserves required Node runtime entitlements", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "build-macos.sh"), "utf8");
  const plist = fs.readFileSync(path.join(root, "macos", "node-entitlements.plist"), "utf8");
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation"
  ]) {
    assert.match(plist, new RegExp(`<key>${entitlement.replaceAll(".", "\\.")}</key>\\s*<true/>`));
    assert.ok(script.includes(entitlement));
  }
  assert.match(script, /--entitlements "\$NODE_ENTITLEMENTS" --sign "\$SIGN_IDENTITY"/);
  assert.match(script, /Bundled Node runtime failed its post-signing smoke test/);
  assert.match(script, /codesign --force --deep --sign - "\$app"/);
});

test("Windows build validates artifact SemVer against the numeric manifest core", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "build-release.ps1"), "utf8");
  assert.match(script, /--core \$Version/);
  assert.match(script, /\$manifest\.version -ne \$versionCore/);
  assert.match(script, /ValidateVersionOnly/);
  assert.doesNotMatch(script, /\$manifest\.version -ne \$Version/);
  assert.match(script, /\[Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(script, /Write-Utf8NoBom -Path \$artifactManifestPath/);
  assert.match(
    script,
    /Write-Utf8NoBom -Path \(Join-Path \$dist "SHA256SUMS\.txt"\)[\s\S]*\$hashLines -join "`n"/
  );
  assert.doesNotMatch(
    script,
    /Set-Content -LiteralPath \$artifactManifestPath/
  );
  assert.doesNotMatch(script, /Set-Content[^\r\n]*SHA256SUMS/);
});

test("stable Windows package has signed PowerShell trust root and verified payload", () => {
  const build = fs.readFileSync(path.join(root, "scripts", "build-release.ps1"), "utf8");
  const installer = fs.readFileSync(
    path.join(root, "packaging", "windows", "install.ps1"),
    "utf8"
  );
  assert.match(build, /Get-ChildItem[\s\S]*-Filter \*\.cmd[\s\S]*Remove-Item -Force/);
  assert.match(build, /Sign-PowerShellScript -Path \(Join-Path \$stage "uninstall\.ps1"\)/);
  assert.match(build, /Sign-PowerShellScript -Path \$companion/);
  assert.match(build, /Sign-PowerShellScript -Path \$installer/);
  assert.match(build, /Get-AuthenticodeSignature/);
  assert.doesNotMatch(build, /signtool|server\.js"\)[\s\S]*Authenticode/);
  assert.match(build, /New-PayloadManifest/);
  assert.match(installer, /__PAYLOAD_MANIFEST_SHA256__/);
  assert.match(installer, /Unexpected payload file/);
  assert.match(installer, /Payload hash verification failed/);
  assert.match(installer, /ExecutionPolicy AllSigned/);
  assert.match(installer, /if \(\$signedPackage\)[\s\S]*CreateShortcut/);
});

test("release workflow derives stable and prerelease flags from validated tag SemVer", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8"
  );
  assert.match(workflow, /\r?\n  metadata:\r?\n/);
  assert.match(workflow, /id: release/);
  assert.match(workflow, /node extension\/update\.js --channel "\$version"/);
  assert.match(workflow, /version: \$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.match(workflow, /prerelease: \$\{\{ needs\.metadata\.outputs\.prerelease \}\}/);

  const helper = path.join(root, "extension", "update.js");
  for (const [tag, expected] of [
    ["v1.7.0", "stable"],
    ["v1.7.0+build.9", "stable"],
    ["v1.7.0-beta.1", "prerelease"]
  ]) {
    const result = spawnSync(process.execPath, [helper, "--channel", tag], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
  assert.notEqual(
    spawnSync(process.execPath, [helper, "--channel", "v1.07.0"], { encoding: "utf8" }).status,
    0
  );
});

test("release workflow fails stable closed and keeps prereleases unsigned", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8"
  );
  for (const secret of [
    "WINDOWS_CERTIFICATE_PFX_BASE64",
    "WINDOWS_PFX_PASSWORD",
    "APPLE_CERTIFICATE_P12_BASE64",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGN_IDENTITY",
    "APPLE_NOTARY_KEY_BASE64",
    "APPLE_NOTARY_KEY_ID",
    "APPLE_NOTARY_ISSUER_ID"
  ]) {
    assert.ok(workflow.includes(`secrets.${secret}`), `workflow omits ${secret}`);
  }
  assert.match(workflow, /Build unsigned prerelease[\s\S]*prerelease == 'true'/);
  assert.match(workflow, /build-release\.ps1[\s\S]*-Sign[\s\S]*-PfxPath/);
  assert.match(workflow, /APPLE_NOTARIZE=1 APPLE_NOTARY_KEY="\$notary_key"/);
  assert.match(workflow, /Verify release artifact policy/);
  assert.match(workflow, /scripts\/verify-release-artifacts\.js/);
  assert.match(workflow, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(workflow, /manifest\.signed \|\| manifest\.notarized/);
  assert.match(workflow, /!manifest\.signed \|\| !manifest\.notarized/);
  assert.match(workflow, /Remove Windows signing material/);
  assert.match(workflow, /security delete-keychain/);
});

test("release artifact policy enforces channel signing state", () => {
  const fixtures = path.join(__dirname, ".release-policy-fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  function createBundle(version, prerelease) {
    fs.rmSync(fixtures, { recursive: true, force: true });
    fs.mkdirSync(fixtures, { recursive: true });
    const signed = !prerelease;
    const windowsLabel = signed ? "signed" : "unsigned";
    const macLabel = signed ? "signed-notarized" : "unsigned";
    const windowsNames = [
      `AI-Knowledge-Inbox-${version}-Windows-${windowsLabel}.zip`,
      `AI-Knowledge-Inbox-Extension-${version}.zip`,
      `AI-Knowledge-Inbox-Store-${version}.zip`
    ];
    const macNames = [
      `AI-Knowledge-Inbox-${version}-macOS-arm64-${macLabel}.dmg`,
      `AI-Knowledge-Inbox-${version}-macOS-x64-${macLabel}.dmg`
    ];
    const makeArtifacts = names => names.map((name, index) => {
      const content = Buffer.from(`artifact-${index}-${name}`);
      fs.writeFileSync(path.join(fixtures, name), content);
      return { file: name, sha256: hash(content), bytes: content.length };
    });
    const windows = {
      version,
      signed,
      unsigned: prerelease,
      signedEntrypoint: signed ? "install.ps1" : null,
      payloadVerified: true,
      artifacts: makeArtifacts(windowsNames)
    };
    const macos = {
      version,
      signed,
      notarized: signed,
      artifacts: makeArtifacts(macNames)
    };
    fs.writeFileSync(
      path.join(fixtures, "artifact-manifest-windows.json"),
      JSON.stringify(windows)
    );
    fs.writeFileSync(
      path.join(fixtures, "artifact-manifest-macos.json"),
      JSON.stringify(macos)
    );
    const sumNames = [
      ...windowsNames,
      ...macNames,
      "artifact-manifest-windows.json",
      "artifact-manifest-macos.json"
    ];
    fs.writeFileSync(
      path.join(fixtures, "SHA256SUMS.txt"),
      `${sumNames.map(name => `${hash(fs.readFileSync(path.join(fixtures, name)))}  ${name}`)
        .join("\n")}\n`
    );
    return { windows, macos, windowsNames, macNames };
  }
  try {
    createBundle("1.6.0-beta.1", true);
    assert.equal(
      fs.readFileSync(path.join(fixtures, "SHA256SUMS.txt")).includes(0x0d),
      false,
      "SHA256SUMS must use LF-only lines"
    );
    assert.deepEqual(
      verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      { prerelease: true, signed: false, artifacts: 5 }
    );
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "false"),
      /channel|signed/
    );
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "prerelease"),
      /must be 'true' or 'false'/
    );

    createBundle("1.6.0", false);
    assert.deepEqual(
      verifyReleaseArtifacts(fixtures, "1.6.0", "false"),
      { prerelease: false, signed: true, artifacts: 5 }
    );

    let bundle = createBundle("1.6.0-beta.1", true);
    fs.appendFileSync(path.join(fixtures, bundle.windowsNames[0]), "tamper");
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /size mismatch/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    bundle.windows.artifacts[0].bytes += 1;
    fs.writeFileSync(
      path.join(fixtures, "artifact-manifest-windows.json"),
      JSON.stringify(bundle.windows)
    );
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /size mismatch/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    bundle.windows.artifacts[0].sha256 = "0".repeat(64);
    fs.writeFileSync(
      path.join(fixtures, "artifact-manifest-windows.json"),
      JSON.stringify(bundle.windows)
    );
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /SHA-256 mismatch/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    fs.writeFileSync(path.join(fixtures, "unexpected.zip"), "unexpected");
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /allowlist/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    bundle.windows.artifacts[0].file = "../renamed.zip";
    fs.writeFileSync(
      path.join(fixtures, "artifact-manifest-windows.json"),
      JSON.stringify(bundle.windows)
    );
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /Unsafe or duplicate|not clearly labeled/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    fs.rmSync(path.join(fixtures, bundle.macNames[0]));
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /missing/
    );

    bundle = createBundle("1.6.0-beta.1", true);
    const sums = path.join(fixtures, "SHA256SUMS.txt");
    const originalSums = fs.readFileSync(sums, "utf8");
    fs.writeFileSync(sums, `${originalSums[0] === "0" ? "1" : "0"}${originalSums.slice(1)}`);
    assert.throws(
      () => verifyReleaseArtifacts(fixtures, "1.6.0-beta.1", "true"),
      /SHA256SUMS mismatch/
    );
  } finally {
    fs.rmSync(fixtures, { recursive: true, force: true });
  }
});

test("capture popup contains no version or update controls", () => {
  const html = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "extension", "popup.js"), "utf8");
  for (const forbidden of [
    "versionPanel",
    "versionStatus",
    "checkUpdates",
    "prereleaseChannel",
    "updateResult",
    'src="update.js"'
  ]) {
    assert.equal(html.includes(forbidden), false, `popup HTML includes ${forbidden}`);
    assert.equal(script.includes(forbidden), false, `popup script includes ${forbidden}`);
  }
  assert.match(html, /id="backend"/);
  assert.match(html, /id="pairing"/);
  assert.match(html, /id="entryForm"/);
});

test("release identity falls back to manifest and staged builds overwrite it", () => {
  const source = fs.readFileSync(path.join(root, "extension", "release-info.js"), "utf8");
  const fallbackContext = {
    chrome: { runtime: { getManifest: () => ({ version: "1.7.0" }) } }
  };
  vm.createContext(fallbackContext);
  vm.runInContext(source, fallbackContext);
  assert.equal(fallbackContext.__AI_KNOWLEDGE_RELEASE_VERSION, "1.7.0");

  const fixtureParent = path.join(__dirname, ".release-info-fixtures");
  const stage = path.join(fixtureParent, "extension");
  fs.mkdirSync(stage, { recursive: true });
  try {
    writeReleaseInfo(stage, "1.7.0-beta.1");
    const staged = fs.readFileSync(path.join(stage, "release-info.js"), "utf8");
    assert.match(staged, /"1\.7\.0-beta\.1"/);
    const stagedContext = {};
    vm.createContext(stagedContext);
    vm.runInContext(staged, stagedContext);
    assert.equal(stagedContext.__AI_KNOWLEDGE_RELEASE_VERSION, "1.7.0-beta.1");
  } finally {
    fs.rmSync(fixtureParent, { recursive: true, force: true });
  }

  const build = fs.readFileSync(path.join(root, "scripts", "build-release.ps1"), "utf8");
  assert.match(build, /write-release-info\.js"\) \$extensionStage \$Version/);
  assert.match(build, /write-release-info\.js"\) `\s*\$storeExtensionStage \$manifest\.version/);
  assert.match(build, /New-DeterministicZip -Source \$storeExtensionStage -Destination \$storeZip/);
});
