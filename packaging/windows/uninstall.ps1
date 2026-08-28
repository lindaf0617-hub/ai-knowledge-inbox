$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "AIKnowledgeInbox"
$appDir = Join-Path $installRoot "app"
$extensionDir = Join-Path $installRoot "extension"
$startupDirectory = [Environment]::GetFolderPath("Startup")
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AI Knowledge Inbox"
$scheduledTaskName = "AI Knowledge Companion"

Stop-ScheduledTask -TaskName $scheduledTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $scheduledTaskName -Confirm:$false -ErrorAction SilentlyContinue

foreach ($pidName in @("watchdog.pid", "companion.pid", "server.pid")) {
    $pidPath = Join-Path $installRoot $pidName
    if (Test-Path -LiteralPath $pidPath) {
        $processId = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
        if ($processId -match "^\d+$") {
            Stop-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Milliseconds 500

Remove-Item -LiteralPath (Join-Path $startupDirectory "AI Knowledge Companion.cmd") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $startupDirectory "AI Knowledge Companion.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extensionDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "AI Knowledge Inbox Beta application files were removed." -ForegroundColor Green
Write-Host "Your database was preserved at:"
Write-Host (Join-Path $installRoot "knowledge.db") -ForegroundColor Cyan
Write-Host ""
Write-Host "Remove the unpacked extension manually from Edge/Chrome."
Write-Host "Delete the database and OneDrive sync file manually only if you want to erase all knowledge."
