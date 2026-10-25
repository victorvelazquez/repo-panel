# Registers a per-user scheduled task that starts the repo-panel tray icon at every Windows logon.
# No admin rights needed. Remove it with uninstall-tray.ps1. -DryRun only prints what would be registered.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$taskName = 'repo-panel-tray'
$root = Split-Path -Parent $PSScriptRoot
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
