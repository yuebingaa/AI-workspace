// Fixed synthetic CSV, independent expected counts, existing development site.
// No model requests, external databases, service lifecycle, or user projects.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { QUALITY_FILE, QUALITY_CSV, NORMALIZED_ROWS, EXPECTED_COUNTS, EXPECTED_FIELDS,
  QUALITY_SQL, QUALITY_PYTHON } from './fixtures/dataset-quality.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/dataset-quality-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], errors = [], blocked = [], runs = [];
let passed = false, failure, scenario = 'setup', handle, datasetId, imported, formalDocument;
let gateUpload = false, heldUpload;
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/')) {
    blocked.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (gateUpload && url.pathname === '/api/datasets' && route.request().method() === 'POST') {
    heldUpload = route; return; // Explicit network-wait substitute, never forwarded to a data store.
  }
  return route.continue();
});
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const upload = () => page.getByRole('dialog', { name: '导入本机表格', exact: true });
const details = () => page.getByRole('dialog', { name: `${QUALITY_FILE.replace('.csv', '')} 数据源详情`, exact: true });
const profile = () => details().getByRole('region', { name: '当前数据统计', exact: true });
const editor = () => page.locator('.notebook-editor');
async function step(name, fn) { scenario = name; await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop page must not overflow');
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario, assertions });
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
    const header = await page.locator('.top-actions').innerText();
    if (predicate(value) && /已保存到本地项目|已打开本地项目/.test(header)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Synthetic project did not reach the required persisted state');
}
async function storedDataset() {
  const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return response.json();
}
async function openDetails() {
  await openBrowser();
  await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /数据表/ }).click();
  await dataBrowser().getByRole('button', { name: '预览数据 / 字段', exact: true }).click();
  await details().waitFor();
}
async function openUpload(fileName, text) {
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  await upload().locator('input[type=file]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await upload().getByRole('button', { name: '导入 1 份文件', exact: true }).waitFor();
}
async function assertProfile() {
  await profile().waitFor();
  const stats = await profile().locator('dl').evaluate((element) => Object.fromEntries([...element.querySelectorAll('dt')]
    .map((term) => [term.textContent.trim(), term.nextElementSibling.textContent.trim()])));
  assert.equal(stats['当前行数'], '9'); assert.equal(stats['声明字段'], '3');
  assert.match(stats['空单元格'], /^6\s*\/\s*27/);
  assert.equal(stats['全空行'], '1'); assert.equal(stats['额外重复行'], '4');
  assert.match(await details().innerText(), /导入\s*\/\s*来源质量摘要/);
}
async function saveCell() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
}
async function runAll() {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  const next = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click();
  const response = await next; const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, 'success', JSON.stringify(body.run.cells.map((cell) => cell.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body.run;
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create an isolated synthetic project and import the exact nine-row CSV', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('统计口径合成验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    await openUpload(QUALITY_FILE, QUALITY_CSV);
    const posted = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload().getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await posted; assert.equal(response.status(), 201);
    imported = await response.json(); datasetId = imported.dataset.datasetId;
    await upload().waitFor({ state: 'hidden' });
    const saved = await manifest((value) => value.tables.length === 1 && value.files.length === 1 && value.state?.dataProduct.datasets.length === 1);
    assert.deepEqual(imported.rows, NORMALIZED_ROWS);
    assert.deepEqual((await storedDataset()).rows, NORMALIZED_ROWS);
    assert.equal(saved.tables[0].descriptor.storageMode, 'project');
    assert.equal(saved.tables[0].descriptor.expiresAt, undefined);
    assert.equal(imported.dataset.source.quality.nullCellCount, 6);
    assert.equal(imported.dataset.source.quality.duplicateRowCount, 4);
    for (const field of imported.dataset.source.fields) {
      const { type, nullCount, uniqueCount } = field;
      assert.deepEqual({ type, nullCount, uniqueCount }, EXPECTED_FIELDS[field.name]);
    }
  });
  await step('Current-row statistics and field counts match independent literals at 1440 and 1024', async () => {
    await openDetails(); await assertProfile();
    await shot('01-statistics-1440', profile(), ['9 rows / 3 columns / 27 cells', 'null=6, all-null=1, extra duplicate=4', 'source quality separated']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-statistics-1024', profile(), ['current-data scope and definition text readable at minimum desktop width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await details().getByRole('button', { name: '字段', exact: true }).click();
    for (const [field, expected] of Object.entries(EXPECTED_FIELDS)) {
      const row = details().locator('.source-fields-table tbody tr').filter({ has: page.locator('td b', { hasText: new RegExp(`^${field}$`) }) });
      const values = await row.locator('td').allTextContents();
      assert.equal(values[1], expected.type === 'number' ? '数值' : '文本');
      assert.match(values[2], new RegExp(`^${expected.nullCount}`));
      assert.equal(values[3], String(expected.uniqueCount));
    }
    await shot('03-fields-1440', details().locator('.source-fields-table'), ['amount null=2 / distinct=3', 'category null=1', 'note null=3', 'NULL and false preserved as text']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('04-fields-1024', details().locator('.source-fields-table'), ['field statistics readable with table-contained scrolling']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await details().getByRole('button', { name: '关闭数据源详情', exact: true }).click();
  });
  await step('Malformed CSV fails through the real parser and does not add a dataset or original file', async () => {
    await openUpload('invalid-width.csv', 'category,amount,note\nA,1,x,unexpected');
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload().getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await pending; assert.equal(response.status(), 400);
    const body = await response.json(); assert.match(body.error.message, /CSV.*解析|CSV.*行列/);
    await upload().getByRole('alert').waitFor();
    await shot('05-invalid-csv', upload(), ['actual server 400 for malformed column count', 'no dataset or original file added']);
    await upload().getByRole('button', { name: '关闭', exact: true }).click();
    const saved = await manifest(); assert.equal(saved.tables.length, 1); assert.equal(saved.files.length, 1);
  });
  await step('Cancel a gated synthetic XHR upload without creating data', async () => {
    await openUpload('cancelled-quality.csv', QUALITY_CSV); gateUpload = true;
    await upload().getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const deadline = Date.now() + 10000;
    while (!heldUpload && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    assert.ok(heldUpload, 'Own synthetic upload must be held before forwarding');
    await upload().getByRole('button', { name: '取消导入', exact: true }).click();
    await upload().getByRole('alert').filter({ hasText: 'CSV 上传已取消' }).waitFor();
    await heldUpload.abort('aborted').catch(() => {}); gateUpload = false;
    await shot('06-cancelled-import', upload(), ['real client cancellation with an explicitly gated network wait', 'not a backend cancellation test']);
    await upload().getByRole('button', { name: '关闭', exact: true }).click();
    const saved = await manifest(); assert.equal(saved.tables.length, 1); assert.equal(saved.files.length, 1);
  });
  await step('Real SQL and Python independently produce the literal expected statistics', async () => {
    await page.getByRole('button', { name: '＋ Data', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('规范化测试数据');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('quality_data');
    await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveCell();
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('SQL 独立口径核对');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sql_counts');
    await editor().getByLabel('SQL', { exact: true }).fill(QUALITY_SQL); await saveCell();
    await page.getByRole('button', { name: '＋ Python', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('Python 独立口径核对');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('python_counts');
    for (const checkbox of await editor().getByRole('checkbox').all()) await checkbox.uncheck();
    await editor().getByRole('checkbox', { name: /quality_data/ }).check();
    await editor().getByLabel('Python', { exact: true }).fill(QUALITY_PYTHON); await saveCell();
    const run = await runAll();
    assert.deepEqual(run.cells[0].table.rows, NORMALIZED_ROWS);
    assert.deepEqual(run.cells[1].table.rows, [EXPECTED_COUNTS]);
    assert.deepEqual(run.cells[2].table.rows, [EXPECTED_COUNTS]);
    assert.equal(run.cells[2].resultRef.inputResultIds.length, 1);
    assert.equal(run.cells[2].resultRef.inputResultIds[0], run.cells[0].resultRef.resultId);
    const sql = page.getByRole('article', { name: 'SQL单元 SQL 独立口径核对', exact: true });
    const python = page.getByRole('article', { name: 'Python单元 Python 独立口径核对', exact: true });
    await shot('07-sql-counts', sql, ['actual DuckDB counts equal fixed 9/3/27/6/1/4, not just success']);
    await shot('08-python-counts', python, ['actual Python counts independently equal fixed 9/3/27/6/1/4', 'same Dataset input, not SQL output']);
    const saved = await manifest((value) => Object.values(value.state?.dataProduct.notebooks ?? {}).some((book) => book.cells.length === 3));
    formalDocument = Object.values(saved.state.dataProduct.notebooks)[0];
  });
  await step('Project refresh preserves canonical values, field metadata, definitions and recomputed statistics', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    const saved = await manifest(); assert.equal(saved.tables.length, 1); assert.equal(saved.files.length, 1);
    assert.deepEqual(Object.values(saved.state.dataProduct.notebooks)[0], formalDocument);
    const dataset = await storedDataset(); assert.deepEqual(dataset.rows, NORMALIZED_ROWS);
    assert.deepEqual(dataset.dataset.source.fields, imported.dataset.source.fields);
    await openDetails(); await assertProfile();
    await shot('09-reopened-statistics', profile(), ['reopened project still reports 6 null cells / 4 extras / 1 all-null row']);
    await details().getByRole('button', { name: '关闭数据源详情', exact: true }).click();
    const run = await runAll();
    assert.deepEqual(run.cells[1].table.rows, [EXPECTED_COUNTS]); assert.deepEqual(run.cells[2].table.rows, [EXPECTED_COUNTS]);
  });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  if (heldUpload) await heldUpload.abort('aborted').catch(() => {});
  const report = { passed, failure, checks, screenshots, pageErrors: errors, blockedRequests: blocked, realModelCalls: 0,
    expected: EXPECTED_COUNTS, expectedFields: EXPECTED_FIELDS, actualRuns: runs,
    limits: ['All data is synthetic. Both programs analyze normalized Dataset values, not raw CSV bytes.',
      'Malformed CSV uses the real server parser. Cancellation gates only this synthetic XHR before forwarding; it does not prove backend rollback.',
      'SQL/Python are fixed deterministic programs, not model-generated analysis. No real AI model or database is used.',
      'No zero-row or missing-row browser state is fabricated; component tests cover those states separately.'] };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(directory, 'expected.json'), JSON.stringify({ csv: QUALITY_CSV, normalizedRows: NORMALIZED_ROWS, expected: EXPECTED_COUNTS, fields: EXPECTED_FIELDS }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, directory, failure }, null, 2));
}
