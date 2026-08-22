param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^\d+\.\d+\.\d+$")]
    [string]$Version,
    [string]$NodeVersion = "24.13.0"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repoRoot "dist"
$stageName = "AI-Knowledge-Inbox-$Version-Windows"
$stage = Join-Path $dist $stageName
$extensionStage = Join-Path $stage "extension"
$desktopStage = Join-Path $stage "desktop"
$nodeArchive = Join-Path $dist "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$checksumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"

$manifest = Get-Content -Raw (Join-Path $repoRoot "extension\manifest.json") | ConvertFrom-Json
if ($manifest.version -ne $Version) {
    throw "Manifest version $($manifest.version) does not match requested version $Version."
}

Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist, $stage, $extensionStage, $desktopStage | Out-Null

Copy-Item -Path (Join-Path $repoRoot "desktop\*") -Destination $desktopStage -Recurse -Force
Copy-Item -Path (Join-Path $repoRoot "extension\*") -Destination $extensionStage -Recurse -Force
Copy-Item -Path (Join-Path $repoRoot "packaging\windows\*") -Destination $stage -Recurse -Force

$installer = Join-Path $stage "install.ps1"
$readme = Join-Path $stage "README.txt"
Set-Content -LiteralPath $installer -Value ((Get-Content -Raw $installer).Replace("__VERSION__", $Version)) -Encoding UTF8
Set-Content -LiteralPath $readme -Value ((Get-Content -Raw $readme).Replace("__VERSION__", $Version)) -Encoding UTF8

Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive -UseBasicParsing
$checksums = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
$archiveName = [IO.Path]::GetFileName($nodeArchive)
$expectedLine = @($checksums -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" })[0]
if (-not $expectedLine) {
    throw "Official checksum for $archiveName was not found."
}
$expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw "Node.js runtime checksum mismatch."
}

Expand-Archive -LiteralPath $nodeArchive -DestinationPath $dist -Force
$nodeDir = Join-Path $dist "node-v$NodeVersion-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeDir "node.exe") -Destination $desktopStage -Force
Copy-Item -LiteralPath (Join-Path $nodeDir "LICENSE") -Destination (Join-Path $desktopStage "NODE-LICENSE.txt") -Force

$windowsZip = Join-Path $dist "$stageName.zip"
$extensionZip = Join-Path $dist "AI-Knowledge-Inbox-Extension-$Version.zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $windowsZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $extensionStage "*") -DestinationPath $extensionZip -CompressionLevel Optimal

$hashLines = @($windowsZip, $extensionZip) | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
}
Set-Content -LiteralPath (Join-Path $dist "SHA256SUMS.txt") -Value $hashLines -Encoding ASCII

Remove-Item -LiteralPath $nodeArchive, $nodeDir -Recurse -Force
Write-Output "Release artifacts created in $dist"
