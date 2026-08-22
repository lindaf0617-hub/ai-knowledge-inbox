# Privacy

AI Knowledge Inbox is designed to keep knowledge under the user's control.

## Data storage

- Knowledge is stored in `%LOCALAPPDATA%\AIKnowledgeInbox\knowledge.db`.
- When OneDrive is available, each device writes its own causal operation log under `OneDrive\Apps\AI Knowledge Inbox\operations`; `knowledge-sync.json` is a derived readable snapshot.
- During the bounded v1 migration window, `knowledge-sync.json` is read-only to v2 so late v1 writes are not overwritten; v2-originated changes remain in operation logs until migration completes.
- Daily SQLite backups are stored locally in `%LOCALAPPDATA%\AIKnowledgeInbox\backups`, with the newest seven retained. A restore creates a safety backup first.
- Browser-local storage is used only when the desktop service is unavailable.

## Network behavior

- The desktop API listens on `127.0.0.1:43127` only.
- Requests from normal web origins are rejected.
- The project does not operate a hosted backend or telemetry endpoint.
- Browser built-in AI is invoked locally when the browser exposes Prompt API.

## Deletion

- Deleting knowledge creates a causal delete operation so older operations do not restore it. Earlier immutable operations and retained backups may still contain the old content.
- Uninstalling preserves the database, local backups, and OneDrive sync files to prevent accidental data loss.
- Users may permanently delete those files manually.

## Feedback

Do not include private knowledge text, credentials, or confidential source material in GitHub issues.
