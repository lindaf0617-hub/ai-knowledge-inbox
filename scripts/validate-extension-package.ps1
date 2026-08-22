param(
    [string]$ExtensionPath = "",
    [string]$StoreZip = "",
    [string]$PermissionsDocument = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExtensionPath) { $ExtensionPath = Join-Path $repoRoot "extension" }
if (-not $PermissionsDocument) {
    $PermissionsDocument = Join-Path $repoRoot "store-assets\PERMISSIONS.md"
}

node (Join-Path $PSScriptRoot "package-validator.js") $ExtensionPath $PermissionsDocument
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($StoreZip) {
    if (-not (Test-Path -LiteralPath $StoreZip -PathType Leaf)) {
        throw "Store ZIP was not found: $StoreZip"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $StoreZip))
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
        if ($entries -notcontains "manifest.json") {
            throw "Store ZIP must contain manifest.json at its root."
        }
        if ($entries | Where-Object {
            $_.StartsWith("/") -or $_ -match "^[A-Za-z]:" -or $_.Split("/") -contains ".."
        }) {
            throw "Store ZIP contains an unsafe path."
        }
        $manifestEntry = $archive.GetEntry("manifest.json")
        $reader = [IO.StreamReader]::new($manifestEntry.Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        foreach ($icon in @($manifest.icons.PSObject.Properties.Value) +
            @($manifest.action.default_icon.PSObject.Properties.Value)) {
            if ($entries -notcontains $icon) { throw "Store ZIP is missing icon: $icon" }
        }
    } finally {
        $archive.Dispose()
    }
    Write-Output "Store ZIP root validation passed: $StoreZip"
}
