param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 47826
)

$ErrorActionPreference = 'Stop'
function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$bundleName = "Flowboard-$($package.version)-win-x64"
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist\$bundleName.zip"))
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "缺少 Windows ZIP：$zipPath" }

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ("flowboard-package-smoke-" + [guid]::NewGuid().ToString('N'))))
$requiredPrefix = $tempBase.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar + 'flowboard-package-smoke-'
if (-not $smokeRoot.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '临时验收目录异常。' }
New-Item -ItemType Directory -Path $smokeRoot | Out-Null

$started = $false
try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $smokeRoot
    $bundle = Join-Path $smokeRoot $bundleName
    $manifestPath = Join-Path $bundle 'SHA256SUMS.txt'
    $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8
    foreach ($line in $manifest) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "校验清单格式无效：$line" }
        $expectedHash = $Matches[1]
        $relativePath = $Matches[2]
        $filePath = Join-Path $bundle $relativePath.Replace('/', '\')
        $actualHash = Get-Sha256Hex -LiteralPath $filePath
        if ($actualHash -ne $expectedHash) { throw "文件校验失败：$relativePath" }
    }

    $nodePath = Join-Path $bundle 'runtime\node.exe'
    $codexWrapper = Join-Path $bundle 'app\node_modules\@openai\codex\bin\codex.js'
    $codexVersion = & $nodePath $codexWrapper --version
    if ($LASTEXITCODE -ne 0 -or $codexVersion -notmatch '0\.147\.0') { throw "内置 Codex CLI 无效：$codexVersion" }

    $stateRoot = Join-Path $smokeRoot 'state'
    $dataRoot = Join-Path $smokeRoot 'data'
    $env:FLOWBOARD_STATE_DIR = $stateRoot
    $env:FLOWBOARD_DATA_DIR = $dataRoot
    & (Join-Path $bundle 'Start-Flowboard.ps1') -Port $Port -NoBrowser
    $started = $true

    $origin = "http://127.0.0.1:$Port"
    $health = Invoke-RestMethod -Uri "$origin/api/health"
    if ($health.ok -ne $true) { throw '安装包健康检查失败。' }
    $projectBody = @{ name = 'Package Smoke'; issuePrefix = 'PKG'; workspacePath = $projectRoot } | ConvertTo-Json
    $project = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $projectBody -Uri "$origin/api/projects"
    $issueBody = @{ projectId = $project.id; title = 'Windows ZIP 验收'; status = 'backlog' } | ConvertTo-Json
    $issue = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $issueBody -Uri "$origin/api/issues"

    & (Join-Path $bundle 'Stop-Flowboard.ps1')
    $started = $false
    Start-Sleep -Milliseconds 350
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw '停止脚本执行后端口仍在监听。' }

    [pscustomobject]@{
        ZipSha256 = Get-Sha256Hex -LiteralPath $zipPath
        ManifestEntries = $manifest.Count
        CodexVersion = ($codexVersion -join ' ')
        HealthVersion = $health.version
        AgentAvailable = $health.agents[0].status.available
        CreatedIssue = $issue.identifier
        Stopped = $true
    } | ConvertTo-Json
} finally {
    if ($started) {
        $stopScript = Join-Path (Join-Path $smokeRoot $bundleName) 'Stop-Flowboard.ps1'
        if (Test-Path -LiteralPath $stopScript -PathType Leaf) { & $stopScript }
    }
    if (Test-Path -LiteralPath $smokeRoot) {
        $resolvedRoot = [System.IO.Path]::GetFullPath($smokeRoot)
        if (-not $resolvedRoot.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '拒绝清理异常目录。' }
        $rootItem = Get-Item -LiteralPath $resolvedRoot -Force
        if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw '拒绝清理重解析点。' }
        $reparseChildren = @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 })
        if ($reparseChildren.Count -gt 0) { throw '临时验收目录包含重解析点，未清理。' }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
