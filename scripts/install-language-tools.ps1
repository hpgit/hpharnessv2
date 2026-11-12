$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
Set-Location (Split-Path -Parent $PSScriptRoot)
npm install --prefix .tools/languages pyright@1.1.414 typescript@7.0.2 typescript-language-server@6.0.3
if($LASTEXITCODE -ne 0){throw 'Language server package installation failed'}
Write-Output 'Configure Python server command=node, args=[ABSOLUTE_PATH/.tools/languages/node_modules/pyright/langserver.index.js, --stdio]'
Write-Output 'Other toolchains: use installed clangd, cmake-language-server, rust-analyzer, kotlin-lsp, jdtls, and Groovy language server. Configure servers in their execution environment.'
