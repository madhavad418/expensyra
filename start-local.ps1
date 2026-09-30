# Starts JSAN Expensyra locally from a known-clean environment.
# Clears any Pleo/mock variables left over in this shell session from earlier testing,
# so the only source of truth is .env — no stale $env: value can silently override it.

$varsToClear = @(
    'PLEO_MOCK_MODE',
    'PLEO_API_KEY',
    'PLEO_COMPANY_ID',
    'PLEO_API_BASE',
    'PLEO_SYNC_MODE',
    'PLEO_AUTO_SYNC',
    'PLEO_SYNC_ON_START'
)
foreach ($name in $varsToClear) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

if (-not (Test-Path ".env")) {
    Write-Host "No .env file found in this folder. Copy .env.example to .env and fill in real values first." -ForegroundColor Yellow
    exit 1
}

Write-Host "Cleared any stale Pleo/mock shell variables. Starting server from .env ..." -ForegroundColor Cyan
node --env-file=.env server.js
