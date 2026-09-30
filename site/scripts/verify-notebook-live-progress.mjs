// Managed 3001; owned synthetic Excel project. Explicit gated SSE fixtures, real SQL/chart execution.
// Does not call a model, touch other projects, change settings or manage services.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import writeXlsxFile from 'write-excel-file/node';

assert.equal(process.argv.length, 2);
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/notebook-live-progress-20260928', `browser-${Date.now()}`), projectPath = join(directory, 'project');
const report = { passed: false, checks: [], screenshots: [], runs: [], errors: [], blocked: [], timings: [],
  boundaries: ['Owned synthetic XLSX only; no paid models, external databases or user projects.',
    'Browser SSE is a gated fixture; SQL/chart outputs come from real Notebook API. AI-mode reference conversion is fixture-only.',
    'Fixture timings include deliberate verification pauses and are not model latency measurements.',
    'Real AI-mode per-cell server/SSE transport is separately covered by integration tests.'] };
await mkdir(directory, { recursive: true });
const workbook = await writeXlsxFile([{ sheet: 'Stations', data: [
  [{ value: 'station', type: String }, { value: 'seconds', type: String }],
  ...Array.from({ length: 24 }, (_, i) => [{ value: `Station-${String(i % 12 + 1).padStart(2, '0')}`, type: String }, { value: (i % 12 + 1) * 10, type: Number }]),
] }]).toBuffer();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
let handle, pageId, sourceId, dashboard, created = 0;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()[header];
    if (scope) assert.equal(scope, handle);
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && url.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON().action === 'create') {
      assert.equal(++created, 1); assert.equal(request.postDataJSON().path, projectPath);
      const response = await route.fetch(); assert.equal(response.status(), 200); handle = (await response.json()).handle; return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') {
      assert.ok(handle && scope === handle);
      if (url.pathname === '/api/notebook/run') {
        const response = await route.fetch({ timeout: 45000 }), body = await response.json();
        assert.equal(response.status(), 200, JSON.stringify(body)); report.runs.push({ automatic: true, run: body.run }); return route.fulfill({ response });
      }
      return route.continue();
    }
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
await context.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  window.__liveTest = { sourceId: null, tasks: [], timing: [], active: null };
  window.fetch = async (resource, init = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
    if (!['/api/ai/harness/stream', '/api/ai/dsh/conversation/stream'].includes(url.pathname)) return originalFetch(resource, init);
    const request = JSON.parse(init.body), fixture = window.__liveTest, now = new Date().toISOString();
    if (!fixture.sourceId) throw Error('Unarmed model request');
    const baseline = request.notebookContext.document;
    const task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey, instruction: request.instruction,
      pageId: request.pageId, role: 'editor', state: 'planning', createdAt: now, updatedAt: now, events: [], trace: [], counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 } };
    return new Response(new ReadableStream({ start(controller) {
      const started = performance.now(), timing = { instruction: request.instruction, firstEventMs: null, firstCellMs: null, firstResultMs: null, finalMs: null };
      fixture.timing.push(timing);
      let sequence = 0, version = 0, cells = [], closed = false;
      const emit = (update, extra = {}, terminal = false) => {
        const event = { id: `${task.id}:${++sequence}`, sequence, taskId: task.id, timestamp: new Date().toISOString(),
          type: terminal ? 'completed' : 'status_update', message: '隔离 SSE 验收（合成事件）', taskState: task.state, ...extra,
          ...(update ? { notebookProgress: { baseRevision: baseline.revision, editVersion: version, update } } : {}) };
        const saved = { ...event }; delete saved.notebookProgress; task.trace.push(saved);
        if (timing.firstEventMs === null) timing.firstEventMs = performance.now() - started;
        if (update?.kind === 'draft' && timing.firstCellMs === null) timing.firstCellMs = performance.now() - started;
        if (update?.kind === 'cell_finished' && update.result.status === 'success' && timing.firstResultMs === null) timing.firstResultMs = performance.now() - started;
        if (terminal) timing.finalMs = performance.now() - started;
        try { controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`)); }
        catch { /* Intentionally late fixture after cancellation; must not reach the application. */ }
      };
      fixture.active = {
        request, task,
        draft(limit, invalid = false) {
          const data = baseline.cells.find(cell => cell.kind === 'data') ?? { id: 'source', kind: 'data', title: '合成站点原始数据', sourceDataSourceId: fixture.sourceId, outputName: 'stations' };
          cells = [data, { id: 'top_stations', kind: 'sql', title: `站点停机时长 Top${limit}`, inputCellIds: [data.id], outputName: 'station_totals',
            sql: invalid ? `SELECT missing_column FROM ${data.outputName}` : `SELECT station, SUM(seconds)::DOUBLE AS total_seconds FROM ${data.outputName} GROUP BY station ORDER BY total_seconds DESC LIMIT ${limit}` },
          { id: 'station_chart', kind: 'chart', title: `站点时长 Top${limit} 图`, inputCellId: 'top_stations', chartType: 'bar', categoryField: 'station', valueFields: ['total_seconds'] }];
          version++; task.state = 'executingTool';
          emit({ kind: 'draft', document: { ...baseline, name: '合成 Excel · 站点时长分析', cells }, changedCellIds: cells.map(cell => cell.id), removedCellIds: [] },
            { message: `草稿 v${version} 已同步到 Notebook，尚未保存。`, notebookStatus: 'edited', notebookCellId: 'top_stations', notebookEditVersion: version });
          return { ...baseline, name: '合成 Excel · 站点时长分析', cells };
        },
        runStart(run) { emit({ kind: 'run_started', runId: run.runId, revision: baseline.revision, cellIds: cells.map(cell => cell.id) },
          { message: `开始试运行 ${cells.length} 个单元`, notebookRunId: run.runId, notebookStatus: 'queued' }); },
        cellStart(run, id) { emit({ kind: 'cell_started', runId: run.runId, revision: baseline.revision, cellId: id },
          { message: `正在运行：${cells.find(cell => cell.id === id).title}`, notebookCellId: id, notebookRunId: run.runId, notebookStatus: 'running' }); },
        cellFinish(run, result) { const display = structuredClone(result); if (display.resultRef) display.resultRef.accessMode = 'ai';
          delete display.stdout; delete display.stderr;
          emit({ kind: 'cell_finished', runId: run.runId, revision: baseline.revision, result: display },
            { message: `${display.status === 'success' ? '已完成' : display.status === 'blocked' ? '上游失败，已阻断' : '执行失败'}：${cells.find(cell => cell.id === display.cellId).title}`,
              notebookCellId: display.cellId, notebookRunId: run.runId, notebookStatus: display.status }); },
        runFinish(run) { emit({ kind: 'run_finished', runId: run.runId, revision: baseline.revision, status: run.status },
          { message: run.status === 'success' ? '草稿试运行通过，等待最终核验。' : '试运行存在失败。', notebookRunId: run.runId, notebookStatus: run.status }); },
        finish(run, success = true) {
          task.state = success ? 'awaitingConfirmation' : 'failed';
          task.resultMessage = success ? '合成站点汇总已完成试运行，等待确认。' : '合成失败场景，正式 Notebook 未修改。';
          if (success) {
            task.verification = { attempt: 1, status: 'passed', checks: [], issues: [], evidenceToolCallIds: [] };
            task.notebookArtifact = { id: `draft_${request.idempotencyKey}`, version: 1, status: 'draft', name: '合成 Excel · 站点时长分析', cells,
              executionOrder: cells.map(cell => cell.id), lineage: [{ cellId: cells[0].id, dependsOn: [] }, { cellId: cells[1].id, dependsOn: [cells[0].id] }, { cellId: cells[2].id, dependsOn: [cells[1].id] }],
              sourceDataSourceIds: [fixture.sourceId], createdAt: now, baseRevision: baseline.revision,
              executionEvidence: { runId: run.runId, status: 'success', completedCellIds: cells.map(cell => cell.id), summary: '显式合成 SSE 验收，结果来自真实 Notebook API。' } };
          } else { task.error = task.resultMessage; task.terminationCode = 'toolExecutionFailed'; }
          emit(null, {}, true); fixture.tasks.push(task); if (!closed) { try { controller.close(); } catch {} closed = true; }
        },
      };
      emit(null, { type: 'task_started', message: '输入检查完成：合成站点 Excel，24 行、2 个字段。仅为验收事件。' });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
});
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on('pageerror', error => report.errors.push(error.message));
const frame = () => page.frameLocator('iframe[title="官方 DSH 聊天"]');
const live = () => page.getByRole('region', { name: 'Notebook 实时草稿', exact: true });
const formal = () => page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
async function poll(check, message) {
  for (let i = 0; i < 240; i++) { if (await check()) return; await page.waitForTimeout(125); } throw Error(message);
}
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox').fill(label); await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function manifest() { const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200); return (await response.json()).manifest; }
async function saved(predicate = () => true) {
  let value; await poll(async () => { value = await manifest(); return value.state && predicate(value.state) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').innerText()); }, 'Save did not settle');
  if (dashboard) assert.deepEqual(value.state.appSpec, dashboard); return value.state;
}
async function unchanged(document) { assert.deepEqual((await manifest()).state.dataProduct.notebooks[pageId], document); }
async function shot(file, scenario, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1); await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-vinext-dev-error-overlay]').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(directory, `${file}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${file}.png`, scenario, reviewed: false });
}
async function send(label) {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.evaluate(id => { window.__liveTest.sourceId = id; window.__liveTest.active = null; }, sourceId);
  const composer = frame().locator('[data-composer-input="true"]');
  await poll(async () => await composer.getAttribute('contenteditable') === 'true', 'Official composer not ready');
  await composer.fill(`合成验收：${label}`); await composer.press('Enter');
  await poll(() => page.evaluate(() => Boolean(window.__liveTest.active)), 'SSE fixture not requested');
}
async function draft(limit, invalid = false) { return page.evaluate(({ limit, invalid }) => window.__liveTest.active.draft(limit, invalid), { limit, invalid }); }
async function compute(document) {
  const response = await context.request.post(base + '/api/notebook/run', { headers: { [header]: handle, origin: base }, data: { action: 'run', pageId, document } });
  const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); report.runs.push({ automatic: false, run: body.run }); return body.run;
}
async function replay(run) {
  await page.evaluate(run => { const active = window.__liveTest.active; active.runStart(run); for (const cell of run.cells) { if (cell.status !== 'blocked') active.cellStart(run, cell.cellId); active.cellFinish(run, cell); } active.runFinish(run); }, run);
}
async function finish(run, success = true) {
  await page.evaluate(({ run, success }) => window.__liveTest.active.finish(run, success), { run, success });
  if (success) { await formal().waitFor(); await formal().getByRole('button', { name: '确认更改', exact: true }).waitFor();
    await poll(async () => await formal().getByRole('button', { name: '确认更改', exact: true }).isEnabled(), 'Final preview did not verify'); }
}
try {
  await page.goto(base, { waitUntil: 'networkidle' }); await menu('数据浏览器');
  const browserDialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await browserDialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await browserDialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await browserDialog.getByLabel('项目名称', { exact: true }).fill('实时草稿隔离验收');
  await browserDialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await browserDialog.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type=file]').setInputFiles({ name: 'stations-synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook });
  await upload.getByRole('button', { name: /导入 1 份文件/u }).click(); await upload.waitFor({ state: 'hidden' });
  const prepared = await saved(state => state.appSpec.dataSources.some(source => source.name.includes('stations-synthetic')));
  sourceId = prepared.appSpec.dataSources.find(source => source.name.includes('stations-synthetic')).id;
  pageId = prepared.appSpec.pages[0].id; dashboard = structuredClone(prepared.appSpec);
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  let baseline = (await saved()).dataProduct.notebooks[pageId];
  // Empty notebooks may be derived until their first explicit save. Capture the exact request baseline below.
  await send('按站点聚合并生成 Top10 图'); const document = await draft(10);
  baseline = (await manifest()).state.dataProduct.notebooks[pageId];
  await live().waitFor(); assert.equal(await live().locator('article').count(), 3);
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await shot('01-live-draft-before-result', 'Draft cells appear before any run or terminal answer'); await unchanged(baseline);
  const run = await compute(document); assert.equal(run.status, 'success'); assert.equal(run.cells[1].table.rows.length, 10);
  await page.evaluate(run => { const active = window.__liveTest.active; active.runStart(run); active.cellStart(run, run.cells[0].cellId); active.cellFinish(run, run.cells[0]); active.cellStart(run, 'top_stations'); }, run);
  await live().locator('[data-live-status="running"]').waitFor();
  await shot('02-per-cell-running', 'Actual source output plus SQL running and chart queued (gated fixture)');
  await page.evaluate(run => { const active = window.__liveTest.active; active.cellFinish(run, run.cells[1]); active.cellStart(run, 'station_chart'); active.cellFinish(run, run.cells[2]); active.runFinish(run); }, run);
  const chart = live().locator('article[data-cell-id="station_chart"]'); await chart.locator('.recharts-surface').first().waitFor();
  const progress = frame().locator('[data-agentcanvas-dsh-progress]'); await progress.waitFor();
  assert.match(await progress.innerText(), /已完成/u); await progress.getByRole('button', { name: '定位单元', exact: true }).last().click();
  await poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-cell-id') === 'station_chart'), 'Cell navigation failed');
  await shot('03-live-chart-and-process', 'Top10 computed chart and official DSH process slot; locate-cell focuses chart', chart);
  await unchanged(baseline); await finish(run); await unchanged(baseline);
  await shot('04-final-preview-confirmation', 'Final verification still performs an authorized local preview and awaits explicit confirmation', formal().locator('.notebook-heading'));
  await formal().getByRole('button', { name: '确认更改', exact: true }).click();
  baseline = (await saved(state => state.dataProduct.notebooks[pageId]?.cells.length === 3)).dataProduct.notebooks[pageId];
  await shot('05-adopted-definition', 'Explicitly adopted three cells; results remain visible', formal().locator('.notebook-heading'));
  report.checks.push('Synthetic XLSX import → live draft → per-cell progress → real Top10 SQL/chart → explicit adoption; dashboard unchanged');

  await send('将 Top10 改成 Top5，包含错误修复'); const badDocument = await draft(5, true); const badRun = await compute(badDocument);
  assert.equal(badRun.status, 'failure'); assert.equal(badRun.cells[1].status, 'failure'); assert.equal(badRun.cells[2].status, 'blocked');
  await replay(badRun); await live().locator('[data-live-status="blocked"]').waitFor();
  await shot('06-sql-failure-blocks-chart', 'Actual invalid SQL and blocked downstream chart; no old success reused', live().locator('article[data-cell-id="top_stations"]'));
  const corrected = await draft(5); await live().locator('[data-live-status="stale"]').first().waitFor();
  await shot('07-edited-invalidates-results', 'New edit version invalidates previous per-cell results before retry');
  const repaired = await compute(corrected); assert.equal(repaired.status, 'success'); assert.equal(repaired.cells[1].table.rows.length, 5);
  await replay(repaired); await live().locator('article[data-cell-id="station_chart"] .recharts-surface').first().waitFor();
  await shot('08-top5-repaired', 'Same task repaired SQL; new run/version yields five chart rows', live().locator('article[data-cell-id="station_chart"]'));
  await unchanged(baseline); await finish(repaired); await formal().getByRole('button', { name: '撤销预览', exact: true }).click(); await unchanged(baseline);
  report.checks.push('Actual SQL failure → blocked chart → edit invalidation → repaired Top5 → withdraw preserves saved Top10');

  await send('取消正在生成的草稿'); const cancelledDoc = await draft(5); const cancelledRun = await compute(cancelledDoc);
  await page.evaluate(run => { window.__liveTest.active.runStart(run); window.__liveTest.active.cellStart(run, run.cells[0].cellId); }, cancelledRun);
  // The parent cancel command is the supported public bridge, same command as the official Stop button.
  const stop = frame().getByRole('button', { name: /停止|Stop|取消/u }).first(); await stop.click();
  await live().getByText(/任务已取消/u).waitFor();
  const beforeLate = await live().innerText(); await replay(cancelledRun); await page.waitForTimeout(400);
  assert.equal(await live().innerText(), beforeLate); await unchanged(baseline);
  await shot('09-cancelled-ignores-late-receipts', 'Cancel prevents late synthetic results replacing live state or formal Notebook');
  report.checks.push('Cancellation ignores late receipts and never adopts a draft');
  await page.setViewportSize({ width: 1024, height: 900 });
  await send('不可修复 SQL 错误需如实停止'); const terminalDocument = await draft(5, true), terminalRun = await compute(terminalDocument);
  await replay(terminalRun); await finish(terminalRun, false); await live().getByText(/任务未完成/u).waitFor();
  await shot('10-terminal-failure-narrow', 'At 1024px the failed task retains actual errors, never grants adoption', live().locator('article[data-cell-id="top_stations"]'));
  await unchanged(baseline); assert.equal(await live().getByRole('button', { name: /确认更改|采用草稿/u }).count(), 0);
  await live().getByRole('button', { name: '查看正式文档', exact: true }).click(); await formal().waitFor();
  assert.match(await formal().innerText(), /Top10/u); await unchanged(baseline);
  await shot('11-formal-document-still-readable', 'Failed task can switch to the saved Top10 document without overwriting it');
  report.checks.push('Unrepaired SQL failure remains read-only; existing saved document remains accessible; 1024px has no page overflow');
  report.timings = await page.evaluate(() => window.__liveTest.timing);
  const automaticBeforeReload = report.runs.filter(run => run.automatic).length;
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await formal().waitFor(); await unchanged(baseline);
  assert.equal(await live().count(), 0); await page.waitForTimeout(500); assert.equal(report.runs.filter(run => run.automatic).length, automaticBeforeReload);
  const reopened = await manifest(); assert.equal(JSON.stringify(reopened).includes('notebookProgress'), false);
  await shot('12-reopened-no-transient-results', 'Reload restores only saved definitions, not live projection or automatic replay');
  report.checks.push('Reopen restores saved Top10 without transient rows/code in task history or automatic rerun');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {}); }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ passed: report.passed,
  report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), screenshots: report.screenshots.length, failure: report.failure?.message }, null, 2)); }
