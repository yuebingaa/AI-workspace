// Existing dev service only. Isolated browser storage, synthetic CSV, mocked AI.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/notebook-code-cells-2026-09-15', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const results = [], errors = [], createdIds = new Set(); let fixtureCount = 0, blockedAi = 0;
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', async (response) => {
  if (response.url() === `${base}/api/datasets` && response.request().method() === 'POST' && response.ok()) {
    const body = await response.json().catch(() => null); if (body?.dataset?.datasetId) createdIds.add(body.dataset.datasetId);
  }
});
await page.route('**/api/ai/**', async (route) => { blockedAi++; await route.abort(); });
const editor = page.locator('.notebook-editor');
const query = () => page.getByRole('article', { name: 'SQL单元 地区销售汇总', exact: true });
const recipe = () => page.getByRole('article', { name: 'DataRecipe单元 规则代码汇总', exact: true });
const mode = (name) => page.getByRole('group', { name: 'Notebook 显示模式', exact: true }).getByRole('button', { name, exact: true });
const document = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')).dataProduct.notebooks)[0]);
async function step(label, fn) { console.log(label); await fn(); results.push(label); }
async function saved() { await editor.getByRole('button', { name: '保存单元', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); }
async function run(button) {
  const responsePromise = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await button.click(); const response = await responsePromise, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, 'success', JSON.stringify(body));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return body;
}
async function screenshot(name, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page must not overflow horizontally');
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}
async function requestDraft() {
  await page.getByRole('button', { name: '✧ AI 编写步骤', exact: true }).click();
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await page.locator('.notebook-draft').waitFor();
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
}
try {
  await step('Default steps view; code preference survives reload', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.equal(await mode('步骤').getAttribute('aria-pressed'), 'true');
    await mode('代码').click(); await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await mode('代码').getAttribute('aria-pressed'), 'true');
    await screenshot('01-empty-code');
  });
  await step('Import synthetic sales and create a real SQL code cell', async () => {
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'code-cell-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\nEast,100\nEast,50\nSouth,80\n') });
    await dialog.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const storageNotice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
    if (await storageNotice.isVisible()) await storageNotice.click();
    await page.getByRole('button', { name: '＋ Data', exact: true }).click();
    await editor.getByLabel('单元名称', { exact: true }).fill('销售原始数据');
    await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales');
    const source = await editor.getByLabel('数据源', { exact: true }).locator('option').evaluateAll((options) => options.find((item) => item.textContent.includes('code-cell-sales'))?.value);
    assert.ok(source); await editor.getByLabel('数据源', { exact: true }).selectOption(source); await saved();
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    await editor.getByLabel('单元名称', { exact: true }).fill('地区销售汇总');
    await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
    for (const checkbox of await editor.getByRole('checkbox').all()) await checkbox.check();
    await editor.getByLabel('SQL', { exact: true }).fill('SELECT region, SUM(amount) AS revenue\nFROM sales\nGROUP BY region\nORDER BY revenue DESC');
    assert.equal(await editor.locator('.notebook-code-gutter > span').count(), 4);
    await screenshot('02-sql-editor-desktop', editor); await saved();
    const body = await run(query().getByRole('button', { name: '▶ 运行', exact: true }));
    assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
    const sourceBox = await query().locator('.notebook-source:visible').boundingBox();
    const tableBox = await query().locator('table').first().boundingBox();
    assert.ok(tableBox.y >= sourceBox.y + sourceBox.height, 'Code output must be below the source');
    await screenshot('03-sql-output-desktop', query());
  });
  await step('Folding and switching views preserve definition and fresh results', async () => {
    const before = await document();
    await query().getByRole('button', { name: '收起SQL', exact: true }).click();
    assert.equal(await query().locator('.notebook-source:visible').count(), 0);
    assert.equal(await query().locator('table').count(), 1);
    await mode('步骤').click(); assert.equal(await page.locator('.notebook-cell .notebook-source:visible').count(), 0);
    await query().getByRole('button', { name: '查看SQL', exact: true }).click();
    assert.equal(await query().locator('.notebook-source:visible').count(), 1);
    assert.deepEqual(await document(), before);
    await mode('代码').click();
  });
  await step('DataRecipe JSON validates and round-trips with forms, then executes', async () => {
    await page.getByRole('button', { name: '＋ DataRecipe', exact: true }).click();
    await editor.getByLabel('单元名称', { exact: true }).fill('规则代码汇总');
    await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('recipe_totals');
    const source = (await document()).cells.find((cell) => cell.kind === 'data').id;
    await editor.getByLabel('上游输出', { exact: true }).selectOption(source);
    const code = editor.getByLabel('DataRecipe 规则代码', { exact: true });
    const before = await document(); await code.fill('[');
    await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    assert.match(await editor.getByRole('alert').innerText(), /JSON/);
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    assert.equal(await code.isVisible(), true); assert.deepEqual(await document(), before);
    const rules = [{ id: 'aggregate', type: 'groupAggregate', groupBy: ['region'], aggregations: [{ field: 'amount', aggregation: 'sum', as: 'revenue', label: '销售额' }] }];
    await code.fill(JSON.stringify(rules, null, 2)); await editor.getByRole('button', { name: '表单', exact: true }).click();
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.deepEqual(JSON.parse(await code.inputValue()), rules);
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    await editor.getByLabel('输出字段', { exact: true }).fill('total_revenue');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    rules[0].aggregations[0].as = 'total_revenue'; rules[0].aggregations[0].label = 'total_revenue';
    assert.deepEqual(JSON.parse(await code.inputValue()), rules);
    await screenshot('04-recipe-code-editor', editor); await saved();
    const body = await run(recipe().getByRole('button', { name: '▶ 运行', exact: true }));
    assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'East', total_revenue: 150 }, { region: 'South', total_revenue: 80 }]);
    await screenshot('05-recipe-result', recipe());
  });
  await step('Long SQL editor scrolls with its line gutter and cancel preserves results', async () => {
    // The recipe run refreshed shared upstream data, so rerun SQL before checking cancel.
    await run(query().getByRole('button', { name: '▶ 运行', exact: true }));
    const before = await document(); await query().getByRole('button', { name: '编辑', exact: true }).click();
    const code = editor.getByLabel('SQL', { exact: true });
    await code.fill(Array.from({ length: 100 }, (_, i) => `-- line ${i + 1}`).join('\n') + '\nSELECT ' + 'long_column_name_'.repeat(40));
    await code.evaluate((node) => { node.scrollTop = 500; node.scrollLeft = 250; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await page.waitForFunction(() => Math.abs(document.querySelector('.notebook-code-gutter').scrollTop - document.querySelector('.notebook-code-input textarea').scrollTop) < 2);
    assert.ok(await code.evaluate((node) => node.scrollTop > 0 && node.scrollLeft > 0));
    for (const [width, height] of [[1280, 720], [390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height }); await screenshot(`06-long-code-${width}`, editor);
      assert.ok((await code.boundingBox()).height < 500);
      await editor.getByRole('button', { name: '保存单元', exact: true }).scrollIntoViewIfNeeded();
      const button = await editor.getByRole('button', { name: '保存单元', exact: true }).boundingBox(); assert.ok(button.x >= 0 && button.x + button.width <= width);
    }
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await document(), before); assert.equal(await query().locator('table').count(), 1);
    await page.setViewportSize({ width: 1680, height: 1000 });
  });
  await step('Prepare an independent note and an explicit mocked AI draft', async () => {
    await page.getByRole('button', { name: '＋ 说明', exact: true }).click();
    await editor.getByLabel('单元名称', { exact: true }).fill('待移除说明');
    await editor.getByLabel('分析说明', { exact: true }).fill('旧说明'); await saved();
    await page.route('**/api/ai/harness/stream', async (route) => {
      fixtureCount++; const request = route.request().postDataJSON(), current = request.notebookContext.document;
      const cells = current.cells.filter((cell) => cell.title !== '待移除说明').map((cell) => cell.kind === 'sql' ? { ...cell, sql: cell.sql.replace('DESC', 'ASC') } : cell);
      cells.push({ id: 'review_note', kind: 'text', title: 'AI 建议说明', markdown: '合成数据：East 150，South 80。' });
      const timestamp = new Date().toISOString(), taskId = `harness_${request.idempotencyKey}`;
      const artifact = { id: `code_review_${fixtureCount}`, version: 1, status: 'draft', name: current.name, cells, baseRevision: current.revision,
        executionOrder: cells.map((cell) => cell.id), lineage: cells.map((cell) => ({ cellId: cell.id, dependsOn: cell.inputCellIds ?? (cell.inputCellId ? [cell.inputCellId] : []) })),
        sourceDataSourceIds: cells.filter((cell) => cell.kind === 'data').map((cell) => cell.sourceDataSourceId), createdAt: timestamp,
        executionEvidence: { runId: 'ui_fixture_only', status: 'success', completedCellIds: cells.map((cell) => cell.id), summary: 'UI fixture only; real execution verified separately.' } };
      const task = { id: taskId, idempotencyKey: request.idempotencyKey, instruction: request.instruction, pageId: request.pageId, role: 'editor', state: 'awaitingConfirmation', createdAt: timestamp, updatedAt: timestamp, events: [], counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 }, resultMessage: 'Notebook 草稿待采用。', notebookArtifact: artifact };
      const event = { id: `${taskId}:1`, sequence: 1, taskId, timestamp, type: 'completed', taskState: task.state, message: task.resultMessage };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: completed\ndata: ${JSON.stringify({ event, task })}\n\n` });
    });
  });
  await step('Review additions/removals/SQL changes; dismissal leaves document intact', async () => {
    const before = await document(); await requestDraft(); const draft = page.locator('.notebook-draft');
    await draft.locator('summary').click();
    const diff = draft.getByRole('article', { name: '草稿修改 地区销售汇总', exact: true });
    assert.match(await diff.locator('.notebook-source-line.removed').innerText(), /DESC/); assert.match(await diff.locator('.notebook-source-line.added').innerText(), /ASC/);
    assert.equal(await draft.getByRole('article', { name: '草稿移除 待移除说明', exact: true }).count(), 1);
    assert.equal(await draft.getByRole('article', { name: '草稿新增 AI 建议说明', exact: true }).count(), 1);
    assert.deepEqual(await document(), before); await screenshot('07-draft-desktop', diff);
    for (const [width, height] of [[390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height });
      const close = page.getByRole('button', { name: '关闭 AI 助手面板', exact: true }), box = await close.boundingBox();
      if (box && box.x >= 0 && box.x + box.width <= width) await close.click();
      await page.waitForFunction(() => document.querySelector('.assistant-panel-slot').getBoundingClientRect().left >= innerWidth);
      await screenshot(`08-draft-${width}`, diff);
    }
    await draft.getByRole('button', { name: '暂不采用', exact: true }).click();
    assert.deepEqual(await document(), before); await page.setViewportSize({ width: 1680, height: 1000 });
  });
  await step('Manual edits make the pending draft stale and disable adoption', async () => {
    await requestDraft(); await query().getByRole('button', { name: '编辑', exact: true }).click();
    const code = editor.getByLabel('SQL', { exact: true }); await code.fill(`${await code.inputValue()}\n-- manual revision`); await saved();
    const draft = page.locator('.notebook-draft');
    assert.equal(await draft.getByRole('button', { name: '采用草稿', exact: true }).isDisabled(), true);
    assert.match(await draft.innerText(), /版本|变化|修改/);
    assert.equal(await query().locator('table').count(), 0, 'Saved SQL changes invalidate its old result');
    await screenshot('09-stale-draft', draft); await draft.getByRole('button', { name: '暂不采用', exact: true }).click();
  });
  await step('Explicit adoption changes the notebook once, then runs real new SQL', async () => {
    const before = await document(); await requestDraft();
    await page.locator('.notebook-draft').getByRole('button', { name: '采用草稿', exact: true }).click();
    await page.locator('.notebook-draft').waitFor({ state: 'hidden' });
    await page.waitForFunction((revision) => Object.values(JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')).dataProduct.notebooks)[0].revision === revision + 1, before.revision);
    const after = await document(); assert.equal(after.cells.some((cell) => cell.title === '待移除说明'), false);
    assert.equal(after.cells.some((cell) => cell.title === 'AI 建议说明'), true);
    assert.equal(await query().locator('table').count(), 0, 'Mocked trial must not restore fake live results');
    const body = await run(query().getByRole('button', { name: '▶ 运行', exact: true }));
    assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'South', revenue: 80 }, { region: 'East', revenue: 150 }]);
    await screenshot('10-adopted-real-result', query());
    assert.equal(await page.getByText('对话上下文', { exact: true }).count(), 0);
    assert.equal(fixtureCount, 3); assert.equal(blockedAi, 0); assert.deepEqual(errors, []);
  });
  console.log('Passed:', directory);
} catch (error) {
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1;
} finally {
  for (const id of createdIds) await context.request.delete(`${base}/api/datasets/${encodeURIComponent(id)}`).catch(() => {});
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed: process.exitCode !== 1, completedSteps: results, pageErrors: errors, mockAiRequests: fixtureCount, blockedAiRequests: blockedAi, screenshots: directory }, null, 2));
  await browser.close();
}
