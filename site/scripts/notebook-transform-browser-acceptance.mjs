// Existing managed development service only; isolated browser and synthetic CSV.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:3001';
const directory = resolve('evidence', `notebook-transform-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEBOOK_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], createdIds = new Set(), completed = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/ai/**', (route) => route.abort());
page.on('response', async (response) => {
  if (response.request().method() !== 'POST' || !response.ok()) return;
  const body = await response.json().catch(() => null);
  const id = body?.dataset?.datasetId ?? body?.snapshot?.dataset?.datasetId;
  if (id) createdIds.add(id);
});
async function save() { await page.locator('.notebook-editor').getByRole('button', { name: '保存单元', exact: true }).click(); await page.locator('.notebook-editor').waitFor({ state: 'hidden' }); }
async function run(button) {
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await button.click(); const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, 'success', JSON.stringify(body));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return body;
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await page.locator('.notebook-connections summary').click();
  assert.match(await page.locator('.notebook-connections').innerText(), /数据库连接/);
  await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'recipe-browser-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\nEast,100\nEast,50\nSouth,80\n') });
  await dialog.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const dismiss = page.getByRole('button', { name: '知道了', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales'); await save();
  await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('SQL', { exact: true }).fill('SELECT region, amount FROM sales');
  await save(); await run(page.getByRole('button', { name: '▶ 全部运行', exact: true }));
  completed.push('Imported synthetic data and ran actual DuckDB SQL');

  await page.getByRole('button', { name: '＋ DataRecipe', exact: true }).click();
  const editor = page.locator('.notebook-editor');
  await editor.getByLabel('单元名称', { exact: true }).fill('地区汇总配方');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
  await editor.getByRole('button', { name: '＋ 添加处理步骤', exact: true }).click();
  await editor.getByLabel('步骤 2 类型', { exact: true }).selectOption('groupAggregate');
  await editor.getByLabel('分组字段（逗号分隔）', { exact: true }).fill('region');
  await editor.getByLabel('汇总字段', { exact: true }).fill('amount');
  await editor.getByLabel('输出字段', { exact: true }).fill('revenue');
  await editor.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(directory, '01-recipe-editor.png') });
  await save();
  const recipe = page.getByRole('article', { name: 'DataRecipe单元 地区汇总配方', exact: true });
  const recipeRun = await run(recipe.getByRole('button', { name: '▶ 运行', exact: true }));
  assert.deepEqual(recipeRun.run.cells.at(-1).table.rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
  completed.push('Edited a DataRecipe through the UI and aggregated complete SQL output');

  await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('单元名称', { exact: true }).fill('配方销售额'); await save();
  const chart = page.getByRole('article', { name: '图表单元 配方销售额', exact: true });
  const chartRun = await run(chart.getByRole('button', { name: '▶ 运行', exact: true }));
  assert.equal(await chart.locator('.recharts-bar-rectangle').count(), 2);
  assert.deepEqual(chartRun.run.cells.at(-1).resultRef.inputResultIds, [chartRun.run.cells.at(-2).resultRef.resultId]);
  await chart.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(directory, '02-recipe-chart.png') });
  completed.push('Rendered chart directly from DataRecipe with matching result lineage');

  await run(recipe.getByRole('button', { name: '▶ 运行', exact: true }));
  assert.match(await chart.innerText(), /已失效/);
  assert.equal(await chart.locator('table').count(), 0);
  completed.push('Rerunning unchanged upstream invalidates the old chart');
  const saved = await run(recipe.getByRole('button', { name: '保存为 Dataset', exact: true }));
  assert.equal(saved.snapshot.rows.length, 2); assert.equal(saved.snapshot.dataset.provenance.cellId, recipeRun.run.cells.at(-1).cellId);
  assert.equal(await page.getByRole('tab', { name: 'Notebook', exact: true }).getAttribute('aria-selected'), 'true');
  completed.push('Saved a Dataset without switching to or modifying the dashboard');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const left = document.querySelector('.pages-panel-slot')?.getBoundingClientRect();
    const right = document.querySelector('.assistant-panel-slot')?.getBoundingClientRect();
    return left && right && left.right <= 0 && right.left >= innerWidth;
  });
  await recipe.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.notebook-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(directory, '03-recipe-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.notebook-editor').evaluate((editor) => {
    const boxes = [...editor.querySelectorAll('input, select, button')].map((item) => item.getBoundingClientRect()).filter((box) => box.width && box.height);
    return boxes.some((a, index) => boxes.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
  }), false, 'Mobile form controls must not overlap');
  assert.deepEqual(errors, []); completed.push('Mobile editor fits the viewport with no page errors');
  console.log('Notebook transform browser acceptance passed:', directory);
} catch (error) {
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ completed, pageErrors: errors, passed: process.exitCode !== 1 }, null, 2));
  for (const id of createdIds) await context.request.delete(`${base}/api/datasets/${encodeURIComponent(id)}`).catch(() => {});
  await browser.close();
}
