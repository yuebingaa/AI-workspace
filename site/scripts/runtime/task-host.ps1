param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
try {
    $runtimeConfig = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $runtimeEntry = Join-Path $RuntimeRoot 'bin\supervisor.mjs'
    $runtimeProcess = Start-Process -FilePath $runtimeConfig.node -ArgumentList ('"' + $runtimeEntry + '" "' + $RuntimeRoot + '"') -WorkingDirectory $RuntimeRoot -WindowStyle Hidden -PassThru -Wait
    if ($runtimeProcess.ExitCode -ne 0) { exit 1 }
    exit 0
} catch { exit 1 }
