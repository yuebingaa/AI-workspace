// Runs only against the existing dev service. Uses an isolated browser context
// and synthetic data; deletes only the upload IDs created by this test.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:3001';
const directory = resolve('evidence', `notebook-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEBOOK_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(12_000);
const errors = [], createdIds = new Set(), results = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', async (response) => {
  if (response.request().method() !== 'POST' || !response.ok()) return;
  if (response.url() === `${base}/api/datasets`) { const body = await response.json().catch(() => null); if (body?.dataset?.datasetId) createdIds.add(body.dataset.datasetId); }
  if (response.url() === `${base}/api/notebook/run`) { const body = await response.json().catch(() => null); if (body?.snapshot?.dataset?.datasetId) createdIds.add(body.snapshot.dataset.datasetId); }
});
async function step(label, fn) { console.log(label); await fn(); results.push(label); }
async function addData(title, tableName, fileName) {
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  const editor = page.locator('.notebook-editor');
  await editor.getByLabel('单元名称', { exact: true }).fill(title);
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(tableName);
  const options = await editor.locator('select option').evaluateAll((nodes) => nodes.map((node) => ({ label: node.label, value: node.value })));
  await editor.getByLabel('数据源', { exact: true }).selectOption(options.find((option) => option.label.includes(fileName)).value);
  await editor.getByRole('button', { name: '保存单元', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
}
async function run(button) {
  const responsePromise = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45_000 });
  await button.click();
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, 'success', JSON.stringify(body));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  return body;
}
try {
  await step('Open a clean Notebook on dev', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.screenshot({ path: resolve(directory, '01-empty-desktop.png') });
  });
  await step('Import two synthetic CSV files with existing UI', async () => {
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type=file]').setInputFiles([
      { name: 'notebook-acceptance-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\nEast,100\nEast,50\nSouth,80\n') },
      { name: 'notebook-acceptance-rates.csv', mimeType: 'text/csv', buffer: Buffer.from('region,rate\nEast,2\nSouth,3\n') },
    ]);
    await dialog.getByRole('button', { name: '导入 2 份文件', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  });
  await step('Create and edit Data cells', async () => {
    await addData('销售数据', 'sales', 'sales'); await addData('地区系数', 'rates', 'rates');
  });
  await step('Create SQL cell and run a real two-table join', async () => {
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    const editor = page.locator('.notebook-editor');
    for (const checkbox of await editor.getByRole('checkbox').all()) await checkbox.check();
    await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('region_summary');
    await editor.getByLabel('SQL', { exact: true }).fill('SELECT s.region, COUNT(*) AS orders, SUM(s.amount * r.rate) AS revenue\nFROM sales s JOIN rates r ON s.region = r.region\nGROUP BY s.region\nORDER BY revenue DESC');
    await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    const body = await run(page.getByRole('button', { name: '▶ 全部运行', exact: true }));
    assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'East', orders: 2, revenue: 300 }, { region: 'South', orders: 1, revenue: 240 }]);
  });
  await step('Create chart, select measure, execute dependencies and inspect rendering', async () => {
    await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
    const editor = page.locator('.notebook-editor');
    await editor.getByLabel('单元名称', { exact: true }).fill('区域加权销售额');
    await editor.getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('revenue');
    await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    const chart = page.getByRole('article', { name: '图表单元 区域加权销售额', exact: true });
    await run(chart.getByRole('button', { name: '▶ 运行', exact: true }));
    assert.equal(await chart.locator('.recharts-bar-rectangle').count(), 2);
    await chart.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, '02-chart-desktop.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await step('Changing SQL invalidates only affected results', async () => {
    const query = page.getByRole('article', { name: 'SQL单元 SQL 数据分析', exact: true });
    await query.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.locator('.notebook-editor');
    await editor.getByLabel('SQL', { exact: true }).fill('SELECT s.region, COUNT(*) AS orders, SUM(s.amount * r.rate) AS revenue\nFROM sales s JOIN rates r ON s.region = r.region\nGROUP BY s.region\nORDER BY revenue ASC');
    await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    const chart = page.getByRole('article', { name: '图表单元 区域加权销售额', exact: true });
    assert.match(await chart.innerText(), /已失效/);
    assert.equal(await chart.locator('table').count(), 0);
    assert.match(await page.getByRole('article', { name: 'Data单元 销售数据', exact: true }).innerText(), /✓/);
    await run(chart.getByRole('button', { name: '▶ 运行', exact: true }));
  });
  await step('Generate a dashboard preview without modifying formal nodes', async () => {
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
    const chart = page.getByRole('article', { name: '图表单元 区域加权销售额', exact: true });
    const response = await run(chart.getByRole('button', { name: '生成看板预览 ↗', exact: true }));
    assert.ok(response.snapshot.dataset.datasetId);
    assert.equal(await page.getByRole('tab', { name: '看板', exact: true }).getAttribute('aria-selected'), 'true');
    const updated = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
    assert.deepEqual(updated.appSpec.pages, original.appSpec.pages);
    await page.screenshot({ path: resolve(directory, '03-dashboard-preview.png') });
    await page.getByRole('button', { name: '应用编辑', exact: true }).click();
    const confirmed = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
    assert.notDeepEqual(confirmed.appSpec.pages, original.appSpec.pages);
    assert.match(JSON.stringify(confirmed.appSpec.pages), /区域加权销售额/);
  });
  await step('Persist definitions across reload; never restore stale results as successful', async () => {
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('tab', { name: 'Notebook', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.notebook-cell').count(), 4);
    assert.equal(await page.locator('.notebook-cell table').count(), 0);
    await run(page.getByRole('button', { name: '▶ 全部运行', exact: true }));
  });
  await step('Scripted SSE UI fixture: verify Notebook context, draft review and explicit adoption', async () => {
    // Tests the browser contract only. Actual Harness + SQL execution is tested
    // separately in core/harness/notebook.test.ts; no external model is called.
    let requestedRevision;
    await page.route('**/api/ai/harness/stream', async (route) => {
      const request = route.request().postDataJSON();
      assert.equal(request.notebookContext.document.cells.length, 4);
      requestedRevision = request.notebookContext.document.revision;
      const timestamp = new Date().toISOString(), taskId = `harness_${request.idempotencyKey}`;
      const cells = [...request.notebookContext.document.cells, { id: 'qa_note', title: '分析结论草稿', kind: 'text', markdown: '合成数据验证：East 为 300，South 为 240。' }];
      const artifact = { id: 'notebook_qa_draft', version: 1, status: 'draft', name: '区域销售分析', cells,
        executionOrder: cells.map((cell) => cell.id), lineage: cells.map((cell) => ({ cellId: cell.id, dependsOn: cell.inputCellIds ?? (cell.inputCellId ? [cell.inputCellId] : []) })),
        sourceDataSourceIds: cells.filter((cell) => cell.kind === 'data').map((cell) => cell.sourceDataSourceId), createdAt: timestamp, baseRevision: requestedRevision,
        executionEvidence: { runId: 'ui_fixture_only', status: 'success', completedCellIds: cells.map((cell) => cell.id), summary: 'UI 测试夹具；真实执行另有集成测试。' } };
      const task = { id: taskId, idempotencyKey: request.idempotencyKey, instruction: request.instruction, pageId: request.pageId,
        role: 'editor', state: 'awaitingConfirmation', createdAt: timestamp, updatedAt: timestamp, events: [], counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 },
        resultMessage: 'Notebook 草稿待采用，正式看板未修改。', notebookArtifact: artifact };
      const event = { id: `${taskId}:1`, sequence: 1, taskId, timestamp, type: 'completed', taskState: task.state, message: task.resultMessage };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: completed\ndata: ${JSON.stringify({ event, task })}\n\n` });
    });
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
    await page.getByRole('button', { name: '✧ AI 编写步骤', exact: true }).click();
    await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
    await page.getByRole('button', { name: '采用草稿', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const draft = page.locator('.notebook-draft');
    await draft.locator('summary').click(); await draft.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, '05-ai-draft-review.png') });
    assert.equal(await page.locator('.notebook-cell').count(), 4);
    await draft.getByRole('button', { name: '采用草稿', exact: true }).click();
    await draft.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.notebook-cell').count(), 5);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
    assert.deepEqual(after.appSpec.pages, before.appSpec.pages);
    assert.equal(Object.values(after.dataProduct.notebooks)[0].revision, requestedRevision + 1);
    await run(page.getByRole('button', { name: '▶ 全部运行', exact: true }));
    await page.unroute('**/api/ai/harness/stream');
  });
  await step('Verify a narrow viewport and dependency-aware delete confirmation', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const left = document.querySelector('.pages-panel-slot')?.getBoundingClientRect();
      const right = document.querySelector('.assistant-panel-slot')?.getBoundingClientRect();
      return left && right && left.right <= 0 && right.left >= innerWidth;
    });
    const chart = page.getByRole('article', { name: '图表单元 区域加权销售额', exact: true });
    await chart.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, '04-chart-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const data = page.getByRole('article', { name: 'Data单元 销售数据', exact: true });
    await data.getByRole('button', { name: '删除', exact: true }).click();
    assert.match(await data.locator('.notebook-delete').innerText(), /2 个依赖/);
    await data.getByRole('button', { name: '保留', exact: true }).click();
    assert.equal(await page.locator('.notebook-cell').count(), 5);
  });
  assert.deepEqual(errors, []);
  console.log('Notebook browser acceptance passed:', directory);
} catch (error) {
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ completedSteps: results, pageErrors: errors, passed: process.exitCode !== 1 }, null, 2));
  for (const id of createdIds) await context.request.delete(`${base}/api/datasets/${encodeURIComponent(id)}`).catch(() => {});
  await browser.close();
}
