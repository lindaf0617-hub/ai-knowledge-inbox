const form = document.getElementById("entryForm");
const contentInput = document.getElementById("content");
const titleInput = document.getElementById("title");
const sourceInput = document.getElementById("source");
const projectInput = document.getElementById("project");
const tagsInput = document.getElementById("tags");
const status = document.getElementById("status");
const backendStatus = document.getElementById("backend");
I18n.bindPicker(document.getElementById("languagePicker"));

async function updateBackendStatus() {
  const mode = await KnowledgeStore.getBackendStatus();
  backendStatus.textContent = mode === "server"
    ? I18n.t("共享 SQLite 已连接")
    : `${I18n.t("浏览器本地模式")} · ${
      I18n.getLanguage() === "en"
        ? "Start the desktop companion to migrate automatically"
        : "启动桌面伴侣后自动迁移"
    }`;
  backendStatus.style.color = mode === "server"
    ? "var(--cp-success)"
    : "var(--cp-warning)";
}

function applySuggestedTags(force = false) {
  if (!force && tagsInput.value.trim()) return;
  const tags = KnowledgeStore.suggestTags(
    contentInput.value,
    titleInput.value,
    sourceInput.value
  );
  tagsInput.value = tags.join(", ");
}

async function loadPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    titleInput.value = tab.title || "";
    sourceInput.value = /^https?:/.test(tab.url || "") ? tab.url : "";
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture-selection.js"]
    });
    contentInput.value = results[0] && results[0].result ? results[0].result.trim() : "";
  } catch {
    status.textContent = "此页面不允许自动读取，请直接粘贴内容。";
    status.style.color = "var(--cp-warning)";
  }
  applySuggestedTags();
  contentInput.focus();
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const content = contentInput.value.trim();
  if (!content) return;

  try {
    await KnowledgeStore.addEntry({
      title: titleInput.value,
      content,
      source: sourceInput.value,
      project: projectInput.value,
      tags: tagsInput.value
    });
    status.textContent = I18n.t("已保存到知识库");
    status.style.color = "var(--cp-success)";
    contentInput.value = "";
    await updateBackendStatus();
  } catch (error) {
    status.textContent = I18n.t(error.message || "保存失败");
    status.style.color = "var(--cp-danger)";
  }
});

document.getElementById("openLibrary").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
});
document.getElementById("suggestTags").addEventListener("click", () => {
  applySuggestedTags(true);
  status.textContent = I18n.t(tagsInput.value ? "标签建议已更新" : "暂未识别出合适标签");
  status.style.color = "var(--cp-text-muted)";
});
contentInput.addEventListener("blur", () => applySuggestedTags());

loadPageContext();
updateBackendStatus();
document.addEventListener("languagechange", () => {
  updateBackendStatus();
  I18n.apply();
});
