// Exercise the existing managed 3001 site only. New synthetic project and
// isolated Edge profile; connection directory is explicitly a non-query mock.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CELL_MODULES_CSV, CELL_LABELS, CELL_TITLES, CELL_OUTPUTS, CELL_MODULES_SQL,
  CELL_MODULES_PYTHON, SQL_EXPECTED, WEIGHTED_EXPECTED, SEMANTIC_EXPECTED, DIRECTORY_CONNECTION } from './fixtures/cell-modules.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/cell-modules-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], errors = [], forbiddenRequests = [], runs = [];
const coverage = Object.fromEntries(Object.keys(CELL_LABELS).map((kind) => [kind, {}]));
const titles = { ...CELL_TITLES };
let scenario = 'setup', passed = false, failure, handle, pageId, datasetId, directoryAvailable = false, directoryReads = 0;
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection POST is prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: directoryAvailable ? [DIRECTORY_CONNECTION] : [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    if (body.document?.cells.some((cell) => cell.kind === 'warehouseSql')) {
      forbiddenRequests.push('Notebook with warehouse SQL was not allowed to execute'); return route.abort('blockedbyclient');
    }
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (kind) => page.getByRole('article', { name: `${CELL_LABELS[kind]}单元 ${titles[kind]}`, exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
async function step(name, fn) { scenario = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
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
    // The saved-status badge is visually hidden at 1024; its state still exists.
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
async function inspectEditor(kind) {
  const labels = { data: '数据源', sql: 'SQL', python: 'Python', warehouseSql: '数据库连接',
    semanticQuery: '语义模型', table: '展示字段（逗号分隔，使用结果中的字段名）', chart: '图表类型', text: '分析说明' };
  if (kind === 'transform') await editor().getByRole('group', { name: '处理规则编辑方式', exact: true }).waitFor();
  else await editor().getByLabel(labels[kind], { exact: true }).waitFor();
}
async function start(kind) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${CELL_LABELS[kind]}`, exact: true }).click();
  await editor().waitFor(); await inspectEditor(kind);
  await editor().getByLabel('单元名称', { exact: true }).fill(titles[kind]);
  if (CELL_OUTPUTS[kind]) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(CELL_OUTPUTS[kind]);
}
async function saveNew(kind) { await save(); await cell(kind).waitFor(); coverage[kind].created = true; }
async function run(kind, status = 'success') {
  await dismissNotice();
  const next = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await cell(kind).getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await next, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, status, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body.run;
}
function output(result, kind) {
  const id = result.cells.at(-1).cellId;
  assert.ok(id); coverage[kind].execution = 'real-local'; return result.cells.at(-1).table.rows;
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create an isolated project and import synthetic data; unavailable choices do not insert invalid cells', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('九类单元模块验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.getByRole('button', { name: '＋ 数据库 SQL', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请先配置当前项目的数据库连接' }).waitFor();
    assert.equal(await editor().count(), 0); assert.equal(await page.locator('.notebook-cell').count(), 0);
    await shot('01-unavailable-connection', page.locator('.notebook-feedback'), ['empty explicit connection directory', 'no warehouse Cell inserted or query sent']);
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'cell-modules-sales.csv', mimeType: 'text/csv', buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' });
    await manifest((value) => value.tables.length === 1 && value.files.length === 1); await dismissNotice();
  });
  await step('New-cell cancel preserves its already inserted default definition; existing edits remain discardable', async () => {
    await page.getByRole('button', { name: '＋ 说明', exact: true }).click();
    const inserted = await savedDocument((book) => book.cells.length === 1);
    assert.equal(inserted.cells[0].kind, 'text');
    await editor().getByLabel('单元名称', { exact: true }).fill('不得被保存的新增草稿标题');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), inserted);
    const initial = page.getByRole('article', { name: `说明单元 ${inserted.cells[0].title}`, exact: true });
    await shot('02-new-cell-cancel-preserved', initial, ['compatibility: insertion is already saved', 'cancel only discards form edits']);
    await initial.getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill(titles.text);
    await editor().getByLabel('分析说明', { exact: true }).fill('合成数据：SQL East=150、South=80；Python 加权后为300、160。');
    await saveNew('text'); coverage.text.newCancelPreservesInsertion = true;
  });
  await step('Real Data to SQL to Python to DataRecipe to table/chart produces independent expected results', async () => {
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveNew('data');
    await page.getByRole('button', { name: '＋ 语义查询', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请先创建语义模型' }).waitFor(); assert.equal(await editor().count(), 0);
    await start('sql'); await editor().getByLabel('SQL', { exact: true }).fill(CELL_MODULES_SQL); await saveNew('sql');
    assert.deepEqual(output(await run('sql'), 'sql'), SQL_EXPECTED); coverage.data.execution = 'real-local';
    await start('python'); await editor().getByLabel('Python', { exact: true }).fill(CELL_MODULES_PYTHON); await saveNew('python');
    assert.deepEqual(output(await run('python'), 'python'), WEIGHTED_EXPECTED);
    await start('transform'); await saveNew('transform');
    assert.deepEqual(output(await run('transform'), 'transform'), WEIGHTED_EXPECTED);
    await start('table'); await editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）', { exact: true }).fill('region, weighted'); await saveNew('table');
    assert.deepEqual(output(await run('table'), 'table'), WEIGHTED_EXPECTED);
    await start('chart'); await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('weighted'); await saveNew('chart');
    assert.deepEqual(output(await run('chart'), 'chart'), WEIGHTED_EXPECTED);
    await cell('chart').getByRole('img', { name: /图表下方提供对应数据表/ }).waitFor();
    await shot('03-real-chart-1440', cell('chart'), ['real chain returns East=300 and South=160', 'chart is backed by actual run']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('04-real-chart-1024', cell('chart'), ['same real chart at supported minimum desktop width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await run('text'); coverage.text.execution = 'real-local';
  });
  await step('Python failure blocks existing dependent table/chart results; explicit repair restores them', async () => {
    await cell('python').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill("raise ValueError('synthetic cell-module failure')"); await save();
    const failedChart = await run('chart', 'failure');
    assert.deepEqual(failedChart.cells.map((item) => item.status), ['success', 'success', 'failure', 'blocked', 'blocked']);
    assert.equal(await cell('chart').locator('table').count(), 0);
    await shot('05-real-failure-1440', cell('python'), ['real ValueError', 'downstream does not reuse old results']);
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.match(await cell('chart').innerText(), /上游步骤失败，未使用旧结果继续计算/);
    await shot('06-blocked-1024', cell('chart'), ['dependent chart blocked rather than shown as success']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual((await run('table', 'failure')).cells.map((item) => item.status), ['success', 'success', 'failure', 'blocked', 'blocked']);
    assert.equal(await cell('table').locator('table').count(), 0);
    await cell('python').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill(CELL_MODULES_PYTHON); await save();
    assert.deepEqual(output(await run('chart'), 'chart'), WEIGHTED_EXPECTED);
    assert.deepEqual(output(await run('table'), 'table'), WEIGHTED_EXPECTED);
  });
  await step('Local semantic model selects the real Data source and computes locally; no external services', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /语义模型/ }).click();
    await dataBrowser().getByRole('button', { name: /新建语义模型/ }).click();
    const manager = page.getByRole('dialog', { name: '语义模型管理', exact: true });
    await manager.getByLabel('模型名称', { exact: true }).fill('单元验收销售语义');
    await manager.getByRole('combobox', { name: /^来源数据表/ }).selectOption(datasetId);
    await manager.getByRole('button', { name: '＋ 添加维度', exact: true }).click();
    await manager.getByLabel('维度1字段', { exact: true }).selectOption('region');
    await manager.getByLabel('维度1标识', { exact: true }).fill('region');
    await manager.getByLabel('维度1名称', { exact: true }).fill('地区');
    await manager.getByRole('button', { name: '＋ 添加指标', exact: true }).click();
    await manager.getByLabel('指标1字段', { exact: true }).selectOption('amount');
    await manager.getByLabel('指标1标识', { exact: true }).fill('revenue');
    await manager.getByLabel('指标1名称', { exact: true }).fill('金额合计');
    await manager.getByLabel('指标1计算方式', { exact: true }).selectOption('sum');
    await manager.getByRole('button', { name: '保存并选择', exact: true }).click(); await manager.waitFor({ state: 'hidden' });
    await manifest((value) => value.state.dataProduct.semanticLayer.models.length === 1);
    await start('semanticQuery');
    assert.match(await editor().getByLabel('语义模型', { exact: true }).innerText(), /单元验收销售语义.*v1/);
    await saveNew('semanticQuery');
    assert.deepEqual(output(await run('semanticQuery'), 'semanticQuery'), SEMANTIC_EXPECTED);
    await shot('07-local-semantic-result', cell('semanticQuery'), ['local model v1', 'real DataRecipe semantic sum 150 and 80']);
  });
  await step('Warehouse SQL only uses an explicit directory fixture; available then unavailable selection survives without queries', async () => {
    directoryAvailable = true;
    const connections = page.locator('.notebook-connections');
    if ((await connections.getAttribute('open')) === null) await connections.locator('summary').click();
    await connections.getByRole('button', { name: '刷新连接', exact: true }).click();
    await connections.getByText(DIRECTORY_CONNECTION.name, { exact: true }).waitFor();
    await start('warehouseSql');
    assert.equal(await editor().getByLabel('数据库连接', { exact: true }).inputValue(), DIRECTORY_CONNECTION.id);
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT 1 AS directory_only');
    await saveNew('warehouseSql'); coverage.warehouseSql.execution = 'not-run-directory-only';
    directoryAvailable = false;
    await connections.getByRole('button', { name: '刷新连接', exact: true }).click();
    await connections.getByText('当前项目尚未配置数据库连接。配置只读连接后，刷新即可使用；也可以继续用导入数据分析。', { exact: true }).waitFor();
    await cell('warehouseSql').getByRole('button', { name: '编辑', exact: true }).click();
    assert.match(await editor().getByLabel('数据库连接', { exact: true }).innerText(), /连接不可用，请重新选择/);
    await shot('08-unavailable-saved-warehouse', editor(), ['directory fixture removed', 'saved definition kept with unavailable selection', 'never connected or queried']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
  });
  await step('All nine existing kinds preserve edit/save/cancel and deletion-retain behavior', async () => {
    const book = await savedDocument((value) => value.cells.length === 9);
    assert.deepEqual([...new Set(book.cells.map((item) => item.kind))].sort(), Object.keys(CELL_LABELS).sort());
    for (const kind of Object.keys(CELL_LABELS)) {
      const before = await savedDocument();
      await cell(kind).getByRole('button', { name: '编辑', exact: true }).click(); await inspectEditor(kind);
      await editor().getByLabel('单元名称', { exact: true }).fill(`未保存 ${kind}`);
      await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
      assert.deepEqual(await savedDocument(), before); coverage[kind].editCancelled = true;
      await cell(kind).getByRole('button', { name: '编辑', exact: true }).click();
      const renamed = `${CELL_TITLES[kind]} · 已改名`;
      await editor().getByLabel('单元名称', { exact: true }).fill(renamed); await save(); titles[kind] = renamed;
      const after = await savedDocument((value) => value.cells.some((item) => item.kind === kind && item.title === renamed));
      assert.deepEqual(after.cells, before.cells.map((item) => item.kind === kind ? { ...item, title: renamed } : item));
      coverage[kind].renamedAndSaved = true;
      await cell(kind).getByRole('button', { name: '删除', exact: true }).click();
      await cell(kind).locator('.notebook-delete').waitFor();
      if (kind === 'data') {
        assert.match(await cell(kind).locator('.notebook-delete').innerText(), /6 个依赖/);
        await shot('09-dependent-delete-retain', cell(kind).locator('.notebook-delete'), ['Data deletion reports its six actual descendants', 'no deletion until confirmation']);
      }
      await cell(kind).getByRole('button', { name: '保留', exact: true }).click();
      assert.deepEqual(await savedDocument(), after); coverage[kind].deleteRetained = true;
    }
  });
  await step('All nine definitions reopen unchanged; final reverse-dependency deletion removes only test cells', async () => {
    const before = await savedDocument();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), before);
    for (const kind of Object.keys(CELL_LABELS)) { await cell(kind).waitFor(); coverage[kind].reopened = true; }
    await shot('10-reopened-nine-kinds', cell('warehouseSql'), ['all nine definitions preserved in the real project', 'unavailable warehouse remains unexecuted']);
    const order = ['warehouseSql', 'semanticQuery', 'chart', 'table', 'transform', 'python', 'sql', 'data', 'text'];
    for (const [index, kind] of order.entries()) {
      await cell(kind).getByRole('button', { name: '删除', exact: true }).click();
      await cell(kind).getByRole('button', { name: '确认删除 1 个单元', exact: true }).click();
      await cell(kind).waitFor({ state: 'hidden' });
      await savedDocument((value) => value.cells.length === order.length - index - 1); coverage[kind].deleted = true;
    }
    const final = await manifest();
    assert.equal(final.tables.length, 1); assert.equal(final.files.length, 1);
    assert.equal(final.state.dataProduct.semanticLayer.models.length, 1);
    assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('11-test-cells-deleted-1024', page.locator('.notebook-heading'), ['only nine test definitions deleted', 'source Dataset/original/model remain', 'dashboard remains blank']);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal((await savedDocument()).cells.length, 0);
  });
  assert.deepEqual(errors, []); assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads >= 3); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, coverage, runs,
    pageErrors: errors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['Synthetic local project only; actual CSV, HTTP, DuckDB, isolated Python and local semantic execution.',
      'Warehouse connection directory is an explicit GET fixture; no connection credentials/config, test/schema POST or warehouse execution.',
      'New-cell Cancel only exits its editor: the initially inserted default cell remains, preserving existing behavior.',
      'No mobile verification, model generation, production database, website service lifecycle or stable-site publication.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, directory, failure }, null, 2));
}
