// Build an isolated fixture, then serve only to this browser context on managed 3001.
// No product route, extra server, project data, model, database, or source mutation.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:3001', prefix = '/__gw-materialized-gate/';
const directory = resolve('.runtime/visualization-unification-20260929', `adapter-${Date.now()}`), bundle = join(directory, 'bundle');
await mkdir(directory, { recursive: true });
await build({ configFile: false, plugins: [react()], define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: bundle, emptyOutDir: false, minify: false,
  lib: { entry: resolve('scripts/fixtures/graphic-walker-materialized.tsx'), formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' } }, logLevel: 'warn' });
const report = { passed: false, scenarios: {}, errors: [], screenshots: [], blocked: [] };
const styles = (await readdir(bundle)).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="${name}">`).join('');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN', serviceWorkers: 'block' });
const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
  if (url.origin !== base || !url.pathname.startsWith(prefix)) { report.blocked.push(url.pathname); return route.abort(); }
  if (url.pathname === prefix) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>隔离适配试验</title>${styles}<div id="root"></div><script type="module" src="fixture.js"></script>` });
  const path = resolve(bundle, decodeURIComponent(url.pathname.slice(prefix.length)));
  assert.ok(path.startsWith(bundle + sep));
  return route.fulfill({ body: await readFile(path), contentType: extname(path) === '.css' ? 'text/css' : 'application/javascript' });
});
try {
  await page.goto(base + prefix);
  for (const scenario of ['series', 'facets', 'rank', 'input-order', 'duplicate', 'dates-null']) {
    await page.getByLabel('适配场景').selectOption(scenario);
    await page.waitForFunction(name => window.gwGate?.scenario === name && window.gwGate.outputs.length > 0, scenario);
    await page.locator('[aria-label="适配画布"] svg').first().waitFor();
    await page.getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    const evidence = await page.evaluate(() => window.gwGate);
    assert.deepEqual(evidence.errors, []);
    const output = evidence.outputs.at(-1);
    assert.equal(output.length, evidence.inputs.length, scenario);
    assert.deepEqual(output.map(row => row.amount).sort((a,b) => (a ?? -999) - (b ?? -999)), evidence.inputs.map(row => row.amount).sort((a,b) => (a ?? -999) - (b ?? -999)));
    const visual = await page.locator('[aria-label="适配画布"] svg').first().textContent();
    const marks = await page.locator('[aria-label="适配画布"] [aria-roledescription]').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), role: node.getAttribute('aria-roledescription') })));
    report.scenarios[scenario] = { ...evidence, visual, marks };
    if (scenario === 'series') { assert.match(visual, /企业/); assert.match(visual, /个人/); }
    if (scenario === 'facets') { assert.match(visual, /东区/); assert.match(visual, /西区/); }
    if (scenario === 'rank') { assert.ok(visual.indexOf('Z 项') < visual.indexOf('M 项') && visual.indexOf('M 项') < visual.indexOf('A 项'), visual); }
    if (scenario === 'input-order') assert.ok(visual.indexOf('Z 项') < visual.indexOf('A 项') && visual.indexOf('A 项') < visual.indexOf('M 项'), visual);
    if (scenario === 'duplicate') assert.equal(marks.filter(mark => mark.role === 'point').length || marks.filter(mark => mark.role === 'point mark').length, 2);
    await page.screenshot({ path: join(directory, `${scenario}.png`), fullPage: true }); report.screenshots.push({ name: scenario, viewed: false });
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch(error) { report.failure = error.stack; await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
