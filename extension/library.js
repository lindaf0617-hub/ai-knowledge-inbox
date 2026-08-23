const state = {
  entries: [],
  query: "",
  project: "",
  tag: "",
  searchMode: "keyword",
  sortOrder: "newest",
  activeId: null
};
I18n.bindPicker(document.getElementById("languagePicker"));

const elements = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  backendStatus: document.getElementById("backendStatus"),
  syncStatus: document.getElementById("syncStatus"),
  versionStatus: document.getElementById("versionStatus"),
  updateResult: document.getElementById("updateResult"),
  pairingForm: document.getElementById("libraryPairing"),
  pairingCode: document.getElementById("libraryPairingCode"),
  checkUpdates: document.getElementById("checkUpdates"),
  prereleaseChannel: document.getElementById("prereleaseChannel"),
  skinPicker: document.getElementById("skinPicker"),
  searchMode: document.getElementById("searchMode"),
  projectFilter: document.getElementById("projectFilter"),
  tagFilter: document.getElementById("tagFilter"),
  sortOrder: document.getElementById("sortOrder"),
  totalMetric: document.getElementById("totalMetric"),
  weekMetric: document.getElementById("weekMetric"),
  viewMetric: document.getElementById("viewMetric"),
  sourceMetric: document.getElementById("sourceMetric"),
  editDialog: document.getElementById("editDialog"),
  editForm: document.getElementById("editForm"),
  editMeta: document.getElementById("editMeta"),
  editTitle: document.getElementById("editTitle"),
  editContent: document.getElementById("editContent"),
  editSummary: document.getElementById("editSummary"),
  editSource: document.getElementById("editSource"),
  editProject: document.getElementById("editProject"),
  editTags: document.getElementById("editTags"),
  previewDialog: document.getElementById("previewDialog"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  markdownPreview: document.getElementById("markdownPreview"),
  previewSummary: document.getElementById("previewSummary"),
  relatedSection: document.getElementById("relatedSection"),
  relatedList: document.getElementById("relatedList"),
  fileInput: document.getElementById("fileInput"),
  toast: document.getElementById("toast")
};

if (!elements.pairingForm) {
  const form = document.createElement("form");
  form.id = "libraryPairing";
  form.className = "library-pairing";
  form.style.display = "none";
  form.style.maxWidth = "520px";
  form.style.marginTop = "12px";
  form.style.padding = "12px";
  form.style.border = "1px solid var(--cp-warning)";
  form.style.borderRadius = "14px";
  form.style.background = "var(--cp-surface-soft)";

  const help = document.createElement("p");
  help.textContent = "在桌面伴侣菜单中生成配对码，然后在这里输入。";
  help.style.margin = "0 0 8px";
  help.style.color = "var(--cp-text-muted)";
  help.style.fontSize = "12px";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";

  const input = document.createElement("input");
  input.id = "libraryPairingCode";
  input.maxLength = 8;
  input.autocomplete = "one-time-code";
  input.placeholder = "8 位配对码";
  input.style.height = "40px";
  input.style.padding = "8px 10px";
  input.style.textTransform = "uppercase";

  const button = document.createElement("button");
  button.className = "button primary";
  button.type = "submit";
  button.textContent = "配对";

  row.append(input, button);
  form.append(help, row);
  elements.updateResult.insertAdjacentElement("afterend", form);
  elements.pairingForm = form;
  elements.pairingCode = input;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

elements.skinPicker.value = document.documentElement.dataset.skin || "tech";
elements.skinPicker.addEventListener("change", event => {
  const skin = event.target.value;
  localStorage.setItem("library-skin", skin);
  document.documentElement.setAttribute("data-skin", skin);
});

function filteredEntries() {
  const terms = searchTerms(state.query);
  const scoredEntries = state.entries.map(entry => ({
    entry,
    relevance: state.searchMode === "semantic" && state.query.trim()
      ? SemanticSearch.similarity(state.query, entry)
      : relevanceScore(entry, terms)
  }));
  const entries = scoredEntries.filter(({ entry, relevance }) => {
    const hasQuery = Boolean(state.query.trim());
    const matchesQuery = !hasQuery ||
      (state.searchMode === "semantic" ? relevance >= 0.08 : relevance > 0);
    const matchesProject = !state.project || entry.project === state.project;
    const matchesTag = !state.tag || entry.tags.includes(state.tag);
    return matchesQuery && matchesProject && matchesTag;
  });
  return entries.sort((a, b) => {
    if (state.query.trim() && b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (state.sortOrder === "mostViewed") {
      return b.entry.viewCount - a.entry.viewCount ||
        new Date(b.entry.createdAt) - new Date(a.entry.createdAt);
    }
    if (state.sortOrder === "recentlyViewed") {
      return new Date(b.entry.lastViewedAt || 0) - new Date(a.entry.lastViewedAt || 0) ||
        new Date(b.entry.createdAt) - new Date(a.entry.createdAt);
    }
    return new Date(b.entry.createdAt) - new Date(a.entry.createdAt);
  }).map(({ entry }) => entry);
}

function searchTerms(query) {
  return String(query || "")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

function relevanceScore(entry, terms) {
  if (!terms.length) return 0;
  const fields = {
    title: entry.title.toLocaleLowerCase("zh-CN"),
    project: entry.project.toLocaleLowerCase("zh-CN"),
    tags: entry.tags.map(tag => tag.toLocaleLowerCase("zh-CN")),
    content: entry.content.toLocaleLowerCase("zh-CN"),
    source: entry.source.toLocaleLowerCase("zh-CN")
  };
  let total = 0;
  for (const term of terms) {
    let termScore = 0;
    if (fields.title.includes(term)) termScore += fields.title === term ? 18 : 10;
    if (fields.project.includes(term)) termScore += fields.project === term ? 14 : 8;
    if (fields.tags.some(tag => tag === term)) termScore += 16;
    else if (fields.tags.some(tag => tag.includes(term))) termScore += 7;
    if (fields.content.includes(term)) termScore += 3;
    if (fields.source.includes(term)) termScore += 1;
    if (!termScore) return 0;
    total += termScore;
  }
  return total;
}

function tokenSet(entry) {
  const text = `${entry.title}\n${entry.content}`
    .toLocaleLowerCase("zh-CN")
    .replace(/https?:\/\/\S+/g, " ")
    .slice(0, 4000);
  const tokens = new Set(text.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2}/g) || []);
  for (const match of text.matchAll(/[\u4e00-\u9fff]{3,}/g)) {
    const value = match[0];
    for (let index = 0; index < value.length - 1; index += 1) {
      tokens.add(value.slice(index, index + 2));
    }
  }
  return tokens;
}

function relatedEntries(current) {
  const currentTokens = tokenSet(current);
  return state.entries
    .filter(entry => entry.id !== current.id)
    .map(entry => {
      const sharedTags = entry.tags.filter(tag => current.tags.includes(tag));
      const candidateTokens = tokenSet(entry);
      let sharedTokenCount = 0;
      currentTokens.forEach(token => {
        if (candidateTokens.has(token)) sharedTokenCount += 1;
      });
      const tokenScore = currentTokens.size
        ? Math.min(6, sharedTokenCount / Math.max(1, Math.sqrt(currentTokens.size)) * 2)
        : 0;
      const sameProject = Boolean(current.project && entry.project === current.project);
      const score = (sameProject ? 8 : 0) + sharedTags.length * 5 + tokenScore;
      const reasons = [];
      if (sameProject) reasons.push(I18n.t(`同项目：${current.project}`));
      if (sharedTags.length) reasons.push(I18n.t(`共同标签：${sharedTags.join("、")}`));
      if (!reasons.length && sharedTokenCount >= 2) {
        reasons.push(I18n.getLanguage() === "en" ? "Similar topic" : "内容主题相近");
      }
      return { entry, score, reason: reasons.join(" · ") };
    })
    .filter(item => item.score >= 2 && item.reason)
    .sort((a, b) => b.score - a.score ||
      new Date(b.entry.createdAt) - new Date(a.entry.createdAt))
    .slice(0, 3);
}

function sourceName(source) {
  if (!source) return I18n.t("手动录入");
  try {
    const hostname = new URL(source).hostname.replace(/^www\./, "");
    if (/chatgpt|openai/.test(hostname)) return "ChatGPT";
    if (/copilot|github/.test(hostname)) return "Copilot";
    if (/claude|anthropic/.test(hostname)) return "Claude";
    return hostname;
  } catch {
    return I18n.t("其他来源");
  }
}

function updateInsights() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sources = new Map();
  state.entries.forEach(entry => {
    const name = sourceName(entry.source);
    sources.set(name, (sources.get(name) || 0) + 1);
  });
  const primarySource = [...sources.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))[0];

  elements.totalMetric.textContent = String(state.entries.length);
  elements.weekMetric.textContent = String(
    state.entries.filter(entry => new Date(entry.createdAt).getTime() >= weekAgo).length
  );
  elements.viewMetric.textContent = String(
    state.entries.reduce((sum, entry) => sum + entry.viewCount, 0)
  );
  elements.sourceMetric.textContent = primarySource ? primarySource[0] : "—";
}

function updateBackendStatus() {
  const mode = KnowledgeStore.currentBackend();
  elements.backendStatus.className = `backend-status ${mode}`;
  elements.backendStatus.textContent = mode === "server"
    ? I18n.t("共享 SQLite 已连接")
    : mode === "security"
      ? I18n.t("安全错误：无法验证桌面伴侣身份")
    : mode === "pairing"
      ? I18n.t("需要配对桌面伴侣")
      : I18n.t("浏览器本地模式");
  elements.backendStatus.title = mode === "server"
    ? "浏览器扩展与桌面伴侣正在使用同一本地数据库"
    : mode === "security"
      ? "本地服务身份验证失败；未发送凭据或知识内容"
      : mode === "pairing"
      ? "请打开扩展弹窗输入桌面伴侣生成的配对码"
      : "启动桌面伴侣后，本地数据会自动迁移到共享数据库";
  elements.pairingForm.style.display = mode === "pairing" ? "block" : "none";
}

elements.pairingForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await KnowledgeStore.pairDesktop(elements.pairingCode.value);
    elements.pairingCode.value = "";
    showToast("桌面伴侣配对成功");
    await refreshEntries();
  } catch (error) {
    showToast(error.message || "配对失败");
  }
});

function formatSyncStatus(status) {
  elements.syncStatus.className = `sync-line${status.status === "error" ? " error" : ""}`;
  elements.syncStatus.title = status.path || "";
  if (!status.enabled) {
    elements.syncStatus.textContent = I18n.t(status.lastError || "OneDrive 同步未启用");
    return;
  }
  if (status.status === "syncing") {
    elements.syncStatus.textContent = I18n.t("OneDrive 正在同步…");
    return;
  }
  if (status.status === "error") {
    elements.syncStatus.textContent = I18n.t(`OneDrive 同步失败：${status.lastError}`);
    return;
  }
  elements.syncStatus.textContent = status.lastSyncAt
    ? I18n.t(`OneDrive 已同步 · ${formatTime(status.lastSyncAt)}`)
    : I18n.t("OneDrive 已启用，等待首次同步");
}

async function refreshSyncStatus() {
  try {
    formatSyncStatus(await KnowledgeStore.getCloudStatus());
  } catch (error) {
    formatSyncStatus({ enabled: false, status: "error", lastError: error.message });
  }
}

function statusLabel(value, english) {
  const labels = english
    ? {
        authenticated: "authenticated",
        "security-error": "identity error",
        "pairing-required": "pairing required",
        "paired-offline": "paired/offline",
        unpaired: "unpaired",
        offline: "offline",
        syncing: "syncing",
        error: "error",
        synced: "synced",
        disabled: "disabled"
      }
    : {
        authenticated: "已认证",
        "security-error": "身份错误",
        "pairing-required": "需要配对",
        "paired-offline": "已配对/离线",
        unpaired: "未配对",
        offline: "离线",
        syncing: "同步中",
        error: "错误",
        synced: "已同步",
        disabled: "未启用"
      };
  return labels[value] || (english ? "ready" : "就绪");
}

function currentReleaseVersion() {
  const identity = String(globalThis.__AI_KNOWLEDGE_RELEASE_VERSION || "").trim();
  return UpdateCore.parseSemver(identity)
    ? identity.replace(/^v/, "")
    : chrome.runtime.getManifest().version;
}

async function refreshVersionStatus() {
  try {
    const info = await KnowledgeStore.getVersionStatus();
    const english = I18n.getLanguage() === "en";
    const syncState = info.sync.enabled ? info.sync.status : (
      info.sync.status === "offline" ? "offline" : "disabled"
    );
    const releaseVersion = currentReleaseVersion();
    elements.versionStatus.textContent = english
      ? `Extension v${releaseVersion} · Desktop ${
          info.desktopVersion ? `v${info.desktopVersion}` : "not detected"
        } · Auth: ${statusLabel(info.authState, true)} · Sync: ${statusLabel(syncState, true)}`
      : `扩展 v${releaseVersion} · 桌面 ${
          info.desktopVersion ? `v${info.desktopVersion}` : "未检测到"
        } · 身份：${statusLabel(info.authState, false)} · 同步：${statusLabel(syncState, false)}`;
    elements.versionStatus.classList.toggle("warning", info.protocolMismatch);
    if (info.protocolMismatch) {
      elements.versionStatus.textContent += english
        ? ` · Warning: protocol major mismatch (${info.extensionProtocolVersion}/${info.desktopProtocolVersion})`
        : ` · 警告：协议主版本不兼容（${info.extensionProtocolVersion}/${info.desktopProtocolVersion}）`;
    }
  } catch (error) {
    elements.versionStatus.textContent = error.message;
    elements.versionStatus.classList.add("warning");
  }
}

async function loadUpdateChannel() {
  const saved = await chrome.storage.local.get({ updateChannel: "stable" });
  elements.prereleaseChannel.checked = saved.updateChannel === "prerelease";
}

elements.prereleaseChannel.addEventListener("change", async () => {
  await chrome.storage.local.set({
    updateChannel: elements.prereleaseChannel.checked ? "prerelease" : "stable"
  });
  elements.updateResult.textContent = "";
});

elements.checkUpdates.addEventListener("click", async () => {
  elements.checkUpdates.disabled = true;
  elements.updateResult.textContent = I18n.getLanguage() === "en"
    ? "Checking GitHub releases…"
    : "正在检查 GitHub Releases…";
  try {
    const result = await UpdateCore.checkForUpdates(
      currentReleaseVersion(),
      elements.prereleaseChannel.checked ? "prerelease" : "stable"
    );
    elements.updateResult.replaceChildren();
    if (result.status === "available") {
      elements.updateResult.append(document.createTextNode(
        I18n.getLanguage() === "en" ? `Version ${result.release.version} is available: ` :
          `发现新版本 ${result.release.version}：`
      ));
      const link = document.createElement("a");
      link.className = "release-link";
      link.href = result.release.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = I18n.getLanguage() === "en" ? "Open release" : "打开发布页";
      elements.updateResult.append(link);
    } else {
      elements.updateResult.textContent = I18n.getLanguage() === "en"
        ? "You are on the latest release for this channel."
        : "当前已是此渠道的最新版本。";
    }
  } catch {
    elements.updateResult.textContent = I18n.getLanguage() === "en"
      ? "Update check failed. Try again later."
      : "检查更新失败，请稍后重试。";
  } finally {
    elements.checkUpdates.disabled = false;
  }
});

function updateFilters() {
  const selectedProject = state.project;
  const selectedTag = state.tag;
  const projects = [...new Set(state.entries.map(entry => entry.project).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const tags = [...new Set(state.entries.flatMap(entry => entry.tags))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));

  fillSelect(elements.projectFilter, "全部项目", projects, selectedProject);
  fillSelect(elements.tagFilter, "全部标签", tags, selectedTag);
}

function fillSelect(select, defaultLabel, values, selected) {
  select.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = I18n.t(defaultLabel);
  select.append(defaultOption);
  values.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  select.value = values.includes(selected) ? selected : "";
}

function render() {
  updateFilters();
  updateInsights();
  updateBackendStatus();
  const entries = filteredEntries();
  elements.grid.replaceChildren();
  elements.count.textContent = I18n.t(state.query
    ? `找到 ${entries.length} 条，共 ${state.entries.length} 条`
    : `共 ${state.entries.length} 条`);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const title = document.createElement("strong");
    title.textContent = state.query ? "没有匹配结果" : "知识库还是空的";
    const text = document.createElement("span");
    text.textContent = state.query
      ? "换一个关键词试试。"
      : "在任意网页选中文字，右键保存到 AI 知识库。";
    empty.append(title, text);
    elements.grid.append(empty);
    I18n.apply(elements.grid);
    return;
  }

  entries.forEach(entry => {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h2");
    title.textContent = entry.title;
    const taxonomy = createTaxonomy(entry);
    const preview = document.createElement("p");
    preview.className = "preview";
    preview.textContent = entry.content;
    const footer = document.createElement("div");
    footer.className = "card-footer";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${formatTime(entry.createdAt)}${
      entry.viewCount ? ` · ${I18n.t(`预览 ${entry.viewCount}`)}` : ""
    }`;
    const actions = document.createElement("div");
    const exportButton = document.createElement("button");
    exportButton.className = "text-button preview-button";
    exportButton.type = "button";
    exportButton.textContent = "导出";
    exportButton.addEventListener("click", () => exportEntryMarkdown(entry));
    const previewButton = document.createElement("button");
    previewButton.className = "text-button preview-button";
    previewButton.type = "button";
    previewButton.textContent = "预览";
    previewButton.addEventListener("click", () => openPreview(entry));
    const view = document.createElement("button");
    view.className = "text-button";
    view.type = "button";
    view.textContent = "编辑";
    view.style.color = "var(--cp-link)";
    view.addEventListener("click", () => openEditor(entry));
    const remove = document.createElement("button");
    remove.className = "text-button";
    remove.type = "button";
    const approvalProposalId = entry.provenance?.origin === "agent" &&
      entry.approvedAt ? entry.provenance.proposalId : "";
    if (approvalProposalId && entry.status !== "deprecated") {
      remove.textContent = "撤销审批";
      remove.addEventListener("click", () => undoApprovedEntry(entry));
    } else {
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeEntry(entry.id));
    }
    actions.append(exportButton, previewButton, view);
    if (!(approvalProposalId && entry.status === "deprecated")) actions.append(remove);
    footer.append(meta, actions);
    card.append(title);
    if (taxonomy.childElementCount) card.append(taxonomy);
    card.append(preview, footer);
    elements.grid.append(card);
  });
  I18n.apply(elements.grid);
}

function createTaxonomy(entry) {
  const taxonomy = document.createElement("div");
  taxonomy.className = "taxonomy";
  if (entry.status && entry.status !== "raw") {
    const status = document.createElement("span");
    status.className = "chip";
    status.textContent = entry.status;
    taxonomy.append(status);
  }
  if (entry.project) {
    const project = document.createElement("span");
    project.className = "chip project";
    project.textContent = entry.project;
    taxonomy.append(project);
  }
  entry.tags.forEach(value => {
    const tag = document.createElement("span");
    tag.className = "chip";
    tag.textContent = `#${value}`;
    taxonomy.append(tag);
  });
  return taxonomy;
}

function openEditor(entry) {
  state.activeId = entry.id;
  elements.editMeta.textContent = I18n.getLanguage() === "en"
    ? `Created ${formatTime(entry.createdAt)}${entry.updatedAt ? ` · Updated ${formatTime(entry.updatedAt)}` : ""}`
    : `创建于 ${formatTime(entry.createdAt)}${entry.updatedAt ? ` · 更新于 ${formatTime(entry.updatedAt)}` : ""}`;
  elements.editTitle.value = entry.title;
  elements.editContent.value = entry.content;
  elements.editSummary.value = entry.summary;
  elements.editSource.value = entry.source;
  elements.editProject.value = entry.project;
  elements.editTags.value = entry.tags.join(", ");
  elements.editDialog.showModal();
}

async function openPreview(entry) {
  elements.previewTitle.textContent = entry.title;
  elements.previewMeta.textContent = `${entry.project ? `${entry.project} · ` : ""}${formatTime(entry.createdAt)}`;
  elements.previewSummary.textContent = entry.summary;
  elements.previewSummary.classList.toggle("hidden", !entry.summary);
  MarkdownRenderer.render(elements.markdownPreview, entry.content);
  renderRelated(entry);
  if (!elements.previewDialog.open) elements.previewDialog.showModal();
  const updated = await KnowledgeStore.recordView(entry.id);
  if (updated) {
    const index = state.entries.findIndex(item => item.id === updated.id);
    if (index >= 0) state.entries[index] = updated;
    render();
  }
}

function renderRelated(entry) {
  const related = relatedEntries(entry);
  elements.relatedList.replaceChildren();
  elements.relatedSection.classList.toggle("hidden", !related.length);
  related.forEach(item => {
    const button = document.createElement("button");
    button.className = "related-item";
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = item.entry.title;
    const reason = document.createElement("span");
    reason.textContent = item.reason;
    button.append(title, reason);
    button.addEventListener("click", () => openPreview(item.entry));
    elements.relatedList.append(button);
  });
}

async function removeEntry(id) {
  if (!confirm("确定删除这条知识吗？")) return;
  await KnowledgeStore.deleteEntry(id);
  state.entries = state.entries.filter(entry => entry.id !== id);
  render();
  showToast("已删除");
}

async function undoApprovedEntry(entry) {
  const proposalId = entry.provenance?.proposalId;
  if (!proposalId) {
    showToast(I18n.t("此审批知识缺少候选关联，无法撤销"));
    return;
  }
  try {
    await KnowledgeStore.decideProposal(proposalId, "undo", { actor: "local-user" });
    state.entries = await KnowledgeStore.getEntries();
    render();
    showToast(I18n.t("审批已撤销，知识已标记 deprecated"));
  } catch (error) {
    showToast(error.message);
  }
}

function showToast(message) {
  elements.toast.textContent = I18n.t(message);
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2000);
}

function safeFilename(value) {
  return String(value || "未命名知识")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "未命名知识";
}

function yamlValue(value) {
  return JSON.stringify(String(value || ""));
}

function entryMarkdown(entry, includeTitle = true) {
  const metadata = [
    "---",
    `title: ${yamlValue(entry.title)}`,
    `created: ${yamlValue(entry.createdAt)}`,
    `source: ${yamlValue(entry.source)}`,
    `project: ${yamlValue(entry.project)}`,
    `tags: [${entry.tags.map(yamlValue).join(", ")}]`,
    `status: ${yamlValue(entry.status || "raw")}`,
    `confidence: ${entry.confidence === null ? "null" : entry.confidence}`,
    `agentRunId: ${yamlValue(entry.agentRunId)}`,
    `approvedBy: ${yamlValue(entry.approvedBy)}`,
    `approvedAt: ${yamlValue(entry.approvedAt)}`,
    `supersedes: [${(entry.supersedes || []).map(yamlValue).join(", ")}]`,
    `relations: [${(entry.relations || []).map(yamlValue).join(", ")}]`,
    `provenance: ${yamlValue(JSON.stringify(entry.provenance || {}))}`,
    "---",
    ""
  ];
  if (includeTitle) metadata.push(`# ${entry.title}`, "");
  if (entry.summary) metadata.push("> 摘要", ">", ...entry.summary.split("\n").map(line => `> ${line}`), "");
  metadata.push(entry.content, "");
  return metadata.join("\n");
}

function downloadText(filename, content, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function localDateStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function exportEntryMarkdown(entry) {
  downloadText(`${safeFilename(entry.title)}.md`, entryMarkdown(entry));
  showToast("Markdown 已导出");
}

function exportAllMarkdown() {
  const entries = [...state.entries].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
  const sections = [
    "# AI 知识库导出",
    "",
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    `条目数量：${entries.length}`,
    "",
    ...entries.flatMap((entry, index) => [
      index ? "\n---\n" : "",
      entryMarkdown(entry)
    ])
  ];
  downloadText(`AI-知识库-${localDateStamp()}.md`, sections.join("\n"));
  showToast(`已导出 ${entries.length} 条知识`);
}

async function exportBackup() {
  let payload;
  try {
    payload = await KnowledgeStore.exportBundle();
  } catch (error) {
    showToast(error.message);
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-knowledge-backup-${localDateStamp()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${state.entries.length} 条知识`);
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.entries;
    if (parsed.version !== undefined && ![1, 2].includes(parsed.version)) {
      throw new Error("Unsupported backup version");
    }
    const count = await KnowledgeStore.importEntries(incoming, parsed.agentLedger);
    state.entries = await KnowledgeStore.getEntries();
    render();
    showToast(`已导入 ${count} 条新知识`);
  } catch {
    showToast("导入失败：备份文件格式不正确");
  } finally {
    elements.fileInput.value = "";
  }
}

elements.search.addEventListener("input", event => {
  state.query = event.target.value;
  render();
});
elements.searchMode.addEventListener("change", event => {
  state.searchMode = event.target.value;
  render();
});
elements.projectFilter.addEventListener("change", event => {
  state.project = event.target.value;
  render();
});
elements.tagFilter.addEventListener("change", event => {
  state.tag = event.target.value;
  render();
});
elements.sortOrder.addEventListener("change", event => {
  state.sortOrder = event.target.value;
  render();
});
elements.editForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.activeId) return;
  try {
    await KnowledgeStore.updateEntry(state.activeId, {
      title: elements.editTitle.value,
      content: elements.editContent.value,
      summary: elements.editSummary.value,
      source: elements.editSource.value,
      project: elements.editProject.value,
      tags: elements.editTags.value
    });
    state.entries = await KnowledgeStore.getEntries();
    elements.editDialog.close();
    render();
    showToast("修改已保存");
  } catch (error) {
    showToast(error.message || "保存失败");
  }
});
document.getElementById("organizeButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  const content = elements.editContent.value.trim();
  if (!content) {
    showToast("请先填写正文");
    return;
  }
  button.disabled = true;
  button.textContent = "正在整理…";
  try {
    const result = await BrowserAI.organize(content);
    elements.editTitle.value = result.title;
    elements.editSummary.value = result.summary;
    showToast("AI 整理完成，请确认后保存");
  } catch (error) {
    showToast(error.message || "AI 整理失败");
  } finally {
    button.disabled = false;
    button.textContent = "AI 智能整理";
  }
});
document.getElementById("exportMarkdownButton").addEventListener("click", exportAllMarkdown);
document.getElementById("askButton").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ask.html") });
});
document.getElementById("agentButton").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("agent.html") });
});
document.getElementById("syncButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "同步中…";
  try {
    const status = await KnowledgeStore.syncCloud();
    formatSyncStatus(status);
    await refreshEntries();
    showToast("OneDrive 同步完成");
  } catch (error) {
    formatSyncStatus({ enabled: false, status: "error", lastError: error.message });
    showToast(error.message || "OneDrive 同步失败");
  } finally {
    button.disabled = false;
    button.textContent = "立即同步";
  }
});
document.getElementById("exportButton").addEventListener("click", exportBackup);
document.getElementById("importButton").addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) importBackup(file);
});
document.getElementById("closeDialog").addEventListener("click", () => elements.editDialog.close());
document.getElementById("cancelEdit").addEventListener("click", () => elements.editDialog.close());
elements.editDialog.addEventListener("click", event => {
  if (event.target === elements.editDialog) elements.editDialog.close();
});
document.getElementById("closePreview").addEventListener("click", () => elements.previewDialog.close());
elements.previewDialog.addEventListener("click", event => {
  if (event.target === elements.previewDialog) elements.previewDialog.close();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.entries && KnowledgeStore.currentBackend() === "local") {
    state.entries = Array.isArray(changes.entries.newValue) ? changes.entries.newValue : [];
    render();
  }
});

async function refreshEntries() {
  try {
    state.entries = await KnowledgeStore.getEntries();
    render();
    await refreshSyncStatus();
    await refreshVersionStatus();
  } catch (error) {
    updateBackendStatus();
    if (error.pairingRequired) {
      elements.syncStatus.textContent = I18n.t("需要配对桌面伴侣");
      elements.versionStatus.textContent = I18n.t("需要配对桌面伴侣");
    }
    showToast(error.message || "读取知识库失败");
  }
}

window.addEventListener("focus", refreshEntries);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshEntries();
});

refreshEntries();
loadUpdateChannel();
setInterval(refreshSyncStatus, 30_000);
document.addEventListener("languagechange", () => {
  render();
  refreshSyncStatus();
  refreshVersionStatus();
  I18n.apply();
});
