// Managed 3001 only. Fresh synthetic local project; AI/SSE and its prior trial
// receipt are explicitly fixtures. Successful preview uses the real Notebook API.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.argv.length, 2, 'This verifier does not accept a user project.');
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/ai-notebook-auto-run-20260924', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
const filename = 'auto-run-synthetic.csv';
const csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const report = { passed: false, base, projectPath: rel(projectPath), checks: [], screenshots: [], runs: [],
  aiTasks: [], pageErrors: [], routeErrors: [], realModelRequests: 0,
  boundaries: ['One newly created synthetic local project only; no user data or service mutations.',
    'AI SSE, artifact and historical trial evidence are synthetic and visibly labelled; no real model calls.',
    'Successful automatic preview runs Data -> DuckDB SQL -> table through the real public Notebook endpoint.',
    'HTTP 503 and transport cancellation are controlled fixtures, not production failures or server cancellation proofs.'] };
await mkdir(directory, { recursive: true });
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
let handle, created = 0, pageId, dataId, datasetId, dashboard, currentScenario = 'prepare', nextRunMode = 'real', releaseHeld;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    if (request.method() === 'GET') {
      if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
      if (url.pathname === '/api/projects' && !request.headers()[header]) return route.fulfill({ json: { projects: [] } });
      if (url.pathname === '/api/datasets' && !request.headers()[header]) return route.fulfill({ json: { datasets: [] } });
      if (request.headers()[header]) assert.equal(request.headers()[header], handle);
      return route.continue();
    }
    if (url.pathname.startsWith('/api/ai/')) {
      report.realModelRequests++;
      throw new Error('Unexpected real AI transport: fixture was not used.');
    }
    if (url.pathname === '/api/projects') {
      const body = request.postDataJSON();
      if (body.action === 'create') {
        assert.equal(++created, 1); assert.equal(body.path, projectPath);
        const response = await route.fetch(); assert.equal(response.status(), 200);
        handle = (await response.json()).handle;
        return route.fulfill({ response });
      }
      assert.equal(body.action, 'save'); assert.equal(request.headers()[header], handle);
      if (dashboard) assert.deepEqual(body.state.appSpec, dashboard, 'Formal dashboard must not change.');
      return route.continue();
    }
    assert.ok(handle && request.headers()[header] === handle, 'Only the owned project may be mutated.');
    if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
      assert.equal(decodeURIComponent(request.headers()['x-file-name']), filename);
      assert.equal(request.postData(), csv);
      return route.continue();
    }
    if (url.pathname === '/api/notebook/run') {
      const input = request.postDataJSON();
      assert.equal(input.pageId, pageId); assert.equal(input.action, 'run');
      const kinds = currentScenario === 'chart-preview' ? ['data', 'sql', 'table', 'chart'] : ['data', 'sql', 'table'];
      assert.equal(input.document.cells.length, kinds.length);
      assert.deepEqual(input.document.cells.map(cell => cell.kind), kinds);
      assert.equal(input.document.cells[0].sourceDataSourceId, datasetId);
      const record = { scenario: currentScenario, document: input.document, mode: nextRunMode };
      report.runs.push(record);
      assert.equal(report.runs.filter(item => item.scenario === currentScenario).length, 1, 'One AI task must schedule only one Notebook run.');
      const mode = nextRunMode; nextRunMode = 'real';
      if (mode === 'failure') {
        record.httpStatus = 503; record.dispatchedToServer = false;
        return route.fulfill({ status: 503, json: { error: { message: '合成 HTTP 503：Notebook 暂时不可用，请手动重试。' } } });
      }
      if (mode === 'hold') {
        record.dispatchedToServer = false; record.transportHeld = true;
        await new Promise(done => { releaseHeld = done; });
        record.transportCancelled = true;
        return route.abort('aborted');
      }
      record.dispatchedToServer = true;
      const response = await route.fetch({ timeout: 45_000 });
      record.httpStatus = response.status();
      const value = await response.json(); record.run = value.run;
      assert.equal(response.status(), 200, JSON.stringify(value));
      assert.equal(value.run.status, 'success');
      return route.fulfill({ response });
    }
    throw new Error(`Unexpected mutation: ${url.pathname}`);
  } catch (error) { report.routeErrors.push(error.message); return route.abort('blockedbyclient').catch(() => {}); }
});
await context.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window);
  window.__aiNotebookPreview = { next: null, tasks: [], requests: [] };
  window.fetch = async (resource, init = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
    if (url.pathname !== '/api/ai/harness/stream') return nativeFetch(resource, init);
    const fixture = window.__aiNotebookPreview, choice = fixture.next;
    if (!choice) throw new Error('Unarmed AI request; real models are forbidden.');
    fixture.next = null;
    const request = JSON.parse(init.body); fixture.requests.push(request);
    const now = new Date().toISOString(), document = request.notebookContext.document;
    const task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
      instruction: request.instruction, pageId: request.pageId, role: 'editor', state: 'planning', createdAt: now,
      updatedAt: now, events: [], trace: [], counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 } };
    if (choice.kind === 'draft') {
      const data = document.cells.find(cell => cell.kind === 'data');
      if (!data) throw new Error('The synthetic draft requires the actually imported Data cell.');
      const cells = [data,
        { id: 'auto_preview_sql', kind: 'sql', title: '合成 AI 草稿：地区汇总', inputCellIds: [data.id], outputName: 'region_totals',
          sql: `SELECT region, SUM(amount) * ${choice.multiplier} AS revenue FROM ${data.outputName} GROUP BY region ORDER BY region` },
        { id: 'auto_preview_table', kind: 'table', title: '自动运行结果', inputCellId: 'auto_preview_sql', columns: ['region', 'revenue'] }];
      if (choice.chart) cells.push({ id: 'auto_preview_chart', kind: 'chart', title: '地区金额图', inputCellId: 'auto_preview_sql',
        chartType: 'bar', categoryField: 'region', valueFields: ['revenue'] });
      task.notebookArtifact = { id: `draft_${request.idempotencyKey}`, version: 1, status: 'draft', name: '合成 AI 回执 · 自动运行验收', cells,
        executionOrder: cells.map(cell => cell.id), lineage: [
          { cellId: data.id, dependsOn: [] }, { cellId: 'auto_preview_sql', dependsOn: [data.id] },
          { cellId: 'auto_preview_table', dependsOn: ['auto_preview_sql'] },
          ...(choice.chart ? [{ cellId: 'auto_preview_chart', dependsOn: ['auto_preview_sql'] }] : [])], sourceDataSourceIds: [data.sourceDataSourceId], createdAt: now,
        baseRevision: document.revision, executionEvidence: { runId: `synthetic_trial_${choice.multiplier}`, status: 'success',
          completedCellIds: cells.map(cell => cell.id), summary: '合成历史试运行回执；后续预览将使用真实 Notebook API。' } };
    }
    return new Response(new ReadableStream({ start(controller) {
      const emit = (type, message, terminal = false) => {
        const event = { id: `${task.id}:${task.trace.length + 1}`, sequence: task.trace.length + 1, taskId: task.id,
          timestamp: now, type, message, taskState: task.state };
        task.trace.push(event);
        controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`));
      };
      emit('task_started', '隔离自动运行验收：这是明确的合成 AI 事件，不是收费模型。');
      task.state = choice.kind === 'draft' ? 'awaitingConfirmation' : choice.kind === 'failed' ? 'failed' : 'completed';
      task.resultMessage = choice.message;
      if (choice.kind === 'failed') { task.error = choice.message; task.terminationCode = 'toolExecutionFailed'; }
      else task.verification = { attempt: 1, status: 'passed', checks: [], issues: [], evidenceToolCallIds: [] };
      emit('completed', '合成任务回执；正式看板不修改。', true);
      fixture.tasks.push(task); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
});
const page = await context.newPage(); page.setDefaultTimeout(20_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const notebook = () => page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const editor = () => page.locator('.notebook-editor');
const toggle = () => page.getByRole('checkbox', { name: 'AI 分析后自动运行 Notebook', exact: true });
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
const table = () => page.getByRole('article', { name: '表格单元 自动运行结果', exact: true });
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(predicate, message, timeout = 45_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
async function snapshot(predicate = () => true) {
  let result;
  await poll(async () => {
    assert.ok(handle);
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200); const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    result = value.manifest.state;
    return result && predicate(result) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent());
  }, 'Owned project did not finish saving.');
  if (dashboard) assert.deepEqual(result.appSpec, dashboard);
  return result;
}
const documentOf = state => state.dataProduct.notebooks[pageId];
async function unchanged(baseline) { assert.deepEqual(documentOf(await snapshot()), baseline); }
async function noNewRuns(count) { await pause(1200); assert.equal(report.runs.length, count, 'Unexpected automatic retry or execution.'); }
async function shot(name, scenario, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const file = `${name}.png`; await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), actualImageReviewed: false });
}
async function send(kind, multiplier, mode, label, chart = false) {
  currentScenario = label; nextRunMode = mode;
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  const message = `合成 AI ${label}：${kind === 'draft' ? '分析草稿已就绪。' : kind === 'failed' ? '任务失败，未提供草稿。' : '只读回答，不产生新草稿。'}`;
  await page.evaluate(choice => { window.__aiNotebookPreview.next = choice; }, { kind, multiplier, message, chart });
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(`自动运行隔离验收 ${label}，仅合成销售数据。`);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await poll(() => page.evaluate(expected => window.__aiNotebookPreview.tasks.at(-1)?.resultMessage === expected, message), 'Synthetic task was not emitted.');
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  const task = await page.evaluate(() => window.__aiNotebookPreview.tasks.at(-1));
  assert.equal(task.resultMessage, message); report.aiTasks.push({ scenario: label, id: task.id, kind, artifactId: task.notebookArtifact?.id });
  return task;
}
async function waitRun(count) { await poll(() => report.runs.length === count, 'Automatic Notebook request was not sent.'); }
async function idle() { await notebook().getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden', timeout: 45_000 }); }
async function withdraw() {
  await notebook().getByRole('button', { name: '撤销预览', exact: true }).click();
  await notebook().getByRole('button', { name: '撤销预览', exact: true }).waitFor({ state: 'hidden' });
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await page.getByRole('navigation', { name: '工作区功能菜单', exact: true }).getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('AI 草稿自动预览运行 · 隔离验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  pageId = (await snapshot()).appSpec.pages[0].id;
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  await notebook().locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: /导入 1 份文件/u }).click();
  await upload.waitFor({ state: 'hidden' });
  const imported = await snapshot(state => state.appSpec.dataSources.some(source => source.originalFileName === filename || source.name.includes('auto-run-synthetic')));
  datasetId = imported.appSpec.dataSources.find(source => source.originalFileName === filename || source.name.includes('auto-run-synthetic')).id;
  await notebook().getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill('合成三行销售数据');
  await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_input');
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await notebook().getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
  if (await notice.isVisible()) await notice.click();
  const prepared = await snapshot(state => documentOf(state)?.cells.length === 1);
  let baseline = documentOf(prepared); dataId = baseline.cells[0].id;
  assert.equal(baseline.cells[0].sourceDataSourceId, datasetId);
  dashboard = structuredClone(prepared.appSpec);
  assert.equal(await toggle().isChecked(), true);

  const successTask = await send('draft', 1, 'real', 'success-preview');
  await waitRun(1); await notebook().waitFor(); await idle();
  await poll(() => report.runs[0]?.run?.status === 'success', 'Real preview run did not succeed.');
  assert.deepEqual(report.runs[0].run.cells.find(cell => cell.cellId === 'auto_preview_table').table.rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
  await notebook().getByText(/AI 分析后运行完成/u).waitFor();
  await notebook().getByRole('button', { name: '确认更改', exact: true }).waitFor();
  await unchanged(baseline); await noNewRuns(1);
  await shot('01a-success-pending-confirmation-controls', 'Successful preview is visibly pending confirmation; confirmation and undo remain separate from execution.', draft());
  await shot('01-preview-success-not-confirmed', 'Real Data/SQL/table gives East150/South80; pending preview is not yet persisted.', table());
  await notebook().getByRole('button', { name: '确认更改', exact: true }).click();
  baseline = documentOf(await snapshot(state => documentOf(state)?.lastDraftId === successTask.notebookArtifact.id));
  assert.equal(baseline.cells.length, 3); await noNewRuns(1);
  assert.match(await table().innerText(), /150/u); assert.match(await table().innerText(), /80/u);
  await shot('02-confirmed-preserves-result', 'Explicit confirmation saves three cells and reuses preview output, without another request.', table());
  report.checks.push('New successful artifact opens/runs preview once; formal Notebook stays unchanged until explicit confirmation; dashboard never changes.');

  const confirmedRunId = report.runs[0].run.runId;
  const sourceDetails = () => table().locator('details').filter({ has: page.locator('summary', { hasText: '结果来源' }) });
  assert.ok(confirmedRunId); assert.match(await sourceDetails().textContent(), new RegExp(confirmedRunId));
  await send('draft', 5, 'real', 'withdraw-successful-preview');
  await waitRun(2); await notebook().waitFor(); await idle();
  await poll(() => report.runs[1]?.run?.status === 'success', 'Second real preview did not succeed.');
  assert.deepEqual(report.runs[1].run.cells.find(cell => cell.cellId === 'auto_preview_table').table.rows, [{ region: 'East', revenue: 750 }, { region: 'South', revenue: 400 }]);
  await unchanged(baseline); await noNewRuns(2); await withdraw();
  await unchanged(baseline); await noNewRuns(2);
  assert.match(await table().innerText(), /150/u); assert.match(await table().innerText(), /80/u);
  assert.match(await sourceDetails().textContent(), new RegExp(confirmedRunId));
  assert.ok(!(await sourceDetails().textContent()).includes(report.runs[1].run.runId));
  await shot('02b-withdraw-restores-previous-results', 'Withdrawing a successfully computed new preview restores the pre-existing result values and run identity without executing again.', table());
  report.checks.push('Withdrawing a successful preview restores existing non-empty result values and original run ID without changing the formal document or another request.');

  await send('draft', 7, 'hold', 'withdraw-running-preview');
  await waitRun(3); await notebook().getByRole('button', { name: '停止运行', exact: true }).waitFor();
  await withdraw(); releaseHeld?.(); releaseHeld = undefined; await idle();
  await unchanged(baseline); await noNewRuns(3);
  assert.match(await table().innerText(), /150/u); assert.match(await table().innerText(), /80/u);
  assert.match(await sourceDetails().textContent(), new RegExp(confirmedRunId));
  await shot('02c-withdraw-running-preserves-results', 'Directly withdrawing an in-flight preview restores old values and run identity, even after the held transport is released and rejects.', table());
  report.checks.push('Direct withdrawal during a held run retains previous results and original run ID after the cancelled transport rejects; no late cache overwrite or retry.');

  await page.reload({ waitUntil: 'networkidle' }); await notebook().waitFor(); await unchanged(baseline); await noNewRuns(3);
  assert.equal(await page.evaluate(() => window.__aiNotebookPreview.requests.length), 0);
  await shot('03-refresh-no-run', 'Saved definition/chat reopen, but no historical task or Notebook run executes on refresh.', notebook().locator('.notebook-heading'));
  report.checks.push('Refresh reopens saved definitions without executing a historical artifact.');
  await send('readonly', 0, 'real', 'readonly-answer'); await noNewRuns(3); await unchanged(baseline);
  await send('failed', 0, 'real', 'failed-ai'); await noNewRuns(3); await unchanged(baseline);
  report.checks.push('Read-only answer and failed AI task never trigger Notebook preview/run.');

  await send('draft', 2, 'failure', 'http-failure'); await waitRun(4); await notebook().waitFor(); await idle();
  await notebook().getByRole('alert').filter({ hasText: '合成 HTTP 503' }).waitFor();
  assert.equal(await notebook().getByRole('button', { name: '确认更改', exact: true }).isDisabled(), true);
  await unchanged(baseline); await noNewRuns(4);
  await shot('04-http-failure-not-confirmed', 'Injected HTTP503 is shown; no automatic retry or formal adoption.', notebook().locator('.notebook-feedback'));
  await withdraw(); await unchanged(baseline); await noNewRuns(4);
  report.checks.push('HTTP failure is visible once, remains unconfirmed, and withdraw preserves the formal Notebook.');

  await send('draft', 3, 'hold', 'cancel-run'); await waitRun(5); await notebook().waitFor();
  const stop = notebook().getByRole('button', { name: '停止运行', exact: true }); await stop.waitFor();
  await shot('05-preview-running', 'One Notebook transport is held before dispatch; preview can be stopped.', notebook().locator('.notebook-heading'));
  await stop.click(); releaseHeld?.(); releaseHeld = undefined; await idle();
  await notebook().getByRole('alert').filter({ hasText: /取消|停止/u }).waitFor();
  assert.equal(await notebook().getByRole('button', { name: '确认更改', exact: true }).isDisabled(), true);
  await unchanged(baseline); await noNewRuns(5);
  await shot('06-preview-cancelled', 'Stopping the held transport leaves pending changes unconfirmed, with no retry.', notebook().locator('.notebook-feedback'));
  await withdraw(); await unchanged(baseline); await noNewRuns(5);
  report.checks.push('Stop cancels the owned delayed transport once; no retry or adoption; withdraw restores formal definitions.');

  await toggle().uncheck();
  const offTask = await send('draft', 4, 'real', 'disabled-auto-preview'); await noNewRuns(5); await unchanged(baseline);
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await draft().waitFor();
  await draft().getByRole('button', { name: '采用草稿', exact: true }).waitFor();
  await draft().getByRole('button', { name: '暂不采用', exact: true }).waitFor();
  await shot('07-disabled-keeps-manual-draft', 'With the switch off, a new successful artifact remains an ordinary manual draft and does not run.', draft());
  await snapshot(state => state.harnessTasks.some(task => task.id === offTask.id));
  await page.reload({ waitUntil: 'networkidle' }); await notebook().waitFor();
  await unchanged(baseline); await noNewRuns(5);
  assert.equal(await page.evaluate(() => window.__aiNotebookPreview.requests.length), 0);
  await shot('08-historical-pending-no-run', 'Refresh must not run or confirm an old pending artifact even when the window setting defaults on.', notebook().locator('.notebook-heading'));
  report.checks.push('Switch off leaves a manual draft; refresh of an unconfirmed historical task does not run or adopt it.');

  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(await toggle().isChecked(), true);
  await send('draft', 6, 'real', 'chart-preview', true);
  await waitRun(6); await notebook().waitFor(); await idle();
  await poll(() => report.runs[5]?.run?.status === 'success', 'Real chart preview did not succeed.');
  assert.deepEqual(report.runs[5].run.cells.find(cell => cell.cellId === 'auto_preview_chart').table.rows, [{ region: 'East', revenue: 900 }, { region: 'South', revenue: 480 }]);
  await unchanged(baseline); await noNewRuns(6);
  assert.equal(await notebook().getByRole('button', { name: '确认更改', exact: true }).isEnabled(), true);
  await shot('09-narrow-chart-pending-confirmation', 'At 1024px, a new four-cell chart preview runs successfully but stays unconfirmed.', draft());
  const chart = page.getByRole('article', { name: '图表单元 地区金额图', exact: true });
  await chart.locator('svg').first().waitFor();
  assert.match(await chart.innerText(), /900/u); assert.match(await chart.innerText(), /480/u);
  await shot('10-narrow-chart-real-result', 'Real SQL output East900/South480 is rendered into the chart in a 1024px preview; Dashboard unchanged.', chart);
  await withdraw(); await unchanged(baseline); await noNewRuns(6);
  report.checks.push('Narrow desktop renders a real four-cell chart preview; confirmation is explicit and withdrawal preserves the formal Notebook and Dashboard.');
  assert.equal(report.realModelRequests, 0); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []);
  assert.equal(report.runs.length, 6); assert.equal(report.runs.filter(item => item.dispatchedToServer).length, 3);
  report.passed = true;
} catch (error) {
  report.failure = { scenario: currentScenario, message: error.message, stack: error.stack };
  await page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  releaseHeld?.();
  report.dataCellId = dataId;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, report: rel(join(directory, 'report.json')), checks: report.checks.length,
    screenshots: report.screenshots.length, realModelRequests: report.realModelRequests, failure: report.failure?.message }, null, 2));
}
