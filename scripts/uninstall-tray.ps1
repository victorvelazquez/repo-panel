# Removes the repo-panel-tray logon task created by install-tray.ps1. -DryRun only says what it would do.
# It does not close a tray that is already running: use its "Quit tray" menu item.
param([switch]$DryRun)
$taskName = 'repo-panel-tray'
if ($DryRun) {
  Write-Host "Dry run: nothing was removed. Would remove task '$taskName' if installed."
} elseif (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Task '$taskName' removed."
} else {
  Write-Host "Task '$taskName' is not installed."
}
