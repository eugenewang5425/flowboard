$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 Node.js 24 或更高版本。'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@openai\codex'))) {
    Write-Host '首次运行：正在安装 Codex CLI 依赖…' -ForegroundColor Cyan
    npm install
}

node scripts/launch.mjs
