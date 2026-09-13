import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson } from './common.mjs';

const evidence = join(process.cwd(), '.runtime');
await mkdir(evidence, { recursive: true });
const { root } = readJson(join(evidence, 'runtime-location.json'));
const before = readJson(join(root, 'status.json'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const results = [];
  for (const port of [3000, 3001]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/ai/**', (route) => route.abort());
    const response = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(response.status(), 200);
    assert.ok((await page.locator('body').innerText()).length > 100);
    const marker = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--agentcanvas-runtime-proof').trim());
    if (process.argv.includes('--isolation')) assert.equal(marker, port === 3001 ? 'verified' : '');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(evidence, `runtime-${port}.png`), fullPage: false });
    results.push({ port, status: response.status(), errors, marker });
    await page.close();
  }
  const after = readJson(join(root, 'status.json'));
  assert.equal(after.services.stable.pid, before.services.stable.pid, 'Stable PID changed while testing development code');
  const report = { checkedAt: new Date().toISOString(), stablePid: after.services.stable.pid, sourceIsolation: process.argv.includes('--isolation'), results };
  await atomicJson(join(evidence, process.argv.includes('--isolation') ? 'runtime-browser-isolation.json' : 'runtime-browser-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
