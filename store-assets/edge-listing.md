# Edge Add-ons listing draft

## Name

AI Knowledge Inbox

## Short description

Save useful AI and web content into a private, searchable knowledge base.

## Detailed description

Capture selected web text, preserve Markdown, organize it with tags and projects, search locally, and ask questions with cited sources using supported browser built-in AI.

The extension can run independently with browser-local storage or connect to the optional Windows companion for SQLite storage and OneDrive synchronization.

## Permissions rationale

- `activeTab`: read the current tab title, URL, and selected content after user action.
- `contextMenus`: provide “Save to AI Knowledge Inbox” for selected text.
- `scripting`: convert the user-selected page fragment to Markdown.
- `storage`: retain knowledge when the desktop companion is unavailable.
- `http://127.0.0.1:43127/*`: connect only to the optional local desktop service.
- `http://127.0.0.1:11434/*`: connect only to local Ollama when the user selects it.
- `https://api.github.com/*`: fetch public release metadata only after the user clicks Check updates; no knowledge or identifier is sent.

## Privacy

No ads, analytics, telemetry, hosted backend, or remote code. Knowledge remains in browser-local
storage or the optional local desktop database. The manual update check sends no user data.
