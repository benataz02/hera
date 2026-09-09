# Registers hera-agent (and optionally cloudflared) as Windows services.
# Run elevated, from the folder holding hera-agent.exe and agent.json.
#
#   bun run build                       # produces hera-agent.exe
#   .\deploy\install-service.ps1        # dev / LAN: no tunnel (set "bindHost": "0.0.0.0" in agent.json)
#   .\deploy\install-service.ps1 -TunnelToken <token>
#
# ponytail: sc.exe, not NSSM or a service wrapper. A compiled Bun binary is a normal exe and
# Windows restarts it on failure by itself.
param(
  [string]$ExePath = (Join-Path $PSScriptRoot "..\hera-agent.exe"),
  [string]$ConfigPath = (Join-Path $PSScriptRoot "..\agent.json"),
  [string]$TunnelToken
)

$ErrorActionPreference = "Stop"
$exe = (Resolve-Path $ExePath).Path
$cfg = (Resolve-Path $ConfigPath).Path

if ((sc.exe query hera-agent 2>$null) -match "SERVICE_NAME") {
  Write-Host "hera-agent exists - stopping and deleting first"
  sc.exe stop hera-agent | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete hera-agent | Out-Null
  Start-Sleep -Seconds 2
}

# HERA_AGENT_CONFIG is read by src/index.ts; the service has no working directory of its own.
sc.exe create hera-agent binPath= "`"$exe`"" start= auto DisplayName= "HERA on-prem agent"
sc.exe description hera-agent "Bridges HERA cloud to the local SAP B1 Service Layer."
sc.exe failure hera-agent reset= 86400 actions= restart/5000/restart/5000/restart/30000
[Environment]::SetEnvironmentVariable("HERA_AGENT_CONFIG", $cfg, "Machine")
sc.exe start hera-agent

if ($TunnelToken) {
  # Production only: cloudflared dials out, so no inbound firewall hole. The agent URL in
  # sap_connection then becomes the tunnel hostname - config, not code.
  cloudflared.exe service install $TunnelToken
  Write-Host "Tunnel installed. agent.json needs an `"access`" block (teamDomain + aud) so the agent"
  Write-Host "verifies the Cloudflare Access assertion - see docs/cloudflare-tunnel-agent.md."
}

Write-Host "Installed. Health check: curl http://localhost:4000/health"
