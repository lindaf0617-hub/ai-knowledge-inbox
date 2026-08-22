# AI Knowledge Inbox

> Turn useful output from Copilot, ChatGPT, Claude, desktop Agents, and the web into a private, searchable, reusable knowledge base.

Windows / macOS companion | Edge / Chrome extension | SQLite | OneDrive | Cited Ask

---

AI Knowledge Inbox addresses a simple problem: **AI creates valuable work every day, but most of it remains trapped in scattered conversations and tools.**

It provides:

- One-keystroke desktop capture: Windows `Ctrl + ;`, macOS `Command + ;`
- Right-click web selection capture with Markdown preservation
- Projects, tags, summaries, keyword search, and local semantic vectors
- Grounded Ask: local retrieval, browser built-in AI, and `[K1]` citations
- Local SQLite storage and user-owned OneDrive sync
- Causal operation-log sync, explicit conflict resolution, and seven retained daily SQLite backups
- Chinese and English UI
- Markdown and JSON export

---

![Knowledge library](store-assets/screenshot-library.png)

![Ask with citations](store-assets/screenshot-ask.png)

---

## Install

Download the [v1.6.0 Beta](https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.6.0):

- Windows: `AI-Knowledge-Inbox-<version>-Windows.zip`
- Apple Silicon: `AI-Knowledge-Inbox-<version>-macOS-arm64-unsigned.dmg`
- Intel Mac: `AI-Knowledge-Inbox-<version>-macOS-x64-unsigned.dmg`
- Browser extension only: `AI-Knowledge-Inbox-Extension-<version>.zip`

The macOS Beta is not notarized yet. Control-click the app and choose **Open** on first launch.

---

## Privacy

- The primary database is local SQLite.
- The service listens only on `127.0.0.1`.
- Sync uses the user's own OneDrive.
- There is no hosted backend, advertising, or telemetry.
- Ask uses browser built-in AI only when Prompt API is supported.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

Sync v2 stores one device-owned operation log per device under
`Apps\AI Knowledge Inbox\operations`; `knowledge-sync.json` remains a readable
compatibility snapshot. The desktop service exposes `/sync/status`,
`/sync/conflicts`, and `/backups` for diagnostics, resolution, and recovery.
During the bounded v1 migration window, v2 treats that snapshot as read-only
input to avoid overwriting late v1 changes; v1 devices therefore do not receive
new v2-originated changes until the window is completed.

---

## More

- [中文 README](README.md)
- [Source-of-truth and release rules](SOURCE_OF_TRUTH.md)
- [Full project record](PROJECT_RECORD.md)
- [Hackathon statement](HACKATHON.md)
- [Knowledge Agent roadmap](AGENT_ROADMAP.md)

---

MIT License.
