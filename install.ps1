# Run from an Administrator PowerShell:
#   irm https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Guardian needs Node.js 18+ first: https://nodejs.org'; exit 1
}
$f = Join-Path $env:TEMP 'guardian-install.mjs'
Invoke-WebRequest 'https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/guardian-install.mjs' -OutFile $f
node $f install
Remove-Item $f -ErrorAction SilentlyContinue
