const UpdateCore = (() => {
  const RELEASES_API =
    "https://api.github.com/repos/lindaf0617-hub/ai-knowledge-inbox/releases";

  function parseSemver(value) {
    const match = String(value || "").trim().match(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    );
    if (!match) return null;
    const prerelease = match[4] ? match[4].split(".") : [];
    if (prerelease.some(identifier => /^\d+$/.test(identifier) &&
        identifier.length > 1 && identifier.startsWith("0"))) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease,
      raw: String(value)
    };
  }

  function compareIdentifiers(left, right) {
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) {
      if (left.length !== right.length) return left.length - right.length;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function compareSemver(left, right) {
    const a = typeof left === "string" ? parseSemver(left) : left;
    const b = typeof right === "string" ? parseSemver(right) : right;
    if (!a || !b) throw new TypeError("Invalid semantic version");
    for (const key of ["major", "minor", "patch"]) {
      if (a[key] !== b[key]) return a[key] - b[key];
    }
    if (!a.prerelease.length || !b.prerelease.length) {
      return a.prerelease.length === b.prerelease.length
        ? 0
        : a.prerelease.length ? -1 : 1;
    }
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      if (a.prerelease[index] === undefined) return -1;
      if (b.prerelease[index] === undefined) return 1;
      const compared = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
      if (compared) return compared;
    }
    return 0;
  }

  function normalizeChannel(value) {
    return value === "prerelease" ? "prerelease" : "stable";
  }

  function releaseChannel(value) {
    const version = parseSemver(value);
    if (!version) return null;
    return version.prerelease.length ? "prerelease" : "stable";
  }

  function safeReleaseUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.pathname.startsWith("/lindaf0617-hub/ai-knowledge-inbox/releases/")
        ? url.href
        : "";
    } catch {
      return "";
    }
  }

  function selectLatestRelease(releases, currentVersion, channel = "stable") {
    const current = parseSemver(currentVersion);
    if (!current) throw new TypeError("Invalid current version");
    const includePrerelease = normalizeChannel(channel) === "prerelease";
    const candidates = (Array.isArray(releases) ? releases : [])
      .filter(release => release && !release.draft && (includePrerelease || !release.prerelease))
      .map(release => ({
        release,
        version: parseSemver(release.tag_name),
        url: safeReleaseUrl(release.html_url)
      }))
      .filter(candidate => candidate.version && candidate.url)
      .sort((left, right) => compareSemver(right.version, left.version));
    const latest = candidates[0];
    if (!latest) return { status: "none", release: null };
    return {
      status: compareSemver(latest.version, current) > 0 ? "available" : "current",
      release: {
        version: latest.release.tag_name.replace(/^v/, ""),
        url: latest.url,
        prerelease: Boolean(latest.release.prerelease),
        name: String(latest.release.name || latest.release.tag_name)
      }
    };
  }

  function protocolMajorMismatch(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    return Boolean(a && b && a.major !== b.major);
  }

  async function checkForUpdates(currentVersion, channel = "stable", fetchImpl = fetch) {
    const response = await fetchImpl(RELEASES_API, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);
    return selectLatestRelease(await response.json(), currentVersion, channel);
  }

  return {
    RELEASES_API,
    checkForUpdates,
    compareSemver,
    normalizeChannel,
    parseSemver,
    protocolMajorMismatch,
    releaseChannel,
    safeReleaseUrl,
    selectLatestRelease
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = UpdateCore;
  if (require.main === module && ["--core", "--channel"].includes(process.argv[2])) {
    const parsed = UpdateCore.parseSemver(process.argv[3]);
    if (!parsed) {
      console.error("Invalid semantic version");
      process.exitCode = 1;
    } else if (process.argv[2] === "--channel") {
      process.stdout.write(UpdateCore.releaseChannel(process.argv[3]));
    } else {
      process.stdout.write(`${parsed.major}.${parsed.minor}.${parsed.patch}`);
    }
  }
}
