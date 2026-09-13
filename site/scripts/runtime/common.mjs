import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function acquireSupervisorLock(pipe) {
  const greeting = 'AgentCanvasSupervisor/1\n';
  const server = net.createServer((socket) => { socket.on('error', () => {}); socket.end(greeting); });
  try {
    await new Promise((res, rej) => { server.once('error', rej); server.listen(pipe, res); });
    return server;
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      const knownSupervisor = await new Promise((res) => {
        const socket = net.createConnection(pipe);
        let received = ''; let settled = false;
        const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); res(value); };
        const timer = setTimeout(() => finish(false), 1000);
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => { received += chunk; if (received.length > 256) finish(false); });
        socket.once('end', () => finish(received === greeting));
        socket.once('error', () => finish(false));
      });
      if (knownSupervisor) return null;
    }
    throw error; // A foreign/broken pipe is still a real error, never a successful duplicate.
  }
}
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temp, file); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await sleep(25 * (attempt + 1));
    }
  }
}
export function readEnvironment(root) {
  return Object.assign({}, ...['.env', '.env.local'].map((name) => {
    const file = join(root, name);
    return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  }));
}
export function redact(text) {
  return String(text)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function logLine(file, message) {
  if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
    for (let index = 4; index >= 1; index--) if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    renameSync(file, `${file}.1`);
  }
  appendFileSync(file, `${new Date().toISOString()} ${redact(message)}\n`, { mode: 0o600 });
}
export async function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
export async function health(port, path = '/api/health', strict = false) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    const alive = response.ok && ['ok', 'degraded'].includes(data.status);
    return { alive, ready: alive && data.status === 'ok' && (!strict || data.persistence?.configured === true), status: data.status ?? 'invalid' };
  } catch { return { alive: false, ready: false, status: 'unreachable' }; }
}
// Only called for a ChildProcess still owned by this runner, never a discovered port PID.
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
  } else child.kill('SIGTERM');
}
