importScripts("storage.js");

const MENU_ID = "save-to-ai-knowledge";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "保存到 AI 知识库",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;

  try {
    let content = info.selectionText;
    if (tab && tab.id) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["capture-selection.js"]
        });
        if (results[0] && results[0].result) content = results[0].result;
      } catch {
        content = info.selectionText;
      }
    }
    await KnowledgeStore.addEntry({
      title: tab && tab.title ? tab.title : "",
      content,
      source: info.pageUrl || (tab && tab.url) || ""
    });
    await showBadge("✓");
  } catch (error) {
    await showBadge(error && error.message && error.message.includes("已经保存") ? "重复" : "!");
  }
});

async function showBadge(text) {
  const color = text === "✓" ? "#16a34a" : text === "重复" ? "#f59e0b" : "#dc2626";
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
}
