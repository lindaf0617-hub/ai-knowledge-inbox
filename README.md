# AI Knowledge Inbox

> 把散落在 Copilot、ChatGPT、Claude 和网页里的 AI 产出，变成一个本地优先、可搜索、可追溯、可继续生长的个人知识库。

[English](README_EN.md)

Windows / macOS companion | Edge / Chrome extension | SQLite | OneDrive | Cited Ask

---

AI Knowledge Inbox 解决一个简单问题：**AI 每天生成很多有价值的内容，但它们通常留在不同应用和会话里，之后很难再次找到和复用。**

它提供：

- 桌面端复制后按快捷键保存：Windows `Ctrl + ;`，macOS `Command + ;`
- 浏览器选区右键保存，保留常见 Markdown 格式
- 项目、标签、摘要、关键词与本地语义搜索
- Ask 知识库：本地检索，浏览器内置 AI 综合，回答附 `[K1]` 引用
- SQLite 本地存储和用户自己的 OneDrive 同步
- 因果操作日志同步、显式冲突处理与保留 7 份的每日 SQLite 备份
- 中文 / English 界面
- Markdown 和 JSON 导出

---

![Knowledge library](store-assets/screenshot-library.png)

![Ask with citations](store-assets/screenshot-ask.png)

---

## 安装

从 [v1.6.0 Beta](https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.6.0) 下载：

- Windows：`AI-Knowledge-Inbox-<version>-Windows.zip`
- Apple Silicon：`AI-Knowledge-Inbox-<version>-macOS-arm64-unsigned.dmg`
- Intel Mac：`AI-Knowledge-Inbox-<version>-macOS-x64-unsigned.dmg`
- 仅浏览器扩展：`AI-Knowledge-Inbox-Extension-<version>.zip`

Windows 解压后运行 `安装 Beta.cmd`。macOS 首个 Beta 尚未签名，需按 Release 说明允许打开。

浏览器扩展暂以 Developer mode 加载；商店版本准备中。

---

## 隐私

- 主库保存在本机 SQLite
- 本地服务只监听 `127.0.0.1`
- OneDrive 同步写入用户自己的 OneDrive
- 无托管后端、广告或遥测
- Ask 仅在浏览器支持 Prompt API 时调用内置 AI

详见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

同步 v2 在 OneDrive 的 `Apps\AI Knowledge Inbox\operations` 中为每台设备保存独立操作日志；
`knowledge-sync.json` 仅是可读兼容快照。桌面服务提供 `/sync/status`、`/sync/conflicts`
和 `/backups` 接口用于检查同步、解决冲突及恢复本地备份。
在限时 v1 迁移窗口内，v2 只读取兼容快照，以免覆盖仍在运行的 v1 设备写入；
因此窗口完成前，v1 设备不会收到 v2 新产生的更改。

---

## 项目资料

- [唯一源码与发布规则](SOURCE_OF_TRUTH.md)
- [完整项目记录](PROJECT_RECORD.md)
- [黑客松项目陈述](HACKATHON.md)
- [知识 Agent 路线图](AGENT_ROADMAP.md)
- [发布说明](PUBLISHING.md)

---

MIT License.
