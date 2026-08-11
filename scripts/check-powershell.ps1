$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$files = @(
    (Join-Path $projectRoot 'Start-Flowboard.ps1'),
    (Join-Path $projectRoot 'scripts\build-windows-portable.ps1'),
    (Join-Path $projectRoot 'scripts\verify-windows-package.ps1'),
    (Join-Path $projectRoot 'packaging\windows\Start-Flowboard.ps1'),
    (Join-Path $projectRoot 'packaging\windows\Stop-Flowboard.ps1')
)
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        $messages = ($errors | ForEach-Object { "$($_.Extent.File):$($_.Extent.StartLineNumber) $($_.Message)" }) -join [Environment]::NewLine
        throw $messages
    }
}
Write-Host "PowerShell syntax OK ($($files.Count) files)"
