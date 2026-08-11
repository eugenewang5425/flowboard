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
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$bundlePath = [System.IO.Path]::GetFullPath((Join-Path $distRoot $bundleName))
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $distRoot "$bundleName.zip"))
$expectedPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $bundlePath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '打包目录越出 dist。' }
if ([System.IO.Path]::GetFileName($bundlePath) -ne $bundleName) { throw '打包目录名称异常。' }
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null

foreach ($target in @($bundlePath, $zipPath)) {
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "拒绝清理重解析点：$target" }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

$appPath = Join-Path $bundlePath 'app'
$runtimePath = Join-Path $bundlePath 'runtime'
New-Item -ItemType Directory -Force -Path $appPath, $runtimePath | Out-Null

foreach ($directory in @('server', 'web', 'cli', 'skills')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination (Join-Path $appPath $directory) -Recurse
}
foreach ($file in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $appPath $file)
}
New-Item -ItemType Directory -Force -Path (Join-Path $appPath 'node_modules\@openai') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\@openai\codex') -Destination (Join-Path $appPath 'node_modules\@openai\codex') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\@openai\codex-win32-x64') -Destination (Join-Path $appPath 'node_modules\@openai\codex-win32-x64') -Recurse

$nodeHome = Split-Path -Parent (Get-Command node -ErrorAction Stop).Source
$nodeExecutable = Join-Path $nodeHome 'node.exe'
$nodeLicense = Join-Path $nodeHome 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw '未找到可打包的 node.exe。' }
if ((Get-Item -LiteralPath $nodeExecutable).VersionInfo.ProductVersion -notmatch '^24\.') { throw 'Windows 包要求 Node.js 24.x。' }
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $runtimePath 'node.exe')
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimePath 'NODE-LICENSE.txt')

foreach ($file in @('Flowboard.vbs', 'Start-Flowboard.ps1', 'Stop-Flowboard.ps1', 'README-Windows.txt', 'THIRD-PARTY-NOTICES.txt')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\$file") -Destination (Join-Path $bundlePath $file)
}

$manifest = Get-ChildItem -LiteralPath $bundlePath -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($bundlePath.Length + 1).Replace('\', '/')
    $hash = Get-Sha256Hex -LiteralPath $_.FullName
    "$hash  $relative"
}
[System.IO.File]::WriteAllLines((Join-Path $bundlePath 'SHA256SUMS.txt'), $manifest, [System.Text.UTF8Encoding]::new($false))

Compress-Archive -LiteralPath $bundlePath -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = Get-Sha256Hex -LiteralPath $zipPath
[pscustomobject]@{
    Bundle = $bundlePath
    Zip = $zipPath
    ZipBytes = (Get-Item -LiteralPath $zipPath).Length
    Sha256 = $zipHash
    Files = @(Get-ChildItem -LiteralPath $bundlePath -Recurse -File).Count
} | ConvertTo-Json
