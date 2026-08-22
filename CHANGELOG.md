# Changelog

## Unreleased

- Added explicit SQLite schema migrations with safe v1-to-v2 data retention.
- Replaced shared-snapshot synchronization with authoritative per-device operation logs, causal version vectors, deterministic concurrent-operation handling, and persistent conflict-resolution APIs.
- Kept `knowledge-sync.json` as a derived readable compatibility snapshot.
- Added automatic retained daily SQLite backups plus list, create, and safe restore APIs.
- Expanded sync status with schema, operation, conflict, backup, and storage-path details.
- Reconciled first-run v1 local/snapshot state by v1 timestamps, consumed duplicate-content remote operations as resolvable conflicts, and made failed restores roll back unpublished OneDrive artifacts.
- Collapsed retained local v1 entry/tombstone pairs by validated timestamps, annotated losing duplicate conflicts, and deferred restore publication to normal post-response sync.
- Added a bounded mixed-version window for changed v1 compatibility snapshots and made database replacement preserve the active file across rename failures.
- Added compatibility-snapshot compare/retry protection, durable restore recovery, serialized database access, isolated degraded operation files, and per-reason backup retention.
- Made migration-window snapshots read-only, added causal frontier/dependency deferral, pre-gate body timeouts, journal-loss recovery, and graceful shutdown draining.
- Isolated malformed compatibility snapshots as degraded input and made restore rollback phase-aware for candidate WAL/SHM sidecars.

## 1.6.0

- Redesigned Technology Skin 2 with navy, cyan, mint, and lilac highlights.
- Increased bright surfaces, gradients, and rounded-card geometry across desktop and HTML.
- Added a dedicated English README and English GitHub Pages site.
- Fixed Windows high-DPI capture-window sizing.

## 1.5.0

- Added Chinese / English browser UI.
- Added a native macOS menu-bar companion with `Command + ;`.
- Applied Technology Skin 2 to Windows desktop capture.
- Added complete project, hackathon, and Agent roadmap documentation.
- Simplified public README and release notes.

## 1.4.0

- Added grounded Ask with hybrid retrieval, browser built-in AI, citations, answer modes, and save-back.
- Added persistent Classic and Technology library skins.
- Added extension icons and release/store assets.
- Added reproducible GitHub Releases and GitHub Pages workflows.

## 1.3.0

- Added two switchable knowledge-library skins.

## 1.2.0

- Added OneDrive synchronization with conflict resolution and deletion tombstones.

## 1.1.0

- Added shared SQLite storage between the browser extension and Windows companion.

## 1.0.0

- Completed the initial browser-extension MVP.
