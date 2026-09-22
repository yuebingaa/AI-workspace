// Existing managed 3001 only; new synthetic project, real local SQL/DataRecipe.
// No model, Python, warehouse, user-project access, service operation or deletion.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CSV, ROW_COUNT } from './fixtures/result-access.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-result-presentation-2026-09-16', `browser-${Date.now()}`);
const cells = {
  data: { label: 'Data', title: '1324 行合成原始数据', output: 'raw_rows' },
  sql: { label: 'SQL', title: '45 行数值、空值与字符串', output: 'sort_rows' },
  aggregate: { label: 'SQL', title: '不受预览排序影响的下游聚合', output: 'chart_rows' },
  chart: { label: '图表', title: '原始顺序图表与可排序数据表' },
  transform: { label: 'DataRecipe', title: '1000 行预览与完整 1324 行', output: 'complete_rows' },
};
const query = `SELECT seq,
  CASE WHEN seq IN (43, 44) THEN NULL WHEN seq = 45 THEN -10
    WHEN seq IN (1, 3) THEN 2 WHEN seq = 2 THEN 10 ELSE seq + 100 END::DOUBLE AS score,
  CASE seq WHEN 1 THEN '001' WHEN 2 THEN '1' WHEN 3 THEN '10' WHEN 4 THEN '2'
    WHEN 5 THEN '9007199254740993' WHEN 6 THEN '9007199254740992'
    ELSE 'x' || LPAD(CAST(CAST(seq AS BIGINT) AS VARCHAR), 2, '0') END AS code
FROM raw_rows WHERE seq <= 45 ORDER BY seq`;
const aggregateQuery = `SELECT CASE WHEN seq <= 15 THEN 'A' WHEN seq <= 30 THEN 'B' ELSE 'C' END AS category,
  SUM(score)::DOUBLE AS value FROM sort_rows GROUP BY category ORDER BY category`;
const expected = Array.from({ length: 45 }, (_, index) => {
  const seq = index + 1;
  return { seq, score: [43, 44].includes(seq) ? null : seq === 45 ? -10 : [1, 3].includes(seq) ? 2 : seq === 2 ? 10 : seq + 100,
    code: ['001', '1', '10', '2', '9007199254740993', '9007199254740992'][index] ?? `x${String(seq).padStart(2, '0')}` };
});
const expectedChart = ['A', 'B', 'C'].map((category, index) => ({ category,
  value: expected.slice(index * 15, (index + 1) * 15).reduce((sum, row) => sum + (row.score ?? 0), 0) }));
const display = (rows) => rows.map((row) => Object.values(row).map((value) => String(value ?? 'NULL')));
function ordered(field, direction) {
  return [...expected].sort((left, right) => {
    if (left[field] === null) return right[field] === null ? 0 : 1;
    if (right[field] === null) return -1;
    const delta = typeof left[field] === 'number' ? left[field] - right[field]
      : left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
    return direction === 'ascending' ? delta : -delta;
  });
}

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [];
const ids = {};
let scenario = 'setup', passed = false, failure, handle, pageId, datasetId, sourceBefore, savedBefore, directoryReads = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection write prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    if (body.document?.cells.some((cell) => ['warehouseSql', 'python'].includes(cell.kind))) {
      forbiddenRequests.push('Only synthetic local Data, SQL, DataRecipe and chart allowed'); return route.abort('blockedbyclient');
    }
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document?.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const header = (key, field) => cell(key).getByRole('button', { name: `按${field}排序`, exact: true });
async function sort(key, field, state, keyboardKey) {
  if (keyboardKey) {
    await header(key, field).focus(); await header(key, field).press(keyboardKey);
    assert.equal(await header(key, field).evaluate((button) => button === document.activeElement), true);
  } else await header(key, field).click();
  assert.equal(await header(key, field).evaluate((button) => button.closest('th').getAttribute('aria-sort')), state);
}
async function visibleRows(key) {
  return cell(key).locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent)));
}
async function allPreviewRows(key) {
  const previous = cell(key).getByRole('button', { name: '上一页结果', exact: true });
  const next = cell(key).getByRole('button', { name: '下一页结果', exact: true });
  while (await previous.isEnabled()) await previous.click();
  const output = [];
  do {
    const rows = await visibleRows(key); assert.ok(rows.length <= 20); output.push(...rows);
    if (!await next.isEnabled()) break;
    await next.click();
  } while (true);
  return output;
}
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
async function openBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
}
async function manifest(predicate = (value) => Boolean(value.state)) {
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
async function sourceDataset() {
  assert.ok(datasetId && handle);
  const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return response.json();
}
async function save() { await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' }); }
async function start(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${cells[key].label}`, exact: true }).click();
  await editor().waitFor(); await editor().getByLabel('单元名称', { exact: true }).fill(cells[key].title);
  if (cells[key].output) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(cells[key].output);
}
async function saveNew(key) {
  await save(); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === cells[key].title));
  ids[key] = book.cells.find((item) => item.title === cells[key].title).id;
}
async function selectOnlyInput(outputName) {
  const options = editor().locator('.notebook-input-list label');
  for (let index = 0; index < await options.count(); index++) {
    const option = options.nth(index), name = await option.locator('code').textContent();
    await option.getByRole('checkbox').setChecked(name === outputName);
  }
  assert.equal(await editor().locator('.notebook-input-list input:checked').count(), 1);
}
async function run(key, status = 'success') {
  await dismissNotice();
  const next = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await cell(key).getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await next, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, status, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body.run;
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a synthetic project; import 1324 rows and run real SQL with 45 typed edge-case rows', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 结果展示独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'presentation-1324.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' });
    savedBefore = await manifest((value) => value.tables.length === 1 && value.files.length === 1);
    sourceBefore = await sourceDataset(); assert.equal(sourceBefore.rows.length, ROW_COUNT);
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveNew('data');
    await start('sql'); await selectOnlyInput(cells.data.output);
    await editor().getByLabel('SQL', { exact: true }).fill(query); await saveNew('sql');
    assert.deepEqual((await run('sql')).cells.at(-1).table.rows, expected);
    assert.deepEqual(await visibleRows('sql'), display(expected.slice(0, 20)));
  });
  await step('Sort the whole 45-row preview numerically, stably and NULL-last in both directions, without requests', async () => {
    const before = actions.length, document = await savedDocument();
    await sort('sql', 'score', 'ascending', 'Enter');
    assert.deepEqual(await visibleRows('sql'), display(ordered('score', 'ascending').slice(0, 20)));
    assert.equal((await visibleRows('sql'))[0][0], '45', 'Minimum originally on final page must move to first');
    await shot('01-numeric-sort-1440', cell('sql').locator('thead'), ['2 precedes 10; last-page minimum becomes first', 'Equal score seq 1 and 3 retain their original order']);
    assert.deepEqual(await allPreviewRows('sql'), display(ordered('score', 'ascending')));
    await sort('sql', 'score', 'descending');
    assert.deepEqual(await allPreviewRows('sql'), display(ordered('score', 'descending')));
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-null-last-descending-1024', cell('sql').locator('tbody'), ['Final page retains NULL rows at the end when descending', 'Preview pages contain at most 20 rows']);
    await sort('sql', 'score', 'none');
    assert.deepEqual(await visibleRows('sql'), display(expected.slice(0, 20)));
    assert.equal(await cell('sql').getByRole('button', { name: '上一页结果', exact: true }).isDisabled(), true);
    assert.match(await cell('sql').innerText(), /仅对当前预览排序，不会重新查询或改变下游计算。/);
    assert.equal(actions.length, before); assert.deepEqual(await savedDocument(), document);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Numeric-looking strings keep leading zeros and precision; a fresh run resets sort and page', async () => {
    await sort('sql', 'code', 'ascending');
    assert.deepEqual(await allPreviewRows('sql'), display(ordered('code', 'ascending')));
    await sort('sql', 'code', 'descending');
    assert.deepEqual(await allPreviewRows('sql'), display(ordered('code', 'descending')));
    await sort('sql', 'code', 'none'); await sort('sql', 'code', 'ascending');
    assert.deepEqual(await visibleRows('sql'), display(ordered('code', 'ascending').slice(0, 20)));
    await shot('03-string-precision-1440', cell('sql').locator('thead'), ['001 remains text', '9007199254740992 and 9007199254740993 remain distinct and lexically ordered']);
    await cell('sql').getByRole('button', { name: '下一页结果', exact: true }).click();
    const previousRunId = runs.at(-1).runId;
    const next = await run('sql'); assert.notEqual(next.runId, previousRunId);
    assert.deepEqual(next.cells.at(-1).table.rows, expected);
    assert.deepEqual(await visibleRows('sql'), display(expected.slice(0, 20)));
    assert.equal(await header('sql', 'code').evaluate((button) => button.closest('th').getAttribute('aria-sort')), 'none');
    assert.equal(await cell('sql').getByRole('button', { name: '上一页结果', exact: true }).isDisabled(), true);
  });
  await step('Real downstream SQL and chart use original results; sorting the chart table never mutates its SVG', async () => {
    await sort('sql', 'score', 'ascending'); await sort('sql', 'score', 'descending');
    await start('aggregate'); await selectOnlyInput(cells.sql.output);
    await editor().getByLabel('SQL', { exact: true }).fill(aggregateQuery); await saveNew('aggregate');
    assert.deepEqual((await run('aggregate')).cells.at(-1).table.rows, expectedChart);
    await start('chart'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.aggregate);
    await editor().getByLabel('分类字段', { exact: true }).fill('category');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('value'); await saveNew('chart');
    assert.deepEqual((await run('chart')).cells.at(-1).table.rows, expectedChart);
    const plot = cell('chart').getByRole('img', { name: /图表下方提供对应数据表/ }); await plot.waitFor();
    await page.mouse.move(1, 1);
    const chartSvg = plot.locator('svg[role="application"]');
    const svg = await chartSvg.innerHTML(), before = actions.length;
    await sort('chart', 'value', 'ascending', 'Space'); await sort('chart', 'value', 'descending');
    assert.deepEqual(await visibleRows('chart'), display([...expectedChart].sort((a, b) => b.value - a.value)));
    await page.mouse.move(1, 1); assert.equal(await chartSvg.innerHTML(), svg); assert.equal(actions.length, before);
    await shot('04-chart-independent-1440', plot, ['Real SQL totals match independent JavaScript sums', 'Chart stays A/B/C while its table is value-descending']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('05-chart-independent-1024', plot, ['Supported desktop width retains chart and independently sorted table']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('1000-row display sorts only its preview, without relabeling the complete 1324 rows', async () => {
    await start('transform'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.data);
    await editor().getByLabel('步骤 1 类型', { exact: true }).selectOption('limit');
    await editor().getByLabel('行数', { exact: true }).fill('2000'); await saveNew('transform');
    const result = (await run('transform')).cells.at(-1);
    assert.equal(result.table.rows.length, 1000); assert.equal(result.resultRef.rowCount, 1324); assert.equal(result.resultRef.complete, true);
    await sort('transform', 'seq', 'ascending'); await sort('transform', 'seq', 'descending');
    assert.deepEqual((await visibleRows('transform'))[0], ['1000', '1']);
    assert.equal(await cell('transform').getByLabel('结果范围', { exact: true }).textContent(), '完整结果 1324 行 · 当前预览 1000 行 · 2 列');
    assert.equal(await cell('transform').getByRole('button', { name: '保存为 Dataset', exact: true }).isEnabled(), true);
    assert.equal(await cell('transform').getByRole('button', { name: '生成看板预览 ↗', exact: true }).isDisabled(), true);
    await shot('06-preview-only-scope-1440', cell('transform').locator('.notebook-result > footer'), ['Descending begins at preview row 1000, not hidden complete row 1324', 'Save and dashboard availability keep existing complete-result boundaries']);
    await cell('transform').getByRole('button', { name: '下一页结果', exact: true }).click();
    assert.equal(await cell('transform').getByRole('button', { name: '上一页结果', exact: true }).isEnabled(), true);
    const priorRunId = runs.at(-1).runId;
    const rerun = await run('transform'); assert.notEqual(rerun.runId, priorRunId);
    assert.equal(rerun.cells.at(-1).resultRef.rowCount, 1324);
    assert.deepEqual((await visibleRows('transform'))[0], ['1', '1']);
    assert.equal(await header('transform', 'seq').evaluate((button) => button.closest('th').getAttribute('aria-sort')), 'none');
    assert.equal(await cell('transform').getByRole('button', { name: '上一页结果', exact: true }).isDisabled(), true);
  });
  await step('A real SQL error removes stale chart output and blocks downstream; explicit repair restores results', async () => {
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT missing_presentation_column FROM raw_rows'); await save();
    const result = await run('chart', 'failure');
    assert.deepEqual(result.cells.map((item) => item.status), ['success', 'failure', 'blocked', 'blocked']);
    assert.equal(await cell('chart').locator('table').count(), 0);
    assert.equal(await cell('chart').locator('.notebook-plot').count(), 0);
    await shot('07-real-sql-failure-1440', cell('sql'), ['Actual local DuckDB binding failure', 'No successful old chart/table is reused']);
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.match(await cell('chart').innerText(), /上游步骤失败，未使用旧结果继续计算/);
    await shot('08-blocked-chart-1024', cell('chart'), ['Chart explicitly blocked; no fake successful preview']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill(query); await save();
    assert.deepEqual((await run('chart')).cells.at(-1).table.rows, expectedChart);
  });
  await step('Cancel editing and reopen preserve definitions and source data; presentation sorting is not persisted', async () => {
    const before = await savedDocument();
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT 999 AS unsaved_change');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before);
    await shot('09-cancelled-edit-1440', cell('sql'), ['Cancelled SQL draft is not saved', 'Formal query and repaired downstream definitions remain unchanged']);
    await sort('chart', 'value', 'ascending'); await sort('chart', 'value', 'descending');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), before);
    assert.deepEqual((await run('chart')).cells.at(-1).table.rows, expectedChart);
    assert.equal(await header('chart', 'value').evaluate((button) => button.closest('th').getAttribute('aria-sort')), 'none');
    assert.deepEqual(await visibleRows('chart'), display(expectedChart));
    const final = await manifest(); assert.deepEqual(final.files, savedBefore.files); assert.deepEqual(final.tables, savedBefore.tables);
    assert.deepEqual(await sourceDataset(), sourceBefore); assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('10-reopened-real-chart-1024', cell('chart').locator('.notebook-plot'), ['Reopened synthetic project runs original SQL and chart successfully', 'Sort state is local presentation only; no Dashboard or source changes']);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, runs, actions, ids,
    expected, expectedChart, pageErrors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic local project only; actual CSV upload, HTTP, DuckDB and DataRecipe execution.',
      'Connections GET is an explicit empty-directory fixture. No provider credentials or real model/warehouse calls.',
      'Sort is preview-only: no network query, result rewrite, persisted document change or changed chart SVG.',
      'A fresh execution and page reload reset transient sorting; edit cancellation preserves formal definitions.',
      'All synthetic evidence and project files retained; no cleanup, service lifecycle, stable publication or mobile verification.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
