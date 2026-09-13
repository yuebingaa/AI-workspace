import { spawn } from 'node:child_process';
import { logLine, stopChild } from './common.mjs';

let child;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopChild(child);
  process.exit(0);
}
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('message', (message) => {
  if (message.type === 'stop') { void stop(); return; }
  if (message.type !== 'start' || child || stopping) return;
  child = spawn(message.node, message.args, {
    cwd: message.cwd, env: message.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const secrets = Object.entries(message.env).filter(([key, value]) => /key|secret|token|password/i.test(key) && value.length > 5).map(([, value]) => value);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    const output = (line) => {
      for (const secret of secrets) line = line.replaceAll(secret, '[redacted]');
      if (message.logFile) logLine(message.logFile, line);
      else console.log(line);
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) output(line);
      // Do not flush partial lines (which could split a credential across chunks).
      if (pending.length > 65536) { pending = ''; output('[oversized log line omitted]'); }
    });
    stream.on('end', () => { if (pending) output(pending); });
  }
  child.once('spawn', () => process.send?.({ type: 'started', pid: child.pid }));
  child.once('error', (error) => { console.error(error.code); process.exit(1); });
  child.once('exit', (code) => { if (!stopping) process.exit(code ?? 1); });
});
