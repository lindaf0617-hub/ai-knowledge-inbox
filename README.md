# AI Knowledge Inbox

Save useful output from AI assistants into one private, searchable knowledge base.

## What it does

- Capture copied text from Windows desktop apps with `Ctrl + ;`
- Save selected web content from Edge or Chrome
- Preserve common formatting as Markdown
- Organize knowledge with projects, tags, summaries, and related-item suggestions
- Search locally with keyword and lightweight semantic-vector modes
- Ask questions across the knowledge base with browser built-in AI and cited sources
- Sync through the user's own OneDrive folder
- Export Markdown or JSON backups

## Privacy model

- The primary database is local SQLite.
- The local API listens only on `127.0.0.1`.
- OneDrive sync writes to the user's own OneDrive account.
- No hosted backend, telemetry, or vendor API key is required.
- Ask uses the browser's built-in Prompt API when available.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Install a release

1. Download `AI-Knowledge-Inbox-<version>-Windows.zip` from [GitHub Releases](https://github.com/lindaf0617-hub/ai-knowledge-inbox/releases/latest).
2. Extract the ZIP.
3. Run `安装 Beta.cmd`.
4. In Edge or Chrome, enable Developer mode and load the extension folder shown by the installer.
5. Copy text in a desktop AI app and press `Ctrl + ;`.

The Windows package includes its own Node.js runtime.

## Browser extension only

Download `AI-Knowledge-Inbox-Extension-<version>.zip`, extract it, then load the extracted directory from:

- Edge: `edge://extensions`
- Chrome: `chrome://extensions`

Without the desktop companion, the extension uses browser-local storage. When the companion becomes available, it safely migrates local entries into the shared SQLite database.

## Ask knowledge base

Open the library and select **Ask 知识库**. The workflow is:

1. Hybrid local retrieval ranks relevant knowledge.
2. Only the selected knowledge is provided to browser built-in AI.
3. The answer cites sources as `[K1]`, `[K2]`, and so on.
4. The answer can be saved back into the library.

If Prompt API is unavailable, retrieval sources remain visible but synthesis is disabled.

## Platform support

| Component | Windows | macOS |
|---|---:|---:|
| Edge/Chrome extension | Yes | Yes |
| Desktop clipboard companion | Yes | Not yet |
| OneDrive sync | Yes | Through Windows companion |

## Development

Requirements:

- Node.js 24+
- Windows PowerShell 5.1+ for the desktop companion and packaging

Validation:

```powershell
node --check desktop\server.js
Get-ChildItem extension -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Build a release:

```powershell
.\scripts\build-release.ps1 -Version 1.4.0
```

## License

[MIT](LICENSE)
