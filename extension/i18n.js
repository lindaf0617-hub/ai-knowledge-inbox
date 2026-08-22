const I18n = (() => {
  const EN = {
    "AI 知识收件箱": "AI Knowledge Inbox",
    "保存到知识库": "Save to knowledge base",
    "自动带入当前页面选中的文字。": "Automatically includes selected text from the current page.",
    "打开知识库": "Open library",
    "正在检测存储…": "Checking storage...",
    "内容": "Content",
    "选中文字，或在这里粘贴…": "Select text or paste it here...",
    "标题": "Title",
    "默认使用页面标题": "Uses the page title by default",
    "项目（可选）": "Project (optional)",
    "例如：知识库 MVP": "Example: Knowledge MVP",
    "标签（可选）": "Tags (optional)",
    "重新建议": "Suggest again",
    "产品, Agent, 灵感": "Product, Agent, Idea",
    "根据当前内容在本地自动建议，可直接修改。": "Suggested locally from the content; edit freely.",
    "来源": "Source",
    "保存": "Save",
    "来自浏览器和桌面伴侣的知识，都保存在这里。": "Knowledge from the browser and desktop companion lives here.",
    "正在检测 OneDrive 同步…": "Checking OneDrive sync...",
    "正在检测版本和身份状态…": "Checking version and authentication status...",
    "检查更新": "Check updates",
    "包含预发布版": "Include prereleases",
    "Ask 知识库": "Ask library",
    "配色 1 · 鲜艳": "Skin 1 · Vivid",
    "配色 2 · 科技": "Skin 2 · Technology",
    "立即同步": "Sync now",
    "导出全部 Markdown": "Export all Markdown",
    "导出备份": "Export backup",
    "导入备份": "Import backup",
    "全部知识": "All knowledge",
    "近 7 天新增": "Added in 7 days",
    "累计预览": "Total views",
    "主要来源": "Top source",
    "输入多个关键词，按相关性搜索…": "Enter keywords to search by relevance...",
    "关键词": "Keyword",
    "语义向量": "Semantic vector",
    "全部项目": "All projects",
    "全部标签": "All tags",
    "最新保存": "Newest",
    "最多预览": "Most viewed",
    "最近预览": "Recently viewed",
    "编辑知识": "Edit knowledge",
    "关闭": "Close",
    "浏览器内置 AI 在设备本地生成，不上传到外部服务。": "Browser built-in AI runs on-device and is not sent to an external service.",
    "AI 智能整理": "Organize with AI",
    "摘要": "Summary",
    "可手动填写，或使用浏览器内置 AI 生成": "Enter manually or generate with browser built-in AI",
    "项目": "Project",
    "标签": "Tags",
    "多个标签用逗号分隔。": "Separate tags with commas.",
    "取消": "Cancel",
    "保存修改": "Save changes",
    "相关知识": "Related knowledge",
    "正在检测浏览器内置 AI…": "Checking browser built-in AI...",
    "正在检测 AI 提供方…": "Checking AI provider...",
    "从你的知识中检索、整合并给出可追溯回答。": "Retrieve and synthesize traceable answers from your knowledge.",
    "返回知识库": "Back to library",
    "你想从知识库中了解什么？": "What do you want to learn from your knowledge base?",
    "例如：整合我关于 Agent 安全的观点，并列出下一步行动。": "Example: Synthesize my Agent security ideas and list next actions.",
    "综合总结": "Synthesize",
    "对比分析": "Compare",
    "行动清单": "Action list",
    "时间线": "Timeline",
    "检索并回答": "Retrieve and answer",
    "答案将在这里生成": "Your answer will appear here",
    "问题会先在本地检索，再由浏览器内置 AI 综合。": "The question is retrieved locally, then synthesized by browser built-in AI.",
    "问题会先在本地检索，再由所选 AI 提供方综合。": "The question is retrieved locally, then synthesized by the selected AI provider.",
    "知识库回答": "Knowledge answer",
    "保存回答": "Save answer",
    "检索来源": "Retrieved sources",
    "尚未检索": "Not retrieved yet",
    "检索与向量计算均在本地完成。只有选中的来源会交给浏览器内置 AI。": "Retrieval and vectors run locally. Only selected sources are provided to browser built-in AI.",
    "检索与向量计算均在本地完成。只有选中的来源会交给所选 AI 提供方。": "Retrieval and vectors run locally. Only selected sources are sent to the selected AI provider.",
    "打开原始来源": "Open original source",
    "AI 提供方": "AI provider",
    "浏览器内置 Prompt API": "Browser built-in Prompt API",
    "本地 Ollama": "Local Ollama",
    "Ollama 模型": "Ollama model",
    "检索匹配度": "Retrieval match",
    "引用检查警告": "Citation check warning",
    "以下重要段落没有来源引用，请谨慎核对：": "The following substantial paragraphs have no source citation; verify them carefully:",
    "AI 回答没有有效引用，已拒绝显示": "The AI answer had no valid citation and was rejected",
    "无法连接本地 Ollama · 请确认服务正在运行": "Cannot reach local Ollama · Make sure the service is running",
    "保存设置失败": "Failed to save settings",
    "浏览器本地模式": "Browser-local mode",
    "共享 SQLite 已连接": "Shared SQLite connected",
    "需要配对桌面伴侣": "Pair desktop companion",
    "安全错误：无法验证桌面伴侣身份": "Security error: desktop companion identity could not be verified",
    "安全错误：无法验证桌面伴侣身份，请停止操作并重新启动桌面伴侣": "Security error: desktop companion identity could not be verified. Stop and restart the companion.",
    "请先配对桌面伴侣": "Pair the desktop companion first",
    "在桌面伴侣菜单中生成配对码，然后在这里输入。": "Generate a pairing code from the desktop companion menu, then enter it here.",
    "8 位配对码": "8-character code",
    "配对": "Pair",
    "桌面伴侣配对成功": "Desktop companion paired",
    "配对失败": "Pairing failed",
    "OneDrive 正在同步…": "Syncing OneDrive...",
    "OneDrive 已启用，等待首次同步": "OneDrive enabled; waiting for first sync",
    "知识库还是空的": "Your library is empty",
    "在任意网页选中文字，右键保存到 AI 知识库。": "Select text on any page and right-click to save it.",
    "没有匹配结果": "No matching results",
    "换一个关键词试试。": "Try another keyword.",
    "导出": "Export",
    "预览": "Preview",
    "编辑": "Edit",
    "删除": "Delete",
    "手动录入": "Manual entry",
    "其他来源": "Other source",
    "暂未识别出合适标签": "No suitable tags found",
    "标签建议已更新": "Tag suggestions updated",
    "已保存到知识库": "Saved to the knowledge base",
    "修改已保存": "Changes saved",
    "已删除": "Deleted",
    "OneDrive 同步完成": "OneDrive sync complete",
    "正在整理…": "Organizing...",
    "AI 整理完成，请确认后保存": "AI organization complete; review and save",
    "请先填写正文": "Enter content first",
    "请先输入问题": "Enter a question first",
    "没有找到足够相关的知识": "Not enough relevant knowledge found",
    "AI 正在整合…": "AI is synthesizing...",
    "生成回答失败": "Failed to generate answer",
    "回答已保存到知识库": "Answer saved to the knowledge base",
    "保存回答失败": "Failed to save answer",
    "没有找到可用于回答的内容": "No knowledge found for this answer",
    "浏览器内置 AI 可用 · 内容在设备本地处理": "Browser built-in AI available · Content is processed on-device",
    "浏览器 AI 模型将在首次使用时下载": "The browser AI model will download on first use",
    "浏览器内置 AI 不可用 · 仍可查看本地检索来源": "Browser built-in AI unavailable · Local retrieval sources remain available",
    "当前浏览器未启用内置 AI，请使用支持 Prompt API 的 Chrome/Edge 版本": "Browser built-in AI is not enabled. Use a Chrome/Edge version that supports Prompt API.",
    "当前设备不支持浏览器内置 AI": "This device does not support browser built-in AI",
    "浏览器 AI 未生成回答": "Browser AI did not generate an answer",
    "回答已生成，但部分长段落没有引用": "Answer generated; some long paragraphs have no citation",
    "Ask AI 知识库": "Ask AI Knowledge Base",
    "PRIVATE RAG // ON-DEVICE AI": "PRIVATE RAG // ON-DEVICE AI",
    "KNOWLEDGE SYSTEM // ONLINE": "KNOWLEDGE SYSTEM // ONLINE",
    "本地检索、明确审批、可追溯写入。": "Local retrieval, explicit approval, traceable writes.",
    "默认只读：": "Read-only by default:",
    "Agent 只生成分析和候选卡。模型输出是不可信建议，绝不会自动写入；每张卡必须由你审批。外部搜索不可用。": "The Agent only generates analysis and candidate cards. Model output is an untrusted suggestion and is never written automatically; you must approve every card. External search is unavailable.",
    "目标": "Goal",
    "例如：总结 Agent 安全资料并形成三条可复用原则": "Example: Summarize Agent security material into three reusable principles",
    "输出格式": "Output format",
    "分析报告": "Analysis report",
    "简报": "Brief",
    "时间范围": "Time range",
    "全部时间": "All time",
    "近 7 天": "Past 7 days",
    "近 30 天": "Past 30 days",
    "近一年": "Past year",
    "外部资料补充（未来功能）": "External supplementation (future)",
    "尚未实现 / Not implemented": "Not implemented",
    "生成计划": "Create plan",
    "运行 Agent": "Run Agent",
    "取消运行": "Cancel run",
    "执行前确认": "Pre-run review",
    "最终分析": "Final analysis",
    "候选知识卡": "Candidate knowledge cards",
    "逐条审批。批准后默认写入 draft；可明确选择 verified。撤销采用 deprecated 墓碑策略，保留 provenance 与审计记录。": "Review each card. Approval writes draft by default; verified can be explicitly selected. Undo marks the entry deprecated and retains provenance and audit history.",
    "请先输入目标": "Enter a goal first",
    "计划已保存。确认来源后点击“运行 Agent”。": "Plan saved. Review the sources, then click Run Agent.",
    "Agent 正在本地分析…": "Agent is analyzing locally...",
    "Agent 已完成。请逐条审查候选知识。": "Agent complete. Review each candidate.",
    "批准写入": "Approve write",
    "拒绝": "Reject",
    "撤销写入": "Undo write",
    "撤销审批": "Undo approval",
    "审批已撤销，知识已标记 deprecated": "Approval undone; knowledge marked deprecated",
    "此审批知识缺少候选关联，无法撤销": "This approved entry has no proposal link and cannot be undone",
    "查看候选正文": "View candidate content",
    "候选知识已批准并写入": "Candidate approved and written",
    "候选知识已拒绝": "Candidate rejected",
    "写入已撤销；知识已标记 deprecated": "Write undone; knowledge marked deprecated",
    "Agent 运行已取消": "Agent run cancelled",
    "Agent 正在运行，不能重新规划": "The Agent is running and cannot be replanned",
    "此候选属于旧运行，操作已拒绝": "This candidate belongs to an older run; the action was rejected"
  };

  const languages = { zh: {}, en: EN };
  let language = localStorage.getItem("ui-language") || "zh";

  function translateDynamic(value) {
    if (language !== "en") return value;
    const patterns = [
      [/^共 (\d+) 条$/, "$1 items"],
      [/^找到 (\d+) 条，共 (\d+) 条$/, "$1 found / $2 total"],
      [/^已选取 (\d+) 条相关知识$/, "$1 relevant sources selected"],
      [/^Ollama 本地服务可用 · 模型：(.+)$/, "Local Ollama available · Model: $1"],
      [/^Ollama 服务可用，但模型未安装：(.+)$/, "Ollama is available, but the model is not installed: $1"],
      [/^基于 (\d+) 条知识生成的回答$/, "Answer generated from $1 knowledge items"],
      [/^知识库回答：(.+)$/, "Knowledge answer: $1"],
      [/^保存于 (.+)$/, "Saved $1"],
      [/^创建于 (.+)$/, "Created $1"],
      [/^预览 (\d+)$/, "$1 views"],
      [/^已导入 (\d+) 条新知识$/, "Imported $1 new items"],
      [/^已导出 (\d+) 条知识$/, "Exported $1 items"],
      [/^OneDrive 已同步 · (.+)$/, "OneDrive synced · $1"],
      [/^OneDrive 同步失败：(.+)$/, "OneDrive sync failed: $1"],
      [/^同项目：(.+)$/, "Same project: $1"],
      [/^共同标签：(.+)$/, "Shared tags: $1"]
    ];
    for (const [pattern, replacement] of patterns) {
      if (pattern.test(value)) return value.replace(pattern, replacement);
    }
    return value;
  }

  function t(value) {
    const text = String(value || "");
    return languages[language][text] || translateDynamic(text);
  }

  function apply(root = document) {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (["SCRIPT", "STYLE"].includes(node.parentElement && node.parentElement.tagName)) continue;
      if (node.__i18nOriginal === undefined) node.__i18nOriginal = node.nodeValue;
      const original = node.__i18nOriginal;
      const trimmed = original.trim();
      if (!trimmed) continue;
      const translated = t(trimmed);
      node.nodeValue = original.replace(trimmed, translated);
    }
    root.querySelectorAll("[placeholder]").forEach(element => {
      if (!element.dataset.i18nPlaceholder) {
        element.dataset.i18nPlaceholder = element.getAttribute("placeholder");
      }
      element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
    });
    root.querySelectorAll("[aria-label]").forEach(element => {
      if (!element.dataset.i18nAria) element.dataset.i18nAria = element.getAttribute("aria-label");
      element.setAttribute("aria-label", t(element.dataset.i18nAria));
    });
    root.querySelectorAll(".language-picker").forEach(element => { element.value = language; });
  }

  function setLanguage(value) {
    language = value === "en" ? "en" : "zh";
    localStorage.setItem("ui-language", language);
    apply();
    document.dispatchEvent(new CustomEvent("languagechange", { detail: { language } }));
  }

  function bindPicker(element) {
    if (!element) return;
    element.value = language;
    element.addEventListener("change", event => setLanguage(event.target.value));
  }

  return {
    apply,
    bindPicker,
    getLanguage: () => language,
    setLanguage,
    t
  };
})();

document.addEventListener("DOMContentLoaded", () => I18n.apply());
