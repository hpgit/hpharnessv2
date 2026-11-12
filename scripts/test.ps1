param([switch]$LiveModels,[switch]$Ssh,[switch]$Lsp)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:UV_CACHE_DIR=Join-Path (Get-Location) '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR=Join-Path (Get-Location) '.tools\python'
if($LiveModels){$env:HPH_LIVE_TEST='1'}
if($Lsp){$env:HPH_LSP_TEST='1'}
if($Ssh){$env:HPH_TEST_SSH='wsl';$env:HPH_SSH_TEST='wsl'}
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE)" } }
npm run build
Check-Exit
npm test
Check-Exit
cargo test --workspace
Check-Exit
uv run --python .venv\Scripts\python.exe --no-project python -m unittest discover -s packages/worker/tests -v
Check-Exit
