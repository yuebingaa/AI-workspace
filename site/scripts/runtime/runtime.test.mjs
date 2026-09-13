import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { acquireSupervisorLock, atomicJson, health, logLine, readJson, sleep, stopChild } from './common.mjs';
import { buildRuntimeHosts, buildTaskHost, compileWindowsExecutable } from './build-task-host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
async function freePort() {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  await new Promise((res) => server.close(res));
  return port;
}
async function until(check, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await sleep(150); }
  assert.fail('Condition did not become true before timeout');
}

test('atomic configuration stays parseable and log output redacts credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-runtime-unit-'));
  try {
    const file = join(root, 'config.json');
    await atomicJson(file, { version: 1 });
    await atomicJson(file, { version: 2 });
    assert.equal(readJson(file).version, 2);
    const log = join(root, 'service.log');
    logLine(log, 'Authorization=secret-value Bearer abcdef sk-test-secret API_KEY=example-key');
    const output = readFileSync(log, 'utf8');
    for (const secret of ['secret-value', 'abcdef', 'sk-test-secret', 'example-key']) assert.ok(!output.includes(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('services recover independently, retain data, reject duplicates and recover an interrupted release', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-runtime-integration-'));
  const source = join(root, 'source');
  const app = join(root, 'releases/good/app');
  const stablePort = await freePort(), devPort = await freePort(), capturePort = await freePort();
  let supervisor;
  try {
    for (const directory of [app, join(app, 'scripts'), join(source, 'node_modules/vinext/dist'), join(root, 'config')]) await mkdir(directory, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const fixture = join(here, 'fixtures/server.mjs');
    await cp(fixture, join(app, 'server.js'));
    await cp(fixture, join(app, 'scripts/playwright-capture-service.mjs'));
    await cp(fixture, join(source, 'node_modules/vinext/dist/cli.js'));
    const config = { source, node: process.execPath, stablePort, devPort, capturePort,
      lockPipe: process.platform === 'win32' ? `\\\\.\\pipe\\agentcanvas-test-${randomUUID()}` : join(root, 'lock.sock'),
      stableState: join(root, 'state/stable'), devState: join(root, 'state/dev') };
    await atomicJson(join(root, 'config.json'), config);
    const desired = { stable: { enabled: true, release: 'good', revision: 'one' }, dev: { enabled: true, revision: 'one' }, capture: { enabled: true, revision: 'one' } };
    await atomicJson(join(root, 'desired.json'), desired);
    supervisor = spawn(process.execPath, [join(here, 'supervisor.mjs'), root], { windowsHide: true, stdio: 'pipe' });
    let errors = '';
    supervisor.stderr.on('data', (chunk) => { errors += chunk; });
    const status = () => readJson(join(root, 'status.json'), {}).services;
    await until(async () => {
      assert.equal(supervisor.exitCode, null, errors);
      return ['stable', 'dev', 'capture'].every((name) => status()?.[name]?.pid) && (await health(stablePort)).ready && (await health(devPort)).ready;
    });
    const initial = structuredClone(status());
    await fetch(`http://127.0.0.1:${stablePort}/write`);
    assert.ok(existsSync(join(config.stableState, 'marker.txt')));
    assert.ok(!existsSync(join(config.devState, 'marker.txt')));

    const duplicate = spawn(process.execPath, [join(here, 'supervisor.mjs'), root], { windowsHide: true, stdio: 'ignore' });
    const duplicateExit = await new Promise((res) => duplicate.once('exit', res));
    assert.equal(duplicateExit, 0, 'a known live supervisor is a successful no-op, not a retryable failure');
    assert.equal(status().stable.pid, initial.stable.pid);

    await fetch(`http://127.0.0.1:${capturePort}/crash`);
    await until(() => status().capture.pid && status().capture.pid !== initial.capture.pid);
    assert.equal(status().stable.pid, initial.stable.pid);
    assert.equal(status().dev.pid, initial.dev.pid);

    await fetch(`http://127.0.0.1:${stablePort}/crash`);
    await until(async () => status().stable.pid && status().stable.pid !== initial.stable.pid && (await health(stablePort)).ready);
    assert.equal(await (await fetch(`http://127.0.0.1:${stablePort}/marker`)).text(), 'survives restart');
    assert.equal(status().dev.pid, initial.dev.pid);

    const stablePid = status().stable.pid;
    await writeFile(join(config.stableState, 'degraded'), 'intentional persistence warning');
    await until(() => status().stable.health === 'degraded');
    assert.equal(status().stable.pid, stablePid, 'degraded state must not cause a restart loop');

    // Simulate a publisher dying after stopping the stable site, before committing a release.
    await atomicJson(join(root, 'release-switch.json'), { previous: desired, deadline: Date.now() + 1500 });
    await atomicJson(join(root, 'desired.json'), { ...desired, stable: { ...desired.stable, enabled: false } });
    await until(() => !existsSync(join(root, 'release-switch.json')) && status().stable.pid && status().stable.pid !== stablePid);
    assert.equal(readJson(join(root, 'desired.json')).stable.release, 'good');

    const stopped = structuredClone(desired);
    for (const service of Object.values(stopped)) service.enabled = false;
    await atomicJson(join(root, 'desired.json'), stopped);
    await until(() => Object.values(status()).every((service) => service.health === 'stopped'));
    await sleep(1500);
    assert.ok(Object.values(status()).every((service) => service.pid === null), 'manual stop must not auto-restart');
  } finally {
    // Stop our supervisor first, letting each worker's IPC disconnect terminate its own tree.
    if (supervisor?.exitCode === null) supervisor.kill();
    await sleep(1500);
    await stopChild(supervisor);
    // This directory was created above by mkdtemp and contains only this test's fixtures.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('supervisor lock only skips a verified active supervisor, not a foreign pipe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-lock-test-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\agentcanvas-test-${randomUUID()}` : join(root, 'lock.sock');
  let lock;
  try {
    lock = await acquireSupervisorLock(pipe);
    assert.ok(lock);
    assert.equal(await acquireSupervisorLock(pipe), null);
    await new Promise((res) => lock.close(res));
    lock = net.createServer((socket) => socket.end('unrelated service\n'));
    await new Promise((res) => lock.listen(pipe, res));
    await assert.rejects(acquireSupervisorLock(pipe), { code: 'EADDRINUSE' });
  } finally {
    if (lock?.listening) await new Promise((res) => lock.close(res));
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows GUI task host creates no child console, skips duplicates, logs safely and preserves exit codes', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  // No Task Scheduler or real website is touched: this test owns this entire fixture root.
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-host-test-'));
  let host, failedHost;
  const waitExit = (child) => new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code) => res(code)); });
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'config.json'), '{}');
    await writeFile(join(root, 'bin/supervisor.mjs'), '// Test marker; executable is a harmless console probe.');
    const exe = await buildTaskHost(join(root, 'bin'));
    await compileWindowsExecutable(join(here, 'fixtures/task-host-probe.cs'), join(root, 'runtime/node.exe'), 'exe');
    // windowsHide is deliberately false: GUI subsystem itself must suppress the console.
    host = spawn(exe, ['--runtime-root', root], { windowsHide: false, stdio: 'ignore' });
    const exit = waitExit(host);
    await until(() => existsSync(join(root, 'probe.json')));
    const initial = readJson(join(root, 'probe.json'));
    assert.equal(initial.hasConsole, false, 'CreateNoWindow must prevent a console even for a console-subsystem child');
    const duplicate = spawn(exe, ['--runtime-root', root], { windowsHide: false, stdio: 'ignore' });
    assert.equal(await waitExit(duplicate), 0);
    assert.equal(readJson(join(root, 'probe.json')).pid, initial.pid);
    await writeFile(join(root, 'finish'), 'test done');
    assert.equal(await exit, 0);
    const log = readFileSync(join(root, 'logs/launcher.log'), 'utf8');
    assert.match(log, /duplicate skipped successfully/);
    assert.match(log, /stdout-ready/);
    for (const secret of ['private-fixture', 'abcdef', 'sk-test-secret', 'example-key']) assert.ok(!log.includes(secret));
    await writeFile(join(root, 'fail'), 'test failure');
    failedHost = spawn(exe, ['--runtime-root', root], { windowsHide: false, stdio: 'ignore' });
    assert.equal(await waitExit(failedHost), 23);
    assert.match(readFileSync(join(root, 'logs/launcher.log'), 'utf8'), /Supervisor exited code=23/);
    const invalid = spawn(exe, [], { windowsHide: false, stdio: 'ignore' });
    assert.equal(await waitExit(invalid), 2);
  } finally {
    await stopChild(host); await stopChild(failedHost);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Windows watchdog respects disabled tasks, starts an isolated stopped task, and skips its running instance', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-watchdog-test-'));
  const name = `AgentCanvas-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const execute = (exe, args) => new Promise((res, rej) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
    child.once('error', rej); child.once('exit', (code) => res({ code, output }));
  });
  const fixture = (action) => execute('powershell.exe', ['-NoProfile', '-File', join(here, 'fixtures/watchdog-task.ps1'), '-Action', action, '-FixtureRoot', root, '-TaskName', name]);
  try {
    const { watchdog } = await buildRuntimeHosts(join(root, 'bin'));
    await mkdir(join(root, 'runtime'));
    await writeFile(join(root, 'config.json'), '{}');
    await writeFile(join(root, 'bin/supervisor.mjs'), '// harmless fixture');
    await compileWindowsExecutable(join(here, 'fixtures/task-host-probe.cs'), join(root, 'runtime/node.exe'), 'exe');
    const registered = await fixture('register'); assert.equal(registered.code, 0, registered.output);
    const check = () => execute(watchdog, ['--runtime-root', root, '--task-name', name]);
    const disabled = await check(); assert.equal(disabled.code, 0, existsSync(join(root, 'logs/watchdog.log')) ? readFileSync(join(root, 'logs/watchdog.log'), 'utf8') : 'watchdog failed');
    assert.equal(existsSync(join(root, 'probe.json')), false);
    const enabled = await fixture('enable'); assert.equal(enabled.code, 0, enabled.output);
    const started = await check(); assert.equal(started.code, 0, existsSync(join(root, 'logs/watchdog.log')) ? readFileSync(join(root, 'logs/watchdog.log'), 'utf8') : 'watchdog failed');
    await until(() => existsSync(join(root, 'probe.json')));
    const probe = readJson(join(root, 'probe.json')); assert.equal(probe.hasConsole, false);
    assert.equal((await check()).code, 0);
    assert.equal(readJson(join(root, 'probe.json')).pid, probe.pid);
    await writeFile(join(root, 'finish'), 'done');
    await sleep(300);
  } finally {
    const cleanup = await fixture('remove'); assert.equal(cleanup.code, 0, cleanup.output);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
