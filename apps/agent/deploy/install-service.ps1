<#
.SYNOPSIS
  Install / uninstall the HERA on-prem agent as a Windows service (via WinSW).

.DESCRIPTION
  Deploy flow:
    1. On a dev/CI box:  bun run build:agent   -> apps/agent/dist/hera-agent.exe
    2. Copy into one folder on the on-prem box (e.g. C:\HERA-Agent\):
         - hera-agent.exe              (the compiled agent)
         - hera-agent-service.xml      (WinSW config; fill in the <env> values)
         - install-service.ps1         (this script)
    3. Fill in HERA_AGENT_TOKEN / B1_* in hera-agent-service.xml.
    4. Open an *elevated* PowerShell in that folder and run:  .\install-service.ps1
  Uninstall:  .\install-service.ps1 -Uninstall

  WinSW (the service wrapper) is fetched from its pinned GitHub release unless you
  pass -WinSWPath to a pre-downloaded copy (air-gapped sites).

.PARAMETER Uninstall
  Stop and remove the service instead of installing.

.PARAMETER WinSWPath
  Path to a pre-downloaded WinSW-x64.exe. Skips the download.

.PARAMETER WinSWSha256
  Optional expected SHA-256 of the WinSW exe. If set, the script aborts on mismatch.
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$WinSWPath,
  [string]$WinSWSha256
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# WinSW wrapper must share the XML's basename: hera-agent-service.{xml,exe}
$xml     = Join-Path $here "hera-agent-service.xml"
$wrapper = Join-Path $here "hera-agent-service.exe"
$agent   = Join-Path $here "hera-agent.exe"

# Pinned WinSW release (the URL pins the version; github.com is TLS-authenticated).
$winswVersion = "v2.12.0"
$winswUrl     = "https://github.com/winsw/winsw/releases/download/$winswVersion/WinSW-x64.exe"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this from an elevated PowerShell (Administrator)."
  }
}

Assert-Admin
if (-not (Test-Path $xml)) { throw "Missing $xml" }

if ($Uninstall) {
  if (-not (Test-Path $wrapper)) { throw "Missing $wrapper - nothing to uninstall." }
  & $wrapper stop $xml
  & $wrapper uninstall $xml
  Write-Host "hera-agent service removed." -ForegroundColor Green
  return
}

# ---- Install ----
if (-not (Test-Path $agent)) {
  throw "Missing $agent. Build it first (bun run build:agent) and copy it here."
}

# Refuse to install with placeholder secrets still in the XML.
if ((Get-Content $xml -Raw) -match "__FILL_ME__") {
  throw "hera-agent-service.xml still has __FILL_ME__ placeholders. Fill in the <env> values first."
}

# Obtain WinSW: use the provided copy, or download the pinned release.
if ($WinSWPath) {
  Copy-Item -Force $WinSWPath $wrapper
} elseif (-not (Test-Path $wrapper)) {
  Write-Host "Downloading WinSW $winswVersion ..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $winswUrl -OutFile $wrapper -UseBasicParsing
}

$hash = (Get-FileHash $wrapper -Algorithm SHA256).Hash
if ($WinSWSha256) {
  if ($hash -ne $WinSWSha256.ToUpper()) {
    Remove-Item -Force $wrapper
    throw "WinSW SHA-256 mismatch. Expected $WinSWSha256, got $hash."
  }
} else {
  Write-Host "WinSW SHA-256: $hash  (pin it via -WinSWSha256 to enforce on future installs)" -ForegroundColor Yellow
}

& $wrapper install $xml
& $wrapper start $xml
Get-Service hera-agent | Format-Table -AutoSize
Write-Host "Installed. Logs: $(Join-Path $here 'logs')" -ForegroundColor Green
