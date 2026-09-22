// Existing managed 3001 site only. Execute after the implementation is frozen.
// A new synthetic project only; no model, Python, warehouse or user-project access.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CELLS, COUNT_SQL, CSV, EXPECTED, ROW_COUNT, TRUNCATED_SQL } from './fixtures/result-access.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/result-access-2026-09-16', `browser-${Date.now()}`);
const projectPath = resolve(directory, 'project');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [], snapshots = [];
const ids = {};
let scenario = 'setup', passed = false, failure, handle, pageId, sourceId, savedId, rejectedSave, finalDocument;
let sourceBefore, sourceEntryBefore, originalFiles, directoryReads = 0;
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
      forbiddenRequests.push('Only local synthetic Data, DataRecipe and SQL allowed'); return route.abort('blockedbyclient');
    }
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document?.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${CELLS[key].label}单元 ${CELLS[key].title}`, exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const datasetButton = (key) => cell(key).getByRole('button', { name: '保存为 Dataset', exact: true });
const dashboardButton = (key) => cell(key).getByRole('button', { name: '生成看板预览 ↗', exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
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
async function dataset(id) {
  assert.ok([sourceId, savedId].includes(id), 'Only this fixture source/saved Dataset may be read');
  const response = await context.request.get(`${base}/api/datasets/${id}`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return response.json();
}
function assertCompleteRows(rows, count = ROW_COUNT) {
  assert.equal(rows.length, count);
  assert.deepEqual(rows, Array.from({ length: count }, (_, index) => ({ seq: index + 1, amount: 1 })));
}
async function save() { await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' }); }
async function start(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${CELLS[key].label}`, exact: true }).click();
  await editor().waitFor();
  await editor().getByLabel('单元名称', { exact: true }).fill(CELLS[key].title);
  await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(CELLS[key].output);
}
async function saveNew(key) {
  await save(); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === CELLS[key].title));
  ids[key] = book.cells.find((item) => item.title === CELLS[key].title).id;
}
async function perform(key, action = 'run') {
  await dismissNotice();
  const responsePromise = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`
    && response.request().postDataJSON()?.action === action, { timeout: 45000 });
  const button = action === 'dataset' ? datasetButton(key) : action === 'snapshot' ? dashboardButton(key)
    : cell(key).getByRole('button', { name: '▶ 运行', exact: true });
  await button.click();
  const response = await responsePromise, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, 'success');
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push({ action, run: body.run });
  if (body.snapshot) snapshots.push({ action, dataset: body.snapshot.dataset, rowCount: body.snapshot.rows.length,
    firstRow: body.snapshot.rows[0], lastRow: body.snapshot.rows.at(-1) });
  return body;
}
async function selectOnlyInput(outputName) {
  const options = editor().locator('.notebook-input-list label');
  for (let index = 0; index < await options.count(); index++) {
    const option = options.nth(index), name = await option.locator('code').textContent();
    await option.getByRole('checkbox').setChecked(name === outputName);
  }
  assert.equal(await editor().locator('.notebook-input-list input:checked').count(), 1);
}
function assertFullPreview(run) {
  assert.deepEqual(run.cells.map((item) => item.cellId), [ids.data, ids.transform]);
  const [data, result] = run.cells;
  assertCompleteRows(data.table.rows, 100); assert.equal(data.table.truncated, true);
  assert.equal(data.resultRef.rowCount, ROW_COUNT); assert.equal(data.resultRef.complete, true);
  assertCompleteRows(result.table.rows, 1000); assert.equal(result.table.truncated, true);
  assert.equal(result.resultRef.rowCount, ROW_COUNT); assert.equal(result.resultRef.complete, true);
  assert.deepEqual(result.resultRef.inputResultIds, [data.resultRef.resultId]);
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create an isolated project and import 1324 unique synthetic CSV rows', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('完整结果与预览独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'result-access-1324.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); sourceId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' });
    const saved = await manifest((value) => value.tables.length === 1 && value.files.length === 1);
    sourceBefore = await dataset(sourceId); assertCompleteRows(sourceBefore.rows);
    sourceEntryBefore = saved.tables[0]; originalFiles = saved.files;
    await dismissNotice();
  });
  await step('A 1000-row DataRecipe preview is distinct from its complete 1324-row result', async () => {
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(sourceId); await saveNew('data');
    await start('transform');
    await editor().getByLabel('步骤 1 类型', { exact: true }).selectOption('limit');
    await editor().getByLabel('行数', { exact: true }).fill('2000'); await saveNew('transform');
    assertFullPreview((await perform('transform')).run);
    assert.equal(await datasetButton('transform').isEnabled(), true);
    assert.equal(await dashboardButton('transform').isDisabled(), true);
    assert.equal(await cell('transform').getByLabel('结果范围', { exact: true }).textContent(), '完整结果 1324 行 · 当前预览 1000 行 · 2 列');
    await shot('01-complete-result-preview-1440', datasetButton('transform'), ['Display payload has 1000 rows; complete execution has 1324 rows', 'Dataset save enabled; dashboard snapshot over 500 rows disabled']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-complete-result-preview-1024', datasetButton('transform'), ['Full-result and preview distinction remains readable at 1024 px']);
    assert.equal(await datasetButton('data').isDisabled(), true);
    assert.equal(await cell('data').getByLabel('结果范围', { exact: true }).textContent(), '完整结果 1324 行 · 当前预览 100 行 · 2 列');
    await shot('03-data-preview-1024', cell('data').locator('.notebook-result > footer'), ['Data displays only 100 rows but its complete source contains 1324', 'Raw Data save remains disabled']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Saving reruns the target and persists all 1324 typed rows with complete lineage', async () => {
    const previousRunId = runs.at(-1).run.runId;
    const saved = await perform('transform', 'dataset');
    assert.notEqual(saved.run.runId, previousRunId, 'Saving is a fresh execution, not a cached preview');
    assertFullPreview(saved.run); assertCompleteRows(saved.snapshot.rows);
    savedId = saved.snapshot.dataset.datasetId;
    assert.notEqual(savedId, sourceId);
    const provenance = saved.snapshot.dataset.provenance;
    assert.equal(saved.snapshot.dataset.source.rowCount, ROW_COUNT);
    assert.equal(provenance.lineage.rowCount, ROW_COUNT); assert.equal(provenance.lineage.complete, true);
    assert.equal(provenance.runId, saved.run.runId); assert.deepEqual(provenance.lineage.sourceDatasetIds, [sourceId]);
    const savedProject = await manifest((value) => value.tables.some((item) => item.descriptor.datasetId === savedId));
    assert.equal(savedProject.tables.length, 2);
    const entry = savedProject.tables.find((item) => item.descriptor.datasetId === savedId);
    const disk = JSON.parse(await readFile(resolve(projectPath, 'tables', entry.file), 'utf8'));
    assertCompleteRows(disk.rows); assert.deepEqual(disk.dataset.provenance, provenance);
    assert.deepEqual(savedProject.tables.find((item) => item.descriptor.datasetId === sourceId), sourceEntryBefore);
    const recent = page.getByRole('region', { name: '最近保存的数据集', exact: true });
    await recent.locator('.dataset-provenance > summary').click();
    assert.match(await recent.innerText(), /1324 行完整结果/);
    await shot('04-saved-complete-lineage-1440', recent, ['Fresh run saves 1324 rows rather than 1000 preview rows', 'On-disk Dataset and lineage agree; source table unchanged']);
  });
  await step('Reloading retains the complete saved Dataset and displays its provenance', async () => {
    const before = await savedDocument();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    await cell('transform').waitFor(); assert.deepEqual(await savedDocument(), before);
    const reopened = await dataset(savedId); assertCompleteRows(reopened.rows);
    assert.equal(reopened.dataset.provenance.lineage.complete, true);
    await openBrowser(); await dataBrowser().getByRole('button', { name: /已保存结果/ }).click();
    await dataBrowser().locator('.dataset-provenance > summary').click();
    assert.match(await dataBrowser().innerText(), /1324 行完整结果/);
    await shot('05-reopened-saved-dataset-1440', dataBrowser(), ['Saved result is restored from the local project', '1324-row complete lineage is visible after reload']);
    await dataBrowser().getByRole('button', { name: '关闭数据浏览器', exact: true }).click();
  });
  await step('A new Data and SQL chain independently counts and sums the saved 1324 rows', async () => {
    await start('saved'); await editor().getByLabel('数据源', { exact: true }).selectOption(savedId); await saveNew('saved');
    await start('count'); await selectOnlyInput(CELLS.saved.output);
    await editor().getByLabel('SQL', { exact: true }).fill(COUNT_SQL); await saveNew('count');
    const result = (await perform('count')).run;
    assert.deepEqual(result.cells.map((item) => item.cellId), [ids.saved, ids.count]);
    assert.deepEqual(result.cells.at(-1).table.rows, EXPECTED);
    assert.equal(result.cells[0].resultRef.rowCount, ROW_COUNT); assert.equal(result.cells[0].resultRef.complete, true);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('06-independent-count-sum-1024', cell('count'), ['Fresh SQL COUNT, SUM, unique seq and max seq are all 1324', 'Saved Dataset was not silently limited to the 1000-row preview']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('A genuinely truncated SQL result is visibly incomplete and cannot be saved', async () => {
    await start('truncated'); await selectOnlyInput(CELLS.data.output);
    await editor().getByLabel('SQL', { exact: true }).fill(TRUNCATED_SQL); await saveNew('truncated');
    const result = (await perform('truncated')).run;
    assert.deepEqual(result.cells.map((item) => item.cellId), [ids.data, ids.truncated]);
    const truncated = result.cells.at(-1);
    assertCompleteRows(truncated.table.rows, 1000); assert.equal(truncated.table.truncated, true);
    assert.equal(truncated.resultRef.complete, false); assert.equal(truncated.resultRef.rowCount, 1000);
    assert.equal(await datasetButton('truncated').isDisabled(), true);
    assert.equal(await dashboardButton('truncated').isDisabled(), true);
    assert.equal(await cell('truncated').getByLabel('结果范围', { exact: true }).textContent(), '结果不完整 · 当前预览 1000 行 · 2 列');
    await shot('07-truncated-sql-disabled-1440', datasetButton('truncated'), ['SQL execution itself is incomplete, not merely display-limited', 'Dataset and dashboard actions remain disabled']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('08-truncated-sql-disabled-1024', datasetButton('truncated'), ['Incomplete result explanation readable at desktop minimum width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('The real API rejects a forced save of the truncated result without creating a Dataset', async () => {
    const before = await manifest();
    rejectedSave = await page.evaluate(async ({ document, selectedPage, project, target }) => {
      const response = await fetch('/api/notebook/run', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-agentcanvas-project': project,
      }, body: JSON.stringify({ pageId: selectedPage, document, semanticModels: [], targetCellId: target, action: 'dataset' }) });
      return { status: response.status, body: await response.json() };
    }, { document: await savedDocument(), selectedPage: pageId, project: handle, target: ids.truncated });
    assert.equal(rejectedSave.status, 400); assert.match(rejectedSave.body.error?.message ?? '', /截断|不完整/);
    assert.equal(rejectedSave.body.snapshot, undefined);
    const after = await manifest(); assert.deepEqual(after.tables, before.tables);
    assert.deepEqual(after.state.appSpec.pages, before.state.appSpec.pages);
  });
  await step('A complete 100-row recipe may preview a dashboard but cancellation leaves it unchanged', async () => {
    await cell('transform').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('行数', { exact: true }).fill('100'); await save();
    const result = (await perform('transform')).run.cells.at(-1);
    assertCompleteRows(result.table.rows, 100); assert.equal(result.table.truncated, false);
    assert.equal(result.resultRef.complete, true); assert.equal(result.resultRef.rowCount, 100);
    assert.equal(await datasetButton('transform').isEnabled(), true);
    assert.equal(await dashboardButton('transform').isEnabled(), true);
    await shot('09-small-complete-result-1440', dashboardButton('transform'), ['Explicit recipe limit produces a complete 100-row result', 'Both actions available within their existing boundaries']);
    const formal = structuredClone((await manifest()).state.appSpec.pages);
    const preview = await perform('transform', 'snapshot'); assertCompleteRows(preview.snapshot.rows, 100);
    await page.getByRole('button', { name: '应用编辑', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '看板', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual((await manifest((value) => value.tables.length === 3)).state.appSpec.pages, formal);
    await shot('10-unapplied-dashboard-preview-1440', page.locator('.canvas-toolbar'), ['100-row snapshot preview exists but formal dashboard remains unchanged', 'No automatic apply/confirmation']);
    await page.getByRole('button', { name: '取消预览', exact: true }).click();
    await page.getByRole('button', { name: '应用编辑', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual((await manifest()).state.appSpec.pages, formal);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('11-cancelled-dashboard-preview-1024', page.locator('.canvas-toolbar'), ['Cancelling preview leaves the empty formal dashboard unchanged', 'The separately saved synthetic snapshot is retained, not deleted']);
  });
  await step('The original CSV, source table and saved 1324-row Dataset remain unchanged', async () => {
    const final = await manifest();
    assert.equal(final.tables.length, 3); assert.deepEqual(final.files, originalFiles);
    assert.deepEqual(final.tables.find((entry) => entry.descriptor.datasetId === sourceId), sourceEntryBefore);
    assert.deepEqual(await dataset(sourceId), sourceBefore); assertCompleteRows((await dataset(savedId)).rows);
    assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
    finalDocument = final.state.dataProduct.notebooks[pageId];
    assert.equal(finalDocument.cells.length, 5);
    assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0);
  });
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, ids, sourceId, savedId,
    runs, actions, snapshots, rejectedSave, finalDocument, pageErrors, forbiddenRequests, directoryReads,
    realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic local project and generated 1324-row CSV only; actual HTTP, DataRecipe, DuckDB and local storage.',
      'Connection GET uses an explicit empty-directory fixture. No credentials or provider configuration read/changed.',
      'Saving Dataset reruns the target; bounded display rows and complete saved rows are asserted independently.',
      'SQL row-cap truncation is not treated as a complete result; forced-save HTTP rejection is separately verified.',
      'Dashboard cancellation does not delete the already stored result snapshot. All synthetic project data is retained.',
      'No running-task cancellation, real model, Python, external database, service operation, publication or user-project access.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, actions: actions.length, directory, failure }, null, 2));
}
