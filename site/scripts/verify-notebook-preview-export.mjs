// Existing managed 3001 only; isolated browser and a newly created synthetic
// project. Real CSV import, local SQL/DataRecipe, downloads and persistence.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { chromium } from 'playwright-core';
import { CSV, ROW_COUNT } from './fixtures/result-access.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-preview-export-2026-09-17', `browser-${Date.now()}`);
const cells = {
  data: { label: 'Data', title: '1324 行合成导出源', output: 'raw_rows' },
  sql: { label: 'SQL', title: '45 行精度与文本导出', output: 'export_rows' },
  aggregate: { label: 'SQL', title: '导出不影响下游汇总', output: 'chart_rows' },
  chart: { label: '图表', title: '独立图表与预览导出' },
  transform: { label: 'DataRecipe', title: '完整 1324 行只导出预览 1000 行', output: 'complete_rows' },
  truncated: { label: 'SQL', title: '真实截断也仅导出已返回行', output: 'truncated_rows' },
  empty: { label: 'SQL', title: '空查询结果仍可导出表头', output: 'empty_rows' },
};
const formulas = ['=1+1', '+1', '-2', '@SUM(1,2)', '\t=2', '  =3', '\r=4', '\n=5'];
const multiline = '中文, "引号"\n下一行';
const query = `SELECT seq,
  CASE WHEN seq IN (43,44) THEN NULL WHEN seq=45 THEN -10 ELSE seq * 2 END::DOUBLE AS score,
  CASE seq WHEN 1 THEN '001' WHEN 2 THEN '9007199254740993' WHEN 3 THEN '9007199254740992' ELSE 'x' || CAST(CAST(seq AS BIGINT) AS VARCHAR) END AS code,
  CASE seq WHEN 1 THEN '中文, "引号"' || chr(10) || '下一行' WHEN 2 THEN NULL ELSE '普通文本' END AS "=note",
  '2026-09-17'::VARCHAR AS date_text,
  (CAST(seq AS BIGINT) % 2 = 1) AS enabled,
  CASE seq WHEN 1 THEN '=1+1' WHEN 2 THEN '+1' WHEN 3 THEN '-2' WHEN 4 THEN '@SUM(1,2)'
    WHEN 5 THEN chr(9) || '=2' WHEN 6 THEN '  =3' WHEN 7 THEN chr(13) || '=4' WHEN 8 THEN chr(10) || '=5' ELSE 'safe' END AS formula
FROM raw_rows WHERE seq <= 45 ORDER BY seq`;
const expected = Array.from({ length: 45 }, (_, index) => {
  const seq = index + 1;
  return { seq, score: [43, 44].includes(seq) ? null : seq === 45 ? -10 : seq * 2,
    code: ['001', '9007199254740993', '9007199254740992'][index] ?? `x${seq}`,
    field_4: seq === 1 ? multiline : seq === 2 ? null : '普通文本', date_text: '2026-09-17', enabled: seq % 2 === 1,
    formula: formulas[index] ?? 'safe' };
});
const headers = ['seq', 'score', 'code', 'field_4', 'date_text', 'enabled', 'formula'];
function records(rows) {
  return [headers, ...rows.map((row) => [String(row.seq), row.score == null ? '' : String(row.score), row.code,
    row.field_4 ?? '', row.date_text, String(row.enabled), row.seq <= formulas.length ? `'${row.formula}` : row.formula])];
}
function ordered(direction) {
  return [...expected].sort((a, b) => a.score === null ? b.score === null ? 0 : 1
    : b.score === null ? -1 : direction === 'ascending' ? a.score - b.score : b.score - a.score);
}
const aggregateQuery = "SELECT CASE WHEN seq <= 15 THEN 'A' WHEN seq <= 30 THEN 'B' ELSE 'C' END AS category, SUM(score)::DOUBLE AS value FROM export_rows GROUP BY category ORDER BY category";
const expectedChart = ['A', 'B', 'C'].map((category, index) => ({ category,
  value: expected.slice(index * 15, (index + 1) * 15).reduce((sum, row) => sum + (row.score ?? 0), 0) }));

await mkdir(resolve(directory, 'downloads'), { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [], requests = [], downloads = [], ids = {};
let scenario = 'setup', passed = false, failure, handle, pageId, datasetId, sourceBefore, projectBefore, directoryReads = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/connections/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: request.method() });
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection write prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.ok(body.document.cells.every((cell) => !['warehouseSql', 'python'].includes(cell.kind)), 'Only synthetic local data/SQL/chart/recipe execution');
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const exportRegion = (key) => cell(key).getByRole('region', { name: '当前预览导出', exact: true });
const exportButton = (key) => cell(key).getByRole('button', { name: '导出当前预览 CSV', exact: true });
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
  assert.ok(handle, 'Only this newly created synthetic project may be read');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
    assert.equal(response.status(), 200); const value = (await response.json()).manifest;
    if (predicate(value) && /已保存到本地项目|已打开本地项目/.test(await page.locator('.top-actions').textContent())) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Synthetic project did not finish saving');
}
async function savedDocument(predicate = () => true) {
  const result = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId]; return Boolean(book && predicate(book));
  }); return result.state.dataProduct.notebooks[pageId];
}
async function dataset() {
  assert.ok(handle && datasetId);
  const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return response.json();
}
async function save({ creating = false } = {}) {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  if (creating) {
    await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
    const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
    if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  }
  await editor().waitFor({ state: 'hidden' });
}
async function start(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${cells[key].label}`, exact: true }).click();
  await editor().waitFor(); await editor().getByLabel('单元名称', { exact: true }).fill(cells[key].title);
  if (cells[key].output) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(cells[key].output);
}
async function saveNew(key) {
  await save({ creating: true }); await cell(key).waitFor();
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
  const response = await next, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, status, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body.run;
}
async function sort(key, field, direction) {
  const button = cell(key).getByRole('button', { name: `按${field}排序`, exact: true }); await button.click();
  assert.equal(await button.evaluate((element) => element.closest('th').getAttribute('aria-sort')), direction);
}
async function download(key, name, expectedRecords) {
  const requestCount = requests.length, runCount = actions.length;
  const next = page.waitForEvent('download'); await exportButton(key).click(); const item = await next;
  assert.match(item.suggestedFilename(), /^notebook-.+-preview\.csv$/);
  assert.equal(await item.failure(), null); const path = resolve(directory, 'downloads', `${name}.csv`); await item.saveAs(path);
  const bytes = await readFile(path), decoded = bytes.toString('utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  assert.deepEqual(parse(bytes, { bom: true, record_delimiter: '\r\n' }), expectedRecords, 'All preview values and order');
  const expectedBytes = '\ufeff' + expectedRecords.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
  assert.equal(decoded, expectedBytes, 'Every field quoted, CRLF records, exact escaping and formula safeguards');
  assert.equal(actions.length, runCount); assert.equal(requests.length, requestCount, 'Export must not request data or rerun');
  assert.match(await exportRegion(key).getByRole('status').innerText(), new RegExp(`已发起当前预览 CSV 下载：${expectedRecords.length - 1} 行`));
  downloads.push({ file: `downloads/${name}.csv`, suggestedFilename: item.suggestedFilename(), dataRows: expectedRecords.length - 1,
    columns: expectedRecords[0].length, bytes: bytes.length, scenario, checked: 'Exact UTF-8 BOM/quoted CRLF bytes plus independent csv-parse records' });
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create isolated project, import 1324 synthetic rows and execute 45 typed edge-case SQL rows', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
    await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 当前预览CSV导出验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')); pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'export-synthetic-1324.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' }); projectBefore = await manifest((value) => value.tables.length === 1 && value.files.length === 1);
    sourceBefore = await dataset(); assert.equal(sourceBefore.rows.length, ROW_COUNT);
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveNew('data');
    await start('sql'); await selectOnlyInput(cells.data.output); await editor().getByLabel('SQL', { exact: true }).fill(query); await saveNew('sql');
    const result = (await run('sql')).cells.at(-1); assert.deepEqual(result.table.rows, expected);
    assert.equal(result.table.fields[3].label, '=note'); assert.equal(result.table.rows.length, 45);
  });
  await step('Downloads contain all 45 sorted preview rows, not the visible page, with exact safe CSV encoding', async () => {
    const before = await savedDocument(), count = actions.length;
    await sort('sql', 'score', 'ascending'); await cell('sql').getByRole('button', { name: '下一页结果', exact: true }).click();
    assert.equal(await cell('sql').locator('tbody tr').count(), 20);
    await download('sql', '01-all-45-ascending', records(ordered('ascending')));
    await exportRegion('sql').getByText('导出说明', { exact: true }).click();
    await shot('01-sorted-whole-preview-1440', exportRegion('sql'), ['Visible page has 20 rows but download has all 45 sorted rows', 'Exports field identifiers, not dangerous display labels; exact strings, formula safeguards, NULL, numeric negatives and encoding checked byte-for-byte']);
    await sort('sql', 'score', 'descending');
    await cell('sql').getByRole('button', { name: '下一页结果', exact: true }).click(); await cell('sql').getByRole('button', { name: '下一页结果', exact: true }).click();
    assert.equal(await cell('sql').locator('tbody tr').count(), 5);
    await download('sql', '02-all-45-descending', records(ordered('descending')));
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-last-page-still-all-45-1024', exportRegion('sql'), ['Last page displays five rows; download still contains all 45', 'NULL stays last, declared negative numbers are not apostrophe-prefixed']);
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
  });
  await step('Injected browser download failure is visible and retry succeeds without a query or lost result', async () => {
    const before = actions.length, count = downloads.length;
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = (...args) => { URL.createObjectURL = original; void args; throw new Error('Synthetic object URL failure'); };
    });
    await exportButton('sql').click(); await exportRegion('sql').getByRole('alert').waitFor();
    assert.match(await exportRegion('sql').getByRole('alert').innerText(), /失败.*重试/); assert.equal(await exportButton('sql').isEnabled(), true);
    assert.equal(downloads.length, count); assert.equal(actions.length, before);
    await shot('03-download-failure-retry-1024', exportRegion('sql'), ['One browser URL allocation failure is injected, not a server response', 'Visible failure leaves the preview and retry button available']);
    await download('sql', '03-retry-all-45', records(ordered('descending')));
    assert.equal(await exportRegion('sql').getByRole('alert').count(), 0);
    await shot('04-download-retry-success-1024', exportRegion('sql'), ['Restored browser download succeeds using the same result', 'No new run or fetch; exact exported bytes verified']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Exporting a chart data preview leaves the original chart SVG and downstream computation unchanged', async () => {
    await start('aggregate'); await selectOnlyInput(cells.sql.output); await editor().getByLabel('SQL', { exact: true }).fill(aggregateQuery); await saveNew('aggregate');
    assert.deepEqual((await run('aggregate')).cells.at(-1).table.rows, expectedChart);
    await start('chart'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.aggregate);
    await editor().getByLabel('分类字段', { exact: true }).fill('category'); await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('value'); await saveNew('chart');
    assert.deepEqual((await run('chart')).cells.at(-1).table.rows, expectedChart);
    const plot = cell('chart').getByRole('img', { name: /图表下方提供对应数据表/ }); await plot.waitFor(); await page.mouse.move(1, 1);
    const svg = await plot.locator('svg[role="application"]').innerHTML();
    await sort('chart', 'value', 'ascending'); await sort('chart', 'value', 'descending');
    const sorted = [...expectedChart].sort((a, b) => b.value - a.value);
    await download('chart', '04-chart-preview', [['category', 'value'], ...sorted.map((row) => [row.category, String(row.value)])]);
    await page.mouse.move(1, 1); assert.equal(await plot.locator('svg[role="application"]').innerHTML(), svg);
    await shot('05-chart-export-independent-1440', exportRegion('chart'), ['Export uses independently sorted chart data preview', 'SVG stays in original A/B/C order; source data and calculation unchanged']);
  });
  await step('Complete 1324-row result exports only the 1000 returned preview rows', async () => {
    await start('transform'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.data);
    await editor().getByLabel('步骤 1 类型', { exact: true }).selectOption('limit'); await editor().getByLabel('行数', { exact: true }).fill('2000'); await saveNew('transform');
    const result = (await run('transform')).cells.at(-1); assert.equal(result.table.rows.length, 1000);
    assert.equal(result.resultRef.rowCount, 1324); assert.equal(result.resultRef.complete, true);
    await sort('transform', 'seq', 'ascending'); await sort('transform', 'seq', 'descending');
    await download('transform', '05-preview-1000-not-1324', [['seq', 'amount'], ...Array.from({ length: 1000 }, (_, index) => [String(1000 - index), '1'])]);
    assert.match(await cell('transform').getByLabel('结果范围', { exact: true }).innerText(), /完整结果 1324 行 · 当前预览 1000 行/);
    await exportRegion('transform').getByText('导出说明', { exact: true }).click();
    await shot('06-complete-vs-preview-export-1440', exportRegion('transform'), ['Complete result is 1324, explicit export scope is current 1000 preview rows', 'Hidden rows are never fetched; descending starts at 1000, not 1324']);
  });
  await step('A genuinely truncated SQL result remains labeled incomplete but can export its returned preview', async () => {
    await start('truncated'); await selectOnlyInput(cells.data.output);
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT * FROM raw_rows ORDER BY seq'); await saveNew('truncated');
    const result = (await run('truncated')).cells.at(-1); assert.equal(result.table.truncated, true); assert.equal(result.resultRef.complete, false);
    assert.equal(result.table.rows.length, 1000); assert.match(await cell('truncated').getByLabel('结果范围', { exact: true }).innerText(), /结果不完整 · 当前预览 1000 行/);
    await download('truncated', '06-truncated-preview', [['seq', 'amount'], ...Array.from({ length: 1000 }, (_, index) => [String(index + 1), '1'])]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('07-incomplete-preview-export-1024', exportRegion('truncated'), ['Real DuckDB result is incomplete and explicitly labeled', 'CSV contains only the 1000 returned rows, not a claimed complete dataset']);
  });
  await step('A successful empty result exports exactly its header, not a fake row or failure', async () => {
    await start('empty'); await selectOnlyInput(cells.data.output);
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT seq, amount FROM raw_rows WHERE false'); await saveNew('empty');
    const result = (await run('empty')).cells.at(-1); assert.deepEqual(result.table.rows, []); assert.equal(result.resultRef.complete, true);
    await download('empty', '07-empty-header-only', [['seq', 'amount']]);
    assert.match(await exportRegion('empty').innerText(), /0 行/);
    await shot('08-empty-success-header-only-1024', exportRegion('empty'), ['Real query succeeds with zero rows', 'Exact downloaded file is BOM plus quoted header and CRLF']);
  });
  await step('Edit cancellation preserves definitions; stale, failed and reopened results cannot export old values', async () => {
    const before = await savedDocument(), count = actions.length;
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT 999 AS cancelled'); await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    await shot('09-cancelled-edit-preserves-source-1024', cell('sql'), ['Cancelling editor draft does not save or execute', 'This does not claim visibility into the native save-dialog cancellation']);
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT nonexistent_export_column FROM raw_rows'); await save();
    assert.equal(await exportButton('sql').count(), 0); await run('sql', 'failure'); assert.equal(await exportButton('sql').count(), 0);
    await shot('10-failed-result-not-exportable-1024', cell('sql'), ['Real invalid SQL fails; neither stale nor failed output offers a CSV export', 'Old result is not reused']);
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('SQL', { exact: true }).fill(query); await save();
    assert.deepEqual((await run('sql')).cells.at(-1).table.rows, expected); await download('sql', '08-repaired-original-order', records(expected));
    const repaired = await savedDocument();
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), repaired); assert.equal(await page.getByRole('button', { name: '导出当前预览 CSV', exact: true }).count(), 0);
    assert.deepEqual((await run('sql')).cells.at(-1).table.rows, expected); await download('sql', '09-reopened-original-order', records(expected));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('11-reopened-export-after-rerun-1440', exportRegion('sql'), ['Reopened definition has no persisted result or export until manually rerun', 'New result exports original order and exact text']);
    const final = await manifest(); assert.deepEqual(final.files, projectBefore.files); assert.deepEqual(final.tables, projectBefore.tables);
    assert.deepEqual(await dataset(), sourceBefore); assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, downloads, runs, actions, ids,
    pageErrors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic project and isolated browser only; actual import, HTTP, local SQL, DataRecipe, chart and downloads.',
      'Connections GET is an explicit empty-directory fixture; provider, remote connection and external network requests prohibited.',
      'Downloaded bytes checked exactly and independently parsed; exported rows are the whole returned preview, never the hidden full result.',
      'One browser URL.createObjectURL failure deliberately injected then restored; no server success/failure fixture.',
      'Cancellation covers editor cancellation only; native browser save-dialog cancellation is not observable or claimed.',
      'No spreadsheet application was opened; formula guards reduce CSV execution risk but do not guarantee external import types.',
      'All synthetic evidence and project retained; no deletion, service operation, stable publication or mobile verification.'] }, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, downloads: downloads.length,
    runs: runs.length, directory, failure }, null, 2));
}
