import { cp, mkdir, symlink } from 'node:fs/promises';
import { existsSync, openSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
import { spawn, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { atomicJson, health, portFree, readEnvironment, readJson, sleep, stopChild } from './common.mjs';
import { copyWecomCli } from '../copy-wecom-cli.mjs';
import { copyNotebookRuntime } from '../copy-notebook-runtime.mjs';
import { buildRuntimeHosts } from './build-task-host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const identity = createHash('sha256').update(source.toLowerCase()).digest('hex').slice(0, 10);
const root = resolve(process.env.AGENTCANVAS_RUNTIME_ROOT || join(process.env.LOCALAPPDATA || source, 'AgentCanvas', `site-${identity}`));
const configFile = join(root, 'config.json');
const desiredFile = join(root, 'desired.json');
const statusFile = join(root, 'status.json');
const command = process.argv[2] || 'status';
const target = process.argv[3] || 'all';
const mutable = !['status', 'logs', 'help'].includes(command);
let controlLock;

async function run(exe, args, options = {}) {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'inherit', ...options });
  const stop = () => { void stopChild(child); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('exit', (code) => code === 0 ? res() : rej(new Error(`${args[0] ?? exe} exited ${code}`)));
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
function config() { return readJson(configFile); }
function desired() { return readJson(desiredFile); }
async function waitFor(predicate, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(500); }
  throw new Error('Timed out; inspect npm run site:logs');
}
async function ensureSupervisor() {
  const current = readJson(statusFile, {});
  if (Date.now() - Date.parse(current.checkedAt) < 5000 && Number.isInteger(current.supervisorPid)) {
    try { process.kill(current.supervisorPid, 0); return; } catch { /* A stale PID is not a live supervisor. */ }
  }
  await run('powershell.exe', ['-NoProfile', '-File', join(here, 'register-task.ps1'), '-RuntimeRoot', root]);
  await waitFor(() => {
    const status = readJson(statusFile, {});
    return Date.now() - Date.parse(status.checkedAt) < 5000;
  }, 30000);
}
async function install() {
  if (!existsSync(configFile)) {
    for (const folder of ['bin', 'runtime', 'config', 'logs', 'releases', 'builds', 'state/stable', 'state/dev', 'state/checks', 'state/backups']) await mkdir(join(root, folder), { recursive: true });
    await cp(process.execPath, join(root, 'runtime/node.exe'));
    for (const file of ['common.mjs', 'worker.mjs', 'supervisor.mjs', 'task-host.ps1']) await cp(join(here, file), join(root, 'bin', file));
    await buildRuntimeHosts(join(root, 'bin'));
    for (const file of ['.env', '.env.local']) if (existsSync(join(source, file))) await cp(join(source, file), join(root, 'config', file));
    await atomicJson(configFile, { source, node: join(root, 'runtime/node.exe'), taskName: `AgentCanvas-${identity}`,
      lockPipe: `\\\\.\\pipe\\agentcanvas-${identity}`, stableState: join(root, 'state/stable'), devState: join(root, 'state/dev') });
    await atomicJson(desiredFile, { stable: { enabled: false, release: null, previous: null, revision: randomUUID() },
      dev: { enabled: false, revision: randomUUID() }, capture: { enabled: false, revision: randomUUID() } });
    await atomicJson(join(source, '.runtime/runtime-location.json'), { root, taskName: config().taskName });
  }
  await ensureSupervisor();
  console.log(`Runtime: ${root}`);
}
async function updateManager() {
  const previous = desired();
  // Compile before interrupting anything; retain the stage and old task/files for recovery.
  const stage = join(root, 'manager-updates', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await buildRuntimeHosts(stage);
  await atomicJson(join(stage, 'desired-before.json'), previous);
  console.log('Console-free task host compiled and validated; updating background manager ...');
  let updateError;
  try {
    const current = readJson(statusFile, {}).services;
    const alreadyStopped = ['stable', 'dev', 'capture'].every((name) => current?.[name]?.health === 'stopped' && !current[name].pid);
    if (alreadyStopped) {
      // Recover an interrupted/disabled manager without first trying to run that
      // disabled task. Verify ports really are idle, not just a stale status file.
      const ports = [config().stablePort ?? 3000, config().devPort ?? 3001, config().capturePort ?? 3198];
      if (!(await Promise.all(ports.map(portFree))).every(Boolean)) throw new Error('Stopped service status conflicts with occupied ports; refusing manager replacement.');
    } else await control('stop', 'all');
    await run('powershell.exe', ['-NoProfile', '-File', join(here, 'register-task.ps1'), '-RuntimeRoot', root, '-RefreshManager', '-ManagerStage', stage]);
  } catch (error) {
    updateError = error;
  } finally { await atomicJson(desiredFile, previous); }
  await ensureSupervisor();
  await waitFor(() => {
    const services = readJson(statusFile, {}).services;
    return Object.entries(previous).every(([name, value]) => !value.enabled || (services?.[name]?.pid && ['ok', 'degraded'].includes(services[name].health)));
  }, 240000);
  if (updateError) throw new Error(`Manager update failed; prior enabled services were restored. ${updateError.message}`);
  console.log('Background manager updated; previously enabled services are ready.');
}
async function snapshot(id) {
  const work = join(root, 'builds', id);
  const excluded = new Set(['node_modules', 'dist', '.next', '.git', '.runtime', '.wrangler', '.vinext', '.studio-data', 'evidence', 'outputs', 'work', 'coverage', '.edgeone', '.tef_dist']);
  await cp(source, work, { recursive: true, filter: (path) => {
    const rel = relative(source, path);
    if (!rel) return true;
    const first = rel.split(sep)[0];
    return !excluded.has(first) && !first.startsWith('.env') && first !== 'mcp.config.json' && !first.endsWith('.tsbuildinfo');
  } });
  // Only the build uses the installed dependencies. Releases contain copied runtime files.
  await symlink(join(source, 'node_modules'), join(work, 'node_modules'), 'junction');
  console.log(`Building isolated source snapshot ${id} ...`);
  const publicEnv = Object.fromEntries(Object.entries(readEnvironment(join(root, 'config'))).filter(([key]) => key.startsWith('NEXT_PUBLIC_')));
  await run(config().node, [join(work, 'node_modules/vinext/dist/cli.js'), 'build'], { cwd: work,
    env: { ...process.env, ...publicEnv, NODE_ENV: 'production', STUDIO_LOCAL_STATE_DIR: join(root, 'state/checks', id) } });
  const app = join(root, 'releases', id, 'app');
  await cp(join(work, 'dist/standalone'), app, { recursive: true, dereference: true });
  await copyWecomCli(source, app);
  await copyNotebookRuntime(source, app);
  // vinext beta omits these runtime peers from standalone output (also needed by portable packaging).
  for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'playwright-core']) {
    await cp(join(source, 'node_modules', name), join(app, 'node_modules', name), { recursive: true, dereference: true });
  }
  await mkdir(join(app, 'scripts'), { recursive: true });
  await cp(join(work, 'scripts/playwright-capture-service.mjs'), join(app, 'scripts/playwright-capture-service.mjs'));
  await atomicJson(join(root, 'releases', id, 'manifest.json'), { id, createdAt: new Date().toISOString(), source, build: 'vinext-standalone', node: process.version });
  return app;
}
async function smoke(id) {
  let port;
  for (let p = 33100; p < 33120; p++) if (await portFree(p)) { port = p; break; }
  if (!port) throw new Error('No free candidate-check port');
  const file = join(root, 'logs', `check-${id}.log`);
  const fd = openSync(file, 'a', 0o600);
  const worker = fork(join(root, 'bin/worker.mjs'), [], { execPath: config().node, windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'] });
  closeSync(fd);
  worker.send({ type: 'start', node: config().node, cwd: join(root, 'releases', id, 'app'), args: ['server.js'],
    logFile: file, env: { ...process.env, ...readEnvironment(join(root, 'config')), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      STUDIO_LOCAL_STATE_DIR: join(root, 'state/checks', `${id}-${randomUUID()}`), HARNESS_VISUAL_VERIFICATION_ENABLED: '0' } });
  try {
    await waitFor(async () => {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Candidate exited; see ${file}`);
      return (await health(port, '/api/health', true)).ready;
    }, 60000);
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(20000) });
    const html = await page.text();
    if (!page.ok || !html.includes('<html')) throw new Error('Candidate homepage failed');
    const asset = html.match(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/);
    if (!asset) throw new Error('Candidate homepage did not expose JS/CSS assets');
    const assetUrl = new URL(asset[1].replaceAll('&amp;', '&'), `http://127.0.0.1:${port}`);
    if (assetUrl.origin !== `http://127.0.0.1:${port}`) throw new Error('Expected local asset');
    const response = await fetch(assetUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Candidate static asset failed');
    await response.arrayBuffer();
    console.log('Candidate passed: persistent health, homepage and static asset.');
  } finally {
    if (worker.connected) worker.send({ type: 'stop' }, () => {});
    const deadline = Date.now() + 10000;
    while (worker.exitCode === null && worker.signalCode === null && Date.now() < deadline) await sleep(100);
    await stopChild(worker);
  }
}
async function switchRelease(id) {
  const previous = desired();
  const next = structuredClone(previous);
  const journalFile = join(root, 'release-switch.json');
  await atomicJson(journalFile, { previous, deadline: Date.now() + 150000 });
  try {
    // Persistence has a single-writer contract: stop the old instance before backing up or switching.
    next.stable.enabled = false;
    await atomicJson(desiredFile, next);
    await waitFor(() => readJson(statusFile, {}).services?.stable?.health === 'stopped', 30000);
    const backup = join(root, 'state/backups', `${Date.now()}-${id}`);
    await mkdir(backup, { recursive: true });
    await cp(config().stableState, backup, { recursive: true });
    next.stable = { enabled: true, release: id, previous: previous.stable.release, revision: randomUUID() };
    next.capture = { enabled: true, revision: randomUUID() };
    await atomicJson(desiredFile, next);
    await waitFor(async () => {
      const state = readJson(statusFile, {}).services?.stable;
      return state?.release === id && state?.pid && state?.health === 'ok' && (await health(3000, '/api/health', true)).ready;
    });
    unlinkSync(journalFile);
  } catch (error) {
    console.error('Switch failed; restoring the previous release selection. State backup retained.');
    await atomicJson(desiredFile, previous);
    if (existsSync(journalFile)) unlinkSync(journalFile);
    if (previous.stable.enabled) await waitFor(async () => {
      const state = readJson(statusFile, {}).services?.stable;
      return state?.release === previous.stable.release && (await health(3000)).alive;
    });
    throw error;
  }
  console.log(`Stable release: ${id} — http://127.0.0.1:3000`);
}
async function control(action, name) {
  if (!['all', 'stable', 'dev', 'capture'].includes(name)) throw new Error('Target must be all, stable, dev or capture');
  await ensureSupervisor();
  const next = desired();
  const names = name === 'all' ? ['stable', 'dev', 'capture'] : [name];
  for (const service of names) {
    if (service === 'stable' && action !== 'stop' && !next.stable.release) throw new Error('Publish a release first: npm run site:publish');
    next[service].enabled = action !== 'stop';
    if (action === 'restart') next[service].revision = randomUUID();
  }
  await atomicJson(desiredFile, next);
  await waitFor(() => {
    const state = readJson(statusFile, {}).services;
    return names.every((service) => action === 'stop' ? state?.[service]?.health === 'stopped'
      : state?.[service]?.pid && state[service].revision === next[service].revision && ['ok', 'degraded'].includes(state[service].health));
  }, name === 'dev' || name === 'all' ? 240000 : 90000);
  console.log(`${action} ${name}: done`);
}

try {
  const runtimeRelation = relative(source, root);
  if (!runtimeRelation || (!runtimeRelation.startsWith(`..${sep}`) && !isAbsolute(runtimeRelation))) throw new Error('Runtime directory must be outside the source tree.');
  if (existsSync(configFile) && resolve(config().source).toLowerCase() !== source.toLowerCase()) throw new Error('Runtime directory belongs to a different source workspace.');
  await mkdir(root, { recursive: true });
  await mkdir(join(source, '.runtime'), { recursive: true });
  if (mutable) {
    controlLock = net.createServer((socket) => socket.end());
    await new Promise((res, rej) => {
      controlLock.once('error', () => rej(new Error('Another management command is running.')));
      controlLock.listen(`\\\\.\\pipe\\agentcanvas-control-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`, res);
    });
  }
  if (command === 'install') await install();
  else if (command === 'update-manager') await updateManager();
  else if (command === 'publish') {
    await ensureSupervisor();
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await snapshot(id); await smoke(id); await switchRelease(id);
  } else if (command === 'rollback') {
    const id = desired().stable.previous;
    if (!id) throw new Error('No previous release to roll back to');
    await ensureSupervisor(); await smoke(id); await switchRelease(id);
  } else if (['start', 'stop', 'restart'].includes(command)) await control(command, target);
  else if (command === 'status') {
    const status = readJson(statusFile, {});
    console.log(JSON.stringify({ root, taskName: existsSync(configFile) ? config().taskName : null,
      supervisorFresh: Date.now() - Date.parse(status.checkedAt) < 15000, ...status }, null, 2));
  } else if (command === 'logs') {
    const names = target === 'all' ? ['launcher', 'watchdog', 'supervisor', 'stable', 'dev', 'capture'] : [target];
    if (names.some((name) => !['launcher', 'watchdog', 'supervisor', 'stable', 'dev', 'capture'].includes(name))) throw new Error('Invalid log target');
    for (const name of names) {
      const file = join(root, 'logs', `${name}.log`);
      console.log(`\n${name}: ${file}`);
      if (existsSync(file)) console.log(readFileSync(file, 'utf8').split(/\r?\n/).slice(-35).join('\n'));
    }
  } else if (command === 'help') console.log('install | update-manager | publish | rollback | start/stop/restart [all|stable|dev|capture] | status | logs [all|launcher|watchdog|supervisor|stable|dev|capture]');
  else throw new Error(`Unknown command ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { controlLock?.close(); }
