# Privacy

AI Knowledge Inbox is designed to keep knowledge under the user's control.

## Data storage

- Knowledge is stored in `%LOCALAPPDATA%\AIKnowledgeInbox\knowledge.db`.
- When OneDrive is available, a mergeable JSON snapshot is written to `OneDrive\Apps\AI Knowledge Inbox\knowledge-sync.json`.
- Browser-local storage is used only when the desktop service is unavailable.

## Network behavior

- The desktop API listens on `127.0.0.1:43127` only.
- Requests from normal web origins are rejected.
- The project does not operate a hosted backend or telemetry endpoint.
- Browser built-in AI is invoked locally when the browser exposes Prompt API.

## Deletion

- Deleting knowledge creates a synchronization tombstone so old snapshots do not restore it.
- Uninstalling preserves the database and OneDrive file to prevent accidental data loss.
- Users may permanently delete those files manually.

## Feedback

Do not include private knowledge text, credentials, or confidential source material in GitHub issues.
