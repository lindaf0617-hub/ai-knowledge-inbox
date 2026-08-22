Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$serviceUrl = "http://127.0.0.1:43127"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptRoot "server.js"
$dataDir = Join-Path $env:LOCALAPPDATA "AIKnowledgeInbox"
$pidFile = Join-Path $dataDir "companion.pid"
$authTokenPath = Join-Path $dataDir "auth-token"
$packageVersion = "__VERSION__"
if (-not $packageVersion.StartsWith("__")) {
    $env:AI_KNOWLEDGE_APP_VERSION = $packageVersion
    $env:AI_KNOWLEDGE_BUILD_VERSION = "windows-portable"
}
$script:authToken = ""
$script:serviceProcess = $null
$script:captureOpen = $false
$script:proofValidUntil = [DateTime]::MinValue

Add-Type -ReferencedAssemblies System.Windows.Forms.dll -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class GlobalHotKeyWindow : NativeWindow, IDisposable
{
    private const int WM_HOTKEY = 0x0312;
    private readonly int id;

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public event EventHandler Pressed;

    public GlobalHotKeyWindow(int id, uint modifiers, uint key)
    {
        this.id = id;
        CreateHandle(new CreateParams());
        if (!RegisterHotKey(Handle, id, modifiers, key))
        {
            DestroyHandle();
            throw new InvalidOperationException("The global hotkey is already in use.");
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_HOTKEY && message.WParam.ToInt32() == id)
        {
            if (Pressed != null)
            {
                Pressed(this, EventArgs.Empty);
            }
        }
        base.WndProc(ref message);
    }

    public void Dispose()
    {
        if (Handle != IntPtr.Zero)
        {
            UnregisterHotKey(Handle, id);
            DestroyHandle();
        }
    }
}

public static class WindowChrome
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

    public static void Drag(IntPtr handle)
    {
        ReleaseCapture();
        SendMessage(handle, 0x00A1, (IntPtr)0x0002, IntPtr.Zero);
    }

    public static void EnableDpiAwareness()
    {
        try
        {
            if (!SetProcessDpiAwarenessContext((IntPtr)(-4)))
            {
                SetProcessDPIAware();
            }
        }
        catch (EntryPointNotFoundException)
        {
            SetProcessDPIAware();
        }
    }
}
"@

[WindowChrome]::EnableDpiAwareness()

function Test-KnowledgeService {
    try {
        $result = Invoke-RestMethod -Uri "$serviceUrl/health" -Method Get -TimeoutSec 1
        return $result.status -eq "ok"
    } catch {
        return $false
    }
}

function Initialize-AuthToken {
    if (-not (Test-Path -LiteralPath $authTokenPath)) {
        throw "The local service authentication token is missing."
    }
    $script:authToken = (Get-Content -LiteralPath $authTokenPath -Raw).Trim()
    if (-not $script:authToken) {
        throw "The local service authentication token is invalid."
    }
}

function Reset-ServiceProof {
    $script:proofValidUntil = [DateTime]::MinValue
}

function New-AuthenticationNonce {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Test-FixedTimeHex([string]$left, [string]$right) {
    if ($null -eq $left -or $null -eq $right -or $left.Length -ne $right.Length) {
        return $false
    }
    $difference = 0
    for ($index = 0; $index -lt $left.Length; $index++) {
        $difference = $difference -bor ([int][char]$left[$index] -bxor [int][char]$right[$index])
    }
    return $difference -eq 0
}

function Assert-ServiceIdentity {
    if ($script:proofValidUntil -and [DateTime]::UtcNow -lt $script:proofValidUntil) {
        return
    }
    try {
        $domain = "AIKnowledgeInbox.LocalAPI.AuthChallenge"
        $protocol = 1
        $nonce = New-AuthenticationNonce
        $body = @{ protocol = $protocol; nonce = $nonce } | ConvertTo-Json -Compress
        $challenge = Invoke-RestMethod -Uri "$serviceUrl/auth/challenge" -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3
        if ($challenge.domain -ne $domain -or
            [int]$challenge.protocol -ne $protocol -or
            $challenge.nonce -cne $nonce -or
            $challenge.proof -notmatch "^[a-f0-9]{64}$") {
            throw "Invalid challenge response."
        }
        $hmac = New-Object System.Security.Cryptography.HMACSHA256(
            (,[System.Text.Encoding]::UTF8.GetBytes($script:authToken))
        )
        try {
            $message = "$domain`n$protocol`n$nonce"
            $expected = (($hmac.ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes($message)
            ) | ForEach-Object { $_.ToString("x2") }) -join "")
        } finally {
            $hmac.Dispose()
        }
        if (-not (Test-FixedTimeHex $expected ([string]$challenge.proof))) {
            throw "Challenge proof did not match."
        }
        $script:proofValidUntil = [DateTime]::UtcNow.AddSeconds(15)
    } catch {
        Reset-ServiceProof
        throw "SECURITY ERROR: The desktop service identity could not be verified. No credential was sent. Stop and restart the companion."
    }
}

function Get-AuthHeaders {
    Assert-ServiceIdentity
    return @{ Authorization = "Bearer $script:authToken" }
}

function Show-PairingCode {
    try {
        $pairing = Invoke-RestMethod -Uri "$serviceUrl/pairing/code" -Method Post `
            -Headers (Get-AuthHeaders) -TimeoutSec 3
        [System.Windows.Forms.MessageBox]::Show(
            "Enter this one-time code in the extension popup:`r`n`r`n$($pairing.code)`r`n`r`nIt expires in 5 minutes.",
            "Pair browser extension",
            "OK",
            "Information"
        ) | Out-Null
    } catch {
        Reset-ServiceProof
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message, "Pairing failed", "OK", "Error"
        ) | Out-Null
    }
}

function Save-Diagnostics {
    try {
        $diagnostics = Invoke-RestMethod -Uri "$serviceUrl/diagnostics" -Method Get `
            -Headers (Get-AuthHeaders) -TimeoutSec 3
        $dialog = New-Object System.Windows.Forms.SaveFileDialog
        $dialog.Filter = "JSON files (*.json)|*.json"
        $dialog.FileName = "ai-knowledge-inbox-diagnostics.json"
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $diagnostics | ConvertTo-Json -Depth 10 |
                Set-Content -LiteralPath $dialog.FileName -Encoding UTF8
        }
        $dialog.Dispose()
    } catch {
        Reset-ServiceProof
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message, "Diagnostics export failed", "OK", "Error"
        ) | Out-Null
    }
}

function Start-KnowledgeService {
    if (Test-KnowledgeService) {
        return
    }

    $bundledNode = Join-Path $scriptRoot "node.exe"
    $node = if (Test-Path -LiteralPath $bundledNode) {
        $bundledNode
    } else {
        (Get-Command node -ErrorAction Stop).Source
    }
    $script:serviceProcess = Start-Process `
        -FilePath $node `
        -ArgumentList "`"$serverPath`"" `
        -WindowStyle Hidden `
        -PassThru

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-KnowledgeService) {
            return
        }
        if ($script:serviceProcess.HasExited) {
            throw "The local knowledge service failed to start."
        }
    }
    throw "The local knowledge service timed out during startup."
}

function Get-DerivedTitle([string]$content) {
    $line = ($content -split "\r?\n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $line) {
        return "Untitled knowledge"
    }
    $line = $line.Trim()
    return $line.Substring(0, [Math]::Min(60, $line.Length))
}

function Show-Balloon([string]$title, [string]$message, [System.Windows.Forms.ToolTipIcon]$icon) {
    $notifyIcon.BalloonTipTitle = $title
    $notifyIcon.BalloonTipText = $message
    $notifyIcon.BalloonTipIcon = $icon
    $notifyIcon.ShowBalloonTip(2500)
}

function Show-CaptureWindow {
    if ($script:captureOpen) {
        return
    }

    $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
    if ([string]::IsNullOrWhiteSpace($clipboardText)) {
        Show-Balloon "Nothing to save" "Copy text in Copilot first." Warning
        return
    }

    $script:captureOpen = $true
    $bg = [System.Drawing.ColorTranslator]::FromHtml("#08172B")
    $surface = [System.Drawing.ColorTranslator]::FromHtml("#122743")
    $soft = [System.Drawing.ColorTranslator]::FromHtml("#193251")
    $border = [System.Drawing.ColorTranslator]::FromHtml("#31506F")
    $text = [System.Drawing.ColorTranslator]::FromHtml("#F8FBFF")
    $muted = [System.Drawing.ColorTranslator]::FromHtml("#AEC5DF")
    $accent = [System.Drawing.ColorTranslator]::FromHtml("#52D8F2")
    $accentHover = [System.Drawing.ColorTranslator]::FromHtml("#75E5F7")
    $success = [System.Drawing.ColorTranslator]::FromHtml("#63E5C5")
    $link = [System.Drawing.ColorTranslator]::FromHtml("#A99DF7")

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Save to AI Knowledge Inbox"
    $form.ClientSize = New-Object System.Drawing.Size(700, 690)
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "None"
    $form.TopMost = $true
    $form.BackColor = $link
    $form.Padding = New-Object System.Windows.Forms.Padding(1)
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)

    $root = New-Object System.Windows.Forms.Panel
    $root.Dock = [System.Windows.Forms.DockStyle]::Fill
    $root.BackColor = $bg

    $header = New-Object System.Windows.Forms.Panel
    $header.Location = New-Object System.Drawing.Point(0, 0)
    $header.Size = New-Object System.Drawing.Size(698, 86)
    $header.BackColor = $surface

    $signalLine = New-Object System.Windows.Forms.Panel
    $signalLine.Location = New-Object System.Drawing.Point(6, 83)
    $signalLine.Size = New-Object System.Drawing.Size(692, 3)
    $signalLine.BackColor = $link

    $accentBar = New-Object System.Windows.Forms.Panel
    $accentBar.Location = New-Object System.Drawing.Point(0, 0)
    $accentBar.Size = New-Object System.Drawing.Size(6, 86)
    $accentBar.BackColor = $accent

    $logo = New-Object System.Windows.Forms.Label
    $logo.Location = New-Object System.Drawing.Point(24, 21)
    $logo.Size = New-Object System.Drawing.Size(44, 44)
    $logo.BackColor = $accent
    $logo.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#061526")
    $logo.Font = New-Object System.Drawing.Font("Consolas", 13, [System.Drawing.FontStyle]::Bold)
    $logo.Text = "AI"
    $logo.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

    $heading = New-Object System.Windows.Forms.Label
    $heading.Location = New-Object System.Drawing.Point(84, 17)
    $heading.Size = New-Object System.Drawing.Size(500, 31)
    $heading.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16)
    $heading.ForeColor = $text
    $heading.Text = "Save to AI Knowledge Inbox"

    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.Location = New-Object System.Drawing.Point(86, 50)
    $subtitle.Size = New-Object System.Drawing.Size(500, 21)
    $subtitle.ForeColor = $muted
    $subtitle.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $subtitle.ForeColor = $link
    $subtitle.Text = "CAPTURE NODE // REVIEW BEFORE COMMIT"

    $closeButton = New-Object System.Windows.Forms.Button
    $closeButton.Location = New-Object System.Drawing.Point(646, 20)
    $closeButton.Size = New-Object System.Drawing.Size(32, 32)
    $closeButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $closeButton.FlatAppearance.BorderSize = 0
    $closeButton.BackColor = $surface
    $closeButton.ForeColor = $muted
    $closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 13)
    $closeButton.Text = [char]0x00D7
    $closeButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $closeButton.Add_Click({ $form.Close() })
    $closeButton.Add_MouseEnter({ $closeButton.BackColor = $soft })
    $closeButton.Add_MouseLeave({ $closeButton.BackColor = $surface })

    $header.Add_MouseDown({ [WindowChrome]::Drag($form.Handle) })
    $heading.Add_MouseDown({ [WindowChrome]::Drag($form.Handle) })
    $subtitle.Add_MouseDown({ [WindowChrome]::Drag($form.Handle) })
    $header.Controls.AddRange(@($accentBar, $signalLine, $logo, $heading, $subtitle, $closeButton))

    $sourceBadge = New-Object System.Windows.Forms.Label
    $sourceBadge.Location = New-Object System.Drawing.Point(24, 101)
    $sourceBadge.Size = New-Object System.Drawing.Size(145, 24)
    $sourceBadge.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#183552")
    $sourceBadge.ForeColor = $accent
    $sourceBadge.Font = New-Object System.Drawing.Font("Consolas", 8, [System.Drawing.FontStyle]::Bold)
    $sourceBadge.Text = "SOURCE // COPILOT"
    $sourceBadge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

    $card = New-Object System.Windows.Forms.Panel
    $card.Location = New-Object System.Drawing.Point(24, 134)
    $card.Size = New-Object System.Drawing.Size(650, 450)
    $card.BackColor = $surface
    $card.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle

    $cardSignal = New-Object System.Windows.Forms.Panel
    $cardSignal.Location = New-Object System.Drawing.Point(0, 0)
    $cardSignal.Size = New-Object System.Drawing.Size(648, 3)
    $cardSignal.BackColor = $success

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = "Title"
    $titleLabel.Location = New-Object System.Drawing.Point(22, 18)
    $titleLabel.AutoSize = $true
    $titleLabel.ForeColor = $muted
    $titleLabel.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)

    $titleBox = New-Object System.Windows.Forms.TextBox
    $titleBox.Location = New-Object System.Drawing.Point(22, 42)
    $titleBox.Size = New-Object System.Drawing.Size(604, 30)
    $titleBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $titleBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $titleBox.ForeColor = $text
    $titleBox.BackColor = $surface
    $titleBox.Text = Get-DerivedTitle $clipboardText

    $contentLabel = New-Object System.Windows.Forms.Label
    $contentLabel.Text = "Content"
    $contentLabel.Location = New-Object System.Drawing.Point(22, 88)
    $contentLabel.AutoSize = $true
    $contentLabel.ForeColor = $muted
    $contentLabel.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)

    $countLabel = New-Object System.Windows.Forms.Label
    $countLabel.Location = New-Object System.Drawing.Point(480, 88)
    $countLabel.Size = New-Object System.Drawing.Size(146, 20)
    $countLabel.ForeColor = $muted
    $countLabel.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $countLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
    $countLabel.Text = "$($clipboardText.Length) characters"

    $contentBox = New-Object System.Windows.Forms.RichTextBox
    $contentBox.Location = New-Object System.Drawing.Point(22, 112)
    $contentBox.Size = New-Object System.Drawing.Size(604, 235)
    $contentBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $contentBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#0D213B")
    $contentBox.ForeColor = $text
    $contentBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $contentBox.DetectUrls = $false
    $contentBox.Text = $clipboardText
    $contentBox.Add_TextChanged({ $countLabel.Text = "$($contentBox.TextLength) characters" })

    $projectLabel = New-Object System.Windows.Forms.Label
    $projectLabel.Text = "Project"
    $projectLabel.Location = New-Object System.Drawing.Point(22, 365)
    $projectLabel.AutoSize = $true
    $projectLabel.ForeColor = $muted
    $projectLabel.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)

    $projectBox = New-Object System.Windows.Forms.TextBox
    $projectBox.Location = New-Object System.Drawing.Point(22, 389)
    $projectBox.Size = New-Object System.Drawing.Size(288, 30)
    $projectBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $projectBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)

    $tagsLabel = New-Object System.Windows.Forms.Label
    $tagsLabel.Text = "Tags (auto-generated when blank)"
    $tagsLabel.Location = New-Object System.Drawing.Point(338, 365)
    $tagsLabel.AutoSize = $true
    $tagsLabel.ForeColor = $muted
    $tagsLabel.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)

    $tagsBox = New-Object System.Windows.Forms.TextBox
    $tagsBox.Location = New-Object System.Drawing.Point(338, 389)
    $tagsBox.Size = New-Object System.Drawing.Size(288, 30)
    $tagsBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $tagsBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)

    $privacyLabel = New-Object System.Windows.Forms.Label
    $privacyLabel.Text = "SYSTEM ONLINE  //  SQLITE LOCAL  //  ONEDRIVE SYNC"
    $privacyLabel.Location = New-Object System.Drawing.Point(24, 606)
    $privacyLabel.Size = New-Object System.Drawing.Size(425, 22)
    $privacyLabel.ForeColor = $success
    $privacyLabel.Font = New-Object System.Drawing.Font("Consolas", 8.5, [System.Drawing.FontStyle]::Bold)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = "Cancel"
    $cancelButton.Location = New-Object System.Drawing.Point(458, 630)
    $cancelButton.Size = New-Object System.Drawing.Size(96, 40)
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancelButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $cancelButton.FlatAppearance.BorderColor = $border
    $cancelButton.FlatAppearance.BorderSize = 1
    $cancelButton.BackColor = $soft
    $cancelButton.ForeColor = $text
    $cancelButton.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9.5)
    $cancelButton.Cursor = [System.Windows.Forms.Cursors]::Hand

    $saveButton = New-Object System.Windows.Forms.Button
    $saveButton.Text = "Save to library"
    $saveButton.Location = New-Object System.Drawing.Point(564, 630)
    $saveButton.Size = New-Object System.Drawing.Size(110, 40)
    $saveButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $saveButton.FlatAppearance.BorderSize = 0
    $saveButton.BackColor = $accent
    $saveButton.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#061526")
    $saveButton.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9.5)
    $saveButton.Cursor = [System.Windows.Forms.Cursors]::Hand
    $saveButton.Add_MouseEnter({ if ($saveButton.Enabled) { $saveButton.BackColor = $accentHover } })
    $saveButton.Add_MouseLeave({ $saveButton.BackColor = $accent })

    $saveButton.Add_Click({
        if ([string]::IsNullOrWhiteSpace($contentBox.Text)) {
            [System.Windows.Forms.MessageBox]::Show(
                $form,
                "Content cannot be empty.",
                "Cannot save",
                "OK",
                "Warning"
            )
            return
        }

        $saveButton.Enabled = $false
        $saveButton.Text = "Saving..."
        try {
            $tags = @($tagsBox.Text -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            $body = @{
                title = $titleBox.Text.Trim()
                content = $contentBox.Text.Trim()
                source = "https://copilot.microsoft.com/"
                project = $projectBox.Text.Trim()
                tags = $tags
            } | ConvertTo-Json -Depth 4

            Invoke-RestMethod `
                -Uri "$serviceUrl/entries" `
                -Method Post `
                -Headers (Get-AuthHeaders) `
                -ContentType "application/json; charset=utf-8" `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | Out-Null

            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
            Show-Balloon "Saved" "Clipboard content was added to the AI knowledge inbox." Info
        } catch {
            Reset-ServiceProof
            $message = $_.ErrorDetails.Message
            if ($message) {
                try { $message = ($message | ConvertFrom-Json).error } catch {}
            }
            if (-not $message) { $message = $_.Exception.Message }
            [System.Windows.Forms.MessageBox]::Show($form, $message, "Save failed", "OK", "Error")
        } finally {
            $saveButton.Enabled = $true
            $saveButton.Text = "Save to library"
            $saveButton.BackColor = $accent
        }
    })

    $card.Controls.AddRange(@(
        $cardSignal, $titleLabel, $titleBox, $contentLabel, $countLabel, $contentBox,
        $projectLabel, $projectBox, $tagsLabel, $tagsBox
    ))
    $root.Controls.AddRange(@($header, $sourceBadge, $card, $privacyLabel, $cancelButton, $saveButton))
    $form.Controls.Add($root)
    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton
    $form.Add_Shown({
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $radius = 20
        $width = $form.Width
        $height = $form.Height
        $path.AddArc(0, 0, $radius, $radius, 180, 90)
        $path.AddArc($width - $radius, 0, $radius, $radius, 270, 90)
        $path.AddArc($width - $radius, $height - $radius, $radius, $radius, 0, 90)
        $path.AddArc(0, $height - $radius, $radius, $radius, 90, 90)
        $path.CloseFigure()
        $form.Region = New-Object System.Drawing.Region($path)
        $path.Dispose()
        $cardPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $cardRadius = 24
        $cardPath.AddArc(0, 0, $cardRadius, $cardRadius, 180, 90)
        $cardPath.AddArc($card.Width - $cardRadius, 0, $cardRadius, $cardRadius, 270, 90)
        $cardPath.AddArc($card.Width - $cardRadius, $card.Height - $cardRadius, $cardRadius, $cardRadius, 0, 90)
        $cardPath.AddArc(0, $card.Height - $cardRadius, $cardRadius, $cardRadius, 90, 90)
        $cardPath.CloseFigure()
        $card.Region = New-Object System.Drawing.Region($cardPath)
        $cardPath.Dispose()
        $titleBox.SelectAll()
        $titleBox.Focus()
    })
    $form.Add_FormClosed({ $script:captureOpen = $false })
    $form.ShowDialog() | Out-Null
    $form.Dispose()
}

try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null
    Set-Content -LiteralPath $pidFile -Value $PID -Encoding ASCII
    Start-KnowledgeService
    Initialize-AuthToken
    Assert-ServiceIdentity

    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    $notifyIcon.Text = "AI Knowledge Companion - Ctrl+;"
    $notifyIcon.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $captureItem = $menu.Items.Add("Save clipboard (Ctrl+;)")
    $pairItem = $menu.Items.Add("Pair browser extension...")
    $diagnosticsItem = $menu.Items.Add("Save diagnostics...")
    $dataItem = $menu.Items.Add("Open data folder")
    $menu.Items.Add("-") | Out-Null
    $exitItem = $menu.Items.Add("Exit")
    $notifyIcon.ContextMenuStrip = $menu

    $hotKey = New-Object GlobalHotKeyWindow(1, 0x0002, 0xBA)
    $hotKey.add_Pressed({ Show-CaptureWindow })
    $captureItem.Add_Click({ Show-CaptureWindow })
    $pairItem.Add_Click({ Show-PairingCode })
    $diagnosticsItem.Add_Click({ Save-Diagnostics })
    $notifyIcon.Add_DoubleClick({ Show-CaptureWindow })
    $dataItem.Add_Click({
        Start-Process explorer.exe -ArgumentList "`"$dataDir`""
    })
    $exitItem.Add_Click({ [System.Windows.Forms.Application]::Exit() })

    Show-Balloon "AI Knowledge Companion is running" "Copy Copilot content and press Ctrl+;." Info
    [System.Windows.Forms.Application]::Run()
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        "AI Knowledge Companion failed to start",
        "OK",
        "Error"
    ) | Out-Null
} finally {
    if ($hotKey) { $hotKey.Dispose() }
    if ($notifyIcon) {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
    if ($script:serviceProcess -and -not $script:serviceProcess.HasExited) {
        Stop-Process -Id $script:serviceProcess.Id
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
