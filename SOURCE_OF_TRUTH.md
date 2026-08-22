# Source of truth

The public GitHub repository is the only canonical source:

`https://github.com/lindaf0617-hub/ai-knowledge-inbox`

Rules:

1. Edit source only inside this repository.
2. Never hand-edit files in an installed app directory.
3. Never hand-assemble a release ZIP.
4. Windows, macOS, and extension artifacts are built by GitHub Actions from a version tag.
5. The extension manifest version, git tag, release notes, and download links must match.
6. Local databases, OneDrive snapshots, PID files, logs, and downloaded runtimes are never committed.

Local validation:

```powershell
.\scripts\validate.ps1
node --test tests\*.test.js
.\scripts\build-release.ps1 -Version 1.6.0
```
