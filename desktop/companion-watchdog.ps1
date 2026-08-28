$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$companion = Join-Path $scriptRoot "desktop-companion.ps1"
$dataDir = Join-Path $env:LOCALAPPDATA "AIKnowledgeInbox"
$watchdogPid = Join-Path $dataDir "watchdog.pid"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -LiteralPath $watchdogPid -Value $PID -Encoding ASCII

try {
    while ($true) {
        if (-not (Test-Path -LiteralPath $companion)) {
            throw "Desktop companion script is missing: $companion"
        }

        $process = Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-STA",
                "-WindowStyle", "Hidden",
                "-File", "`"$companion`""
            ) `
            -PassThru

        $process.WaitForExit()
        Start-Sleep -Seconds 2
    }
} finally {
    Remove-Item -LiteralPath $watchdogPid -Force -ErrorAction SilentlyContinue
}
