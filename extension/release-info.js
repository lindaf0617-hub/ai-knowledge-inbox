(() => {
  const manifestVersion = globalThis.chrome &&
    globalThis.chrome.runtime &&
    typeof globalThis.chrome.runtime.getManifest === "function"
    ? globalThis.chrome.runtime.getManifest().version
    : "";
  if (typeof globalThis.__AI_KNOWLEDGE_RELEASE_VERSION !== "string" ||
      !globalThis.__AI_KNOWLEDGE_RELEASE_VERSION.trim()) {
    globalThis.__AI_KNOWLEDGE_RELEASE_VERSION = manifestVersion;
  }
})();
