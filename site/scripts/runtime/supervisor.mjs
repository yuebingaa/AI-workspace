import { fork } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSupervisorLock, atomicJson, health, logLine, portFree, readEnvironment, readJson, sleep, stopChild } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
if (!root) throw new Error('Missing runtime directory');
const config = readJson(join(root, 'config.json'));
const logRoot = join(root, 'logs');
mkdirSync(logRoot, { recursive: true });
const supervisorLog = join(logRoot, 'supervisor.log');
// An OS-held exclusive socket avoids stale PID files and duplicate supervisors.
const lock = await acquireSupervisorLock(config.lockPipe).catch((error) => {
  logLine(supervisorLog, `supervisor lock failed: ${error.code ?? error.name}`);
  throw error;
});
if (!lock) {
  logLine(supervisorLog, 'Existing supervisor is active; duplicate skipped successfully.');
  process.exit(0);
}
const services = new Map();
let shuttingDown = false;

function serviceSpec(name, desired) {
  const release = desired.stable.release;
  const env = { ...process.env, ...readEnvironment(join(root, 'config')) };
  // Runtime-only evaluation gates must never leak into the daily site.
  delete env.HARNESS_EVAL_SERVER; delete env.HARNESS_EVAL_SESSION_NONCE;
  env.HOST = '127.0.0.1'; env.HOSTNAME = '127.0.0.1';
  const stablePort = config.stablePort ?? 3000;
  const devPort = config.devPort ?? 3001;
  const capturePort = config.capturePort ?? 3198;
  if (name === 'stable') {
    if (!desired.stable.enabled || !release) return null;
    return { cwd: join(root, 'releases', release, 'app'), args: ['server.js'], port: stablePort,
      env: { ...env, NODE_ENV: 'production', PORT: String(stablePort), STUDIO_LOCAL_STATE_DIR: config.stableState,
        HARNESS_VISUAL_BASE_URL: `http://127.0.0.1:${stablePort}` }, revision: desired.stable.revision, release };
  }
  if (name === 'dev') {
    if (!desired.dev.enabled) return null;
    return { cwd: config.source, args: [join(config.source, 'node_modules/vinext/dist/cli.js'), 'dev', '--hostname', '127.0.0.1', '--port', String(devPort)], port: devPort,
      env: { ...env, ...readEnvironment(config.source), NODE_ENV: 'development', PORT: String(devPort), AGENTCANVAS_LOCAL_NODE_DEV: '1',
        STUDIO_LOCAL_STATE_DIR: config.devState, HARNESS_VISUAL_BASE_URL: `http://127.0.0.1:${devPort}` }, revision: desired.dev.revision };
  }
  if (!desired.capture.enabled) return null;
  const cwd = release ? join(root, 'releases', release, 'app') : config.source;
  return { cwd, args: [join(cwd, 'scripts/playwright-capture-service.mjs')], port: capturePort, path: '/health',
    env: { ...env, HARNESS_PLAYWRIGHT_CAPTURE_PORT: String(capturePort) }, revision: desired.capture.revision };
}
async function stop(service) {
  const worker = service.worker;
  service.worker = null;
  service.pid = null;
  if (!worker) return;
  worker.send?.({ type: 'stop' }, () => {});
  const until = Date.now() + 10000;
  while (worker.exitCode === null && worker.signalCode === null && Date.now() < until) await sleep(100);
  await stopChild(worker);
}
async function tick(name, desired) {
  let service = services.get(name);
  if (!service) { service = { name, worker: null, pid: null, failures: 0, nextStart: 0, restarts: 0, health: 'stopped' }; services.set(name, service); }
  const spec = serviceSpec(name, desired);
  const signature = JSON.stringify(spec);
  if (signature !== service.signature) {
    await stop(service);
    service.signature = signature; service.failures = 0; service.nextStart = 0; service.misses = 0; service.checkedAt = 0;
  }
  if (!spec) { service.health = 'stopped'; return; }
  service.release = spec.release;
  service.revision = spec.revision;
  if (!service.worker && Date.now() >= service.nextStart) {
    if (!await portFree(spec.port)) {
      service.health = 'port-conflict'; service.nextStart = Date.now() + 10000;
      logLine(supervisorLog, `${name}: port ${spec.port} occupied; no foreign process was stopped`); return;
    }
    const file = join(logRoot, `${name}.log`);
    const worker = fork(join(here, 'worker.mjs'), [], { execPath: config.node, windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    service.worker = worker; service.startedAt = Date.now(); service.misses = 0; service.health = 'starting';
    worker.on('message', (message) => { if (service.worker === worker && message.type === 'started') service.pid = message.pid; });
    worker.on('error', (error) => logLine(supervisorLog, `${name}: worker error ${error.code}`));
    worker.on('exit', (code, signal) => {
      if (service.worker !== worker) return;
      service.worker = null; service.pid = null; service.restarts++;
      const delay = [1000, 2000, 5000, 10000, 30000][Math.min(service.failures++, 4)];
      service.nextStart = Date.now() + delay; service.health = 'restarting';
      logLine(supervisorLog, `${name}: exited (${code ?? signal}); retry in ${delay}ms`);
    });
    worker.send({ type: 'start', node: config.node, logFile: file, ...spec });
    logLine(supervisorLog, `${name}: started worker ${worker.pid}${spec.release ? ` release ${spec.release}` : ''}`);
  }
  if (service.worker && Date.now() - (service.checkedAt ?? 0) > 10000) {
    service.checkedAt = Date.now();
    const check = await health(spec.port, spec.path);
    service.health = check.status;
    if (check.alive) {
      service.misses = 0;
      if (Date.now() - service.startedAt > 60000) service.failures = 0;
    } else if (Date.now() - service.startedAt > (name === 'dev' ? 180000 : 60000) && ++service.misses >= 3) {
      logLine(supervisorLog, `${name}: three failed liveness probes; restarting only this service`);
      await stop(service); service.restarts++; service.nextStart = Date.now() + 5000;
    }
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...services.values()].map(stop));
  lock.close(); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
logLine(supervisorLog, `supervisor ${process.pid} started`);
try {
  while (!shuttingDown) {
    const journalFile = join(root, 'release-switch.json');
    const journal = readJson(journalFile, null);
    if (journal && Date.now() > journal.deadline) {
      logLine(supervisorLog, 'Interrupted release switch expired; restoring previous selection');
      await atomicJson(join(root, 'desired.json'), journal.previous);
      unlinkSync(journalFile);
    }
    const desired = readJson(join(root, 'desired.json'));
    await Promise.all(['stable', 'dev', 'capture'].map((name) => tick(name, desired)));
    await atomicJson(join(root, 'status.json'), {
      supervisorPid: process.pid, checkedAt: new Date().toISOString(),
      services: Object.fromEntries([...services].map(([name, s]) => [name, {
        pid: s.pid, workerPid: s.worker?.pid ?? null, health: s.health, release: s.release,
        revision: s.revision, restarts: s.restarts, startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      }])),
    });
    await sleep(1000);
  }
} catch (error) {
  logLine(supervisorLog, `supervisor failed: ${error.message}`);
  await Promise.all([...services.values()].map(stop));
  lock.close(); process.exitCode = 1;
}
