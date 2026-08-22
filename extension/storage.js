const KnowledgeStore = (() => {
  const API_BASE = globalThis.__AI_KNOWLEDGE_API_BASE || "http://127.0.0.1:43127";
  let backend = "unknown";
  let migrationPromise = null;
  const TOKEN_KEY = "desktopApiToken";
  const LEDGER_KEY = "agentLedger";
  const AUTH_DOMAIN = "AIKnowledgeInbox.LocalAPI.AuthChallenge";
  const AUTH_PROTOCOL = 1;
  const SERVICE_PROTOCOL_VERSION = "1.0.0";
  const PROOF_CACHE_MS = 15_000;
  let proofCache = { token: "", expiresAt: 0 };
  let serviceInfo = {
    version: "",
    build: "",
    protocolVersion: "",
    authenticated: false
  };

  function isValidEntry(entry) {
    return entry &&
      typeof entry.id === "string" &&
      typeof entry.title === "string" &&
      typeof entry.content === "string" &&
      typeof entry.createdAt === "string";
  }

  function normalizeTags(tags) {
    const values = Array.isArray(tags)
      ? tags
      : String(tags || "").split(/[,，]/);
    const seen = new Set();
    return values
      .map(tag => String(tag).trim())
      .filter(tag => {
        const key = tag.toLocaleLowerCase("zh-CN");
        if (!tag || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 20);
  }

  function normalizeEntry(entry) {
    const confidence = entry.confidence === null || entry.confidence === undefined
      ? null
      : Number(entry.confidence);
    return {
      ...entry,
      source: typeof entry.source === "string" ? entry.source : "",
      project: typeof entry.project === "string" ? entry.project.trim() : "",
      tags: normalizeTags(entry.tags),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
      viewCount: Number.isInteger(entry.viewCount) && entry.viewCount >= 0 ? entry.viewCount : 0,
      lastViewedAt: typeof entry.lastViewedAt === "string" ? entry.lastViewedAt : "",
      status: ["raw", "draft", "verified", "deprecated"].includes(entry.status)
        ? entry.status
        : "raw",
      confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
        ? confidence
        : null,
      provenance: entry.provenance && typeof entry.provenance === "object" &&
        !Array.isArray(entry.provenance) ? entry.provenance : {},
      agentRunId: typeof entry.agentRunId === "string" ? entry.agentRunId : "",
      approvedBy: typeof entry.approvedBy === "string" ? entry.approvedBy : "",
      approvedAt: typeof entry.approvedAt === "string" ? entry.approvedAt : "",
      supersedes: Array.isArray(entry.supersedes)
        ? entry.supersedes.map(String).filter(Boolean).slice(0, 50)
        : [],
      relations: Array.isArray(entry.relations)
        ? entry.relations.map(String).filter(Boolean).slice(0, 100)
        : []
    };
  }

  function suggestTags(content, title, source) {
    const text = `${title || ""}\n${content || ""}\n${source || ""}`.toLocaleLowerCase("zh-CN");
    const rules = [
      ["Agent", /\bagents?\b|智能体|代理工作流/],
      ["AI", /\bai\b|人工智能|大模型|llm|生成式/],
      ["产品", /产品|需求|用户体验|\bmvp\b|原型|路线图/],
      ["代码", /代码|编程|开发|调试|重构|api|typescript|javascript|python|github/],
      ["安全", /安全|漏洞|权限|合规|攻击|防护|security|zero trust/],
      ["研究", /研究|调研|分析|洞察|报告|论文/],
      ["写作", /写作|文案|文章|摘要|润色|翻译/],
      ["会议", /会议|纪要|讨论|行动项|meeting/],
      ["销售", /客户|销售|商机|报价|合同|方案/],
      ["数据", /数据|指标|报表|分析|数据库|sql|excel/]
    ];
    const tags = rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
    if (/chatgpt|openai/.test(text)) tags.push("ChatGPT");
    if (/copilot|github\.com/.test(text)) tags.push("Copilot");
    if (/claude|anthropic/.test(text)) tags.push("Claude");
    return normalizeTags(tags).slice(0, 5);
  }

  function comparableContent(content) {
    return String(content || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("zh-CN");
  }

  function createId() {
    return crypto.randomUUID ? crypto.randomUUID() :
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function deriveTitle(content) {
    const firstLine = content.split(/\r?\n/).find(line => line.trim()) || "未命名知识";
    return firstLine.trim().slice(0, 60);
  }

  function invalidateServiceProof() {
    proofCache = { token: "", expiresAt: 0 };
  }

  function serviceIdentityError() {
    const error = new Error("安全错误：无法验证桌面伴侣身份，请停止操作并重新启动桌面伴侣");
    error.serviceIdentityMismatch = true;
    backend = "security";
    return error;
  }

  function unavailableError(cause) {
    const error = new Error("桌面知识服务未运行");
    error.serverUnavailable = true;
    error.cause = cause;
    return error;
  }

  function rememberServiceInfo(data, authenticated) {
    const app = data && data.app;
    serviceInfo = {
      version: typeof app === "object" ? String(app.version || "") : String(data.version || ""),
      build: typeof app === "object" ? String(app.build || "") : "",
      protocolVersion: String(data && data.protocolVersion || ""),
      authenticated
    };
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function randomNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  function proofBytes(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
    return new Uint8Array(value.match(/../g).map(byte => Number.parseInt(byte, 16)));
  }

  function fixedTimeEqual(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) ||
        left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left[index] ^ right[index];
    }
    return difference === 0;
  }

  async function verifyServiceIdentity(token, force = false) {
    if (!force && proofCache.token === token && Date.now() < proofCache.expiresAt) return;
    invalidateServiceProof();
    const nonce = randomNonce();
    let response;
    try {
      response = await fetchWithTimeout(`${API_BASE}/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: AUTH_PROTOCOL, nonce })
      });
    } catch (error) {
      throw unavailableError(error);
    }
    const challenge = await response.json().catch(() => ({}));
    if (!response.ok ||
        challenge.domain !== AUTH_DOMAIN ||
        challenge.protocol !== AUTH_PROTOCOL ||
        challenge.nonce !== nonce) {
      throw serviceIdentityError();
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const message = `${AUTH_DOMAIN}\n${AUTH_PROTOCOL}\n${nonce}`;
    const expected = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    ));
    if (!fixedTimeEqual(expected, proofBytes(challenge.proof))) {
      throw serviceIdentityError();
    }
    proofCache = { token, expiresAt: Date.now() + PROOF_CACHE_MS };
  }

  async function requireToken() {
    const stored = await chrome.storage.local.get({ [TOKEN_KEY]: "" });
    const token = stored[TOKEN_KEY];
    if (token) return token;
    try {
      const response = await fetchWithTimeout(`${API_BASE}/health`);
      const data = await response.json().catch(() => ({}));
      rememberServiceInfo(data, false);
    } catch (error) {
      throw unavailableError(error);
    }

    const error = new Error("请先配对桌面伴侣");
    error.status = 401;
    error.pairingRequired = true;
    backend = "pairing";
    throw error;
  }

  async function serverRequest(path, options = {}) {
    const skipAuth = options.skipAuth === true;
    const token = skipAuth ? "" : await requireToken();
    if (token) await verifyServiceIdentity(token);
    const requestOptions = { ...options };
    delete requestOptions.skipAuth;
    let response;
    try {
      response = await fetchWithTimeout(`${API_BASE}${path}`, {
        ...requestOptions,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {})
        }
      });
    } catch (error) {
      invalidateServiceProof();
      throw unavailableError(error);
    }

    const data = await response.json().catch(() => ({}));
    if (path === "/health" && response.ok) rememberServiceInfo(data, Boolean(token));
    if (response.ok && data.authRequired === true) {
      const error = new Error("请先配对桌面伴侣");
      error.status = 401;
      error.pairingRequired = true;
      backend = "pairing";
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401) invalidateServiceProof();
      const error = new Error(data.error || `本地服务错误（${response.status}）`);
      error.status = response.status;
      if (response.status === 401) {
        backend = "pairing";
        error.pairingRequired = true;
        error.message = "请先配对桌面伴侣";
      }
      throw error;
    }
    return data;
  }

  async function getLocalEntries() {
    const result = await chrome.storage.local.get({ entries: [] });
    return Array.isArray(result.entries)
      ? result.entries.filter(isValidEntry).map(normalizeEntry)
      : [];
  }

  async function migrateLocalEntries() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      const stored = await chrome.storage.local.get({ [LEDGER_KEY]: null });
      const localEntries = await getLocalEntries();
      if (localEntries.length || stored[LEDGER_KEY]) {
        await serverRequest("/import", {
          method: "POST",
          body: JSON.stringify({
            entries: localEntries,
            ...(stored[LEDGER_KEY] ? { agentLedger: stored[LEDGER_KEY] } : {})
          })
        });
        await chrome.storage.local.set({ entries: [], [LEDGER_KEY]: null });
      }
      backend = "server";
    })();
    try {
      return await migrationPromise;
    } finally {
      migrationPromise = null;
    }
  }

  async function useFallback(error, fallback) {
    if (!error.serverUnavailable) throw error;
    backend = "local";
    return fallback();
  }

  async function getEntries() {
    try {
      await migrateLocalEntries();
      const result = await serverRequest("/entries");
      backend = "server";
      return Array.isArray(result.entries)
        ? result.entries.filter(isValidEntry).map(normalizeEntry)
        : [];
    } catch (error) {
      if (error.pairingRequired) {
        backend = "pairing";
        return getLocalEntries();
      }
      return useFallback(error, getLocalEntries);
    }
  }

  async function addEntry(input) {
    const content = String(input.content || "").trim();
    if (!content) throw new Error("内容不能为空");

    try {
      await migrateLocalEntries();
      const result = await serverRequest("/entries", {
        method: "POST",
        body: JSON.stringify(input)
      });
      backend = "server";
      return normalizeEntry(result.entry);
    } catch (error) {
      return useFallback(error, async () => {
        const entries = await getLocalEntries();
        const comparable = comparableContent(content);
        if (entries.some(entry => comparableContent(entry.content) === comparable)) {
          throw new Error("这段内容已经保存过");
        }
        const entry = normalizeEntry({
          id: createId(),
          title: String(input.title || "").trim() || deriveTitle(content),
          content,
          source: String(input.source || "").trim(),
          project: String(input.project || "").trim(),
          tags: normalizeTags(input.tags),
          summary: String(input.summary || "").trim(),
          createdAt: new Date().toISOString(),
          viewCount: 0,
          lastViewedAt: "",
          status: input.status || "raw",
          confidence: input.confidence ?? null,
          provenance: input.provenance || {},
          agentRunId: input.agentRunId || "",
          approvedBy: input.approvedBy || "",
          approvedAt: input.approvedAt || "",
          supersedes: input.supersedes || [],
          relations: input.relations || []
        });
        await chrome.storage.local.set({ entries: [entry, ...entries] });
        return entry;
      });
    }
  }

  async function deleteEntry(id) {
    try {
      await migrateLocalEntries();
      await serverRequest(`/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
      backend = "server";
    } catch (error) {
      return useFallback(error, async () => {
        const entries = await getLocalEntries();
        await chrome.storage.local.set({
          entries: entries.filter(entry => entry.id !== id)
        });
      });
    }
  }

  async function updateEntry(id, input) {
    const content = String(input.content || "").trim();
    if (!content) throw new Error("内容不能为空");

    try {
      await migrateLocalEntries();
      const result = await serverRequest(`/entries/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input)
      });
      backend = "server";
      return normalizeEntry(result.entry);
    } catch (error) {
      return useFallback(error, async () => {
        const entries = await getLocalEntries();
        const index = entries.findIndex(entry => entry.id === id);
        if (index < 0) throw new Error("知识不存在");
        const updated = normalizeEntry({
          ...entries[index],
          title: String(input.title || "").trim() || deriveTitle(content),
          content,
          source: String(input.source || "").trim(),
          project: String(input.project || "").trim(),
          tags: normalizeTags(input.tags),
          summary: String(input.summary || "").trim(),
          updatedAt: new Date().toISOString(),
          status: input.status ?? entries[index].status,
          confidence: input.confidence ?? entries[index].confidence,
          provenance: input.provenance ?? entries[index].provenance,
          agentRunId: input.agentRunId ?? entries[index].agentRunId,
          approvedBy: input.approvedBy ?? entries[index].approvedBy,
          approvedAt: input.approvedAt ?? entries[index].approvedAt,
          supersedes: input.supersedes ?? entries[index].supersedes,
          relations: input.relations ?? entries[index].relations
        });
        entries[index] = updated;
        await chrome.storage.local.set({ entries });
        return updated;
      });
    }
  }

  async function recordView(id) {
    try {
      await migrateLocalEntries();
      const result = await serverRequest(`/entries/${encodeURIComponent(id)}/view`, {
        method: "POST"
      });
      backend = "server";
      return normalizeEntry(result.entry);
    } catch (error) {
      return useFallback(error, async () => {
        const entries = await getLocalEntries();
        const index = entries.findIndex(entry => entry.id === id);
        if (index < 0) return null;
        entries[index] = {
          ...entries[index],
          viewCount: entries[index].viewCount + 1,
          lastViewedAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ entries });
        return entries[index];
      });
    }
  }

  async function importEntries(incoming, agentLedger) {
    if (!Array.isArray(incoming) || !incoming.every(isValidEntry)) {
      throw new Error("备份格式不正确");
    }
    try {
      await migrateLocalEntries();
      const result = await serverRequest("/import", {
        method: "POST",
        body: JSON.stringify({
          entries: incoming,
          ...(agentLedger ? { agentLedger } : {})
        })
      });
      backend = "server";
      return result.imported;
    } catch (error) {
      return useFallback(error, async () => {
        const entries = await getLocalEntries();
        const existingIds = new Set(entries.map(entry => entry.id));
        const existingContent = new Set(entries.map(entry => comparableContent(entry.content)));
        const additions = incoming
          .filter(entry =>
            !existingIds.has(entry.id) &&
            !existingContent.has(comparableContent(entry.content))
          )
          .map(normalizeEntry);
        const merged = [...additions, ...entries]
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        await chrome.storage.local.set({
          entries: merged,
          ...(agentLedger ? { [LEDGER_KEY]: agentLedger } : {})
        });
        return additions.length;
      });
    }
  }

  async function getBackendStatus() {
    try {
      await migrateLocalEntries();
      await serverRequest("/health");
      backend = "server";
    } catch (error) {
      if (error.serviceIdentityMismatch) {
        backend = "security";
        return backend;
      }

      if (error.pairingRequired) {
        backend = "pairing";
        return backend;
      }

      if (!error.serverUnavailable) throw error;
      backend = "local";
    }
    return backend;
  }

  async function getCloudStatus() {
    try {
      await migrateLocalEntries();
      const result = await serverRequest("/sync/status");
      backend = "server";
      return result;
    } catch (error) {
      if (error.pairingRequired) {
        backend = "pairing";
        return {
          enabled: false,
          status: "pairing",
          path: "",
          lastSyncAt: "",
          lastError: "请先配对桌面伴侣"
        };
      }
      if (!error.serverUnavailable) throw error;
      backend = "local";
      return {
        enabled: false,
        status: "offline",
        path: "",
        lastSyncAt: "",
        lastError: "桌面知识服务未运行"
      };
    }
  }

  async function getVersionStatus() {
    const mode = await getBackendStatus();
    const stored = await chrome.storage.local.get({ [TOKEN_KEY]: "" });
    let sync = {
      enabled: false,
      status: mode === "server" ? "unknown" : "offline",
      lastSyncAt: "",
      lastError: ""
    };
    if (mode === "server") {
      try {
        sync = await getCloudStatus();
      } catch (error) {
        sync = { ...sync, status: "error", lastError: error.message };
      }
    }
    const extensionVersion = chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "";
    const desktopMajor = Number.parseInt(serviceInfo.protocolVersion.split(".")[0], 10);
    const extensionMajor = Number.parseInt(SERVICE_PROTOCOL_VERSION.split(".")[0], 10);
    return {
      extensionVersion,
      extensionProtocolVersion: SERVICE_PROTOCOL_VERSION,
      desktopVersion: serviceInfo.version,
      desktopBuild: serviceInfo.build,
      desktopProtocolVersion: serviceInfo.protocolVersion,
      backend: mode,
      authState: mode === "server"
        ? "authenticated"
        : mode === "security"
          ? "security-error"
        : mode === "pairing"
          ? "pairing-required"
          : stored[TOKEN_KEY] ? "paired-offline" : "unpaired",
      sync,
      protocolMismatch: Number.isInteger(desktopMajor) &&
        Number.isInteger(extensionMajor) &&
        desktopMajor !== extensionMajor
    };
  }

  async function syncCloud() {
    try {
      await migrateLocalEntries();
      const result = await serverRequest("/sync", { method: "POST" });
      backend = "server";
      return result;
    } catch (error) {
      if (error.serverUnavailable) backend = "local";
      throw error;
    }
  }

  async function pairDesktop(code) {
    const result = await serverRequest("/pairing/exchange", {
      method: "POST",
      body: JSON.stringify({ code: String(code || "").trim() }),
      skipAuth: true
    });
    if (typeof result.token !== "string" || !result.token) {
      throw new Error("桌面伴侣返回的配对凭据无效");
    }
    await chrome.storage.local.set({ [TOKEN_KEY]: result.token });
    try {
      await verifyServiceIdentity(result.token, true);
    } catch (error) {
      await chrome.storage.local.set({ [TOKEN_KEY]: "" });
      invalidateServiceProof();
      throw error;
    }
    backend = "unknown";
    await migrateLocalEntries();
    return true;
  }

  async function agentRequest(path, options = {}) {
    await migrateLocalEntries();
    const result = await serverRequest(path, options);
    backend = "server";
    return result;
  }

  async function createAgentRun(input) {
    return (await agentRequest("/agent-runs", {
      method: "POST",
      body: JSON.stringify(input)
    })).run;
  }

  async function listAgentRuns() {
    return (await agentRequest("/agent-runs")).runs || [];
  }

  async function getAgentRun(id) {
    return (await agentRequest(`/agent-runs/${encodeURIComponent(id)}`)).run;
  }

  async function transitionAgentRun(id, action, input = {}) {
    return (await agentRequest(
      `/agent-runs/${encodeURIComponent(id)}/${action}`,
      { method: "POST", body: JSON.stringify(input) }
    )).run;
  }

  async function createProposal(runId, input) {
    return (await agentRequest(
      `/agent-runs/${encodeURIComponent(runId)}/proposals`,
      { method: "POST", body: JSON.stringify(input) }
    )).proposal;
  }

  async function listProposals(runId) {
    return (await agentRequest(
      `/agent-runs/${encodeURIComponent(runId)}/proposals`
    )).proposals || [];
  }

  async function decideProposal(id, action, input = {}) {
    return agentRequest(
      `/knowledge-proposals/${encodeURIComponent(id)}/${action}`,
      { method: "POST", body: JSON.stringify(input) }
    );
  }

  async function listAudit(limit = 100) {
    return (await agentRequest(`/audit?limit=${encodeURIComponent(limit)}`)).events || [];
  }

  async function exportBundle() {
    try {
      return await agentRequest("/export");
    } catch (error) {
      return useFallback(error, async () => ({
        app: "AI Knowledge Inbox",
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: await getLocalEntries(),
        ...((await chrome.storage.local.get({ [LEDGER_KEY]: null }))[LEDGER_KEY]
          ? { agentLedger:
              (await chrome.storage.local.get({ [LEDGER_KEY]: null }))[LEDGER_KEY] }
          : {})
      }));
    }
  }

  return {
    addEntry,
    createAgentRun,
    createProposal,
    currentBackend: () => backend,
    deleteEntry,
    decideProposal,
    deriveTitle,
    exportBundle,
    getAgentRun,
    getBackendStatus,
    getCloudStatus,
    getEntries,
    getVersionStatus,
    importEntries,
    isValidEntry,
    listAgentRuns,
    listAudit,
    listProposals,
    normalizeTags,
    pairDesktop,
    recordView,
    suggestTags,
    syncCloud,
    transitionAgentRun,
    updateEntry
  };
})();
