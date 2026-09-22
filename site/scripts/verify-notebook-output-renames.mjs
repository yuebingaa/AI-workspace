// Existing managed 3001 only. A new synthetic project, real local SQL / Python,
// and isolated Edge; no model requests, warehouse execution or service changes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createOutputRenameReceipt } from './fixtures/output-renames.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-output-renames-2026-09-17', `browser-${Date.now()}`);
const definitions = {
  input: { label: '参数', title: '计算输入参数', output: 'minimum' },
  unrelated: { label: '参数', title: '不受改名影响的独立参数', output: 'independent' },
  sql: { label: 'SQL', title: 'SQL 两倍计算', output: 'summary' },
  python: { label: 'Python', title: 'Python 三倍计算', output: 'python_summary' },
  chart: { label: '图表', title: '稳定单元引用图表' },
};
const sqlFor = (input) => `SELECT 'Synthetic' AS region, (value * 2)::DOUBLE AS total FROM ${input}`;
const pythonFor = (input, output) => `import pandas as pd\n${output} = pd.DataFrame({'region': ['Synthetic'], 'total': [${input}['value'].iloc[0] * 3]})`;
const expected = (total) => [{ region: 'Synthetic', total }];

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [], ids = {}, replays = [];
let scenario = 'setup', passed = false, failure, handle, pageId, directoryReads = 0, replayTask;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === base && url.pathname === '/api/ai/harness/stream' && replayTask) {
    const input = request.postDataJSON(); assert.equal(input.pageId, pageId);
    const task = JSON.parse(JSON.stringify(replayTask).replaceAll(replayTask.id, `harness_${input.idempotencyKey}`));
    Object.assign(task, { idempotencyKey: input.idempotencyKey, pageId: input.pageId, instruction: input.instruction });
    assert.equal(task.trace.at(-1).type, 'completed');
    const body = task.trace.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ event,
      ...(index === task.trace.length - 1 ? { task } : {}) })}\n\n`).join('');
    replays.push({ source: 'harness-rename-task.json', events: task.trace.length, finalState: task.state,
      realModel: false, transport: 'explicit actual offline task SSE replay' });
    return route.fulfill({ contentType: 'text/event-stream', status: 200, body });
  }
  if (url.origin !== base || url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/connections/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection write prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    if (body.document?.cells.some((item) => item.kind === 'warehouseSql')) {
      forbiddenRequests.push('Warehouse execution prohibited'); return route.abort('blockedbyclient');
    }
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document?.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const review = () => page.getByRole('region', { name: '确认输出变量改名', exact: true });
const cell = (key) => page.getByRole('article', { name: `${definitions[key].label}单元 ${definitions[key].title}`, exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No desktop page-wide overflow');
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario, assertions });
}
async function dismissNotice() {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
}
async function manifest(predicate = (value) => Boolean(value.state)) {
  assert.ok(handle, 'Only the project created by this run may be read');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
    assert.equal(response.status(), 200);
    const value = (await response.json()).manifest;
    if (predicate(value) && /已保存到本地项目|已打开本地项目/.test(await page.locator('.top-actions').textContent())) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Synthetic project did not finish saving');
}
async function savedDocument(predicate = () => true) {
  const saved = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId]; return Boolean(book && predicate(book));
  });
  return saved.state.dataProduct.notebooks[pageId];
}
async function save({ creating = false } = {}) {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  if (creating) {
    // New cells already have default saved definitions. Their first edited name
    // may require the same explicit confirmation; this is not a silent bypass.
    await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
    if (await review().isVisible()) await review().getByRole('button', { name: '确认改名并保存', exact: true }).click();
  }
  await editor().waitFor({ state: 'hidden' });
}
async function start(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${definitions[key].label}`, exact: true }).click();
  await editor().waitFor(); await editor().getByLabel('单元名称', { exact: true }).fill(definitions[key].title);
  if (definitions[key].output) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(definitions[key].output);
}
async function saveNew(key) {
  await save({ creating: true }); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === definitions[key].title));
  ids[key] = book.cells.find((item) => item.title === definitions[key].title).id;
}
async function selectInputs(names) {
  const options = editor().locator('.notebook-input-list label');
  for (let index = 0; index < await options.count(); index++) {
    const option = options.nth(index), name = await option.locator('code').textContent();
    await option.getByRole('checkbox').setChecked(names.includes(name));
  }
  assert.equal(await editor().locator('.notebook-input-list input:checked').count(), names.length);
}
async function rename(key, output) {
  await cell(key).getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(output);
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await review().waitFor();
}
async function confirmRename() {
  await review().getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await review().waitFor({ state: 'hidden' }); await editor().waitFor({ state: 'hidden' });
}
async function perform(key, status = 'success') {
  await dismissNotice();
  const next = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await cell(key).getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await next, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, status, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body.run;
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a new isolated project and real parameter, SQL, Python and chart chains', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
    await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 输出改名独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.equal(await page.locator('.notebook-cell').count(), 0);
    for (const [key, value] of [['input', '100'], ['unrelated', '7']]) {
      await start(key); await editor().getByLabel('参数类型', { exact: true }).selectOption('number');
      await editor().getByLabel('参数值', { exact: true }).fill(value); await saveNew(key);
    }
    assert.deepEqual((await perform('unrelated')).cells.at(-1).table.rows, [{ value: 7 }]);
    await start('sql'); await selectInputs(['minimum']); await editor().getByLabel('SQL', { exact: true }).fill(sqlFor('minimum')); await saveNew('sql');
    await start('python'); await selectInputs(['minimum']); await editor().getByLabel('Python', { exact: true }).fill(pythonFor('minimum', 'python_summary')); await saveNew('python');
    assert.deepEqual((await perform('python')).cells.at(-1).table.rows, expected(300));
    await shot('01-real-initial-python-1440', cell('python').locator('.notebook-result'), ['Real Python reads the parameter DataFrame; total 300', 'Synthetic data only; no file upload or model call']);
    await start('chart'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.sql);
    await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('total'); await saveNew('chart');
    assert.deepEqual((await perform('chart')).cells.at(-1).table.rows, expected(200));
  });
  await step('Upstream rename review preserves original state; returning and cancelling never runs or saves', async () => {
    const before = await savedDocument(), count = actions.length;
    await rename('input', 'threshold');
    const text = await review().innerText();
    for (const value of ['minimum', 'threshold', definitions.sql.title, definitions.python.title, '3 个下游']) assert.ok(text.includes(value), value);
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    assert.equal(await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).isDisabled(), true);
    await shot('02-upstream-impact-review-1440', review(), ['Rename lists SQL and Python manual checks and affected chart', 'No SQL/Python code rewriting or execution before confirmation']);
    await review().getByRole('button', { name: '返回编辑', exact: true }).click(); await review().waitFor({ state: 'hidden' });
    assert.equal(await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).inputValue(), 'threshold');
    assert.equal(await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).isEnabled(), true);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('03-return-keeps-unsaved-name-1024', editor(), ['Returning preserves the unsaved threshold text', 'Persisted name remains minimum; no execution']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
  });
  await step('Confirmed upstream rename keeps structural references and code; stale SQL fails and blocks chart until manually fixed', async () => {
    const before = await savedDocument(), count = actions.length;
    await rename('input', 'threshold'); await confirmRename();
    const renamed = await savedDocument((book) => book.cells.find((item) => item.id === ids.input).outputName === 'threshold');
    assert.equal(actions.length, count);
    for (const key of ['sql', 'python', 'chart', 'unrelated']) {
      assert.deepEqual(renamed.cells.find((item) => item.id === ids[key]), before.cells.find((item) => item.id === ids[key]));
    }
    for (const key of ['input', 'sql', 'python', 'chart']) assert.equal(await cell(key).locator('.notebook-cell-status').innerText(), '已失效 · 需重算');
    assert.match(await cell('unrelated').locator('.notebook-cell-status').innerText(), /✓/);
    assert.equal(await cell('chart').locator('.notebook-plot').count(), 0);
    await shot('04-confirmed-stale-chain-1024', cell('chart'), ['Confirmation saves only; stale chart is not reused', 'Unrelated successful parameter remains valid']);
    const failed = await perform('chart', 'failure');
    assert.equal(failed.cells.find((item) => item.cellId === ids.sql).status, 'failure');
    assert.equal(failed.cells.find((item) => item.cellId === ids.chart).status, 'blocked');
    await shot('05-old-sql-failure-1024', cell('sql'), ['Real DuckDB rejects the unchanged old minimum table name', 'Failure is not falsely reported as a successful safe rewrite']);
    await shot('06-chart-blocked-1024', cell('chart'), ['Upstream SQL failure blocks the downstream chart']);
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill(sqlFor('threshold')); await save();
    assert.deepEqual((await perform('chart')).cells.at(-1).table.rows, expected(200));
    assert.equal(await cell('python').locator('.notebook-cell-status').innerText(), '已失效 · 需重算');
    await shot('07-manually-fixed-chart-1024', cell('chart').locator('.notebook-plot'), ['Explicit code fix plus manual rerun restores 200', 'Sibling Python still stale until independently repaired']);
    await cell('python').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill(pythonFor('threshold', 'python_summary')); await save();
    assert.deepEqual((await perform('python')).cells.at(-1).table.rows, expected(300));
  });
  await step('SQL output rename preserves the chart input ID without rewriting SQL', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const before = await savedDocument(), count = actions.length;
    await rename('sql', 'renamed_summary');
    assert.ok((await review().innerText()).includes(definitions.chart.title));
    await shot('08-structured-reference-review-1440', review(), ['Chart reference is an unchanged stable cell ID', 'SQL output-name metadata does not require rewriting its own SELECT']);
    await confirmRename();
    const renamed = await savedDocument((book) => book.cells.find((item) => item.id === ids.sql).outputName === 'renamed_summary');
    assert.equal(actions.length, count);
    assert.equal(renamed.cells.find((item) => item.id === ids.sql).sql, sqlFor('threshold'));
    assert.deepEqual(renamed.cells.find((item) => item.id === ids.chart), before.cells.find((item) => item.id === ids.chart));
    assert.equal(renamed.cells.find((item) => item.id === ids.chart).inputCellId, ids.sql);
    assert.deepEqual((await perform('chart')).cells.at(-1).table.rows, expected(200));
  });
  await step('Python output rename requires checking its own assignment; cancellation and actual error/recovery remain explicit', async () => {
    const before = await savedDocument(), count = actions.length;
    await rename('python', 'renamed_python');
    const text = await review().innerText();
    assert.ok(text.includes('python_summary') && text.includes('renamed_python') && text.includes(definitions.python.title));
    await shot('09-python-self-output-review-1440', review(), ['Python output assignment is explicitly listed for manual checking', 'There need not be downstream consumers for this warning']);
    await review().getByRole('button', { name: '返回编辑', exact: true }).click();
    assert.equal(await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).inputValue(), 'renamed_python');
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await review().waitFor(); await confirmRename();
    const renamed = await savedDocument((book) => book.cells.find((item) => item.id === ids.python).outputName === 'renamed_python');
    assert.equal(renamed.cells.find((item) => item.id === ids.python).code, pythonFor('threshold', 'python_summary'));
    assert.equal(actions.length, count);
    const failed = await perform('python', 'failure'); assert.equal(failed.cells.at(-1).status, 'failure');
    assert.match(JSON.stringify(failed.cells.at(-1).error), /renamed_python/);
    await shot('10-python-missing-renamed-output-1440', cell('python'), ['Actual Python rejects the missing renamed output variable', 'The code was not rewritten or claimed verified during save']);
    await cell('python').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill(pythonFor('threshold', 'renamed_python')); await save();
    assert.deepEqual((await perform('python')).cells.at(-1).table.rows, expected(300));
  });
  await step('Duplicate names are rejected before confirmation; reopening retains IDs, names and repaired code', async () => {
    const before = await savedDocument(), count = actions.length;
    await cell('input').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('independent');
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    await editor().getByRole('alert').waitFor(); assert.equal(await review().count(), 0);
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('11-duplicate-name-rejected-1024', editor(), ['Duplicate output names are rejected by the existing graph validator', 'No save, execution or misleading confirmation for invalid definitions']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), before);
    assert.deepEqual((await perform('chart')).cells.at(-1).table.rows, expected(200));
    await shot('12-reopened-chart-1024', cell('chart').locator('.notebook-plot'), ['Persisted stable ID still links the renamed SQL output after reopening', 'Actual recomputation produces 200']);
    assert.deepEqual((await perform('python')).cells.at(-1).table.rows, expected(300));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('13-reopened-python-1440', cell('python').locator('.notebook-result'), ['Persisted renamed Python definition and corrected code produce 300', 'No model calls, database connection changes or Dashboard application']);
    assert.deepEqual(await savedDocument(), before);
    const project = await manifest(); assert.equal(project.tables.length, 0); assert.equal(project.files.length, 0);
    assert.equal(project.state.appSpec.pages[0].root.children.length, 0);
  });
  await step('Actual offline Harness rename draft displays the same impact review and remains unapplied when dismissed', async () => {
    const formal = await savedDocument(), project = await manifest(), count = actions.length;
    replayTask = await createOutputRenameReceipt({ directory, document: formal, appSpec: project.state.appSpec, pageId, ids });
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill('改名草稿验收：固定模型选择与真实本地执行的 SSE 回放，等待确认，不自动采用。');
    await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
    await page.locator('.conversation-turn').last().locator('.harness-trace.waiting').waitFor();
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const draft = page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
    await draft.waitFor(); assert.equal(await draft.getByRole('button', { name: '采用草稿', exact: true }).isEnabled(), true);
    const impact = draft.locator('.notebook-output-rename-review');
    const text = await impact.innerText();
    for (const value of ['threshold', 'ai_threshold', 'renamed_python', 'ai_python', '不会自动改写', '即使已经手动修改']) assert.ok(text.includes(value), value);
    assert.deepEqual(await savedDocument(), formal); assert.equal(actions.length, count);
    await shot('14-ai-draft-rename-review-1440', impact, ['Real offline Harness executed four tools and verified real SQL/Python results', 'Actual task SSE replay displays pending rename impacts; not a live model']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('15-ai-draft-rename-review-1024', impact, ['Shared rename review remains legible at minimum desktop width', 'Even repaired code remains explicitly subject to trial verification and adoption']);
    await draft.getByRole('button', { name: '暂不采用', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
    assert.deepEqual(await savedDocument(), formal); assert.equal(actions.length, count); assert.equal(replays.length, 1);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, runs, actions, ids, replays,
    pageErrors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic project and isolated browser only; actual UI, HTTP, DuckDB, Python and persistence.',
      'Connections GET is an explicit empty-directory fixture. All live model, external and warehouse requests are prohibited.',
      'Cancellation means rename confirmation / editor cancellation, not an execution-cancel scenario.',
      'No code rewriting is inferred from a warning. Both deliberately broken references are actually run and repaired.',
      'AI draft UI uses an explicit SSE replay of a real offline Harness task: scripted model choices, four actual tools and real SQL/Python trial; not real model quality.',
      'Evidence and synthetic project retained; no cleanup, service operations, stable publication or mobile verification.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
