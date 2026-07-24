# install.ps1 — Browser Bridge setup for Windows.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Registers a logon Scheduled Task that keeps the bridge running (the Windows
# equivalent of the macOS launchd agent), starts it now, and opens the extension
# folder so you can Load-unpacked it. Uninstall with uninstall.ps1.

$ErrorActionPreference = "Stop"
$Dir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $Dir "bridge"
$Server = Join-Path $Bridge "server.mjs"

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  Write-Error "Node.js not found in PATH. Install it from https://nodejs.org and re-run."
  exit 1
}
Write-Host "Using node: $Node"

# Free the port if something is already on it.
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Logon task that relaunches on failure (KeepAlive-like).
$action   = New-ScheduledTaskAction   -Execute $Node -Argument "`"$Server`"" -WorkingDirectory $Bridge
$trigger  = New-ScheduledTaskTrigger  -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "BrowserBridge" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "BrowserBridge"
Start-Sleep -Seconds 2

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 3 | Out-Null
  Write-Host "OK  Bridge is running and set to start at logon."
} catch {
  Write-Host "!!  Installed, but health check didn't respond yet. Check $Bridge\bridge.log"
}

Write-Host ""
Write-Host "   Dashboard: http://127.0.0.1:8787/"
Write-Host "   Next: chrome://extensions -> Developer mode -> Load unpacked -> select:"
Write-Host "     $Dir\extension"
Start-Process explorer.exe (Join-Path $Dir "extension")
