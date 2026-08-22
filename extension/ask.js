const askState = {
  entries: [],
  sources: [],
  question: "",
  answer: "",
  mode: "synthesize"
};

const askElements = {
  question: document.getElementById("question"),
  mode: document.getElementById("answerMode"),
  submit: document.getElementById("askSubmit"),
  status: document.getElementById("aiStatus"),
  empty: document.getElementById("answerEmpty"),
  content: document.getElementById("answerContent"),
  markdown: document.getElementById("answerMarkdown"),
  sourceList: document.getElementById("sourceList"),
  sourceCount: document.getElementById("sourceCount"),
  save: document.getElementById("saveAnswer"),
  toast: document.getElementById("toast")
};

function keywordScore(question, entry) {
  const terms = String(question || "")
    .toLocaleLowerCase("zh-CN")
    .split(/\s+/)
    .filter(term => term.length > 1);
  if (!terms.length) return 0;
  const title = entry.title.toLocaleLowerCase("zh-CN");
  const tags = entry.tags.join(" ").toLocaleLowerCase("zh-CN");
  const project = entry.project.toLocaleLowerCase("zh-CN");
  const content = `${entry.summary}\n${entry.content}`.toLocaleLowerCase("zh-CN");
  return terms.reduce((score, term) => {
    if (title.includes(term)) score += 6;
    if (tags.includes(term)) score += 5;
    if (project.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
    return score;
  }, 0);
}

function retrieve(question, entries, limit = 8) {
  return entries
    .map(entry => {
      const semantic = Math.max(0, SemanticSearch.similarity(question, entry));
      const keyword = keywordScore(question, entry);
      return { entry, score: semantic * 10 + keyword };
    })
    .filter(item => item.score >= 0.12)
    .sort((left, right) =>
      right.score - left.score ||
      new Date(right.entry.updatedAt || right.entry.createdAt) -
        new Date(left.entry.updatedAt || left.entry.createdAt)
    )
    .slice(0, limit)
    .map(item => item.entry);
}

function showToast(message) {
  askElements.toast.textContent = message;
  askElements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => askElements.toast.classList.remove("show"), 2200);
}

function renderSources() {
  askElements.sourceList.replaceChildren();
  askElements.sourceCount.textContent = askState.sources.length
    ? `已选取 ${askState.sources.length} 条相关知识`
    : "没有找到相关知识";

  askState.sources.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "source-card";
    const title = document.createElement("strong");
    const id = document.createElement("span");
    id.className = "source-id";
    id.textContent = `[K${index + 1}] `;
    title.append(id, document.createTextNode(entry.title));
    const meta = document.createElement("div");
    meta.className = "source-meta";
    meta.textContent = [entry.project, entry.tags.join(" · ")]
      .filter(Boolean)
      .join(" // ") || "未分类";
    card.append(title, meta);

    if (entry.source && /^https?:/i.test(entry.source)) {
      const open = document.createElement("button");
      open.className = "source-open";
      open.type = "button";
      open.textContent = "打开原始来源";
      open.addEventListener("click", () => chrome.tabs.create({ url: entry.source }));
      card.append(open);
    }
    askElements.sourceList.append(card);
  });
}

function setAiStatus(status) {
  askElements.status.className = "status";
  const label = askElements.status.querySelector("span:last-child");
  if (status === "available") {
    askElements.status.classList.add("available");
    label.textContent = "浏览器内置 AI 可用 · 内容在设备本地处理";
  } else if (status === "downloadable" || status === "downloading") {
    label.textContent = "浏览器 AI 模型将在首次使用时下载";
  } else {
    askElements.status.classList.add("unavailable");
    label.textContent = "浏览器内置 AI 不可用 · 仍可查看本地检索来源";
  }
}

async function askKnowledgeBase() {
  const question = askElements.question.value.trim();
  if (!question) {
    showToast("请先输入问题");
    askElements.question.focus();
    return;
  }

  askState.question = question;
  askState.mode = askElements.mode.value;
  askState.sources = retrieve(question, askState.entries);
  renderSources();
  if (!askState.sources.length) {
    showToast("没有找到足够相关的知识");
    return;
  }

  askElements.submit.disabled = true;
  askElements.submit.textContent = "AI 正在整合…";
  try {
    askState.answer = await BrowserAI.answer(
      askState.question,
      askState.sources,
      askState.mode
    );
    MarkdownRenderer.render(askElements.markdown, askState.answer);
    askElements.empty.classList.add("hidden");
    askElements.content.classList.remove("hidden");
  } catch (error) {
    showToast(error.message || "生成回答失败");
  } finally {
    askElements.submit.disabled = false;
    askElements.submit.textContent = "检索并回答";
  }
}

function savedAnswerMarkdown() {
  const references = askState.sources.map((entry, index) => {
    const label = `[K${index + 1}] ${entry.title}`;
    return entry.source ? `- [${label}](${entry.source})` : `- ${label}`;
  });
  return [
    `# ${askState.question}`,
    "",
    askState.answer,
    "",
    "## 引用来源",
    ...references
  ].join("\n");
}

askElements.submit.addEventListener("click", askKnowledgeBase);
askElements.question.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") askKnowledgeBase();
});
askElements.save.addEventListener("click", async () => {
  if (!askState.answer) return;
  try {
    await KnowledgeStore.addEntry({
      title: `知识库回答：${askState.question.slice(0, 40)}`,
      content: savedAnswerMarkdown(),
      project: "AI 知识整合",
      tags: ["AI", "知识整合"],
      summary: `基于 ${askState.sources.length} 条知识生成的回答`
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
  BrowserAI.getStatus().catch(() => "unavailable")
]).then(([entries, status]) => {
  askState.entries = entries;
  setAiStatus(status);
}).catch(error => {
  setAiStatus("unavailable");
  showToast(error.message || "知识库加载失败");
});
