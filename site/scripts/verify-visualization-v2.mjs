// Use generated real DuckDB evidence, then intercept only an isolated browser's
// 3001 fixture URLs. No extra server or project/model/storage access.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:3001', prefix = '/__visualization-v2-gate/';
const evidenceFile = resolve(process.argv[2] ?? '.runtime/visualization-v2-20260929/formal-results.json');
assert.ok(evidenceFile.startsWith(resolve('.runtime') + sep));
const data = JSON.parse(await readFile(evidenceFile, 'utf8'));
assert.equal(data.series.result.visualResult.inputRowCount, 6); assert.equal(data.series.result.table.rows.length, 4);
const directory = resolve('.runtime/visualization-v2-20260929', `browser-${Date.now()}`), bundle = join(directory, 'bundle');
await mkdir(directory, { recursive: true });
await build({ configFile: false, plugins: [react()], resolve: { alias: { '@': process.cwd() } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: bundle, emptyOutDir: false, minify: false,
    lib: { entry: resolve('scripts/fixtures/visualization-v2.tsx'), formats: ['es'], fileName: () => 'fixture.js', cssFileName: 'fixture' } }, logLevel: 'warn' });
const report = { passed: false, source: evidenceFile, scenarios: {}, errors: [], screenshots: [], blocked: [] };
const styles = (await readdir(bundle)).filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="${name}">`).join('');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
  if (url.origin !== base || !url.pathname.startsWith(prefix)) { report.blocked.push(url.pathname); return route.abort(); }
  if (url.pathname === prefix) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>V2 隔离验收</title>${styles}<style>body{margin:0;background:#fbfaf8;color:#292727;font:14px Arial,"Microsoft YaHei",sans-serif}main{margin:24px auto;padding:24px;background:white;max-width:1200px;border:1px solid #e7e5e3;border-radius:10px}h1{font-size:22px}h2{font-size:18px;margin:24px 0}p{color:#646263}table{border-collapse:collapse;min-width:500px}td,th{padding:10px 20px;border-bottom:1px solid #e7e5e3;text-align:left}th{background:#f7f6f4}select{padding:6px}[role=alert]{color:#b83f32;padding:24px;background:#fff5f3}</style><div id="root"></div><script type="module" src="fixture.js"></script>` });
  if (url.pathname === prefix + 'results.json') return route.fulfill({ json: data });
  const path = resolve(bundle, decodeURIComponent(url.pathname.slice(prefix.length))); assert.ok(path.startsWith(bundle + sep));
  return route.fulfill({ body: await readFile(path), contentType: extname(path) === '.css' ? 'text/css' : 'application/javascript' });
});
try {
  await page.goto(base + prefix);
  for (const scenario of ['series', 'series-warm', 'raw-order', 'filtered', 'rank', 'empty', 'stale']) {
    await page.getByLabel('验证场景').selectOption(scenario);
    await page.waitForFunction(name => window.visualizationV2?.scenario === name && window.visualizationV2.status !== 'loading', scenario);
    const evidence = await page.evaluate(() => window.visualizationV2);
    if (scenario === 'stale') {
      assert.equal(evidence.status, 'error'); await page.getByRole('alert').waitFor(); assert.equal(await page.locator('[aria-label="V2 画布"]').count(), 0);
    } else if (scenario === 'empty') {
      assert.equal(evidence.status, 'empty'); await page.getByText('没有符合筛选条件的数据', { exact: false }).waitFor(); assert.equal(await page.locator('[aria-label="V2 画布"]').count(), 0);
    } else {
      assert.equal(evidence.error, undefined); assert.equal(evidence.status, 'ready');
      await page.locator('[aria-label="V2 画布"] svg').first().waitFor();
      await page.getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' }); await page.waitForTimeout(250);
      const source = data[scenario === 'series-warm' ? 'series' : scenario].result.table.rows;
      assert.deepEqual(evidence.outputs.at(-1), source);
      const visual = await page.locator('[aria-label="V2 画布"] svg').first().textContent();
      if (scenario === 'series') { assert.match(visual, /个人/); assert.match(visual, /企业/); }
      if (scenario === 'rank') assert.ok(visual.indexOf('Z') < visual.indexOf('A') && visual.indexOf('A') < visual.indexOf('M'), visual);
      if (scenario === 'raw-order') assert.ok(visual.indexOf('Z') < visual.indexOf('A') && visual.indexOf('A') < visual.indexOf('M'), visual);
      evidence.visual = visual;
      evidence.marks = await page.locator('[aria-label="V2 画布"] [aria-roledescription]').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), role: node.getAttribute('aria-roledescription') })));
      if (scenario === 'series-warm') {
        assert.ok(!evidence.marks.some(mark => mark.role === 'legend')); const fills = await page.locator('[aria-label="V2 画布"] svg [fill]').evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')));
        assert.ok(fills.includes('#bb7657') || fills.includes('#d49d68'));
      }
    }
    report.scenarios[scenario] = evidence;
    await page.screenshot({ path: join(directory, `${scenario}.png`), fullPage: true }); report.screenshots.push({ name: scenario, viewed: false });
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch(error) { report.failure = error.stack; await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
