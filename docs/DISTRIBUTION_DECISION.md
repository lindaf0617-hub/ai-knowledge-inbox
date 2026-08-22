# Desktop distribution decision

**Status:** accepted for the 1.x release line.

Keep the existing portable Node.js companion and PowerShell/Swift launchers. Produce ZIP/DMG
artifacts with hashes, optional platform signing, and browser-store packages. Do not introduce
Tauri now: it would add a Rust/webview toolchain, migration risk, and a second desktop runtime
without changing the local API or extension value.

MSIX is the preferred future Windows installer once a trusted code-signing certificate, stable
publisher identity, upgrade testing, and uninstall/data-retention behavior are available. The
portable ZIP remains supported for Beta and rollback.

Revisit Tauri only if a cross-platform settings/diagnostics UI or managed auto-update becomes a
confirmed requirement. Any updater must follow signed installer work and must never execute
unsigned downloads.
