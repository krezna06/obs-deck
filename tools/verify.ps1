<#
  Provenance check for the OBS Web Deck.

  1. runs tools/test-deck.mjs -- the deck's real inline script, driven through a
     full obs-websocket v5 session against a fake OBS server
  2. runs tools/ws_selftest.py -- an independent, stdlib-only Python RFC6455
     client against tools/mock-obs.mjs, proving the handshake, auth and frame
     encoding with code that shares nothing with the deck

  Usage:  powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
#>
[CmdletBinding()]
param(
  [int]$MockPort = 4455
)

$ErrorActionPreference = 'Stop'
$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $tools
Set-Location $root

function Find-Exe($names, $fallbacks) {
  foreach ($n in $names) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  foreach ($f in $fallbacks) { if (Test-Path $f) { return $f } }
  return $null
}

function Test-Python($exe) {
  if (-not $exe) { return $false }
  # The Microsoft Store "python.exe" alias is a 0-byte stub that only opens the
  # Store; it must not be mistaken for a real interpreter.
  if ($exe -like '*\WindowsApps\*') { return $false }
  try {
    $out = & $exe -c "import sys; print(sys.version_info[0])" 2>$null
    return ($LASTEXITCODE -eq 0 -and "$out".Trim() -eq '3')
  } catch {
    return $false
  }
}

function Find-Python {
  $candidates = @()
  foreach ($n in @('python', 'python3', 'py')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { $candidates += $c.Source }
  }
  $candidates += @(
    "C:\Python313\python.exe",
    "C:\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  )

  foreach ($p in $candidates) {
    if (Test-Python $p) { return $p }
  }
  return $null
}

$node = Find-Exe @('node') @(
  "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)
$python = Find-Python

if (-not $node) { Write-Host 'node was not found on PATH.' -ForegroundColor Red; exit 1 }

$overall = 0

Write-Host "`n=== 1/2  deck behaviour (fake OBS server, deck's own script) ===" -ForegroundColor Cyan
& $node (Join-Path $tools 'test-deck.mjs')
if ($LASTEXITCODE -ne 0) { $overall = 1 }

if (-not $python) {
  Write-Host "`n=== 2/2  raw WebSocket framing -- SKIPPED (python not found) ===" -ForegroundColor Yellow
  Write-Host '   The mock server reports through a file because this environment' -ForegroundColor Gray
  Write-Host '   denies piped child stdio; run tools/ws_selftest.py directly instead.' -ForegroundColor Gray
} else {
  Write-Host "`n=== 2/2  raw WebSocket framing (independent Python client) ===" -ForegroundColor Cyan
  $report = Join-Path $tools '.ws-selftest-report.json'
  if (Test-Path $report) { Remove-Item $report -Force }

  $mock = Start-Process -FilePath $node -ArgumentList @((Join-Path $tools 'mock-obs.mjs'), "$MockPort", 'test-password') -PassThru -WindowStyle Hidden
  try {
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 150
      try {
        $c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $MockPort)
        $c.Close()
        $ready = $true
        break
      } catch { }
    }

    if (-not $ready) {
      Write-Host "   mock OBS server did not come up on port $MockPort" -ForegroundColor Red
      $overall = 1
    } else {
      & $python (Join-Path $tools 'ws_selftest.py') '127.0.0.1' "$MockPort" 'test-password' "--json=$report"
      if ($LASTEXITCODE -ne 0) { $overall = 1 }

      if (Test-Path $report) {
        try {
          $j = Get-Content $report -Raw | ConvertFrom-Json
          Write-Host "   python client: $($j.passed) passed, $($j.failed) failed" -ForegroundColor Gray
        } catch { }
        Remove-Item $report -Force
      }
    }
  } finally {
    if ($mock -and -not $mock.HasExited) { Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue }
  }
}

Write-Host ''
if ($overall -eq 0) {
  Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
} else {
  Write-Host 'SOME CHECKS FAILED' -ForegroundColor Red
}
exit $overall
