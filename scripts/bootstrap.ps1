$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:UV_CACHE_DIR=Join-Path (Get-Location) '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR=Join-Path (Get-Location) '.tools\python'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE)" } }
node --version
Check-Exit
npm ci
Check-Exit
npm run build
Check-Exit
uv python install 3.12
Check-Exit
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    uv venv --python 3.12 .venv
    Check-Exit
}
cargo build --workspace
Check-Exit
Write-Output 'Ready: cargo run -p hpharness-desktop'
