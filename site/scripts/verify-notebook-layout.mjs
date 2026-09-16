// Managed dev service; isolated storage and synthetic files. No model or account writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/notebook-layout-2026-09-15', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], checks = [], screenshots = [], createdIds = new Set();
let aiRequests = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/ai/**', route => { aiRequests++; return route.abort(); });
await context.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: { projects: [] } }) : route.abort());
await context.route('**/api/connections', route => route.request().method() === 'GET' ? route.fulfill({ json: { connections: [] } }) : route.abort());
page.on('response', async response => {
  if (!response.ok() || response.request().method() !== 'POST') return;
  const body = await response.json().catch(() => null);
  const id = body?.dataset?.datasetId ?? body?.snapshot?.dataset?.datasetId;
  if (id) createdIds.add(id);
});
const notebook = page.getByRole('region', { name: 'Notebook 分析文档' });
async function capture(name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: viewport width`);
  assert.equal(await page.locator('.conversation-heading').count(), 0, 'Removed context toolbar stays removed');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push(name);
}
async function save() {
  await page.locator('.notebook-editor').getByRole('button', { name: '保存单元', exact: true }).click();
  await page.locator('.notebook-editor').waitFor({ state: 'hidden' });
}
async function run(button) {
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await button.click();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, 'success', JSON.stringify(body));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  return body;
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await notebook.locator('.notebook-title').click();
  await page.getByLabel('分析文档名称', { exact: true }).fill('销售渠道分析');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await notebook.locator('.notebook-title').innerText(), '销售渠道分析');
  await notebook.locator('.notebook-title').click();
  await page.getByLabel('分析文档名称', { exact: true }).fill('取消的名称');
  await page.keyboard.press('Escape');
  assert.equal(await notebook.locator('.notebook-title').innerText(), '销售渠道分析');
  checks.push('Title persists through reload; Escape cancels renaming');

  for (const [width, height] of [[1680,1000], [1440,900], [1280,720], [1024,900]]) {
    await page.setViewportSize({ width, height });
    await notebook.evaluate(el => { el.scrollTop = 0; });
    await capture(`empty-${width}`);
    assert.equal(await notebook.locator('.notebook-add button').count(), 9);
    await notebook.getByRole('group', { name: '添加分析单元' }).scrollIntoViewIfNeeded();
    assert(await notebook.getByRole('button', { name: '＋ Data', exact: true }).isVisible());
  }
  checks.push('Empty layout and insert tools at four desktop sizes');
  await page.setViewportSize({ width: 1680, height: 1000 });
  const question = page.getByRole('textbox', { name: 'Notebook 分析问题', exact: true });
  const prompt = page.getByRole('textbox', { name: 'AI 指令', exact: true });
  assert.equal(await question.getAttribute('maxlength'), '1000');
  await question.fill('分析各地区收入，并绘制柱状图');
  await page.getByRole('button', { name: '在 AI 助手中继续', exact: true }).click();
  assert.equal(await prompt.inputValue(), '分析各地区收入，并绘制柱状图');
  await page.waitForFunction(() => document.activeElement === document.querySelector('textarea[aria-label="AI 指令"]'));
  assert(await prompt.evaluate(el => el === document.activeElement));
  await prompt.fill('保留我正在编辑的问题');
  assert.equal(await question.inputValue(), '保留我正在编辑的问题');
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  assert.equal(await question.inputValue(), '保留我正在编辑的问题');
  await page.setViewportSize({ width: 1024, height: 900 });
  await question.fill('在桌面侧栏继续分析地区收入');
  await page.getByRole('button', { name: '在 AI 助手中继续', exact: true }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector('textarea[aria-label="AI 指令"]'));
  assert.equal(await prompt.inputValue(), '在桌面侧栏继续分析地区收入');
  await capture('desktop-question-assistant');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  assert.equal(await question.inputValue(), '在桌面侧栏继续分析地区收入');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.setViewportSize({ width: 1680, height: 1000 });
  await prompt.fill('');
  checks.push('Question shares the AI draft across modes; desktop sidebar restores focus and draft without sending');

  await notebook.locator('.notebook-data-options').getByRole('button', { name: /数据库连接/ }).click();
  assert.equal(await notebook.locator('.notebook-connections').getAttribute('open'), '');
  await capture('connection-entry');
  await notebook.locator('.notebook-connections > summary').click();
  await notebook.locator('.notebook-data-options').getByRole('button', { name: /浏览数据/ }).click();
  await page.locator('.data-browser').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.data-browser').waitFor({ state: 'hidden' });
  checks.push('Connection and data browser entries open the existing working panels');

  await notebook.locator('.notebook-data-options').getByRole('button', { name: /上传文件/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles([
    { name: 'layout-targets.csv', mimeType: 'text/csv', buffer: Buffer.from('region,target\nEast,180\nSouth,100\n') },
    { name: 'layout-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\nEast,100\nEast,50\nSouth,80\n') },
  ]);
  await dialog.getByRole('button', { name: '导入 2 份文件', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const dismiss = page.getByRole('button', { name: '知道了', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await capture('available-data');
  await notebook.locator('.notebook-source-shortcuts').getByRole('button', { name: /layout-sales/ }).click();
  assert.match(await page.locator('.notebook-editor select option:checked').innerText(), /layout-sales/);
  await page.locator('.notebook-editor').getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales');
  await save();
  checks.push('New upload entry imports two real synthetic files; shortcut selects the chosen source');

  await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('单元名称', { exact: true }).fill('地区收入汇总');
  await page.getByLabel('SQL', { exact: true }).fill('SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC');
  await save();
  const sql = page.getByRole('article', { name: 'SQL单元 地区收入汇总', exact: true });
  const body = await run(sql.getByRole('button', { name: '▶ 运行', exact: true }));
  assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
  await sql.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('搜索输入字段', { exact: true }).fill('amount');
  assert.equal(await sql.locator('.notebook-fields li').count(), 1);
  await page.getByLabel('搜索输入字段', { exact: true }).fill('');
  assert(await sql.getByText('已保存步骤的运行结果', { exact: true }).isVisible());
  for (const [width, height] of [[1680,1000], [1280,900], [1024,900]]) {
    await page.setViewportSize({ width, height });
    await sql.scrollIntoViewIfNeeded();
    await capture(`sql-edit-${width}`);
    const left = await sql.locator('.notebook-cell-definition').boundingBox();
    const right = await sql.locator('.notebook-cell-output').boundingBox();
    assert(left.x + left.width <= right.x + 1 || left.y + left.height <= right.y + 1, 'Configuration/result panels do not overlap');
  }
  await save();
  checks.push('Actual SQL yields 150/80; input fields search works; editing and saved results fit wide and narrow panels');

  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('单元名称', { exact: true }).fill('地区销售额');
  await save();
  const chart = page.getByRole('article', { name: '图表单元 地区销售额', exact: true });
  await run(chart.getByRole('button', { name: '▶ 运行', exact: true }));
  assert.equal(await chart.locator('.recharts-bar-rectangle').count(), 2);
  await chart.getByRole('button', { name: '编辑', exact: true }).click();
  await capture('chart-workbench');
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await notebook.getByRole('button', { name: '＋ 添加分析说明', exact: true }).click();
  await page.getByLabel('分析说明', { exact: true }).fill('统计本次导入数据的地区收入。');
  await save();
  await page.reload({ waitUntil: 'networkidle' });
  assert(await notebook.getByText('统计本次导入数据的地区收入。', { exact: true }).isVisible());
  assert.equal(await notebook.locator('.notebook-cell').count(), 4);
  checks.push('Chart and table render together; add-description creates a persisted text step');
  assert.equal(aiRequests, 0);
  assert.deepEqual(errors, []);
  console.log('Notebook layout verification passed:', directory);
} catch (error) {
  console.error(error);
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  for (const id of createdIds) await context.request.delete(`${base}/api/datasets/${encodeURIComponent(id)}`).catch(() => {});
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed: process.exitCode !== 1, checks, screenshots, errors, aiRequests }, null, 2));
  await browser.close();
}
