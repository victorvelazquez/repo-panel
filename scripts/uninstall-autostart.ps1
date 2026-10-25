# Removes the repo-panel logon task created by install-autostart.ps1. -DryRun only says what it would do.
param([switch]$DryRun)
$taskName = 'repo-panel'
$root = Split-Path -Parent $PSScriptRoot
# True when $Path is the OS temp folder or inside it. A copy of these scripts there must never touch the user's real tasks.
function Test-UnderTemp([string]$Path, [string]$Temp = [System.IO.Path]::GetTempPath()) {
  $sep = [string][System.IO.Path]::DirectorySeparatorChar
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + $sep
  $base = [System.IO.Path]::GetFullPath($Temp).TrimEnd('\', '/') + $sep
  return $full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)
}
if (Test-UnderTemp $root) {
  [Console]::Error.WriteLine("uninstall-autostart.ps1 refused: this copy lives inside the OS temp folder ($root); install from the real repository folder.")
  exit 2
}
if ($DryRun) {
  Write-Host "Dry run: nothing was removed. Would remove task '$taskName' if installed."
  return
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Task '$taskName' removed."
} else {
  Write-Host "Task '$taskName' is not installed."
}
