<#
  Stop and remove the OBS Web Deck container.
  Usage:  powershell -ExecutionPolicy Bypass -File .\stop-deck.ps1
#>
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker was not found on PATH.' -ForegroundColor Red
  exit 1
}

Write-Host 'Stopping the OBS Web Deck...' -ForegroundColor Cyan
docker compose down
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Stopped.' -ForegroundColor Green
} else {
  Write-Host 'docker compose down reported an error.' -ForegroundColor Yellow
}
