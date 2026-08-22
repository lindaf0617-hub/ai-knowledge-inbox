$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceDesktop = Join-Path $packageRoot "desktop"
$sourceExtension = Join-Path $packageRoot "extension"
$payloadManifestPath = Join-Path $packageRoot "payload-manifest.json"
$expectedPayloadManifestSha256 = "__PAYLOAD_MANIFEST_SHA256__"
$signedPackage = [bool]::Parse("__SIGNED_PACKAGE__")
$testRoot = $env:AI_KNOWLEDGE_TEST_ROOT
$installRoot = if ($testRoot) { Join-Path $testRoot "AIKnowledgeInbox" } else { Join-Path $env:LOCALAPPDATA "AIKnowledgeInbox" }
$appDir = Join-Path $installRoot "app"
$extensionDir = Join-Path $installRoot "extension"
$startupDir = if ($testRoot) { Join-Path $testRoot "Startup" } else { [Environment]::GetFolderPath("Startup") }
$startupName = if ($signedPackage) { "AI Knowledge Companion.lnk" } else { "AI Knowledge Companion.cmd" }
$startupFile = Join-Path $startupDir $startupName
$startMenuDir = if ($testRoot) { Join-Path $testRoot "StartMenu" } else { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AI Knowledge Inbox" }

function Assert-Source([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "$label is missing from the Beta package."
    }
}

function Assert-PayloadIntegrity {
        Assert-Source $payloadManifestPath "Payload manifest"
        $manifestHash = (Get-FileHash -LiteralPath $payloadManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($manifestHash -ne $expectedPayloadManifestSha256) {
            throw "Payload manifest integrity verification failed."
        }
        $manifest = [IO.File]::ReadAllText($payloadManifestPath, [Text.Encoding]::UTF8) |
            ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or -not $manifest.files) {
            throw "Payload manifest format is invalid."
        }
        $expected = @{}
        foreach ($entry in $manifest.files) {
            $relative = [string]$entry.path
            if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or
                $relative.Split("/") -contains ".." -or $expected.ContainsKey($relative)) {
                throw "Payload manifest contains an unsafe or duplicate path."
            }
            $expected[$relative] = $entry
        }
        $actualFiles = @(
            Get-ChildItem -LiteralPath $sourceDesktop -Recurse -File
            Get-ChildItem -LiteralPath $sourceExtension -Recurse -File
            Get-Item -LiteralPath (Join-Path $packageRoot "uninstall.ps1")
        )
        $actualPaths = @{}
        foreach ($file in $actualFiles) {
            $relative = $file.FullName.Substring($packageRoot.Length).TrimStart("\").Replace("\", "/")
            if (-not $expected.ContainsKey($relative)) {
                throw "Unexpected payload file: $relative"
            }
            $entry = $expected[$relative]
            if ($file.Length -ne [long]$entry.bytes) {
                throw "Payload size verification failed: $relative"
            }
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -ne [string]$entry.sha256) {
                throw "Payload hash verification failed: $relative"
            }
            $actualPaths[$relative] = $true
        }
        if ($actualPaths.Count -ne $expected.Count) {
            throw "Payload is missing one or more manifest files."
    }
}

Assert-Source $sourceDesktop "Desktop app"
Assert-Source $sourceExtension "Browser extension"
Assert-Source (Join-Path $sourceDesktop "node.exe") "Bundled Node runtime"
Assert-PayloadIntegrity

New-Item -ItemType Directory -Force -Path $installRoot, $appDir, $extensionDir, $startupDir, $startMenuDir | Out-Null

foreach ($pidName in @("companion.pid", "server.pid")) {
    $pidPath = Join-Path $installRoot $pidName
    if (Test-Path -LiteralPath $pidPath) {
        $processId = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
        if ($processId -match "^\d+$") {
            Stop-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Milliseconds 500

# The database lives in installRoot and is intentionally not removed or overwritten.
Copy-Item -Path (Join-Path $sourceDesktop "*") -Destination $appDir -Recurse -Force
Copy-Item -Path (Join-Path $sourceExtension "*") -Destination $extensionDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $packageRoot "uninstall.ps1") -Destination $appDir -Force

$companionScript = Join-Path $appDir "desktop-companion.ps1"
$shell = New-Object -ComObject WScript.Shell
$executionPolicy = if ($signedPackage) { "AllSigned" } else { "Bypass" }
if ($signedPackage) {
    $startupShortcut = $shell.CreateShortcut($startupFile)
    $startupShortcut.TargetPath = "powershell.exe"
    $startupShortcut.Arguments = "-NoProfile -ExecutionPolicy AllSigned -STA -WindowStyle Hidden -File `"$companionScript`""
    $startupShortcut.WorkingDirectory = $appDir
    $startupShortcut.Save()
} else {
    $startupContent = @"
@echo off
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "$companionScript"
"@
    Set-Content -LiteralPath $startupFile -Value $startupContent -Encoding ASCII
}

$shortcut = $shell.CreateShortcut((Join-Path $startMenuDir "AI Knowledge Companion.lnk"))
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy $executionPolicy -STA -WindowStyle Hidden -File `"$companionScript`""
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = "Capture copied AI content into the local knowledge inbox"
$shortcut.Save()

$installedUninstaller = Join-Path $appDir "uninstall.ps1"
$uninstallTarget = Join-Path $startMenuDir "Uninstall AI Knowledge Inbox.lnk"
$uninstallShortcut = $shell.CreateShortcut($uninstallTarget)
$uninstallShortcut.TargetPath = "powershell.exe"
$uninstallShortcut.Arguments = "-NoProfile -ExecutionPolicy $executionPolicy -STA -File `"$installedUninstaller`""
$uninstallShortcut.WorkingDirectory = $appDir
$uninstallShortcut.Save()

if (-not $testRoot) {
    Start-Process powershell.exe -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", $executionPolicy,
        "-STA",
        "-WindowStyle", "Hidden",
        "-File", "`"$companionScript`""
    )

    Set-Clipboard -Value $extensionDir
    try {
        Start-Process "msedge.exe" "edge://extensions"
    } catch {
        Start-Process "chrome.exe" "chrome://extensions"
    }
}

Write-Host ""
Write-Host "AI Knowledge Inbox __VERSION__ installed." -ForegroundColor Green
Write-Host "Desktop hotkey: Ctrl + ;"
Write-Host "Extension folder copied to clipboard:"
Write-Host $extensionDir -ForegroundColor Cyan
Write-Host ""
Write-Host "In the extension page:"
Write-Host "1. Enable Developer mode."
Write-Host "2. Choose Load unpacked."
Write-Host "3. Paste/select the extension folder above."
Write-Host ""
Write-Host "Existing knowledge.db and OneDrive sync data were preserved."
