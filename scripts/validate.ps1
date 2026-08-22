$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

node --check (Join-Path $repoRoot "desktop\server.js")
Get-ChildItem (Join-Path $repoRoot "extension") -Filter *.js | ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$errors = @()
Get-ChildItem $repoRoot -Recurse -Filter *.ps1 | ForEach-Object {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $_.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null
    $errors += $parseErrors
}
if ($errors.Count) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

$validatorPath = (Resolve-Path $MyInvocation.MyCommand.Path).Path
$forbidden = @(
    ("C:" + [char]92 + "Users" + [char]92),
    ("." + "scout"),
    ("session" + "-state"),
    ("OneDrive - " + "Microsoft"),
    ("BEGIN " + "PRIVATE KEY"),
    ("gh" + "p_"),
    ("github_" + "pat_")
)
$files = Get-ChildItem $repoRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch "\\.git\\" -and
    $_.FullName -notmatch "\\dist\\" -and
    $_.FullName -ne $validatorPath -and
    $_.Extension -notin @(".png", ".ico")
}
foreach ($pattern in $forbidden) {
    $matches = $files | Select-String -Pattern $pattern -SimpleMatch
    if ($matches) {
        $matches
        throw "Forbidden release content found: $pattern"
    }
}

$manifest = Get-Content -Raw (Join-Path $repoRoot "extension\manifest.json") | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) {
    throw "Extension must use Manifest V3."
}
foreach ($required in @(
    "extension\ask.html",
    "extension\i18n.js",
    "extension\citations.js",
    "macos\Sources\AIKnowledgeCompanion\main.swift",
    "scripts\build-macos.sh",
    "HACKATHON.md",
    "PROJECT_RECORD.md",
    "AGENT_ROADMAP.md"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) {
        throw "Required release file is missing: $required"
    }
}
Write-Output "Validation passed for version $($manifest.version)."
