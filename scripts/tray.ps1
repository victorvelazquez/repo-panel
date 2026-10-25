# Notification-area (tray) icon for repo-panel: open the panel, start it or restart it without hunting processes.
# Windows only. Install it at logon with install-tray.ps1. -SelfTest prints facts as JSON and creates no window.
param(
  [string]$ConfigPath = $(if ($env:REPO_PANEL_CONFIG) { $env:REPO_PANEL_CONFIG } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json' }),
  [switch]$SelfTest,
  [switch]$SelfTestRestart
)
$ErrorActionPreference = 'Stop'

$script:root = Split-Path -Parent $PSScriptRoot
$script:taskName = 'repo-panel'
$script:menuLabels = @('Open panel', 'Restart panel', 'Start panel', 'Quit tray')

function Get-PanelPort {
  $port = 4310
  try {
    $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $p = [int]$cfg.port
    if ($p -ge 1 -and $p -le 65535) { $port = $p }
  } catch { }
  return $port
}

# True when http://127.0.0.1:<port>/health answers with app = repo-panel. Only talks to loopback.
function Test-PanelHealthy([int]$Port) {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/health")
    $req.Proxy = $null
    $req.Timeout = 1500
    $req.ReadWriteTimeout = 1500
    $res = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($res.GetResponseStream())
      return ((($reader.ReadToEnd() | ConvertFrom-Json).app) -eq 'repo-panel')
    } finally { $res.Close() }
  } catch { return $false }
}

function Get-Listeners([int]$Port) {
  $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess })
  return @($pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

# A listener is ours when its command line runs this repo's server.js: either with a path inside this
# repo's folder, or the relative form the autostart task uses (`node server.js`, working directory = repo),
# which only counts if that process also answers /health as repo-panel.
function Test-OwnedListener([int]$ProcessId, [int]$Port) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  $cmd = if ($proc) { [string]$proc.CommandLine } else { '' }
  if (-not $cmd -or $cmd -notmatch 'server\.js') { return $false }
  if ($cmd.IndexOf($script:root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  return (($cmd -match '(^|[\s"])server\.js"?\s*$') -and (Test-PanelHealthy $Port))
}

function Get-OwnedListeners([int]$Port) {
  return @(Get-Listeners $Port | Where-Object { Test-OwnedListener $_ $Port })
}

function Test-PanelTask {
  return [bool](Get-ScheduledTask -TaskName $script:taskName -ErrorAction SilentlyContinue)
}

# Same command the scheduled task runs: conhost --headless node server.js, in the repo folder.
# The first `node` on PATH can be a .cmd or .ps1 shim (npm, volta, fnm), which conhost cannot run: take a real .exe.
function Get-NodeExe {
  $exe = @(Get-Command node -All -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -like '*.exe' })
  if (-not $exe.Count) { throw 'node.exe was not found on PATH.' }
  return $exe[0].Source
}

function Start-PanelProcess {
  $node = Get-NodeExe
  Start-Process -FilePath 'conhost.exe' -ArgumentList "--headless `"$node`" server.js" `
    -WorkingDirectory $script:root -WindowStyle Hidden | Out-Null
}

function Start-PanelAction {
  if (Test-PanelTask) { Start-ScheduledTask -TaskName $script:taskName } else { Start-PanelProcess }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [scriptblock]$Pump) {
  $end = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $end) {
    if (& $Condition) { return $true }
    if ($Pump) { & $Pump } else { Start-Sleep -Milliseconds 200 }
  }
  return [bool](& $Condition)
}

# Ends only the listeners owned by this repo's server.js, then runs $StartAction and waits for /health.
function Invoke-PanelRestart([int]$Port, [scriptblock]$StartAction, [scriptblock]$Pump) {
  $result = [ordered]@{ restarted = $false; oldPid = 0; newPid = 0; message = '' }
  $listeners = Get-Listeners $Port
  $owned = @($listeners | Where-Object { Test-OwnedListener $_ $Port })
  if ($listeners.Count -gt $owned.Count) {
    $result.message = "Port $Port is used by another program; nothing was ended."
    return $result
  }
  if ($owned.Count) { $result.oldPid = $owned[0] }
  foreach ($id in $owned) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  if (-not (Wait-Until { (Get-Listeners $Port).Count -eq 0 } 8 $Pump)) {
    $result.message = "The old process did not release port $Port."
    return $result
  }
  & $StartAction
  if (Wait-Until { Test-PanelHealthy $Port } 15 $Pump) {
    $result.restarted = $true
    $now = @(Get-OwnedListeners $Port)
    if ($now.Count) { $result.newPid = $now[0] }
    $result.message = "repo-panel restarted (port $Port)."
  } else {
    $result.message = "repo-panel did not answer on port $Port within 15 s."
  }
  return $result
}

function Invoke-PanelStart([int]$Port, [scriptblock]$Pump) {
  $listeners = Get-Listeners $Port
  if ($listeners.Count) { return "Port $Port is already in use; not starting." }
  Start-PanelAction
  if (Wait-Until { Test-PanelHealthy $Port } 15 $Pump) { return "repo-panel started (port $Port)." }
  return "repo-panel did not answer on port $Port within 15 s."
}

if ($SelfTest -or $SelfTestRestart) {
  $port = Get-PanelPort
  if ($SelfTestRestart) {
    # Kills processes by port, so it only runs against a throwaway config inside the OS temp folder.
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $ok = $false
    if ($env:REPO_PANEL_CONFIG) {
      $envFull = [System.IO.Path]::GetFullPath($env:REPO_PANEL_CONFIG)
      $cfgFull = [System.IO.Path]::GetFullPath($ConfigPath)
      $ok = $envFull.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and $cfgFull.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)
    }
    if (-not $ok) {
      [Console]::Error.WriteLine('-SelfTestRestart refused: REPO_PANEL_CONFIG and -ConfigPath must point inside the OS temp folder.')
      exit 2
    }
    $r = Invoke-PanelRestart $port { Start-PanelProcess } $null
    [ordered]@{ restarted = $r.restarted; oldPid = $r.oldPid; newPid = $r.newPid } | ConvertTo-Json -Compress
    exit 0
  }
  $listeners = Get-Listeners $port
  [ordered]@{
    port           = $port
    healthy        = (Test-PanelHealthy $port)
    listeners      = @($listeners)
    ownedListeners = @($listeners | Where-Object { Test-OwnedListener $_ $port })
    menu           = $script:menuLabels
    task           = (Test-PanelTask)
  } | ConvertTo-Json -Compress
  exit 0
}

# ---- UI ----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace RepoPanel -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle);'

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\repo-panel-tray', [ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }

# Draws a round badge with an "R" and returns the icon plus the raw handle that must be destroyed later.
function New-StateIcon([System.Drawing.Color]$Color) {
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize
  $bmp = New-Object System.Drawing.Bitmap($size.Width, $size.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $brush = New-Object System.Drawing.SolidBrush($Color)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font('Segoe UI', ($size.Height * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.FillEllipse($brush, 0, 0, $size.Width - 1, $size.Height - 1)
    $g.DrawString('R', $font, $white, (New-Object System.Drawing.RectangleF(0, 0, $size.Width, $size.Height)), $fmt)
    $handle = $bmp.GetHicon()
  } finally { $fmt.Dispose(); $font.Dispose(); $white.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose() }
  return @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}

$script:busy = $false
$script:port = Get-PanelPort
$script:healthy = $false
$green = New-StateIcon ([System.Drawing.Color]::FromArgb(34, 139, 34))
$gray = New-StateIcon ([System.Drawing.Color]::FromArgb(128, 128, 128))

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add($script:menuLabels[0])
$itemRestart = $menu.Items.Add($script:menuLabels[1])
$itemStart = $menu.Items.Add($script:menuLabels[2])
[void]$menu.Items.Add('-')
$itemQuit = $menu.Items.Add($script:menuLabels[3])
$notify.ContextMenuStrip = $menu

function Show-Balloon([string]$Text) {
  try { $notify.ShowBalloonTip(5000, 'repo-panel', $Text, [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
}

function Update-State {
  $script:port = Get-PanelPort
  $script:healthy = Test-PanelHealthy $script:port
  $notify.Icon = if ($script:healthy) { $green.Icon } else { $gray.Icon }
  $notify.Text = if ($script:healthy) { "repo-panel: running (port $($script:port))" } else { 'repo-panel: stopped' }
  $itemStart.Enabled = -not $script:healthy
}

# Keeps the menu responsive while waiting for the panel.
$pump = { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150 }

function Invoke-Safe([scriptblock]$Action) {
  if ($script:busy) { return }
  $script:busy = $true
  try { & $Action } catch { Show-Balloon ("Error: " + $_.Exception.Message) } finally { $script:busy = $false }
  try { Update-State } catch { }
}

$openPanel = { Invoke-Safe { Start-Process "http://127.0.0.1:$($script:port)/" } }
$itemOpen.add_Click($openPanel)
$notify.add_DoubleClick($openPanel)
$itemRestart.add_Click({ Invoke-Safe {
  Show-Balloon 'Restarting repo-panel...'
  $r = Invoke-PanelRestart $script:port { Start-PanelAction } $pump
  Show-Balloon $r.message
} })
$itemStart.add_Click({ Invoke-Safe {
  Show-Balloon (Invoke-PanelStart $script:port $pump)
} })
$menu.add_Opening({ try { Update-State } catch { } })

$context = New-Object System.Windows.Forms.ApplicationContext
$itemQuit.add_Click({ $context.ExitThread() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ if (-not $script:busy) { try { Update-State } catch { } } })

try {
  Update-State
  $notify.Visible = $true
  $timer.Start()
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop(); $timer.Dispose()
  $notify.Visible = $false
  $notify.Dispose()
  $menu.Dispose()
  foreach ($i in @($green, $gray)) { $i.Icon.Dispose(); [void][RepoPanel.Native]::DestroyIcon($i.Handle) }
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
