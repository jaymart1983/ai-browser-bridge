# uninstall.ps1 — remove the Browser Bridge Windows service task + stop it.
$ErrorActionPreference = "SilentlyContinue"
Unregister-ScheduledTask -TaskName "BrowserBridge" -Confirm:$false
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*server.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Browser Bridge uninstalled (task removed, process stopped)."
Write-Host "Remove the extension from chrome://extensions to finish."
