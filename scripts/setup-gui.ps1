# =============================================================================
#  Lighthouse graphical setup / launcher (Windows, WinForms).
#
#  Shows a small branded window with a progress bar while it installs and builds
#  Lighthouse on first run, then launches the app. On later runs everything is
#  already built, so it goes straight to launch. Invoked by Lighthouse.cmd.
#
#  No external dependencies — WinForms ships with Windows. Needs Node.js (the
#  window offers the download if it's missing).
# =============================================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root    = Split-Path -Parent $PSScriptRoot                  # scripts\ -> repo root
$logFile = Join-Path $env:TEMP ("lighthouse-setup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

# --- palette: sandy beach + red beacon -------------------------------------
$cream = [System.Drawing.Color]::FromArgb(251,245,233)
$sand  = [System.Drawing.Color]::FromArgb(244,233,210)
$red   = [System.Drawing.Color]::FromArgb(192,42,32)
$ink   = [System.Drawing.Color]::FromArgb(60,48,40)

$form = New-Object System.Windows.Forms.Form
$form.Text            = "Lighthouse"
$form.ClientSize      = New-Object System.Drawing.Size(540,372)
$form.StartPosition   = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox     = $false
$form.BackColor       = $cream

$icoPath = Join-Path $root "build\icon.ico"
if (Test-Path $icoPath) { try { $form.Icon = New-Object System.Drawing.Icon $icoPath } catch {} }

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Size     = New-Object System.Drawing.Size(72,72)
$pic.Location = New-Object System.Drawing.Point(28,24)
$pic.SizeMode = "Zoom"
$pngPath = Join-Path $root "assets\icon.png"
if (Test-Path $pngPath) { try { $pic.Image = [System.Drawing.Image]::FromFile($pngPath) } catch {} }
$form.Controls.Add($pic)

$title = New-Object System.Windows.Forms.Label
$title.Text      = "Lighthouse"
$title.Font      = New-Object System.Drawing.Font("Segoe UI",20,[System.Drawing.FontStyle]::Bold)
$title.ForeColor = $ink
$title.Location  = New-Object System.Drawing.Point(116,32)
$title.AutoSize  = $true
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text      = "Curate what your AI can see."
$subtitle.Font      = New-Object System.Drawing.Font("Segoe UI",10)
$subtitle.ForeColor = $ink
$subtitle.Location  = New-Object System.Drawing.Point(118,72)
$subtitle.AutoSize  = $true
$form.Controls.Add($subtitle)

$status = New-Object System.Windows.Forms.Label
$status.Text      = "Preparing..."
$status.Font      = New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)
$status.ForeColor = $red
$status.Location  = New-Object System.Drawing.Point(28,118)
$status.Size      = New-Object System.Drawing.Size(484,22)
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style    = "Marquee"
$bar.MarqueeAnimationSpeed = 30
$bar.Location = New-Object System.Drawing.Point(28,146)
$bar.Size     = New-Object System.Drawing.Size(484,18)
$form.Controls.Add($bar)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline  = $true
$logBox.ReadOnly    = $true
$logBox.ScrollBars  = "Vertical"
$logBox.BackColor   = $sand
$logBox.ForeColor   = $ink
$logBox.Font        = New-Object System.Drawing.Font("Consolas",9)
$logBox.Location    = New-Object System.Drawing.Point(28,176)
$logBox.Size        = New-Object System.Drawing.Size(484,138)
$form.Controls.Add($logBox)

$btn = New-Object System.Windows.Forms.Button
$btn.Text     = "Close"
$btn.Location = New-Object System.Drawing.Point(432,324)
$btn.Size     = New-Object System.Drawing.Size(80,28)
$btn.Visible  = $false
$btn.Add_Click({ $form.Close() })
$form.Controls.Add($btn)

function Append($t) { $logBox.AppendText($t + "`r`n") }

# --- Node.js required -------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $status.Text = "Node.js is required."
  $bar.Style = "Continuous"; $bar.Value = 0
  Append "Lighthouse needs Node.js. Opening the download page..."
  Append "Install it, then run Lighthouse again."
  try { Start-Process "https://nodejs.org/en/download" } catch {}
  $btn.Visible = $true
  [System.Windows.Forms.Application]::Run($form)
  return
}

# --- shared state for the background worker --------------------------------
$sync = [hashtable]::Synchronized(@{
  Status  = ""
  Lines   = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
  Done    = $false
  Failed  = $false
  FailMsg = ""
})

$work = {
  param($sync, $root, $logFile)
  function Step($name) { $sync.Status = $name; [void]$sync.Lines.Add($name) }
  function RunCmd($cmd) {
    $errFile = "$logFile.err"
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd `
         -WorkingDirectory $root -NoNewWindow -PassThru -Wait `
         -RedirectStandardOutput $logFile -RedirectStandardError $errFile
    if ((Test-Path $errFile) -and (Get-Item $errFile).Length -gt 0) {
      Add-Content -Path $logFile -Value (Get-Content -Path $errFile -Raw)
    }
    Remove-Item $errFile -ErrorAction SilentlyContinue
    return $p.ExitCode
  }
  try {
    if (-not (Test-Path (Join-Path $root "node_modules\electron"))) {
      Step "Installing dependencies (a few minutes)..."
      if ((RunCmd "npm install") -ne 0) { $sync.FailMsg = "Install failed."; $sync.Failed = $true; return }
    }
    if (-not (Test-Path (Join-Path $root ".next\BUILD_ID"))) {
      Step "Building Lighthouse..."
      if ((RunCmd "npm run build") -ne 0) { $sync.FailMsg = "Build failed."; $sync.Failed = $true; return }
    }
    Step "Launching Lighthouse..."
    $sync.Done = $true
  } catch {
    $sync.FailMsg = $_.Exception.Message; $sync.Failed = $true
  }
}

$rs = [runspacefactory]::CreateRunspace(); $rs.Open()
$psw = [powershell]::Create(); $psw.Runspace = $rs
[void]$psw.AddScript($work).AddArgument($sync).AddArgument($root).AddArgument($logFile)
$handle = $psw.BeginInvoke()

$script:shown = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  while ($script:shown -lt $sync.Lines.Count) { Append $sync.Lines[$script:shown]; $script:shown++ }
  if ($sync.Status) { $status.Text = $sync.Status }
  if ($sync.Failed) {
    $timer.Stop()
    $bar.Style = "Continuous"; $bar.Value = 0
    $status.Text = $sync.FailMsg
    Append ("See log: " + $logFile)
    $btn.Visible = $true
  } elseif ($sync.Done) {
    $timer.Stop()
    try {
      Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run electron" `
        -WorkingDirectory $root -WindowStyle Hidden
    } catch {}
    $form.Close()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
try { $psw.EndInvoke($handle) } catch {}
$rs.Close()
