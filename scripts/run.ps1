$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$repoRoot=Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$binary=Join-Path $repoRoot 'target\debug\hpharness-desktop.exe'
if(-not(Test-Path -LiteralPath $binary)){throw 'Run scripts/bootstrap.ps1 first'}
if(-not(Test-Path -LiteralPath (Join-Path $repoRoot 'packages\harness\dist\main.js'))){throw 'Run npm run build first'}
$env:HPH_ROOT=$repoRoot
Start-Process -FilePath $binary -WorkingDirectory $repoRoot
