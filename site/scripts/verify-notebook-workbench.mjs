// Existing 3001 only; run-owned local project, synthetic data, no remote database or model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chooseUiOption } from './fixtures/ui-controls.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/notebook-workbench-20260927', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, base, projectPath, checks: [], screenshots: [], pageErrors: [], blocked: [], runs: [], aiFixtures: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on('pageerror', error => report.pageErrors.push(error.message));
let handle, stalled = false, release;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  try {
    assert.equal(url.origin, base, 'External requests prohibited');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()['x-agentcanvas-project'];
    if (method === 'POST' && url.pathname === '/api/ai/dsh/conversation/stream') {
      assert.equal(scope, handle); assert.ok(handle);
      const input = request.postDataJSON(), document = input.notebookContext.document;
      const number = report.aiFixtures.length + 1, now = new Date().toISOString();
      const cells = document.cells.map(cell => cell.kind === 'chart' ? { ...cell, chartType: number === 1 ? 'line' : 'bar' } : cell);
      const artifact = { id: `draft_workbench_${number}`, version: 1, status: 'draft', name: document.name,
        baseRevision: document.revision, cells, executionOrder: cells.map(cell => cell.id),
        lineage: cells.map(cell => ({ cellId: cell.id, dependsOn: cell.inputCellIds ?? (cell.inputCellId ? [cell.inputCellId] : []) })),
        sourceDataSourceIds: cells.filter(cell => cell.kind === 'data').map(cell => cell.sourceDataSourceId), createdAt: now,
        executionEvidence: { runId: `synthetic_prior_trial_${number}`, status: 'success', completedCellIds: cells.map(cell => cell.id), summary: '明确的合成 Agent 试运行证据；页面预览使用真实 Notebook API。' } };
      const task = { id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey, instruction: input.instruction, pageId: input.pageId,
        role: 'editor', state: 'awaitingConfirmation', createdAt: now, updatedAt: now, events: [], trace: [],
        counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, notebookArtifact: artifact,
        resultMessage: '合成 Agent 修改已准备好，请预览并确认；没有调用真实模型。', verification: { attempt: 1, status: 'passed', checks: [], issues: [], evidenceToolCallIds: [] } };
      const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', message: task.resultMessage, taskState: task.state };
      task.trace.push(event); report.aiFixtures.push({ taskId: task.id, artifactId: artifact.id, synthetic: true });
      return route.fulfill({ contentType: 'text/event-stream', body: `event: completed\ndata: ${JSON.stringify({ event, task })}\n\n` });
    }
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && !scope && url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
    if (method === 'GET' && !scope && url.pathname === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON()?.action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath);
      const response = await route.fetch(); assert.equal(response.status(), 200, await response.text());
      handle = (await response.json()).handle; assert.ok(handle);
      return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') {
      assert.ok(handle && handle === scope, 'Request outside run-owned project');
      if (url.pathname === '/api/notebook/run' && stalled) {
        await new Promise(done => { release = done; });
        return route.abort('aborted');
      }
      return route.continue();
    }
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    throw new Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
const editor = () => page.locator('.notebook-editor');
const query = () => page.getByRole('article', { name: 'SQL单元 季度销售汇总', exact: true });
const chart = () => page.getByRole('article', { name: '图表单元 季度销售趋势', exact: true });
async function menu(label) {
  const notices = page.getByRole('button', { name: '知道了', exact: true });
  while (await notices.count()) await notices.first().click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await nav.getByRole('textbox').fill(label); await nav.getByRole('button', { name: label, exact: true }).click();
}
async function shot(file, scenario, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const bounds = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }));
  assert.ok(bounds.overflow <= 1, JSON.stringify(bounds));
  const conversationTitlesFit = await page.locator('.conversation-switch-trigger').evaluateAll(elements => elements.every(element => {
    const rect = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
    return !rect.width || rect.right <= parent.right + 1;
  }));
  assert.ok(conversationTitlesFit, 'Long conversation title must not cover adjacent assistant controls');
  await page.screenshot({ path: join(directory, file + '.png'), animations: 'disabled' });
  report.screenshots.push({ file: file + '.png', scenario, bounds, visuallyReviewed: false });
}
async function check(name, action) { console.log(name); await action(); report.checks.push(name); }
async function saved() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('.notebook-output-rename-confirmation'));
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true });
  if (await rename.isVisible()) await rename.click();
  await editor().waitFor({ state: 'hidden' });
}
async function definition() {
  const response = await context.request.get(base + '/api/projects', { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); const state = (await response.json()).manifest.state;
  return Object.values(state.dataProduct.notebooks)[0];
}
async function run(button, expected = 'success') {
  const promise = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 45000 });
  await button.click(); const response = await promise, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, expected, JSON.stringify(body));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.runs.push({ status: body.run.status, action: response.request().postDataJSON().action, cells: body.run.cells.map(cell => ({ id: cell.cellId, status: cell.status, rows: cell.table?.rows.length })) });
  return body;
}
async function selectField(label, name) {
  await editor().getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('combobox', { name: `搜索${label}`, exact: true }).fill(name);
  await page.getByRole('option').filter({ hasText: name }).first().click();
}
const sql = 'SELECT quarter, SUM(amount) AS revenue, SUM(cost) AS cost, COUNT(*) AS accounts\nFROM sales\nGROUP BY quarter\nORDER BY quarter';
try {
  await check('Create isolated project and import 72 synthetic sales rows', async () => {
    await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 }); await menu('数据浏览器');
    const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
    await data.getByRole('button', { name: /项目文件夹/u }).first().click();
    await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
    await data.getByLabel('项目名称', { exact: true }).fill('Notebook 组件隔离验收');
    await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
    await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    const rows = Array.from({ length: 24 }, (_, index) => ['企业客户', '成长客户', '小型客户'].map((segment, i) => `${2020 + Math.floor(index / 4)} Q${index % 4 + 1},${segment},${(index + 1) * (i + 1) * 900},${(index + 1) * (i + 1) * 500}`)).flat();
    await upload.locator('input[type=file]').setInputFiles({ name: 'workbench-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('quarter,segment,amount,cost\n' + rows.join('\n') + '\n') });
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
    await page.getByRole('button', { name: '＋ Data', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('销售明细');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales'); await saved();
  });
  await check('CodeMirror edits Chinese comments, undo, completion and search; SQL executes', async () => {
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('季度销售汇总');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
    for (const checkbox of await editor().getByRole('checkbox').all()) await checkbox.check();
    const code = editor().getByRole('textbox', { name: 'SQL', exact: true });
    await code.fill(sql); await code.press('Control+End'); await page.keyboard.insertText('\n-- 中文编辑验收');
    assert.ok((await code.innerText()).includes('中文编辑验收')); await code.press('Control+z'); assert.ok(!(await code.innerText()).includes('中文编辑验收'));
    await code.fill('SELECT * FROM sa'); await code.press('Control+End'); await code.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor(); assert.ok((await page.locator('.cm-tooltip-autocomplete').innerText()).includes('sales'));
    await code.press('Escape'); await code.fill(sql); await code.press('Control+f'); await editor().locator('.cm-search').waitFor();
    await shot('01a-sql-search-panel', 'Compact CodeMirror search/replace toolbar with checkboxes aligned correctly.', editor());
    await editor().locator('.cm-search button[name="close"]').click(); await editor().locator('.cm-search').waitFor({ state: 'hidden' });
    assert.ok(await editor().locator('.cm-gutterElement').count() > 1);
    await shot('01-sql-editor-1680', 'CodeMirror, editable SQL with syntax highlighting, line numbers and context-aware completion.', editor());
    await saved(); const body = await run(query().getByRole('button', { name: '▶ 运行', exact: true }));
    assert.deepEqual(body.run.cells.at(-1).table.rows[0], { quarter: '2020 Q1', revenue: 5400, cost: 3000, accounts: 3 });
    assert.equal(body.run.cells.at(-1).table.rows.length, 24);
  });
  await check('TanStack search/pagination, column visibility/resize and CSV scope', async () => {
    const before = await definition(), search = query().getByRole('searchbox');
    await query().getByRole('button', { name: '下一页结果', exact: true }).click(); assert.ok((await query().innerText()).includes('预览 2 / 2'));
    await search.fill('2025 Q4'); assert.equal(await query().locator('tbody tr').count(), 1);
    await query().getByRole('button', { name: /列设置/u }).click(); const columns = page.getByRole('dialog', { name: '季度销售汇总列设置', exact: true });
    await columns.getByRole('checkbox').last().uncheck(); await page.keyboard.press('Escape');
    assert.equal(await query().locator('thead th').count(), 3);
    const resize = query().getByRole('button', { name: '调整quarter列宽', exact: true });
    const start = await query().locator('thead th').first().boundingBox(); await resize.focus(); await resize.press('ArrowRight');
    const after = await query().locator('thead th').first().boundingBox(); assert.ok(after.width > start.width);
    const downloadPromise = page.waitForEvent('download'); await query().getByRole('button', { name: '导出当前预览 CSV', exact: true }).click();
    const download = await downloadPromise; await download.saveAs(join(directory, 'preview.csv'));
    const csv = await readFile(join(directory, 'preview.csv'), 'utf8'); assert.equal(csv.trim().split(/\r?\n/u).length, 25); assert.ok(csv.includes('accounts'));
    await shot('02-table-filter-columns-1680', 'Search matches one returned row; three visible columns; CSV retains all 24 returned rows and all fields.', query());
    await search.fill('不存在的值'); await query().getByText('没有匹配的行，试试其他关键词。', { exact: true }).waitFor();
    await shot('03-table-no-match', 'Search empty state, reset available.', query());
    await query().getByRole('button', { name: '清除搜索', exact: true }).click();
    await query().getByRole('button', { name: /列设置/u }).click(); await columns.getByRole('button', { name: '恢复全部列与默认宽度', exact: true }).click(); await page.keyboard.press('Escape');
    assert.deepEqual(await definition(), before);
  });
  await check('Chart field search, live preview, validation, cancellation and save', async () => {
    await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('季度销售趋势');
    const doc = await definition(), queryId = doc.cells.find(cell => cell.title === '季度销售汇总').id;
    await chooseUiOption(page, editor().getByLabel('上游输出', { exact: true }), queryId);
    await selectField('分类字段', 'quarter');
    await selectField('添加数值字段', 'cost'); await editor().getByRole('button', { name: '面积图', exact: true }).click();
    await editor().locator('.recharts-area').first().waitFor();
    await shot('04-chart-builder-1680', 'Searchable fields, selectable chart types and live preview from fresh upstream rows.', editor());
    const formal = await definition(); await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); assert.deepEqual(await definition(), formal);
    const newChartId = formal.cells.find(cell => cell.kind === 'chart').id;
    await page.locator(`[data-cell-kind="chart"]`).getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('季度销售趋势'); await chooseUiOption(page, editor().getByLabel('上游输出', { exact: true }), queryId);
    for (const remove of await editor().getByRole('button', { name: /移除数值字段/u }).all()) await remove.click();
    await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').waitFor();
    await shot('05-chart-required-error', 'Missing numeric selection rejected; draft remains editable.', editor());
    await selectField('添加数值字段', 'revenue'); await selectField('添加数值字段', 'cost');
    await editor().getByRole('button', { name: '面积图', exact: true }).click(); await saved();
    const body = await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); assert.equal(body.run.cells.at(-1).cellId, newChartId);
    assert.equal(body.run.cells.at(-1).table.rows.length, 24);
    await chart().getByRole('button', { name: '编辑', exact: true }).click();
    await page.setViewportSize({ width: 1024, height: 1000 }); await shot('06-chart-builder-1024', 'Desktop minimum-width layout, field controls and preview remain usable.', editor());
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await page.setViewportSize({ width: 1680, height: 1080 });
  });
  await check('Real SQL failure, recovery and explicitly stalled cancellation', async () => {
    const baseline = await definition();
    await query().getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('renamed_totals');
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    await page.getByRole('region', { name: '确认输出变量改名', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false');
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); assert.deepEqual(await definition(), baseline);
    await query().getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByRole('textbox', { name: 'SQL', exact: true }).fill('SELECT missing_column FROM sales'); await saved();
    await run(query().getByRole('button', { name: '▶ 运行', exact: true }), 'failure'); await shot('07-sql-failure', 'Real invalid-column SQL failure; no stale table promoted to success.', query());
    await query().getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByRole('textbox', { name: 'SQL', exact: true }).fill(sql); await saved();
    await run(query().getByRole('button', { name: '▶ 运行', exact: true }));
    stalled = true; await query().getByRole('button', { name: '▶ 运行', exact: true }).click();
    await page.getByRole('button', { name: '停止运行', exact: true }).click(); release?.(); stalled = false;
    await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
    await shot('08-run-cancelled', 'Explicitly stalled HTTP request cancelled; controls recover.', query());
    await run(chart().getByRole('button', { name: '▶ 运行', exact: true }));
  });
  await check('Save Dataset, reload same project, rerun persisted chart', async () => {
    const body = await run(chart().getByRole('button', { name: '保存为 Dataset', exact: true })); assert.ok(body.snapshot?.dataset);
    const before = await definition(); assert.equal(before.cells.find(cell => cell.kind === 'chart').chartType, 'area');
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.deepEqual(await definition(), before);
    await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await shot('09-reopened-chart-dataset', 'Persisted project reopens; SQL and chart execute again; Dataset saved via existing real API.', chart());
  });
  await check('Official Agent fixture previews via real SQL; confirm and undo preserve document rules', async () => {
    const before = await definition();
    const frame = page.frameLocator('iframe[title="官方 DSH 聊天"]');
    const compose = frame.locator('[data-composer-input="true"]');
    async function sendFixture() {
      await compose.waitFor(); await compose.fill('合成验收：请调整当前图表类型，保留数据和 SQL。');
      const promise = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 45000 });
      await compose.press('Enter'); const response = await promise, body = await response.json();
      assert.equal(body.run.status, 'success', JSON.stringify(body));
      await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
      report.runs.push({ status: body.run.status, action: 'synthetic-agent-real-preview', cells: body.run.cells.map(cell => ({ id: cell.cellId, status: cell.status })) });
    }
    await sendFixture(); assert.deepEqual(await definition(), before);
    const draft = page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
    await shot('10-agent-pending-confirmation', 'Explicit synthetic Agent reply; real SQL preview succeeds but formal project remains unchanged.', draft);
    await draft.getByRole('button', { name: '确认更改', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
    let adopted;
    for (let i = 0; i < 100; i++) { adopted = await definition(); if (adopted.cells.find(cell => cell.kind === 'chart').chartType === 'line') break; await page.waitForTimeout(100); }
    assert.equal(adopted.cells.find(cell => cell.kind === 'chart').chartType, 'line');
    await sendFixture(); await draft.getByRole('button', { name: '撤销预览', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
    assert.deepEqual(await definition(), adopted);
    await shot('11-agent-preview-undone', 'Second synthetic change withdrawn; confirmed line chart and saved document retained.', chart());
  });
  assert.deepEqual(report.blocked, []); assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); console.error(report.failure);
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  release?.(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, blocked: report.blocked, pageErrors: report.pageErrors }));
  await browser.close();
}
