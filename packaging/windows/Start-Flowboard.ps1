param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 47823,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$bundleRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$nodePath = Join-Path $bundleRoot 'runtime\node.exe'
$appRoot = Join-Path $bundleRoot 'app'
$serverPath = Join-Path $appRoot 'server\index.mjs'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "缺少内置 Node.js：$nodePath" }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "缺少 Flowboard 服务：$serverPath" }

$stateRoot = if ($env:FLOWBOARD_STATE_DIR) {
    [System.IO.Path]::GetFullPath($env:FLOWBOARD_STATE_DIR)
} else {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Flowboard'
}
$dataRoot = if ($env:FLOWBOARD_DATA_DIR) {
    [System.IO.Path]::GetFullPath($env:FLOWBOARD_DATA_DIR)
} else {
    Join-Path $stateRoot 'data'
}
$logRoot = Join-Path $stateRoot 'logs'
$pidPath = Join-Path $stateRoot 'flowboard.pid'
New-Item -ItemType Directory -Force -Path $stateRoot, $dataRoot, $logRoot | Out-Null

$expectedNode = [System.IO.Path]::GetFullPath($nodePath)
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $existingPidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    $existingPid = 0
    if ([int]::TryParse($existingPidText, [ref]$existingPid)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
        if ($existing -and [System.IO.Path]::GetFullPath($existing.ExecutablePath) -eq $expectedNode) {
            if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidPath -Force
}

$env:FLOWBOARD_DATA_DIR = $dataRoot
$env:FLOWBOARD_PORT = [string]$Port
$standardOutput = Join-Path $logRoot 'server.out.log'
$standardError = Join-Path $logRoot 'server.err.log'
$process = Start-Process -FilePath $nodePath -ArgumentList 'server/index.mjs' -WorkingDirectory $appRoot `
    -WindowStyle Hidden -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError -PassThru
[System.IO.File]::WriteAllText($pidPath, [string]$process.Id)

$healthUrl = "http://127.0.0.1:$Port/api/health"
$ready = $false
for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 125
    if ($process.HasExited) { break }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        if ($health.ok -eq $true) { $ready = $true; break }
    } catch {
        # The server may still be starting.
    }
}
if (-not $ready) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
    $diagnostic = if (Test-Path -LiteralPath $standardError) { (Get-Content -LiteralPath $standardError -Tail 20) -join [Environment]::NewLine } else { '没有错误日志。' }
    throw "Flowboard 启动失败。日志：$diagnostic"
}

if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
