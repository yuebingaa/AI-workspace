// Synthetic data, isolated storage, existing development service only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/python-runtime-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEBOOK_PYTHON_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], checks = [], requests = []; let modelCalls = 0, passed = false, failure;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().endsWith('/api/notebook/run')) requests.push({ type: 'request', at: Date.now() }); });
page.on('response', response => { if (response.url().endsWith('/api/notebook/run')) requests.push({ type: 'response', status: response.status(), at: Date.now() }); });
page.on('requestfailed', request => { if (request.url().endsWith('/api/notebook/run')) requests.push({ type: 'failed', reason: request.failure()?.errorText, at: Date.now() }); });
await page.route('**/api/ai/**', async route => { modelCalls++; await route.abort(); });
const editor = page.locator('.notebook-editor');
const python = () => page.getByRole('article', { name: 'Python单元 合成数据清洗', exact: true });
const sql = () => page.getByRole('article', { name: 'SQL单元 Python 汇总', exact: true });
async function save() { await editor.getByRole('button', { name: '保存单元', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); }
async function run(cell, success = true) {
  const pending = page.waitForResponse(r => r.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await cell.getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.equal(result.run.status, success ? 'success' : 'failure', JSON.stringify(result));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  return result.run;
}
async function screenshot(name, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}
const code = "raw = pd.DataFrame({'station': ['EDS', 'EDS', 'Coat'], 'seconds': [60, 120, 30]})\ncleaned = raw.assign(minutes=raw['seconds'] / 60)\nprint('3 synthetic records cleaned')";
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const info = await (await context.request.get(`${base}/api/notebook/python`)).json();
  assert.equal(info.available, true, JSON.stringify(info));
  await page.getByRole('button', { name: '＋ Python', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('合成数据清洗');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('cleaned');
  await editor.getByLabel('Python', { exact: true }).fill(code);
  await screenshot('01-python-editor', editor); await save();
  const first = await run(python());
  assert.deepEqual(first.cells.at(-1).table.rows.map(row => row.minutes), [1, 2, 0.5]);
  await python().getByText('Python 输出与诊断', { exact: true }).click();
  assert.match(await python().innerText(), /3 synthetic records cleaned/);
  await screenshot('02-python-result', python()); checks.push('real Python and stdout in UI');

  await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('Python 汇总');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
  await editor.getByRole('checkbox').first().check();
  await editor.getByLabel('SQL', { exact: true }).fill('SELECT station, SUM(minutes) AS minutes FROM cleaned GROUP BY station ORDER BY minutes DESC');
  await save();
  const second = await run(sql());
  assert.deepEqual(second.cells.at(-1).table.rows, [{ station: 'EDS', minutes: 3 }, { station: 'Coat', minutes: 0.5 }]);
  checks.push('Python DataFrame feeds real SQL');

  await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('停机分钟');
  const options = await editor.getByLabel('上游输出', { exact: true }).locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
  await editor.getByLabel('上游输出', { exact: true }).selectOption(options.find(item => item.text.includes('totals')).value);
  await editor.getByLabel('分类字段', { exact: true }).fill('station');
  await editor.getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('minutes'); await save();
  const chart = page.getByRole('article', { name: '图表单元 停机分钟', exact: true });
  await run(chart); await screenshot('03-python-sql-chart', chart); checks.push('chart renders downstream result');

  await python().getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByLabel('Python', { exact: true }).fill("print('diagnostic retained')\nraise ValueError('synthetic retry')"); await save();
  const failed = await run(chart, false);
  assert.deepEqual(failed.cells.map(cell => cell.status), ['failure', 'blocked', 'blocked']);
  assert.match(await python().innerText(), /synthetic retry/);
  await screenshot('04-python-error', python());
  await python().getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByLabel('Python', { exact: true }).fill(code); await save(); await run(chart);
  checks.push('Python failure blocks downstream; edit and rerun recover');

  await page.reload({ waitUntil: 'networkidle' });
  await python().waitFor();
  await python().getByRole('button', { name: '查看Python', exact: true }).click();
  assert.match(await python().innerText(), /pd.DataFrame/);
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('05-python-mobile', python());
  checks.push('definition persists; narrow layout has no page overflow');
  assert.deepEqual(errors, []); assert.equal(modelCalls, 0);
  passed = true;
  console.log(JSON.stringify({ directory, checks, errors, modelCalls }));
} catch (error) {
  failure = String(error);
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, errors, modelCalls, requests }, null, 2));
  await browser.close();
}
