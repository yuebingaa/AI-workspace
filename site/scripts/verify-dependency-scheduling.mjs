// Existing managed 3001 site only. Run after the implementation is frozen.
// Every write is to a newly created synthetic project; no model or warehouse calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CSV, EXPECTED, SQL, DEPENDENT_SQL, INVALID_SQL, CELLS } from './fixtures/dependency-scheduling.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/dependency-scheduling-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], inputCandidates = [];
const ids = {};
let scenario = 'setup', passed = false, failure, handle, pageId, datasetId, rejectedCycle, finalDocument;
let directoryReads = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection POST is prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    if (body.document?.cells.some((cell) => ['warehouseSql', 'python'].includes(cell.kind))) {
      forbiddenRequests.push('Only synthetic local Data/SQL/chart execution is allowed'); return route.abort('blockedbyclient');
    }
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${CELLS[key].label}单元 ${CELLS[key].title}`, exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page-wide desktop overflow');
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
async function save() { await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' }); }
async function start(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${CELLS[key].label}`, exact: true }).click();
  await editor().waitFor();
  await editor().getByLabel('单元名称', { exact: true }).fill(CELLS[key].title);
  if (CELLS[key].output) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(CELLS[key].output);
}
async function saveNew(key) {
  await save(); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === CELLS[key].title));
  ids[key] = book.cells.find((item) => item.title === CELLS[key].title).id;
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
function assertChartRun(result) {
  assert.deepEqual(result.cells.map((item) => item.cellId), [ids.data, ids.sql, ids.chart]);
  assert.deepEqual(result.cells.map((item) => item.status), ['success', 'success', 'success']);
  assert.deepEqual(result.cells.at(-1).table.rows, EXPECTED);
  assert.deepEqual(result.cells[1].resultRef.inputResultIds, [result.cells[0].resultRef.resultId]);
  assert.deepEqual(result.cells[2].resultRef.inputResultIds, [result.cells[1].resultRef.resultId]);
  assert.equal(result.cells.some((item) => item.cellId === ids.downstream), false, 'Unrelated downstream branch is not part of target closure');
}
async function assertDisplayOrder(keys) {
  assert.deepEqual(await page.locator('.notebook-cell > header h2').allTextContents(), keys.map((key) => CELLS[key].title));
  const document = await savedDocument((value) => value.cells.map((item) => item.id).join() === keys.map((key) => ids[key]).join());
  return document;
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create an isolated project and import one synthetic CSV', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('依赖调度独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'dependency-scheduling-sales.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' });
    await manifest((value) => value.tables.length === 1 && value.files.length === 1); await dismissNotice();
  });
  await step('Build a real Data to SQL to chart chain with a separate named downstream SQL branch', async () => {
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveNew('data');
    await start('sql'); await editor().getByLabel('SQL', { exact: true }).fill(SQL); await saveNew('sql');
    assert.deepEqual((await run('sql')).cells.at(-1).table.rows, EXPECTED);
    await start('downstream'); await editor().getByLabel('SQL', { exact: true }).fill(DEPENDENT_SQL); await saveNew('downstream');
    // Existing chart creation requires real fields from the latest named output.
    assert.deepEqual((await run('downstream')).cells.at(-1).table.rows, EXPECTED);
    await start('chart'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.sql);
    await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('revenue'); await saveNew('chart');
    assertChartRun(await run('chart'));
    await cell('chart').getByRole('img', { name: /图表下方提供对应数据表/ }).waitFor();
    await shot('01-initial-real-chain-1440', cell('chart'), ['Actual local SQL and chart both return East=150 and South=80', 'Named dependent SQL exists but target closure excludes it']);
  });
  await step('Move the chart before its dependencies and Data after SQL without changing computed dependency order', async () => {
    for (let move = 0; move < 3; move++) await cell('chart').getByRole('button', { name: `上移 ${CELLS.chart.title}`, exact: true }).click();
    for (let move = 0; move < 2; move++) await cell('data').getByRole('button', { name: `下移 ${CELLS.data.title}`, exact: true }).click();
    await assertDisplayOrder(['chart', 'sql', 'downstream', 'data']);
    assertChartRun(await run('chart'));
    await shot('02-chart-first-1440', cell('chart'), ['Chart is displayed first while run receipt is Data→SQL→chart', 'Forward visual dependencies produce 150/80 and exact linked result references']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('03-chart-first-1024', cell('chart'), ['Same dependency-scheduled result is readable at the minimum desktop width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Editors retain and select later visual inputs while excluding self and named downstream candidates', async () => {
    const before = await savedDocument();
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    const candidates = await editor().locator('.notebook-input-list code').allTextContents();
    assert.deepEqual(candidates, [CELLS.data.output]);
    assert.equal(await editor().getByRole('checkbox').count(), 1);
    assert.equal(await editor().getByRole('checkbox').isChecked(), true);
    inputCandidates.push({ cellId: ids.sql, displayIndex: 1, inputDisplayIndex: 3, outputs: candidates, excluded: [ids.sql, ids.downstream] });
    await shot('04-forward-sql-input-1440', editor(), ['Data is visually last but remains checked', 'Current SQL and its named downstream SQL are not offered as inputs']);
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT region, amount AS revenue FROM sales_data');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before, 'Cancel does not save the valid but changed SQL draft');
    await cell('chart').getByRole('button', { name: '编辑', exact: true }).click();
    const upstream = editor().getByLabel('上游输出', { exact: true });
    assert.equal(await upstream.inputValue(), ids.sql);
    const optionIds = await upstream.locator('option').evaluateAll((options) => options.map((option) => option.value));
    assert.deepEqual([...optionIds].sort(), [ids.data, ids.sql, ids.downstream].sort());
    await upstream.selectOption(ids.data); await upstream.selectOption(ids.sql);
    await shot('05-forward-chart-input-1440', editor(), ['Existing SQL input retained even though it is below this chart', 'Later visible eligible outputs can be selected explicitly']);
    await save();
    const saved = await savedDocument((value) => value.revision > before.revision);
    assert.deepEqual(saved.cells, before.cells, 'Saving the selected later input preserves the same valid bindings');
  });
  await step('An actual upstream SQL failure blocks the visually earlier chart and explicit repair restores output', async () => {
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill(INVALID_SQL); await save();
    const failed = await run('chart', 'failure');
    assert.deepEqual(failed.cells.map((item) => item.cellId), [ids.data, ids.sql, ids.chart]);
    assert.deepEqual(failed.cells.map((item) => item.status), ['success', 'failure', 'blocked']);
    assert.equal(failed.cells.at(-1).table, undefined);
    assert.equal(await cell('chart').locator('table').count(), 0);
    assert.match(await cell('chart').innerText(), /上游步骤失败，未使用旧结果继续计算/);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('06-forward-chart-blocked-1024', cell('chart'), ['Real SQL error makes the earlier chart blocked', 'No stale chart table or successful result reused']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('SQL', { exact: true }).fill(SQL); await save();
    assertChartRun(await run('chart'));
    await shot('07-repaired-chart-1440', cell('chart'), ['Repair reruns real local dependencies and restores 150/80', 'Display order stays chart/SQL/downstream SQL/Data']);
  });
  await step('Delete-retain explains all actual dependants despite their earlier display positions', async () => {
    const before = await savedDocument();
    await cell('data').getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = cell('data').locator('.notebook-delete'); await confirmation.waitFor();
    assert.match(await confirmation.innerText(), /3 个依赖/);
    await cell('data').getByRole('button', { name: '确认删除 4 个单元', exact: true }).waitFor();
    await shot('08-delete-retain-dependants-1440', confirmation, ['Data deletion identifies SQL, named downstream SQL and earlier chart', 'Nothing is removed without confirmation']);
    await cell('data').getByRole('button', { name: '保留', exact: true }).click();
    assert.deepEqual(await savedDocument(), before);
  });
  await step('The saved display order reopens unchanged and real execution remains dependency-scheduled', async () => {
    const before = await savedDocument();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    await cell('chart').waitFor();
    assert.deepEqual(await assertDisplayOrder(['chart', 'sql', 'downstream', 'data']), before);
    assertChartRun(await run('chart'));
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('09-reopened-and-run-1024', cell('chart'), ['Disk project retains display order after reload', 'A fresh real run returns Data→SQL→chart and 150/80']);
  });
  await step('A cyclic request copy is rejected by the real API without saving it to the project', async () => {
    const before = await savedDocument();
    const cyclic = structuredClone(before);
    cyclic.cells.find((item) => item.id === ids.sql).inputCellIds = [ids.downstream];
    // Send only a request copy, not a project update. SQL↔downstream is a cycle.
    rejectedCycle = await page.evaluate(async ({ book, selectedPage, project, target }) => {
      const response = await fetch('/api/notebook/run', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-agentcanvas-project': project,
      }, body: JSON.stringify({ pageId: selectedPage, document: book, semanticModels: [], targetCellId: target, action: 'run' }) });
      return { status: response.status, body: await response.json() };
    }, { book: cyclic, selectedPage: pageId, project: handle, target: ids.chart });
    assert.equal(rejectedCycle.status, 400);
    assert.match(rejectedCycle.body.error?.message ?? '', /循环|环路/);
    assert.equal(rejectedCycle.body.run, undefined);
    assert.deepEqual(await savedDocument(), before);
    finalDocument = before;
  });
  const final = await manifest();
  assert.equal(final.tables.length, 1); assert.equal(final.files.length, 1);
  assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, ids, runs,
    inputCandidates, rejectedCycle, finalDocument, pageErrors, forbiddenRequests, directoryReads,
    realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic local project only; actual CSV, HTTP and DuckDB computation, no model/warehouse/Python execution.',
      'Connection GET is an explicit empty-directory fixture. No provider configuration or credentials read/changed.',
      'Cycle was sent as a request copy only; HTTP 400/no run/no project change is observed, executor-port non-invocation requires the separate offline spy tests.',
      'All four synthetic Cells, source Dataset and original CSV are retained; edit cancellation and delete-retain are verified, not running-task cancellation.',
      'No service start/stop/restart, stable publication, mobile verification, external database or user-project operation.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
