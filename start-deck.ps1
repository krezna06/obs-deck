<#
  Start the OBS Web Deck on your local network.

  Usage:  powershell -ExecutionPolicy Bypass -File .\start-deck.ps1
          powershell -ExecutionPolicy Bypass -File .\start-deck.ps1 -Port 9000
          powershell -ExecutionPolicy Bypass -File .\start-deck.ps1 -OpenFirewall

  The deck is served over plain HTTP on purpose: OBS WebSocket is a plain ws://
  endpoint, and browsers refuse to open ws:// from an https:// page.
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [switch]$OpenFirewall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Write-Head($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "   [ok] $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Write-Bad($t)  { Write-Host "   [x]  $t" -ForegroundColor Red }

# ------------------------------------------------------------------ LAN address
# Three methods, because Get-NetIPAddress needs the NetTCPIP module and can be
# denied under a restricted or non-elevated context. ipconfig always works.
function Get-LanAddress {
  $found = @()

  try {
    $found = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.PrefixOrigin -ne 'WellKnown'
      } | ForEach-Object { $_.IPAddress })
  } catch {
    $found = @()
  }

  if ($found.Count -eq 0) {
    try {
      $found = @(
        (ipconfig 2>$null) |
          Select-String -Pattern 'IPv4' |
          ForEach-Object { ($_ -split ':\s*')[-1].Trim() } |
          Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' }
      )
    } catch {
      $found = @()
    }
  }

  if ($found.Count -eq 0) {
    try {
      $found = @(
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
          Where-Object { $_.AddressFamily -eq 'InterNetwork' -and "$_" -notlike '127.*' } |
          ForEach-Object { "$_" }
      )
    } catch {
      $found = @()
    }
  }

  if ($found.Count -eq 0) { return $null }
  return $found[0]
}

Write-Head 'OBS Web Deck - local network launcher'

# ------------------------------------------------------------------- docker check
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Write-Bad 'Docker was not found on PATH.'
  Write-Host '   Install Docker Desktop, open it, wait for "Engine running", then run this again.' -ForegroundColor Gray
  Write-Host '   No Docker? You can still use this deck from the OBS PC itself:' -ForegroundColor Gray
  Write-Host '     python -m http.server 8080 --directory .\site' -ForegroundColor Gray
  exit 1
}

# Is the engine actually up (not just the CLI installed)?
$engineUp = $false
try {
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  $engineUp = ($LASTEXITCODE -eq 0)
} catch { $engineUp = $false }

if (-not $engineUp) {
  Write-Warn2 'Docker is installed but the engine is not responding. Trying to start Docker Desktop...'
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) {
    Start-Process $dd | Out-Null
    Write-Host '   Waiting for the engine (up to 120s)...' -ForegroundColor Gray
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 2
      try { docker info --format '{{.ServerVersion}}' 2>$null | Out-Null } catch { }
      if ($LASTEXITCODE -eq 0) { $engineUp = $true; break }
    }
  }
}

if (-not $engineUp) {
  Write-Bad 'Docker engine is not running. Start Docker Desktop, then run this script again.'
  exit 1
}
Write-Ok 'Docker engine is running.'

# ------------------------------------------------------------------------ compose
if ($Port -ne 8080) {
  Write-Host "   Mapping host port $Port -> container 8080" -ForegroundColor Gray
  $env:DECK_PORT = "$Port"
}

Write-Head 'Starting the deck'
docker compose up -d
if ($LASTEXITCODE -ne 0) {
  Write-Bad 'docker compose up failed. Scroll up for the reason.'
  exit 1
}
Write-Ok 'Container started.'

# --------------------------------------------------------------- firewall prompt
Write-Head 'Reachability'
if ($OpenFirewall) {
  $ruleName = "OBS Web Deck (TCP $Port)"
  try {
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
      Write-Ok "Firewall rule created: $ruleName (Private networks only)"
    } else {
      Write-Ok "Firewall rule already present: $ruleName"
    }
  } catch {
    Write-Warn2 "Could not create the firewall rule: $($_.Exception.Message)"
    Write-Host '   Run this script once from an Administrator PowerShell to allow LAN access.' -ForegroundColor Gray
  }
} else {
  Write-Host "   If phones cannot load the page, Windows Firewall is likely blocking TCP $Port." -ForegroundColor Gray
  Write-Host "   Re-run with:  -OpenFirewall   (from an Administrator PowerShell)" -ForegroundColor Gray
}

# -------------------------------------------------------------------- OBS checks
$lanIp = Get-LanAddress
if (-not $lanIp) { $lanIp = '<this-pc-ip>' }

$obsListening = $false
try {
  $obsListening = [bool](Get-NetTCPConnection -State Listen -LocalPort 4455 -ErrorAction Stop)
} catch {
  $obsListening = [bool](netstat -an | Select-String -Pattern ':4455\s+.*LISTENING')
}

Write-Head 'Open the deck'
Write-Host "   On this PC      : http://localhost:$Port" -ForegroundColor White
Write-Host "   On phone/tablet : http://${lanIp}:$Port" -ForegroundColor White
Write-Host "   OBS WebSocket   : ws://${lanIp}:4455" -ForegroundColor White

if ($obsListening) {
  Write-Ok 'OBS WebSocket appears to be listening on TCP 4455.'
} else {
  Write-Warn2 'Nothing is listening on TCP 4455 yet.'
  Write-Host '   In OBS: Tools -> WebSocket Server Settings -> Enable WebSocket Server.' -ForegroundColor Gray
  Write-Host '   Then set a password and enter the same one in the deck.' -ForegroundColor Gray
  Write-Host '   To reach OBS from other devices, OBS WebSocket must also listen on' -ForegroundColor Gray
  Write-Host '   all interfaces, not just 127.0.0.1 (the setting is next to the port).' -ForegroundColor Gray
}

Write-Host "`n   Stop it later with:  docker compose down`n" -ForegroundColor Gray
