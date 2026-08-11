$ErrorActionPreference = 'Stop'
$bundleRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$expectedNode = [System.IO.Path]::GetFullPath((Join-Path $bundleRoot 'runtime\node.exe'))
$stateRoot = if ($env:FLOWBOARD_STATE_DIR) {
    [System.IO.Path]::GetFullPath($env:FLOWBOARD_STATE_DIR)
} else {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Flowboard'
}
$pidPath = Join-Path $stateRoot 'flowboard.pid'
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Host 'Flowboard 当前未运行。'
    exit 0
}

$pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
$flowboardPid = 0
if (-not [int]::TryParse($pidText, [ref]$flowboardPid)) { throw 'PID 文件无效，未停止任何进程。' }
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$flowboardPid" -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Host 'Flowboard 已停止，已清理过期 PID。'
    exit 0
}
if ([System.IO.Path]::GetFullPath($process.ExecutablePath) -ne $expectedNode) {
    throw 'PID 指向的不是此安装包内的 Node.js，未停止任何进程。'
}

$descendants = @()
$frontier = @($flowboardPid)
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($parentPid in $frontier) {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            if ($seen.Add([int]$child.ProcessId)) {
                $descendants += $child
                if ($child.Name -ne 'conhost.exe') { $next += $child.ProcessId }
            }
        }
    }
    $frontier = $next
}
foreach ($child in @($descendants | Where-Object Name -ne 'conhost.exe' | Sort-Object CreationDate -Descending)) {
    Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
}
Stop-Process -Id $flowboardPid -ErrorAction Stop
Remove-Item -LiteralPath $pidPath -Force
Write-Host 'Flowboard 已停止。'
