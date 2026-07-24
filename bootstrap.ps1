# Browser Bridge — one-command installer (Windows).
#
#   irm https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.ps1 | iex
#
# Creates %LOCALAPPDATA%\Programs\Browser Bridge, downloads the latest release into
# it, then runs install.ps1 (which fetches the pinned Node runtime, registers the
# logon task, and starts the bridge). No prerequisites — not even Node.

$ErrorActionPreference = "Stop"
$Repo   = "jaymart1983/browser-bridge"
$Target = Join-Path $env:LOCALAPPDATA "Programs\Browser Bridge"

Write-Host "Browser Bridge installer"
Write-Host "  target: $Target"

$rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$url = ($rel.assets | Where-Object { $_.name -like "*windows*.zip" } | Select-Object -First 1).browser_download_url
if (-not $url) { Write-Error "Could not find a Windows release asset."; exit 1 }
Write-Host "  downloading: $url"

$tmp = Join-Path $env:TEMP ("bb-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "bb.zip"
Invoke-WebRequest $url -OutFile $zip
Expand-Archive $zip (Join-Path $tmp "x") -Force

# Overlay app files; state/recordings/runtime aren't in the zip so a re-run keeps them.
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item (Join-Path $tmp "x\browser-bridge\*") $Target -Recurse -Force
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host "  installed files; running install.ps1…"
Set-Location $Target
powershell -ExecutionPolicy Bypass -File (Join-Path $Target "install.ps1")
