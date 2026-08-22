const KnowledgeStore = (() => {
  const API_BASE = globalThis.__AI_KNOWLEDGE_API_BASE || "http://127.0.0.1:43127";
  let backend = "unknown";
  let migrationPromise = null;

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
    return {
      ...entry,
      source: typeof entry.source === "string" ? entry.source : "",
      project: typeof entry.project === "string" ? entry.project.trim() : "",
      tags: normalizeTags(entry.tags),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
      viewCount: Number.isInteger(entry.viewCount) && entry.viewCount >= 0 ? entry.viewCount : 0,
      lastViewedAt: typeof entry.lastViewedAt === "string" ? entry.lastViewedAt : ""
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

  async function serverRequest(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        },
        signal: controller.signal
      });
    } catch (error) {
      const unavailable = new Error("桌面知识服务未运行");
      unavailable.serverUnavailable = true;
      unavailable.cause = error;
      throw unavailable;
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `本地服务错误（${response.status}）`);
      error.status = response.status;
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
      const localEntries = await getLocalEntries();
      if (localEntries.length) {
        await serverRequest("/import", {
          method: "POST",
          body: JSON.stringify({ entries: localEntries })
        });
        await chrome.storage.local.set({ entries: [] });
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
          lastViewedAt: ""
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
          updatedAt: new Date().toISOString()
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

  async function importEntries(incoming) {
    if (!Array.isArray(incoming) || !incoming.every(isValidEntry)) {
      throw new Error("备份格式不正确");
    }
    try {
      await migrateLocalEntries();
      const result = await serverRequest("/import", {
        method: "POST",
        body: JSON.stringify({ entries: incoming })
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
        await chrome.storage.local.set({ entries: merged });
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

  return {
    addEntry,
    currentBackend: () => backend,
    deleteEntry,
    deriveTitle,
    getBackendStatus,
    getCloudStatus,
    getEntries,
    importEntries,
    isValidEntry,
    normalizeTags,
    recordView,
    suggestTags,
    syncCloud,
    updateEntry
  };
})();
