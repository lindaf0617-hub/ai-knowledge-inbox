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
- Ask 知识库：本地检索，可选浏览器内置 AI 或本机 Ollama 综合，回答附可点击的 `[K1]` 引用、匹配分数和原文摘录
- SQLite 本地存储和用户自己的 OneDrive 同步
- 因果操作日志同步、显式冲突处理与保留 7 份的每日 SQLite 备份
- 中文 / English 界面
- Markdown 和 JSON 导出
- 手动检查 GitHub Releases 更新（可选预发布渠道，不自动下载或执行）

## Knowledge Agent（审批式写入）

从知识库点击 **Knowledge Agent**，可设置目标、输出格式、项目/时间范围，以及
浏览器内置 AI 或本地 Ollama。系统先在本地展示检索计划、匹配分数和来源，只有
用户点击“运行 Agent”后才调用所选本地提供方。结果与候选知识卡分开展示，候选
必须逐条批准或拒绝，绝不自动写入。

Agent 写入默认是 `draft`，也可由用户明确标记 `verified`。每条写入保留来源 ID、
置信度、理由、模型和运行 ID。撤销会将知识标记为 `deprecated`，不会删除
provenance 或不可变审计记录。既有知识迁移为 `raw`。外部资料补充尚未实现且
开关禁用；除本机 Browser AI/Ollama 与手动 GitHub 更新外不会新增网络访问。

OneDrive v2 操作日志和版本 2 JSON 导出会携带完整 Agent ledger（运行、候选卡和
追加式审计事件），但不包含 provider 凭据或密钥。SQLite 备份是数据库的完整
时间点副本；JSON 是可移植、经过验证的逻辑导出，OneDrive 则用于多设备增量合并。
Agent 在保存执行计划时即固定来源版本、内容哈希和生命周期；模型执行期间来源一旦
变化，候选创建或审批会要求重新生成。`deprecated` 为单调状态，普通编辑、同步
合并和备份恢复都不能将其重新激活。
规划接口同时返回服务端固定的完整来源快照，Agent 只向 provider 发送这些快照。
跨设备并发审批使用由 proposal ID 推导的确定性知识 ID；同步会合并审批关系，
撤销会废弃全部关联写入。运行与候选知识都必须至少引用一个唯一来源。
审批与拒绝并发时，已产生知识的审批状态单调胜出，并记录不可变冲突审计。重新
规划会清空旧结果；旧运行候选卡的操作由运行 ID 和界面代次共同拒绝。
Agent 审批知识不能通过普通编辑篡改，需生成新候选并审批。来源固定使用独立的
语义修订和哈希，预览次数等遥测更新不会使计划过期。审批 ledger 早于对应知识
到达时会安全延后，并在后续同步自动收敛。
Agent 审批知识也不能直接删除；知识库中的操作会显示“撤销审批”并走事务化 undo。
版本 2 ledger 的批准目标必须是 proposal 派生的确定性 canonical entry ID。

---

![Knowledge library](store-assets/screenshot-library.png)

![Ask with citations](store-assets/screenshot-ask.png)

---

## 安装

从 [v1.6.0 Beta](https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.6.0) 下载：

- Windows Beta：`AI-Knowledge-Inbox-<version>-Windows-unsigned.zip`
- Apple Silicon：`AI-Knowledge-Inbox-<version>-macOS-arm64-unsigned.dmg`
- Intel Mac：`AI-Knowledge-Inbox-<version>-macOS-x64-unsigned.dmg`
- 仅浏览器扩展：`AI-Knowledge-Inbox-Extension-<version>.zip`
- 浏览器商店提交：`AI-Knowledge-Inbox-Store-<version>.zip`

当前 Windows/macOS Beta 均未签名。Windows 解压后运行 `安装 Beta.cmd`；macOS 需按
Release 说明允许打开。未来稳定版只发布已签名 Windows 和已签名、公证的 macOS 包。

浏览器扩展暂以 Developer mode 加载；商店版本准备中。
发布包签名、商店提交和回滚步骤见 [PUBLISHING.md](PUBLISHING.md)。

### 配对浏览器扩展

首次连接（或重新安装桌面伴侣后），从 Windows 托盘图标或 macOS 菜单栏图标中选择
**Pair Browser Extension…**，再把显示的 8 位一次性配对码输入扩展弹窗。配对码 5
分钟后过期且只能使用一次。扩展将凭据保存在 `chrome.storage.local`；配对成功前，
原有浏览器本地知识会保留且不会迁移。桌面伴侣未运行时仍可使用浏览器本地模式。

---

## 隐私

- 主库保存在本机 SQLite
- 本地服务只监听 `127.0.0.1`
- 敏感本地 API 使用每次安装随机生成的 Bearer 凭据；网页来源会被拒绝
- OneDrive 同步写入用户自己的 OneDrive
- 无托管后端、广告或遥测
- Ask 可使用浏览器 Prompt API，或用户主动选择的 `127.0.0.1:11434` 本机 Ollama；不会连接云端模型地址

详见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

## Ask AI 提供方

Ask 页可选择浏览器内置 Prompt API，或本机 Ollama，并配置 Ollama 模型名（默认
`llama3.2`）。提供方和模型名会保存在 `chrome.storage.local`；它们不是秘密。
Ollama 必须在 `127.0.0.1:11434` 运行，Ask 使用 `/api/chat` 且关闭流式返回。
目前不支持 Azure 或 API Key；云端凭据需要先完成安全秘密存储与权限设计。

同步 v2 在 OneDrive 的 `Apps\AI Knowledge Inbox\operations` 中为每台设备保存独立操作日志；
`knowledge-sync.json` 仅是可读兼容快照。桌面服务提供 `/sync/status`、`/sync/conflicts`
和 `/backups` 接口用于检查同步、解决冲突及恢复本地备份。
这些接口以及脱敏的 `/diagnostics` 均需要已配对凭据。桌面伴侣菜单可将诊断信息保存为
JSON；诊断不包含知识标题、正文、来源 URL 或秘密。
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
