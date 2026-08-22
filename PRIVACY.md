# Privacy

AI Knowledge Inbox is designed to keep knowledge under the user's control.

## Data storage

- Knowledge is stored in `%LOCALAPPDATA%\AIKnowledgeInbox\knowledge.db`.
- When OneDrive is available, each device writes its own causal operation log under `OneDrive\Apps\AI Knowledge Inbox\operations`; `knowledge-sync.json` is a derived readable snapshot.
- During the bounded v1 migration window, `knowledge-sync.json` is read-only to v2 so late v1 writes are not overwritten; v2-originated changes remain in operation logs until migration completes.
- Daily SQLite backups are stored locally in `%LOCALAPPDATA%\AIKnowledgeInbox\backups`, with the newest seven retained. A restore creates a safety backup first.
- Browser-local storage is used only when the desktop service is unavailable.
- Existing browser-local entries are retained until an authenticated migration completes successfully.

## Network behavior

- The desktop API listens on `127.0.0.1:43127` only.
- Requests from normal web origins are rejected.
- Sensitive routes require a random per-install bearer token stored in the companion data directory. The token is provisioned to an extension only after the user enters a short-lived, one-time desktop pairing code, and is then held in `chrome.storage.local`.
- Before the extension or companion sends that token or a knowledge payload, it verifies a nonce-bound HMAC proof from the service. A process merely impersonating port `43127` cannot produce the proof; verification failure blocks the request and never triggers browser-local mutation fallback. The challenge exposes no token or knowledge.
- Unauthenticated health checks reveal only service availability plus non-sensitive app/protocol versions. Authenticated diagnostics contain build details, counts, and redacted paths, never knowledge titles, content, source URLs, operation payloads, tokens, or provider secrets.
- The project does not operate a hosted backend or telemetry endpoint.
- Browser built-in AI is invoked locally when the browser exposes Prompt API.
- If the user selects Ollama in Ask, only the question and selected, length-bounded source content are sent to the local Ollama API at `http://127.0.0.1:11434`; cloud endpoints are not configurable.
- The selected AI provider and Ollama model name are stored in `chrome.storage.local`. These are non-secret preferences.
- Azure and API-key providers are not implemented. They require a future secure secret-storage and permission design.
- Only when the user clicks **Check updates**, the extension requests public release metadata from GitHub. It sends no knowledge, identifier, or usage data and never downloads or executes an update.

## Deletion

- Deleting knowledge creates a causal delete operation so older operations do not restore it. Earlier immutable operations and retained backups may still contain the old content.
- Uninstalling preserves the database, local backups, and OneDrive sync files to prevent accidental data loss.
- Users may permanently delete those files manually.

## Feedback

Do not include private knowledge text, credentials, or confidential source material in GitHub issues.
