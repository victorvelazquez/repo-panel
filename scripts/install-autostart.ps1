# Registers a per-user scheduled task that starts repo-panel at every Windows logon.
# No admin rights needed. Remove it with uninstall-autostart.ps1. -DryRun only prints what would be registered.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$taskName = 'repo-panel'
$root = Split-Path -Parent $PSScriptRoot
# The task runs node through conhost, which cannot start a node.cmd or node.ps1 shim (npm, volta, fnm): it needs a real .exe.
function Get-NodeExe {
  $exe = @(Get-Command node -All -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -like '*.exe' })
  if (-not $exe.Count) { throw 'node.exe was not found on PATH.' }
  return $exe[0].Source
}

$node = Get-NodeExe
$argument = "--headless `"$node`" server.js"

if ($DryRun) {
  Write-Host "Dry run: nothing was registered."
  Write-Host "Task:      $taskName (at logon of $env:USERNAME, interactive, limited)"
  Write-Host "Action:    conhost.exe $argument"
  Write-Host "Folder:    $root"
  return
}

# conhost --headless runs the console app without opening a window.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless `"$node`" server.js" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Retry if the process exits with an error (e.g. another program briefly held the port at boot).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Task '$taskName' installed. repo-panel will start at your next logon."
Write-Host "Start it now with: Start-ScheduledTask -TaskName $taskName"
