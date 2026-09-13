param([Parameter(Mandatory=$true)][string]$RuntimeRoot, [switch]$RefreshManager, [string]$ManagerStage)
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$runtimeConfig = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$runtimeEntry = Join-Path $RuntimeRoot 'bin\supervisor.mjs'
$runtimeHost = Join-Path $RuntimeRoot 'bin\AgentCanvasHost.exe'
$runtimeWatchdogHost = Join-Path $RuntimeRoot 'bin\AgentCanvasWatchdog.exe'
$runtimeWatchdogName = $runtimeConfig.taskName + '-watchdog'
$runtimePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$existingTask = Get-ScheduledTask -TaskName $runtimeConfig.taskName -ErrorAction SilentlyContinue
$existingWatchdog = Get-ScheduledTask -TaskName $runtimeWatchdogName -ErrorAction SilentlyContinue
$runtimeFiles = @('common.mjs', 'worker.mjs', 'supervisor.mjs', 'AgentCanvasHost.exe', 'AgentCanvasWatchdog.exe')
$runtimeTaskXml = $null
$runtimeWatchdogXml = $null
$runtimeWatchdogRegistered = $false
$runtimeChangesStarted = $false
function Copy-RuntimeFile([string]$From, [string]$To) {
    for ($runtimeCopyAttempt = 0; $runtimeCopyAttempt -lt 50; $runtimeCopyAttempt++) {
        try { Copy-Item -LiteralPath $From -Destination $To -Force; return }
        catch [System.IO.IOException] {
            if ($runtimeCopyAttempt -eq 49) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}
if ($existingWatchdog -and (@($existingWatchdog.Actions).Count -ne 1 -or $existingWatchdog.Actions.Execute -ne $runtimeWatchdogHost -or $existingWatchdog.Actions.Arguments -notlike ('*' + $RuntimeRoot + '*'))) {
    throw 'Watchdog task belongs to another application. Refusing to replace it.'
}
if ($existingTask) {
    if (@($existingTask.Actions).Count -ne 1 -or $existingTask.Actions.Execute -notin @($runtimeConfig.node, $runtimePowerShell, $runtimeHost) -or $existingTask.Actions.Arguments -notlike ('*' + $RuntimeRoot + '*')) {
        throw 'Task name belongs to a different application. Refusing to replace it.'
    }
    if (-not $RefreshManager) {
        if ($existingTask.State -ne 'Running') { Start-ScheduledTask -TaskName $runtimeConfig.taskName }
        Write-Output ('Existing task ready: ' + $runtimeConfig.taskName)
        exit 0
    }
}
if ($RefreshManager) {
    if (-not $ManagerStage) { throw 'A precompiled manager stage is required. Use npm run site:update-manager.' }
    $ManagerStage = [IO.Path]::GetFullPath($ManagerStage).TrimEnd('\')
    $runtimeStagePrefix = (Join-Path $RuntimeRoot 'manager-updates') + '\'
    if (-not $ManagerStage.StartsWith($runtimeStagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manager stage is outside the runtime update directory.' }
    $runtimePreparedHost = Join-Path $ManagerStage 'AgentCanvasHost.exe'
    if (-not (Test-Path -LiteralPath $runtimePreparedHost -PathType Leaf)) { throw 'The console-free host has not been compiled.' }
    if (-not (Test-Path -LiteralPath (Join-Path $ManagerStage 'AgentCanvasWatchdog.exe') -PathType Leaf)) { throw 'The console-free watchdog has not been compiled.' }
    $runtimeBackup = Join-Path $ManagerStage 'previous'
    New-Item -ItemType Directory -Path $runtimeBackup -Force | Out-Null
    foreach ($runtimeFile in $runtimeFiles) {
        $runtimeOldFile = Join-Path $RuntimeRoot ('bin\' + $runtimeFile)
        if (Test-Path -LiteralPath $runtimeOldFile) { Copy-Item -LiteralPath $runtimeOldFile -Destination (Join-Path $runtimeBackup $runtimeFile) }
    }
    if ($existingTask) {
        $runtimeTaskXml = Export-ScheduledTask -TaskName $runtimeConfig.taskName
        [IO.File]::WriteAllText((Join-Path $runtimeBackup 'task.xml'), $runtimeTaskXml, [Text.Encoding]::Unicode)
    }
    if ($existingWatchdog) {
        $runtimeWatchdogXml = Export-ScheduledTask -TaskName $runtimeWatchdogName
        [IO.File]::WriteAllText((Join-Path $runtimeBackup 'watchdog-task.xml'), $runtimeWatchdogXml, [Text.Encoding]::Unicode)
    }
} elseif (-not (Test-Path -LiteralPath $runtimeHost -PathType Leaf)) {
    throw 'The console-free host is missing. Use npm run site:update-manager to repair the installation.'
}
try {
    if ($RefreshManager) {
        $runtimeChangesStarted = $true
        if ($existingWatchdog) {
            Disable-ScheduledTask -TaskName $runtimeWatchdogName | Out-Null
            Stop-ScheduledTask -TaskName $runtimeWatchdogName
            $runtimeWatchdogDeadline = (Get-Date).AddSeconds(15)
            while ((Get-ScheduledTask -TaskName $runtimeWatchdogName).State -eq 'Running') {
                if ((Get-Date) -gt $runtimeWatchdogDeadline) { throw 'Watchdog did not stop.' }
                Start-Sleep -Milliseconds 100
            }
        }
        if ($existingTask) {
            Disable-ScheduledTask -TaskName $runtimeConfig.taskName | Out-Null
            Stop-ScheduledTask -TaskName $runtimeConfig.taskName
            $runtimeDeadline = (Get-Date).AddSeconds(20)
            while ((Get-ScheduledTask -TaskName $runtimeConfig.taskName).State -eq 'Running') {
                if ((Get-Date) -gt $runtimeDeadline) { throw 'Background task did not stop.' }
                Start-Sleep -Milliseconds 200
            }
        }
        # A separately spawned supervisor can outlive an old host. The controller
        # stopped its services; verify BOTH executable and entry before stopping its PID.
        $runtimeStatusFile = Join-Path $RuntimeRoot 'status.json'
        if (Test-Path -LiteralPath $runtimeStatusFile) {
            $runtimeStatus = Get-Content -LiteralPath $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $runtimeOldProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$runtimeStatus.supervisorPid)
            if ($runtimeOldProcess -and $runtimeOldProcess.ExecutablePath -eq $runtimeConfig.node -and $runtimeOldProcess.CommandLine -and $runtimeOldProcess.CommandLine.Contains($runtimeEntry)) {
                Stop-Process -Id $runtimeOldProcess.ProcessId -Force
                Wait-Process -Id $runtimeOldProcess.ProcessId -Timeout 20 -ErrorAction SilentlyContinue
            }
        }
        foreach ($runtimeFile in @('common.mjs', 'worker.mjs', 'supervisor.mjs')) {
            Copy-RuntimeFile (Join-Path $PSScriptRoot $runtimeFile) (Join-Path $RuntimeRoot ('bin\' + $runtimeFile))
        }
        Copy-RuntimeFile $runtimePreparedHost $runtimeHost
        Copy-RuntimeFile (Join-Path $ManagerStage 'AgentCanvasWatchdog.exe') $runtimeWatchdogHost
    }
    $runtimeAction = New-ScheduledTaskAction -Execute $runtimeHost -Argument ('--runtime-root "' + $RuntimeRoot + '"') -WorkingDirectory $RuntimeRoot
    $runtimeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $runtimeUser
    $runtimeWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $runtimePrincipal = New-ScheduledTaskPrincipal -UserId $runtimeUser -LogonType Interactive -RunLevel Limited
    $runtimeSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $runtimeConfig.taskName -Action $runtimeAction -Trigger $runtimeTrigger -Principal $runtimePrincipal -Settings $runtimeSettings -Description 'AgentCanvas console-free background host v2; local stable site and development services.' -Force | Out-Null
    $runtimeWatchdogAction = New-ScheduledTaskAction -Execute $runtimeWatchdogHost -Argument ('--runtime-root "' + $RuntimeRoot + '" --task-name "' + $runtimeConfig.taskName + '"') -WorkingDirectory $RuntimeRoot
    $runtimeWatchdogSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 30) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $runtimeWatchdogName -Action $runtimeWatchdogAction -Trigger $runtimeWatchdog -Principal $runtimePrincipal -Settings $runtimeWatchdogSettings -Description 'AgentCanvas short console-free watchdog; starts only a stopped main task.' -Force | Out-Null
    $runtimeWatchdogRegistered = $true
    Start-ScheduledTask -TaskName $runtimeConfig.taskName
    Write-Output ('Console-free background task installed and started: ' + $runtimeConfig.taskName)
} catch {
    $runtimeUpdateError = $_
    if ($runtimeWatchdogRegistered -and -not $existingWatchdog) {
        Unregister-ScheduledTask -TaskName $runtimeWatchdogName -Confirm:$false
    }
    if ($runtimeChangesStarted -and $runtimeTaskXml) {
        foreach ($runtimeFile in $runtimeFiles) {
            $runtimePreviousFile = Join-Path $runtimeBackup $runtimeFile
            if (Test-Path -LiteralPath $runtimePreviousFile) {
                try { Copy-RuntimeFile $runtimePreviousFile (Join-Path $RuntimeRoot ('bin\' + $runtimeFile)) }
                catch { Write-Warning ('Could not restore manager file: ' + $runtimeFile) }
            }
        }
        Register-ScheduledTask -TaskName $runtimeConfig.taskName -Xml $runtimeTaskXml -Force | Out-Null
        if ($runtimeWatchdogXml) { Register-ScheduledTask -TaskName $runtimeWatchdogName -Xml $runtimeWatchdogXml -Force | Out-Null }
        Start-ScheduledTask -TaskName $runtimeConfig.taskName
        Write-Warning 'Manager update failed; previous task and manager files restored.'
    }
    throw $runtimeUpdateError
}
