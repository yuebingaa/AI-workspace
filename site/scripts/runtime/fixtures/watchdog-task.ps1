param([string]$Action, [string]$FixtureRoot, [string]$TaskName)
$ErrorActionPreference = 'Stop'
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
if (-not ([IO.Path]::GetFileName($FixtureRoot).StartsWith('agentcanvas-watchdog-test-')) -or $TaskName -notmatch '^AgentCanvas-[a-f0-9]{10}$') { throw 'Invalid isolated test identity.' }
$fixtureHost = Join-Path $FixtureRoot 'bin\AgentCanvasHost.exe'
$fixtureDescription = 'isolated-runtime-watchdog-test:' + $FixtureRoot
$fixtureTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($fixtureTask -and ($fixtureTask.Description -ne $fixtureDescription -or $fixtureTask.Actions.Execute -ne $fixtureHost)) { throw 'Refusing to modify a task not owned by this fixture.' }
if ($Action -eq 'register') {
    if ($fixtureTask) { throw 'Fixture task already exists.' }
    $fixtureUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $fixturePrincipal = New-ScheduledTaskPrincipal -UserId $fixtureUser -LogonType Interactive -RunLevel Limited
    $fixtureAction = New-ScheduledTaskAction -Execute $fixtureHost -Argument ('--runtime-root "' + $FixtureRoot + '"') -WorkingDirectory $FixtureRoot
    $fixtureSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 45) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $fixtureAction -Principal $fixturePrincipal -Settings $fixtureSettings -Description $fixtureDescription | Out-Null
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
} elseif ($Action -eq 'enable') {
    if (-not $fixtureTask) { throw 'Missing fixture task.' }
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
} elseif ($Action -eq 'remove') {
    if ($fixtureTask) {
        Stop-ScheduledTask -TaskName $TaskName
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $fixtureProbeFile = Join-Path $FixtureRoot 'probe.json'
    if (Test-Path -LiteralPath $fixtureProbeFile) {
        $fixtureProbe = Get-Content -LiteralPath $fixtureProbeFile -Raw | ConvertFrom-Json
        $fixtureProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$fixtureProbe.pid)
        if ($fixtureProcess -and $fixtureProcess.ExecutablePath -eq (Join-Path $FixtureRoot 'runtime\node.exe')) { Stop-Process -Id $fixtureProcess.ProcessId -Force }
    }
} else { throw 'Unknown fixture action.' }
