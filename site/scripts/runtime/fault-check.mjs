// Explicit operational acceptance: briefly interrupts the installed local services.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicJson, health, readJson, sleep } from './common.mjs';

if (!process.argv.includes('--confirm-interruption')) throw new Error('Requires --confirm-interruption; this checks recovery by stopping installed processes.');
const { root } = readJson(join(process.cwd(), '.runtime/runtime-location.json'));
const config = readJson(join(root, 'config.json'));
const status = () => readJson(join(root, 'status.json'));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
function interrupt(name) {
  const state = status();
  assert.ok(Date.now() - Date.parse(state.checkedAt) < 15000);
  const pid = name === 'supervisor' ? state.supervisorPid : state.services[name].pid;
  assert.ok(Number.isInteger(pid) && pid > 0);
  const validation = name === 'supervisor'
    ? `$runtimeProcess.CommandLine.Contains(${quote(join(root, 'bin/supervisor.mjs'))})`
    : `$runtimeProcess.ParentProcessId -eq ${state.services[name].workerPid}`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    `$runtimeProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    `if (-not $runtimeProcess -or $runtimeProcess.ExecutablePath -ne ${quote(config.node)} -or -not (${validation})) { throw 'Process identity changed; refusing interruption' }`,
    `Stop-Process -Id ${pid} -Force`,
  ].join('\n')], { windowsHide: true, stdio: 'pipe' });
  return state;
}
async function until(check, timeout = 100000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return Date.now() - started; await sleep(500); }
  throw new Error('Recovery timed out');
}
const evidence = { checkedAt: new Date().toISOString(), checks: [] };
for (const name of ['capture', 'stable', 'supervisor']) {
  const previous = interrupt(name);
  console.log(`Interrupted ${name}; waiting for managed recovery...`);
  const milliseconds = await until(async () => {
    const current = status();
    if (name === 'supervisor') return current.supervisorPid !== previous.supervisorPid && Date.now() - Date.parse(current.checkedAt) < 5000
      && (await health(3000, '/api/health', true)).ready && (await health(3001, '/api/health', true)).ready;
    const port = name === 'capture' ? 3198 : 3000;
    return current.services[name].pid && current.services[name].pid !== previous.services[name].pid
      && (await health(port, name === 'capture' ? '/health' : '/api/health')).ready;
  });
  const current = status();
  if (name === 'capture') assert.equal(current.services.stable.pid, previous.services.stable.pid, 'Capture failure stopped the stable website');
  if (name !== 'supervisor') assert.equal(current.services.dev.pid, previous.services.dev.pid, 'Unrelated failure stopped the development website');
  evidence.checks.push({ name, recovered: true, recoveryMs: milliseconds });
  console.log(`${name} recovered in ${milliseconds}ms`);
}
await atomicJson(join(process.cwd(), '.runtime/runtime-fault-verification.json'), evidence);
console.log(JSON.stringify(evidence, null, 2));
