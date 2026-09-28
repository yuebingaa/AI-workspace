// Ephemeral independent marimo editor, synthetic fixture only; does not change the website runtime.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const directory = resolve('.runtime/marimo-notebook-pilot-20260927', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const fixture = resolve('scripts/fixtures/marimo-notebook-pilot.py');
const { stdout } = await promisify(execFile)('uv', ['run', '--python', '3.12', '--script', fixture], { windowsHide: true, timeout: 120000 });
const execution = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
assert.equal(execution.rows, 4); assert.equal(execution.revenue, 590000);
const notebook = join(directory, 'notebook.py'); await copyFile(fixture, notebook);
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const server = spawn(execution.python, ['-m', 'marimo', 'edit', notebook, '--headless', '--no-token', '--no-sandbox', '--skip-update-check', '--host', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
const base = `http://127.0.0.1:${port}`, report = { passed: false, version: '0.25.0', execution, base, screenshots: [], pageErrors: [], boundaries: ['Synthetic standalone marimo editor; no project, DSH, database connector or app persistence integration.', 'Temporary Python server only; website 3000/3001/3198 not changed.'] };
let browser;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`marimo exited: ${logs}`);
    try { const response = await fetch(base, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* own server still starting */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.cm-editor').first().waitFor();
  await page.screenshot({ path: join(directory, '01-marimo-editor.png') });
  report.screenshots.push('01-marimo-editor.png');
  await writeFile(join(directory, 'visible-text.txt'), await page.locator('body').innerText());
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser?.close();
  if (server.exitCode === null) {
    if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }).catch(() => server.kill());
    else server.kill();
  }
  server.stdout.destroy(); server.stderr.destroy(); server.unref();
  await writeFile(join(directory, 'server.log'), logs);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }));
}
