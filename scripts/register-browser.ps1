param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$repoRoot=Split-Path -Parent $PSScriptRoot
$bridgePath=Join-Path $repoRoot 'target\release\hpharness-browser-bridge.exe'
if (-not (Test-Path -LiteralPath $bridgePath)) { throw 'Build first: cargo build --release -p hpharness-browser-bridge' }
$manifestDir=Join-Path $env:USERPROFILE '.hpharness\browser'
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
$manifestPath=Join-Path $manifestDir 'com.hpharness.bridge.json'
$manifest=@{name='com.hpharness.bridge';description='HPHarness local connection';path=$bridgePath;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
[System.IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 4),[System.Text.UTF8Encoding]::new($false))
$key='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hpharness.bridge'
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Output ('Registered user-level native host: '+$manifestPath)
