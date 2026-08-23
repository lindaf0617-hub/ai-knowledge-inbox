# AI Knowledge Inbox

> Turn useful output from Copilot, ChatGPT, Claude, desktop Agents, and the web into a private, searchable, reusable knowledge base.

Windows / macOS companion | Edge / Chrome extension | SQLite | OneDrive | Cited Ask

---

AI Knowledge Inbox addresses a simple problem: **AI creates valuable work every day, but most of it remains trapped in scattered conversations and tools.**

It provides:

- One-keystroke desktop capture: Windows `Ctrl + ;`, macOS `Command + ;`
- Right-click web selection capture with Markdown preservation
- Projects, tags, summaries, keyword search, and local semantic vectors
- Grounded Ask: local retrieval, browser built-in AI or local Ollama, clickable `[K1]` citations, retrieval scores, and exact source excerpts
- Local SQLite storage and user-owned OneDrive sync
- Causal operation-log sync, explicit conflict resolution, and seven retained daily SQLite backups
- Chinese and English UI
- Markdown and JSON export

## Knowledge Agent (approval-gated writes)

Open **Knowledge Agent** from the library to choose a goal, output format,
project/time scope, and either the browser's built-in AI or local Ollama. The
page shows the local retrieval plan, scores, and excerpts before execution.
Only an explicit **Run Agent** click invokes the selected local provider.
Analysis and candidate cards are separate, and every card requires an
individual approval or rejection; model output is never written automatically.

Approved cards default to `draft` and may be explicitly marked `verified`.
Writes retain source IDs, confidence, rationale, provider/model, and run ID.
Undo marks the entry `deprecated` rather than deleting provenance or immutable
audit history. Existing entries migrate to `raw`. External supplementation is
disabled and not implemented; no new network access is used beyond the selected
local provider and manual GitHub updates.

OneDrive v2 operation logs and version 2 JSON exports carry the complete Agent
ledger (runs, proposals, and append-only audit events), but never provider
credentials or keys. SQLite backups are complete point-in-time database images;
JSON is a validated portable logical export, while OneDrive performs
incremental multi-device merging.
The Agent pins source versions, content hashes, and lifecycle at plan creation;
changes during model execution require proposal regeneration. `deprecated` is
monotonic: ordinary edits, sync merges, and backup restores cannot reactivate it.
Planning also returns complete server-pinned source snapshots, and only those
snapshots are sent to the provider. Concurrent device approvals derive one
deterministic entry ID from the proposal ID; sync merges approval links and undo
deprecates every linked write. Runs and proposals require at least one unique
source.
When approval races rejection, an approval that produced knowledge wins
monotonically and an immutable conflict audit is retained. Replanning clears old
output, and proposal actions are guarded by both run ID and UI generation.
Agent-approved knowledge cannot be changed through ordinary editing; create and
approve a new proposal instead. Source pins use a separate semantic revision and
hash, so view telemetry does not stale a plan. Approval ledger records arriving
before their entry are deferred and converge on a later sync.
Agent-approved entries also cannot be deleted directly: the library exposes
**Undo approval**, which uses transactional undo. Version 2 ledgers require the
proposal-derived deterministic canonical entry ID as the approval target.

---

### One-keystroke desktop capture

![One-keystroke desktop capture](store-assets/screenshot-desktop-v17.png)

### Knowledge Agent with cited analysis

![Knowledge Agent with cited analysis](store-assets/screenshot-agent-v17.png)

### Unified knowledge library

![Unified knowledge library](store-assets/screenshot-library-v17.png)

---

## Install

Download [v1.7.0-beta.1](https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/tag/v1.7.0-beta.1):

- Windows Beta: `AI-Knowledge-Inbox-<version>-Windows-unsigned.zip`
- Apple Silicon: `AI-Knowledge-Inbox-<version>-macOS-arm64-unsigned.dmg`
- Intel Mac: `AI-Knowledge-Inbox-<version>-macOS-x64-unsigned.dmg`
- Browser extension only: `AI-Knowledge-Inbox-Extension-<version>.zip`

Current Windows and macOS Beta desktop packages are unsigned. On macOS, Control-click the app and
choose **Open** on first launch. Future stable desktop packages require signed Windows and signed,
notarized macOS artifacts.

### Pair the browser extension

On first connection (or after reinstalling the companion), choose **Pair Browser
Extension…** from the Windows tray or macOS menu-bar icon and enter the shown
8-character one-time code in the extension popup. It expires after five minutes
and works once. The extension stores its credential in `chrome.storage.local`.
Existing browser-local knowledge remains untouched until authenticated migration
succeeds. Browser-local mode remains available while the companion is offline.

---

## Privacy

- The primary database is local SQLite.
- The service listens only on `127.0.0.1`.
- Sensitive local APIs require a random per-install bearer credential; web origins are rejected.
- Sync uses the user's own OneDrive.
- There is no hosted backend, advertising, or telemetry.
- Ask uses either browser Prompt API or a user-selected Ollama service fixed to `127.0.0.1:11434`; it does not accept cloud model endpoints.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Ask AI providers

The Ask page can use browser built-in Prompt API or local Ollama and lets the
user set the Ollama model name (`llama3.2` by default). Provider and model are
non-secret settings stored in `chrome.storage.local`. Ollama must run at
`127.0.0.1:11434`; Ask calls `/api/chat` with streaming disabled. Azure and API
keys are intentionally not supported yet because cloud credentials require a
secure secret-storage and permission design.

Sync v2 stores one device-owned operation log per device under
`Apps\AI Knowledge Inbox\operations`; `knowledge-sync.json` remains a readable
compatibility snapshot. The desktop service exposes `/sync/status`,
`/sync/conflicts`, and `/backups` for diagnostics, resolution, and recovery.
During the bounded v1 migration window, v2 treats that snapshot as read-only
input to avoid overwriting late v1 changes; v1 devices therefore do not receive
new v2-originated changes until the window is completed.
These APIs and the sanitized `/diagnostics` endpoint require pairing. The companion
menu can save diagnostics as JSON; it excludes knowledge titles, content, source
URLs, credentials, and operation payloads.

---

## More

- [中文 README](README.md)
- [Source-of-truth and release rules](SOURCE_OF_TRUTH.md)
- [Full project record](PROJECT_RECORD.md)
- [Hackathon statement](HACKATHON.md)
- [Knowledge Agent roadmap](AGENT_ROADMAP.md)

---

MIT License.
