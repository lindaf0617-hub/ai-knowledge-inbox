const askState = {
  entries: [],
  sources: [],
  question: "",
  answer: "",
  mode: "synthesize",
  citationValidation: null,
  providerConfig: ProviderCore.normalizeConfig(),
  providerStatus: "unavailable"
};
I18n.bindPicker(document.getElementById("languagePicker"));

const askElements = {
  question: document.getElementById("question"),
  mode: document.getElementById("answerMode"),
  submit: document.getElementById("askSubmit"),
  status: document.getElementById("aiStatus"),
  empty: document.getElementById("answerEmpty"),
  content: document.getElementById("answerContent"),
  markdown: document.getElementById("answerMarkdown"),
  citationWarning: document.getElementById("citationWarning"),
  sourceList: document.getElementById("sourceList"),
  sourceCount: document.getElementById("sourceCount"),
  save: document.getElementById("saveAnswer"),
  toast: document.getElementById("toast"),
  provider: document.getElementById("aiProvider"),
  ollamaSettings: document.getElementById("ollamaSettings"),
  ollamaModel: document.getElementById("ollamaModel")
};

function retrieve(question, entries, limit = 8) {
  return RetrievalGrounding.retrieve(
    question,
    entries,
    (query, entry) => SemanticSearch.similarity(query, entry),
    limit
  );
}

function showToast(message) {
  askElements.toast.textContent = I18n.t(message);
  askElements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => askElements.toast.classList.remove("show"), 3000);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function appendHighlightedExcerpt(container, text) {
  RetrievalGrounding.highlightSegments(text, askState.question).forEach(segment => {
    if (segment.match) {
      const mark = document.createElement("mark");
      mark.textContent = segment.text;
      container.append(mark);
    } else {
      container.append(document.createTextNode(segment.text));
    }
  });
}

function renderSources() {
  askElements.sourceList.replaceChildren();
  askElements.sourceCount.textContent = I18n.t(askState.sources.length
    ? `已选取 ${askState.sources.length} 条相关知识`
    : "没有找到相关知识");

  askState.sources.forEach((source, index) => {
    const entry = source.entry;
    const sourceId = `K${index + 1}`;
    const card = document.createElement("article");
    card.className = "source-card";
    card.id = `source-${sourceId}`;
    card.dataset.sourceId = sourceId;
    card.tabIndex = -1;
    card.setAttribute("aria-label", `${sourceId}: ${entry.title}`);

    const title = document.createElement("strong");
    const id = document.createElement("span");
    id.className = "source-id";
    id.textContent = `[${sourceId}] `;
    title.append(id, document.createTextNode(entry.title));

    const score = document.createElement("div");
    score.className = "source-score";
    score.textContent = `${I18n.t("检索匹配度")} ${Math.round(source.score * 100)}%`;

    const meta = document.createElement("div");
    meta.className = "source-meta";
    meta.textContent = [entry.project, entry.tags.join(" · ")]
      .filter(Boolean)
      .join(" // ") || (I18n.getLanguage() === "en" ? "Uncategorized" : "未分类");
    card.append(title, score, meta);

    if (source.excerpt) {
      const excerpt = document.createElement("p");
      excerpt.className = "source-excerpt";
      appendHighlightedExcerpt(excerpt, source.excerpt);
      card.append(excerpt);
    }

    const sourceUrl = safeHttpUrl(entry.source);
    if (sourceUrl) {
      const open = document.createElement("button");
      open.className = "source-open";
      open.type = "button";
      open.textContent = I18n.t("打开原始来源");
      open.addEventListener("click", event => {
        event.stopPropagation();
        chrome.tabs.create({ url: sourceUrl });
      });
      card.append(open);
    }
    askElements.sourceList.append(card);
  });
}

function renderCitationButtons() {
  const walker = document.createTreeWalker(askElements.markdown, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement.closest("code, pre, a, button")) textNodes.push(node);
  }
  textNodes.forEach(textNode => {
    const tokens = CitationGuard.splitTokens(textNode.nodeValue);
    if (!tokens.some(token => token.type === "citation")) return;
    const fragment = document.createDocumentFragment();
    tokens.forEach(token => {
      if (token.type === "text") {
        fragment.append(document.createTextNode(token.value));
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "citation-link";
      button.textContent = token.value;
      button.setAttribute("aria-label", I18n.getLanguage() === "en"
        ? `${token.value} — go to retrieved source`
        : `${token.value} — 跳转到检索来源`);
      button.addEventListener("click", () => {
        const card = document.getElementById(`source-K${token.id}`);
        if (!card) return;
        document.querySelectorAll(".source-card.citation-target")
          .forEach(item => item.classList.remove("citation-target"));
        card.classList.add("citation-target");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.focus({ preventScroll: true });
      });
      fragment.append(button);
    });
    textNode.replaceWith(fragment);
  });
}

function renderCitationWarning(validation) {
  askElements.citationWarning.replaceChildren();
  if (!validation || !validation.uncited.length) {
    askElements.citationWarning.classList.add("hidden");
    return;
  }
  const heading = document.createElement("strong");
  heading.textContent = I18n.t("引用检查警告");
  const description = document.createElement("p");
  description.textContent = I18n.t("以下重要段落没有来源引用，请谨慎核对：");
  const list = document.createElement("ul");
  validation.uncited.forEach(paragraph => {
    const item = document.createElement("li");
    item.textContent = paragraph.slice(0, 180);
    list.append(item);
  });
  askElements.citationWarning.append(heading, description, list);
  askElements.citationWarning.classList.remove("hidden");
}

function providerStatusText() {
  const { provider, ollamaModel } = askState.providerConfig;
  if (askState.providerStatus === "checking") {
    return I18n.t("正在检测 AI 提供方…");
  }
  if (provider === "ollama") {
    if (askState.providerStatus === "available") {
      return I18n.t(`Ollama 本地服务可用 · 模型：${ollamaModel}`);
    }
    if (askState.providerStatus === "model-missing") {
      return I18n.t(`Ollama 服务可用，但模型未安装：${ollamaModel}`);
    }
    return I18n.t("无法连接本地 Ollama · 请确认服务正在运行");
  }
  if (askState.providerStatus === "available") {
    return I18n.t("浏览器内置 AI 可用 · 内容在设备本地处理");
  }
  if (["downloadable", "downloading"].includes(askState.providerStatus)) {
    return I18n.t("浏览器 AI 模型将在首次使用时下载");
  }
  return I18n.t("浏览器内置 AI 不可用 · 仍可查看本地检索来源");
}

function renderProviderStatus() {
  askElements.status.className = "status";
  if (askState.providerStatus === "available") {
    askElements.status.classList.add("available");
  } else if (!["checking", "downloadable", "downloading"].includes(askState.providerStatus)) {
    askElements.status.classList.add("unavailable");
  }
  askElements.status.querySelector("span:last-child").textContent = providerStatusText();
}

async function refreshProviderStatus() {
  askState.providerStatus = "checking";
  renderProviderStatus();
  try {
    askState.providerStatus = await AIProviders
      .get(askState.providerConfig.provider)
      .getStatus(askState.providerConfig);
  } catch {
    askState.providerStatus = "unavailable";
  }
  renderProviderStatus();
}

function applyProviderControls() {
  askElements.provider.value = askState.providerConfig.provider;
  askElements.ollamaModel.value = askState.providerConfig.ollamaModel;
  askElements.ollamaSettings.classList.toggle(
    "hidden",
    askState.providerConfig.provider !== "ollama"
  );
}

async function saveProviderSettings() {
  askState.providerConfig = ProviderCore.normalizeConfig({
    provider: askElements.provider.value,
    ollamaModel: askElements.ollamaModel.value
  });
  applyProviderControls();
  await chrome.storage.local.set({ askProviderSettings: askState.providerConfig });
  await refreshProviderStatus();
}

function resetAnswer() {
  askState.answer = "";
  askState.citationValidation = null;
  askElements.markdown.replaceChildren();
  renderCitationWarning(null);
  askElements.content.classList.add("hidden");
  askElements.empty.classList.remove("hidden");
}

async function askKnowledgeBase() {
  const question = RetrievalGrounding.normalizeQuery(askElements.question.value);
  if (!question) {
    showToast("请先输入问题");
    askElements.question.focus();
    return;
  }
  askElements.question.value = question;

  resetAnswer();
  askState.question = question;
  askState.mode = askElements.mode.value;
  askState.sources = retrieve(question, askState.entries);
  renderSources();
  if (!askState.sources.length) {
    showToast("没有找到足够相关的知识");
    return;
  }

  askElements.submit.disabled = true;
  askElements.submit.textContent = I18n.t("AI 正在整合…");
  try {
    const providerAnswer = await AIProviders.get(askState.providerConfig.provider).answer(
      askState.question,
      askState.sources,
      askState.mode,
      I18n.getLanguage(),
      askState.providerConfig
    );
    const candidate = CitationGuard.normalizeCitationLinks(providerAnswer);
    const validation = CitationGuard.validate(candidate, askState.sources.length);
    if (validation.invalid.length) {
      const ids = validation.invalid.map(id => `[K${id}]`).join("、");
      throw new Error(I18n.getLanguage() === "en"
        ? `AI returned invalid citation IDs: ${ids}`
        : `AI 返回了无效引用：${ids}`);
    }
    if (!validation.valid) {
      throw new Error(I18n.t("AI 回答没有有效引用，已拒绝显示"));
    }
    askState.answer = candidate;
    askState.citationValidation = validation;
    MarkdownRenderer.render(askElements.markdown, askState.answer);
    renderCitationButtons();
    renderCitationWarning(validation);
    askElements.empty.classList.add("hidden");
    askElements.content.classList.remove("hidden");
  } catch (error) {
    showToast(error.message || "生成回答失败");
  } finally {
    askElements.submit.disabled = false;
    askElements.submit.textContent = I18n.t("检索并回答");
  }
}

function savedAnswerMarkdown() {
  const references = askState.sources.map((source, index) => {
    const entry = source.entry;
    const label = `[K${index + 1}] ${entry.title}`;
    const sourceUrl = safeHttpUrl(entry.source);
    return sourceUrl ? `- [${label}](${sourceUrl})` : `- ${label}`;
  });
  return [
    `# ${askState.question}`,
    "",
    askState.answer,
    "",
    I18n.getLanguage() === "en" ? "## Sources" : "## 引用来源",
    ...references
  ].join("\n");
}

askElements.submit.addEventListener("click", askKnowledgeBase);
askElements.question.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") askKnowledgeBase();
});
askElements.provider.addEventListener("change", () => {
  saveProviderSettings().catch(error => showToast(error.message || "保存设置失败"));
});
askElements.ollamaModel.addEventListener("change", () => {
  saveProviderSettings().catch(error => showToast(error.message || "保存设置失败"));
});
askElements.save.addEventListener("click", async () => {
  if (!askState.answer) return;
  try {
    await KnowledgeStore.addEntry({
      title: I18n.getLanguage() === "en"
        ? `Knowledge answer: ${askState.question.slice(0, 40)}`
        : `知识库回答：${askState.question.slice(0, 40)}`,
      content: savedAnswerMarkdown(),
      project: "AI 知识整合",
      tags: ["AI", "知识整合"],
      summary: I18n.t(`基于 ${askState.sources.length} 条知识生成的回答`)
    });
    showToast("回答已保存到知识库");
  } catch (error) {
    showToast(error.message || "保存回答失败");
  }
});
document.getElementById("backButton").addEventListener("click", () => {
  location.href = chrome.runtime.getURL("library.html");
});

Promise.all([
  KnowledgeStore.getEntries(),
  chrome.storage.local.get("askProviderSettings")
]).then(([entries, settings]) => {
  askState.entries = entries;
  askState.providerConfig = ProviderCore.normalizeConfig(settings.askProviderSettings);
  applyProviderControls();
  return refreshProviderStatus();
}).catch(error => {
  askState.providerStatus = "unavailable";
  renderProviderStatus();
  showToast(error.message || "知识库加载失败");
});
document.addEventListener("languagechange", () => {
  renderProviderStatus();
  renderSources();
  renderCitationWarning(askState.citationValidation);
  I18n.apply();
});
