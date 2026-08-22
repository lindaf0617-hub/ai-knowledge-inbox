param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Version,
    [string]$NodeVersion = "24.13.0",
    [switch]$ValidateVersionOnly,
    [switch]$Sign,
    [string]$CertificateThumbprint = "",
    [string]$PfxPath = "",
    [string]$PfxPassword = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repoRoot "dist"
$signRequested = $Sign -or $CertificateThumbprint -or $PfxPath -or $PfxPassword
$signatureLabel = if ($signRequested) { "signed" } else { "unsigned" }
$stageName = "AI-Knowledge-Inbox-$Version-Windows-$signatureLabel"
$stage = Join-Path $dist $stageName
$extensionStage = Join-Path $stage "extension"
$storeExtensionStage = Join-Path $dist "store-extension"
$desktopStage = Join-Path $stage "desktop"
$nodeArchive = Join-Path $dist "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$checksumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$importedCertificate = $null

function New-DeterministicZip {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$RootPrefix = ""
    )
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
    try {
        $archive = [IO.Compression.ZipArchive]::new(
            $stream,
            [IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        try {
            $base = (Resolve-Path -LiteralPath $Source).Path
            Get-ChildItem -LiteralPath $base -Recurse -File |
                Sort-Object { $_.FullName.Substring($base.Length) } |
                ForEach-Object {
                    $relative = $_.FullName.Substring($base.Length).TrimStart("\") -replace "\\", "/"
                    $entryName = if ($RootPrefix) { "$RootPrefix/$relative" } else { $relative }
                    $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
                    $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                    $input = [IO.File]::OpenRead($_.FullName)
                    $output = $entry.Open()
                    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
                }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Resolve-SigningCertificate {
    if ($CertificateThumbprint -and $PfxPath) {
        throw "Specify either CertificateThumbprint or PfxPath, not both."
    }
    if (-not $CertificateThumbprint -and -not $PfxPath) {
        throw "Signing was requested but no certificate thumbprint or PFX path was supplied."
    }
    if ($PfxPath) {
        if (-not (Test-Path -LiteralPath $PfxPath -PathType Leaf)) {
            throw "Signing PFX was not found: $PfxPath"
        }
        $securePassword = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
        $script:importedCertificate = Import-PfxCertificate `
            -FilePath $PfxPath `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -Password $securePassword
        if (-not $script:importedCertificate -or -not $script:importedCertificate.HasPrivateKey) {
            throw "The supplied PFX did not provide a signing certificate with a private key."
        }
        return $script:importedCertificate
    }
    $normalized = $CertificateThumbprint.Replace(" ", "").ToUpperInvariant()
    $certificate = Get-ChildItem "Cert:\CurrentUser\My\$normalized" -ErrorAction SilentlyContinue
    if (-not $certificate -or -not $certificate.HasPrivateKey) {
        throw "The requested certificate is missing or has no private key: $normalized"
    }
    return $certificate
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Sign-PowerShellScript {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Certificate
    )
    $signature = Set-AuthenticodeSignature `
        -LiteralPath $Path `
        -Certificate $Certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer $TimestampUrl
    if ($signature.Status -ne "Valid") {
        throw "Authenticode signing failed ($($signature.Status)): $Path"
    }
    $verified = Get-AuthenticodeSignature -LiteralPath $Path
    if ($verified.Status -ne "Valid" -or
        $verified.SignerCertificate.Thumbprint -ne $Certificate.Thumbprint) {
        throw "Authenticode verification failed: $Path"
    }
}

function New-PayloadManifest {
    $payloadFiles = @(
        Get-ChildItem -LiteralPath $desktopStage -Recurse -File
        Get-ChildItem -LiteralPath $extensionStage -Recurse -File
        Get-Item -LiteralPath (Join-Path $stage "uninstall.ps1")
    ) | Sort-Object FullName
    $entries = $payloadFiles | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($stage.Length).TrimStart("\").Replace("\", "/")
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            bytes = $_.Length
        }
    }
    $payloadManifest = [ordered]@{
        schemaVersion = 1
        files = @($entries)
    }
    $payloadManifestPath = Join-Path $stage "payload-manifest.json"
    Write-Utf8NoBom -Path $payloadManifestPath `
        -Value (($payloadManifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine)
    return $payloadManifestPath
}

try {
    $manifest = Get-Content -Raw (Join-Path $repoRoot "extension\manifest.json") | ConvertFrom-Json
    $versionCore = & node (Join-Path $repoRoot "extension\update.js") --core $Version
    if ($LASTEXITCODE -ne 0 -or -not $versionCore) {
        throw "Artifact version is not valid SemVer: $Version"
    }
    if ($manifest.version -ne $versionCore) {
        throw "Manifest version $($manifest.version) does not match artifact version core $versionCore."
    }
    if ($ValidateVersionOnly) {
        Write-Output "Artifact version $Version matches manifest version core $versionCore."
        return
    }

    Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force `
        -Path $dist, $stage, $extensionStage, $storeExtensionStage, $desktopStage | Out-Null

    Copy-Item -Path (Join-Path $repoRoot "desktop\*") -Destination $desktopStage -Recurse -Force
    Copy-Item -Path (Join-Path $repoRoot "extension\*") -Destination $extensionStage -Recurse -Force
    Copy-Item -Path (Join-Path $repoRoot "extension\*") -Destination $storeExtensionStage -Recurse -Force
    Copy-Item -Path (Join-Path $repoRoot "packaging\windows\*") -Destination $stage -Recurse -Force
    & node (Join-Path $repoRoot "scripts\write-release-info.js") $extensionStage $Version
    if ($LASTEXITCODE -ne 0) { throw "Artifact release identity generation failed." }
    & node (Join-Path $repoRoot "scripts\write-release-info.js") `
        $storeExtensionStage $manifest.version
    if ($LASTEXITCODE -ne 0) { throw "Store release identity generation failed." }

    $installer = Join-Path $stage "install.ps1"
    $readme = Join-Path $stage "README.txt"
    $companion = Join-Path $desktopStage "desktop-companion.ps1"
    Set-Content -LiteralPath $installer `
        -Value ((Get-Content -Raw $installer).Replace("__VERSION__", $Version)) -Encoding UTF8
    $installStep = if ($signRequested) {
        '2. Run: powershell.exe -NoProfile -ExecutionPolicy AllSigned -File ".\install.ps1"'
    } else {
        '2. Double-click the .cmd installer included in this folder.'
    }
    $signingNote = if ($signRequested) {
        "This stable package uses signed PowerShell entrypoints and verifies every payload file."
    } else {
        "This prerelease package is unsigned; verify SHA256SUMS.txt before use."
    }
    $readmeContent = (Get-Content -Raw $readme).
        Replace("__VERSION__", $Version).
        Replace("__INSTALL_STEP__", $installStep).
        Replace("__SIGNING_NOTE__", $signingNote)
    Set-Content -LiteralPath $readme -Value $readmeContent -Encoding UTF8
    Set-Content -LiteralPath $companion `
        -Value ((Get-Content -Raw $companion).Replace("__VERSION__", $Version)) -Encoding UTF8

    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive -UseBasicParsing
    $checksums = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
    $archiveName = [IO.Path]::GetFileName($nodeArchive)
    $expectedLine = @($checksums -split "`n" |
        Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" })[0]
    if (-not $expectedLine) { throw "Official checksum for $archiveName was not found." }
    $expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Node.js runtime checksum mismatch." }

    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $dist -Force
    $nodeDir = Join-Path $dist "node-v$NodeVersion-win-x64"
    Copy-Item -LiteralPath (Join-Path $nodeDir "node.exe") -Destination $desktopStage -Force
    Copy-Item -LiteralPath (Join-Path $nodeDir "LICENSE") `
        -Destination (Join-Path $desktopStage "NODE-LICENSE.txt") -Force

    & node (Join-Path $repoRoot "scripts\package-validator.js") `
        $extensionStage (Join-Path $repoRoot "store-assets\PERMISSIONS.md")
    if ($LASTEXITCODE -ne 0) { throw "Extension source package validation failed." }
    & node (Join-Path $repoRoot "scripts\package-validator.js") `
        $storeExtensionStage (Join-Path $repoRoot "store-assets\PERMISSIONS.md")
    if ($LASTEXITCODE -ne 0) { throw "Store source package validation failed." }

    if ($signRequested) {
        Get-ChildItem -LiteralPath $stage -Recurse -Filter *.cmd |
            Remove-Item -Force
        $certificate = Resolve-SigningCertificate
        Sign-PowerShellScript -Path (Join-Path $stage "uninstall.ps1") -Certificate $certificate
        Sign-PowerShellScript -Path $companion -Certificate $certificate
    }
    $payloadManifestPath = New-PayloadManifest
    $payloadManifestHash = (Get-FileHash -LiteralPath $payloadManifestPath -Algorithm SHA256).
        Hash.ToLowerInvariant()
    $installerContent = (Get-Content -Raw $installer).
        Replace("__PAYLOAD_MANIFEST_SHA256__", $payloadManifestHash).
        Replace("__SIGNED_PACKAGE__", $signRequested.ToString().ToLowerInvariant())
    Set-Content -LiteralPath $installer -Value $installerContent -Encoding UTF8
    if ($signRequested) {
        Sign-PowerShellScript -Path $installer -Certificate $certificate
    }

    $windowsZip = Join-Path $dist "$stageName.zip"
    $extensionZip = Join-Path $dist "AI-Knowledge-Inbox-Extension-$Version.zip"
    $storeZip = Join-Path $dist "AI-Knowledge-Inbox-Store-$Version.zip"
    New-DeterministicZip -Source $stage -Destination $windowsZip -RootPrefix $stageName
    New-DeterministicZip -Source $extensionStage -Destination $extensionZip
    New-DeterministicZip -Source $storeExtensionStage -Destination $storeZip
    & (Join-Path $repoRoot "scripts\validate-extension-package.ps1") `
        -ExtensionPath $storeExtensionStage `
        -StoreZip $storeZip `
        -PermissionsDocument (Join-Path $repoRoot "store-assets\PERMISSIONS.md")

    $artifacts = @($windowsZip, $extensionZip, $storeZip) | ForEach-Object {
        [ordered]@{
            file = [IO.Path]::GetFileName($_)
            sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
            bytes = (Get-Item -LiteralPath $_).Length
        }
    }
    $artifactManifest = [ordered]@{
        schemaVersion = 1
        version = $Version
        platform = "windows-x64"
        signed = [bool]$signRequested
        unsigned = -not [bool]$signRequested
        signedEntrypoint = if ($signRequested) { "install.ps1" } else { $null }
        payloadVerified = $true
        payloadManifest = "payload-manifest.json"
        artifacts = $artifacts
    }
    $artifactManifestPath = Join-Path $dist "artifact-manifest-windows.json"
    Write-Utf8NoBom -Path $artifactManifestPath `
        -Value (($artifactManifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine)
    $hashLines = @($windowsZip, $extensionZip, $storeZip, $artifactManifestPath) |
        ForEach-Object {
            "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
        }
    Write-Utf8NoBom -Path (Join-Path $dist "SHA256SUMS.txt") `
        -Value (($hashLines -join "`n") + "`n")
    Remove-Item -LiteralPath $storeExtensionStage -Recurse -Force
    Write-Output "Release artifacts created in $dist"
} finally {
    Remove-Item -LiteralPath $nodeArchive -Force -ErrorAction SilentlyContinue
    if ($nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($importedCertificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($importedCertificate.Thumbprint)" -Force
    }
}
