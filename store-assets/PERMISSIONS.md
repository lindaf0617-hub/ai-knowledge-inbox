# Extension permission rationale

- `activeTab`: reads the active tab title, URL, and user-selected content only after user action.
- `contextMenus`: adds the user-invoked “Save to AI Knowledge Inbox” selection command.
- `scripting`: converts the selected page fragment to Markdown after user action.
- `storage`: stores settings, pairing credentials, and browser-local knowledge.
- `http://127.0.0.1:43127/*`: talks only to the optional local desktop companion.
- `http://127.0.0.1:11434/*`: talks only to a user-selected local Ollama provider.
- `https://api.github.com/*`: checks this project's public releases only when the user clicks **Check updates**. No background request, telemetry, download, or execution occurs.
