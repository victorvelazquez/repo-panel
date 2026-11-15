# Notification-area (tray) icon for repo-panel: open the panel, start it or restart it without hunting processes.
# Windows only. Install it at logon with install-tray.ps1. -SelfTest prints facts as JSON and creates no window. -RenderIcons <size> draws both icons at that size and prints
# their pixels as JSON (no window, nothing written): the dot of the icon is blue while the panel runs and soft red while it is stopped (RP187; light gray is the other option, see Get-TrayColors).
# RP200: the menu has Restart tray. The tray reads this script ONCE, when it starts; Restart tray starts a NEW tray (a child of this one, like the task starts it) with -ReplacePid <this process>, which waits for
# this process to END before it takes the single-instance lock (-ReplaceWaitSeconds is how long it waits), and then this one leaves. Before that the script on disk is tried in the dry way (-CheckScript <path>
# prints { ok } after running that script with -SelfTest; -ReplaceWaitSeconds is also its time limit); -SelfTestReplace waits like the new tray would and prints { replaced, waitedMs }: neither opens a window or takes the lock.
param(
  [string]$ConfigPath = $(if ($env:REPO_PANEL_CONFIG) { $env:REPO_PANEL_CONFIG } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json' }),
  [switch]$SelfTest,
  [switch]$SelfTestRestart,
  [int]$RenderIcons = 0,
  [int]$ReplacePid = 0,
  [int]$ReplaceWaitSeconds = 20,
  [string]$CheckScript = '',
  [switch]$SelfTestReplace
)
$ErrorActionPreference = 'Stop'

$script:root = Split-Path -Parent $PSScriptRoot
$script:taskName = 'repo-panel'
$script:menuLabels = @('Open panel', 'Restart panel', 'Start panel', 'Restart tray', 'Quit tray')

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

# RP200: true when the process $ProcessId is gone (it never was, or it ended within $Seconds); false when it is still alive after that. The new tray waits like this for the old one before it takes the lock.
function Wait-ProcessEnd([int]$ProcessId, [int]$Seconds) {
  $end = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $end) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 150
  }
  return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# RP200: the dry run. Runs the script at $Path with -SelfTest (it must load and answer, with exit code 0) in a hidden process with a time limit, and ends it if it hangs. A script that does not even load never replaces the tray that works.
function Test-TrayScript([string]$Path, [int]$Seconds = 20) {
  $result = [ordered]@{ ok = $false; seconds = 0 }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sink = Join-Path ([System.IO.Path]::GetTempPath()) "repo-panel-tray-check-$PID.txt"
  try {
    $p = Start-Process -FilePath $powershell -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Path`" -SelfTest" -WindowStyle Hidden -PassThru -RedirectStandardOutput $sink
    $null = $p.Handle   # keeps the handle: without it the exit code of a process that has already ended reads as empty
    if (-not $p.WaitForExit($Seconds * 1000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } else { $result.ok = ($p.ExitCode -eq 0) }
  } catch { $result.ok = $false } finally {
    Remove-Item -LiteralPath $sink -Force -ErrorAction SilentlyContinue
    $result.seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1)
  }
  return $result
}

# RP200: starts the NEW tray the way the task starts it (conhost --headless, the full path of powershell: conhost cannot run a shim), in the folder of the repo, with the process to wait for. The task refuses a second
# instance (MultipleInstances: IgnoreNew), so the new tray is a child of this one; measured on this PC, such a child outlives the end of the task instance.
function Start-NewTray([int]$OldPid) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath 'conhost.exe' -ArgumentList "--headless `"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ReplacePid $OldPid" `
    -WorkingDirectory $script:root -WindowStyle Hidden | Out-Null
}

# RP200: Restart tray. The script on disk is tried first; only then is the child started, and only after the child was started does the caller leave. Any failure leaves this tray where it was and says why.
function Invoke-TrayRestart {
  $result = [ordered]@{ restarted = $false; message = '' }
  $check = Test-TrayScript $PSCommandPath
  if (-not $check.ok) { $result.message = 'The tray script on disk does not load: the tray was not restarted.'; return $result }
  try { Start-NewTray $PID } catch { $result.message = "The new tray could not start: $($_.Exception.Message)"; return $result }
  $result.restarted = $true
  return $result
}

Add-Type -AssemblyName System.Drawing

# The colors of the icon (RP187): the dark of the panel (--bg of public/style.css, as in icon.svg), the K in near-white and a dot that tells the state: blue while the panel runs and a soft
# red while it is stopped. The person accepts a light gray (200, 205, 212) there too: to switch, change the number of Stopped (the tests allow both).
function Get-TrayColors {
  return @{
    Back    = [System.Drawing.Color]::FromArgb(15, 18, 22)
    Line    = [System.Drawing.Color]::FromArgb(58, 69, 83)   # RP199, RP203: the thin line around the square, #3a4553 (the border of the cards of public/style.css). The --line of the page (42, 50, 60) was the same tone as the menu of hidden icons of Windows (44, 47, 52): it could not be seen and the square looked smaller
    Key     = [System.Drawing.Color]::FromArgb(250, 251, 252)
    Running = [System.Drawing.Color]::FromArgb(0, 127, 255)
    Stopped = [System.Drawing.Color]::FromArgb(229, 115, 115)
  }
}

# Draws the icon: the K of the logo (RP102) and the dot of K-icon.svg on a square of the dark of the panel with slightly rounded corners. The drawing is 125.116 wide: the K (85.2 wide), a gap and the dot (19.8 by 21, on the
# baseline of the K). The K is filled with the winding rule, like SVG: its outline crosses itself at two joints and the default rule would leave a notch in each.
function New-StateBitmap([System.Drawing.Color]$Dot, [int]$Width, [int]$Height) {
  $colors = Get-TrayColors
  # The K of the logo (public/icon.svg): 14 straight-line points in the units of the logo (85.2 wide, 111.75 tall from y = 1.8).
  $kPoints = @(
    @(0, 113.55),
    @(0, 1.8),
    @(14.7, 1.8),
    @(14.7, 64.65),
    @(11.1, 63.15),
    @(64.5, 1.8),
    @(82.95, 1.8),
    @(38.1, 53.55),
    @(38.85, 43.05),
    @(85.2, 113.55),
    @(67.65, 113.55),
    @(32.25, 60.45),
    @(14.7, 80.55),
    @(14.7, 113.55)
  )
  $fit = 0.72       # the share of the width of the icon that the K and its dot take (RP199: it was 0.88; the K breathes inside its box)
  $corner = 0.14    # how rounded the corners are, as a share of the side: slightly, like the controls of the panel
  $dotBoost = 1.6   # on 16 px the dot of the file is 2 px: it is drawn 1.6 times bigger (RP199: the K is smaller now, so the dot grows to stay 3 px), from its bottom right corner, so that it can be seen
  $scale = $Width * $fit / 125.116
  $offsetX = ($Width - 125.116 * $scale) / 2
  $offsetY = ($Height - 111.75 * $scale) / 2 - 1.8 * $scale
  $points = [System.Drawing.PointF[]]($kPoints | ForEach-Object { New-Object System.Drawing.PointF([single]($offsetX + $_[0] * $scale), [single]($offsetY + $_[1] * $scale)) })
  $dotW = 19.8 * $dotBoost * $scale
  $dotH = 21 * $dotBoost * $scale
  # The dot snaps to whole pixels, so its color is flat and its edges are sharp.
  $dotX = [int][Math]::Round($offsetX + 125.116 * $scale - $dotW)
  $dotY = [int][Math]::Round($offsetY + 113.55 * $scale - $dotH)
  $dotPxW = [int][Math]::Max(2, [Math]::Round($dotW))
  $dotPxH = [int][Math]::Max(2, [Math]::Round($dotH))
  $d = [single]([Math]::Min($Width, $Height) * $corner * 2)
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $backBrush = New-Object System.Drawing.SolidBrush($colors.Back)
  $keyBrush = New-Object System.Drawing.SolidBrush($colors.Key)
  $dotBrush = New-Object System.Drawing.SolidBrush($Dot)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $linePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $linePen = New-Object System.Drawing.Pen($colors.Line, 1)
  try {
    $path.AddArc([single]0, [single]0, $d, $d, 180, 90)
    $path.AddArc([single]($Width - $d), [single]0, $d, $d, 270, 90)
    $path.AddArc([single]($Width - $d), [single]($Height - $d), $d, $d, 0, 90)
    $path.AddArc([single]0, [single]($Height - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    # RP199: the line is the same rounded square, half a pixel inside, so a pen of ONE pixel covers exactly the outermost row and column of pixels
    $ld = [single]($d - 1)
    $linePath.AddArc([single]0.5, [single]0.5, $ld, $ld, 180, 90)
    $linePath.AddArc([single]($Width - 0.5 - $ld), [single]0.5, $ld, $ld, 270, 90)
    $linePath.AddArc([single]($Width - 0.5 - $ld), [single]($Height - 0.5 - $ld), $ld, $ld, 0, 90)
    $linePath.AddArc([single]0.5, [single]($Height - 0.5 - $ld), $ld, $ld, 90, 90)
    $linePath.CloseFigure()
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half   # the center of a pixel is at +0.5, as in SVG: without it everything lands half a pixel off and the corners are not clean
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.FillPath($backBrush, $path)
    $g.DrawPath($linePen, $linePath)
    $g.FillPolygon($keyBrush, $points, [System.Drawing.Drawing2D.FillMode]::Winding)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.FillRectangle($dotBrush, $dotX, $dotY, $dotPxW, $dotPxH)
  } finally { $linePen.Dispose(); $linePath.Dispose(); $path.Dispose(); $dotBrush.Dispose(); $keyBrush.Dispose(); $backBrush.Dispose(); $g.Dispose() }
  return $bmp
}

if ($CheckScript) {
  # -CheckScript <path>: the dry run of Restart tray (-ReplaceWaitSeconds is its time limit). No window, no lock, nothing started but the hidden check.
  $r = Test-TrayScript $CheckScript $ReplaceWaitSeconds
  $r | ConvertTo-Json -Compress
  exit 0
}

if ($SelfTestReplace) {
  # -SelfTestReplace: waits for -ReplacePid like the new tray does, and says whether it ended. No window, no lock.
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $ended = if ($ReplacePid -gt 0) { Wait-ProcessEnd $ReplacePid $ReplaceWaitSeconds } else { $true }
  [ordered]@{ replaced = [bool]$ended; waitedMs = $(if ($ReplacePid -gt 0) { [int]$watch.ElapsedMilliseconds } else { 0 }) } | ConvertTo-Json -Compress
  exit 0
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

if ($RenderIcons -gt 0) {
  # -RenderIcons <size>: draws both icons at that size and prints their pixels (R, G, B and A of every pixel, row by row) as JSON. No window, no mutex, nothing written.
  $colors = Get-TrayColors
  $out = [ordered]@{ size = $RenderIcons }
  foreach ($state in 'running', 'stopped') {
    $bmp = New-StateBitmap $(if ($state -eq 'running') { $colors.Running } else { $colors.Stopped }) $RenderIcons $RenderIcons
    $pixels = New-Object 'System.Collections.Generic.List[int]'
    for ($y = 0; $y -lt $RenderIcons; $y++) {
      for ($x = 0; $x -lt $RenderIcons; $x++) { $c = $bmp.GetPixel($x, $y); $pixels.Add($c.R); $pixels.Add($c.G); $pixels.Add($c.B); $pixels.Add($c.A) }
    }
    $bmp.Dispose()
    $out[$state] = $pixels
  }
  $out | ConvertTo-Json -Compress
  exit 0
}

# ---- UI ----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace RepoPanel -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle);'

# RP200: a tray started by Restart tray waits for the old one to END before it takes the lock (the old one released it when it left); if the old one does not end in time it leaves quietly and the old one stays.
if ($ReplacePid -gt 0) {
  if (-not (Wait-ProcessEnd $ReplacePid $ReplaceWaitSeconds)) { exit 0 }
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\repo-panel-tray', [ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }

# Makes the icon of the tray from the bitmap (RP187) and returns it plus the raw handle that must be destroyed later.
function New-StateIcon([System.Drawing.Color]$Dot) {
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize
  $bmp = New-StateBitmap $Dot $size.Width $size.Height
  try { $handle = $bmp.GetHicon() } finally { $bmp.Dispose() }
  return @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}

$script:busy = $false
$script:port = Get-PanelPort
$script:healthy = $false
$colors = Get-TrayColors
$running = New-StateIcon $colors.Running
$stopped = New-StateIcon $colors.Stopped

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add($script:menuLabels[0])
$itemRestart = $menu.Items.Add($script:menuLabels[1])
$itemStart = $menu.Items.Add($script:menuLabels[2])
$itemRestartTray = $menu.Items.Add($script:menuLabels[3])
[void]$menu.Items.Add('-')
$itemQuit = $menu.Items.Add($script:menuLabels[4])
$notify.ContextMenuStrip = $menu

function Show-Balloon([string]$Text) {
  try { $notify.ShowBalloonTip(5000, 'Kletus.dev', $Text, [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
}

function Update-State {
  $script:port = Get-PanelPort
  $script:healthy = Test-PanelHealthy $script:port
  $notify.Icon = if ($script:healthy) { $running.Icon } else { $stopped.Icon }
  $notify.Text = if ($script:healthy) { "Kletus.dev: running (port $($script:port))" } else { 'Kletus.dev: stopped' }
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
$itemRestartTray.add_Click({ Invoke-Safe {
  Show-Balloon 'Restarting the tray...'
  $r = Invoke-TrayRestart
  if ($r.restarted) { $context.ExitThread() } else { Show-Balloon $r.message }
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
  foreach ($i in @($running, $stopped)) { $i.Icon.Dispose(); [void][RepoPanel.Native]::DestroyIcon($i.Handle) }
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
