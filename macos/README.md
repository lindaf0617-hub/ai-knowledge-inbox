# macOS companion

The macOS companion is a native AppKit menu-bar application.

- Global shortcut: `Command + ;`
- Captures text from the system clipboard
- Starts the same local Node.js + SQLite service used on Windows
- Automatically detects OneDrive folders under `~/Library/CloudStorage`
- Shares the same browser-extension API on `127.0.0.1:43127`

## Build

Run on macOS 14 with Xcode command-line tools:

```bash
bash scripts/build-macos.sh 1.6.0
```

The script:

1. Compiles arm64 and x86_64 Swift binaries
2. Combines them into one universal app
3. Downloads and verifies official Node.js arm64/x64 runtimes
4. Bundles the local service
5. Applies ad-hoc signing
6. Creates an unsigned DMG

## Beta installation

Open the DMG and drag the app to Applications. Because the Beta is not notarized:

1. Control-click the app
2. Select **Open**
3. Confirm the Gatekeeper prompt

Production distribution requires Apple Developer ID signing and notarization.
