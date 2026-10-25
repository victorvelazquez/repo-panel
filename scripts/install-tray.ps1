# Registers a per-user scheduled task that starts the repo-panel tray icon at every Windows logon.
# No admin rights needed. Remove it with uninstall-tray.ps1. -DryRun only prints what would be registered.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$taskName = 'repo-panel-tray'
$root = Split-Path -Parent $PSScriptRoot
# True when $Path is the OS temp folder or inside it. A copy of these scripts there must never touch the user's real tasks.
function Test-UnderTemp([string]$Path, [string]$Temp = [System.IO.Path]::GetTempPath()) {
  $sep = [string][System.IO.Path]::DirectorySeparatorChar
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + $sep
  $base = [System.IO.Path]::GetFullPath($Temp).TrimEnd('\', '/') + $sep
  return $full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)
}
if (Test-UnderTemp $root) {
  [Console]::Error.WriteLine("install-tray.ps1 refused: this copy lives inside the OS temp folder ($root); install from the real repository folder.")
  exit 2
}
$script = Join-Path $root 'scripts\tray.ps1'
$argument = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

if ($DryRun) {
  Write-Host "Dry run: nothing was registered."
  Write-Host "Task:      $taskName (at logon of $env:USERNAME, interactive, limited)"
  Write-Host "Action:    powershell.exe $argument"
  Write-Host "Folder:    $root"
  return
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Task '$taskName' installed. The repo-panel tray icon will start at your next logon."
Write-Host "Start it now with: Start-ScheduledTask -TaskName $taskName"
