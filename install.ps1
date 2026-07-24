# install.ps1 — Browser Bridge setup for Windows.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Downloads the PINNED Node runtime into .\runtime (no prerequisites to install),
# registers a logon Scheduled Task that keeps the bridge running, starts it, and
# opens the extension folder. Uninstall with uninstall.ps1.

$ErrorActionPreference = "Stop"
$Dir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge  = Join-Path $Dir "bridge"
$Server  = Join-Path $Bridge "server.mjs"
$Runtime = Join-Path $Dir "runtime"
$Node    = Join-Path $Runtime "node.exe"

# Pinned Node version (single source of truth: runtime.json).
$NodeVer = (Get-Content (Join-Path $Dir "runtime.json") -Raw | ConvertFrom-Json).node
if (-not $NodeVer) { Write-Error "Could not read pinned Node version from runtime.json"; exit 1 }

# Fetch + verify the pinned Node once (skip if the right version is already present).
$have = $false
if (Test-Path $Node) { try { if ((& $Node --version) -match "v$NodeVer") { $have = $true } } catch {} }
if (-not $have) {
  $pkg = "node-v$NodeVer-win-x64"
  $url = "https://nodejs.org/dist/v$NodeVer/$pkg.zip"
  Write-Host "Downloading pinned Node v$NodeVer (x64)…"
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $tmp = Join-Path $env:TEMP "bb-node.zip"
  Invoke-WebRequest -Uri $url -OutFile $tmp
  # Verify against the official SHASUMS256.
  $want = ((Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVer/SHASUMS256.txt").Content -split "`n" |
           Where-Object { $_ -match "  $pkg.zip$" }) -replace '\s.*$',''
  $got  = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $got) { Write-Error "Node download failed checksum verification"; exit 1 }
  $ex = Join-Path $env:TEMP "bb-node"
  Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
  Expand-Archive -Path $tmp -DestinationPath $ex -Force
  Copy-Item (Join-Path $ex "$pkg\node.exe") $Node -Force
  Write-Host "Installed runtime: $(& $Node --version)"
}

# Free the port if something is already on it.
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Logon task that relaunches on failure (KeepAlive-like). Runs via run-bridge.cmd so
# a staged Node runtime update (runtime\node.new) is swapped in before start.
$Launcher = Join-Path $Dir "run-bridge.cmd"
$action   = New-ScheduledTaskAction   -Execute $Launcher -WorkingDirectory $Dir
$trigger  = New-ScheduledTaskTrigger  -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "BrowserBridge" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "BrowserBridge"
Start-Sleep -Seconds 2

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 3 | Out-Null
  Write-Host "OK  Bridge is running (bundled Node v$NodeVer) and set to start at logon."
} catch {
  Write-Host "!!  Installed, but health check didn't respond yet. Check $Bridge\bridge.log"
}

Write-Host ""
Write-Host "   Dashboard: http://127.0.0.1:8787/"
Write-Host "   Next: chrome://extensions -> Developer mode -> Load unpacked -> select:"
Write-Host "     $Dir\extension"
Start-Process explorer.exe (Join-Path $Dir "extension")
