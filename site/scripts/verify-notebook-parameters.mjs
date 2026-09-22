// Existing managed 3001 only; isolated Edge and a newly created synthetic project.
// Actual local SQL / Python and project persistence; no model, warehouse or deletion.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-parameters-2026-09-17', `browser-${Date.now()}`);
const literal = "O'Reilly'); DROP TABLE sales; --\n中文字面值";
const csv = 'region,amount,work_date\nEast,100,2026-01-01\nEast,150,2026-01-02\nEast,200,2026-01-03\nWest,500,2026-01-03\n';
const cells = {
  text: { label: '参数', title: '文本参数：按字面值传入', output: 'note', parameter: { type: 'text', value: literal } },
  number: { label: '参数', title: '金额下限参数', output: 'minimum', parameter: { type: 'number', value: 100 } },
  date: { label: '参数', title: '起始日期参数', output: 'since', parameter: { type: 'date', value: '2026-01-02' } },
  select: { label: '参数', title: '地区单选参数', output: 'chosen_region', parameter: { type: 'select', value: 'East', options: ['East', 'West'] } },
  echo: { label: 'SQL', title: '无上传文件的参数 SQL', output: 'parameter_echo' },
  data: { label: 'Data', title: '四行合成销售源', output: 'sales' },
  sql: { label: 'SQL', title: '四参数 SQL 筛选汇总', output: 'filtered_sales' },
  python: { label: 'Python', title: 'Python 显式读取参数表', output: 'python_sales' },
  chart: { label: '图表', title: '参数驱动的地区金额' },
};
const sql = `SELECT region, SUM(amount)::DOUBLE AS total, (SELECT value FROM note) AS note
FROM sales WHERE amount >= (SELECT value FROM minimum)
  AND CAST(work_date AS DATE) >= CAST((SELECT value FROM since) AS DATE)
  AND region = (SELECT value FROM chosen_region)
GROUP BY region ORDER BY region`;
const python = `import pandas as pd
selected = sales[(sales['amount'] >= minimum['value'].iloc[0])
  & (pd.to_datetime(sales['work_date'], utc=True) >= pd.to_datetime(since['value'].iloc[0], utc=True))
  & (sales['region'] == chosen_region['value'].iloc[0])]
python_sales = selected.groupby('region', as_index=False)['amount'].sum().rename(columns={'amount': 'total'})
python_sales['note'] = note['value'].iloc[0]
print('Synthetic parameter inputs only')`;
const expected = (total) => [{ region: 'East', total, note: literal }];
const expectedChart = (total) => [{ region: 'East', total }];

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [];
const ids = {}, createdDatasets = new Set();
let scenario = 'setup', passed = false, failure, handle, pageId, sourceId, savedId, sourceBefore, sourceEntryBefore, originalFiles, directoryReads = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
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
    if (body.document?.cells.some((cell) => cell.kind === 'warehouseSql')) {
      forbiddenRequests.push('Warehouse execution prohibited'); return route.abort('blockedbyclient');
    }
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document?.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
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
async function openBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
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
async function dataset(id) {
  assert.ok(handle && createdDatasets.has(id), 'Only a Dataset created by this run may be read');
  const response = await context.request.get(`${base}/api/datasets/${id}`, { headers: { 'x-agentcanvas-project': handle } });
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
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
  const review = page.getByRole('region', { name: '确认输出变量改名', exact: true });
  if (await review.isVisible()) await review.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' }); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === cells[key].title));
  ids[key] = book.cells.find((item) => item.title === cells[key].title).id;
}
async function selectInputs(names) {
  const options = editor().locator('.notebook-input-list label');
  for (let index = 0; index < await options.count(); index++) {
    const option = options.nth(index), name = await option.locator('code').textContent();
    await option.getByRole('checkbox').setChecked(names.includes(name));
  }
  assert.equal(await editor().locator('.notebook-input-list input:checked').count(), names.length);
}
async function perform(key, action = 'run', status = 'success') {
  await dismissNotice();
  const next = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await cell(key).getByRole('button', { name: action === 'dataset' ? '保存为 Dataset' : '▶ 运行', exact: true }).click();
  const response = await next, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, status, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  runs.push(body.run); return body;
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create all four parameter types in an empty Notebook without uploading a file', async () => {
    await openBrowser();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 参数单元独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.equal(await page.locator('.notebook-cell').count(), 0);
    for (const key of ['text', 'number', 'date', 'select']) {
      await start(key); const parameter = cells[key].parameter;
      await editor().getByLabel('参数类型', { exact: true }).selectOption(parameter.type);
      if (parameter.options) {
        for (const [index, option] of parameter.options.entries()) {
          await editor().getByLabel(`单选选项 ${index + 1}`, { exact: true }).fill(option);
        }
        await editor().getByLabel('参数值', { exact: true }).selectOption(parameter.value);
      } else await editor().getByLabel('参数值', { exact: true }).fill(String(parameter.value));
      if (key === 'text') await shot('01-text-parameter-editor-1440', editor(), ['Empty Notebook accepts a parameter', 'Quotes, SQL-looking text and newlines are ordinary input values']);
      if (key === 'select') await shot('02-select-parameter-editor-1440', editor(), ['Single-select has explicit choices and selected value', 'No data upload or warehouse required']);
      await saveNew(key);
      const book = await savedDocument();
      assert.deepEqual(book.cells.find((item) => item.id === ids[key]).parameter, parameter);
      const result = (await perform(key)).run.cells.at(-1);
      assert.deepEqual(result.table.rows, [{ value: parameter.value }]);
      assert.equal(result.resultRef.rowCount, 1); assert.equal(result.resultRef.complete, true);
      assert.deepEqual(result.resultRef.sourceDatasetIds, []);
    }
    const project = await manifest(); assert.equal(project.tables.length, 0); assert.equal(project.files.length, 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('03-parameter-output-1024', cell('select'), ['Typed one-row value output', 'Parameter-only Notebook works at minimum desktop width']);
    await start('echo'); await selectInputs(['note']);
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT value AS literal FROM note'); await saveNew('echo');
    assert.deepEqual((await perform('echo')).run.cells.at(-1).table.rows, [{ literal }]);
    await shot('03b-parameter-only-sql-1024', cell('echo').locator('.notebook-result'), ['Real local SQL needs no uploaded Dataset when its only input is a parameter', 'Quoted multiline text remains unchanged']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Invalid number and duplicate choices are rejected; cancelled edits leave saved definitions intact', async () => {
    const before = await savedDocument(), count = actions.length;
    await cell('number').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('');
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    await editor().getByRole('alert').waitFor();
    assert.ok((await editor().getByRole('alert').textContent()).length > 0);
    assert.deepEqual(await savedDocument(), before);
    await shot('04-invalid-number-1440', editor(), ['Empty numeric value does not silently become zero', 'Invalid edit remains local and does not run']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await cell('select').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单选选项 1', { exact: true }).fill('East');
    await editor().getByLabel('单选选项 2', { exact: true }).fill('East');
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    await editor().getByRole('alert').waitFor(); assert.deepEqual(await savedDocument(), before);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('05-invalid-select-1024', editor(), ['Duplicate choices rejected with visible explanation', 'Original definition preserved']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await cell('text').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('Do not persist this cancelled value');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    await shot('06-cancelled-parameter-edit-1024', cell('text'), ['Cancel retains the original quoted and multiline text', 'No execution requests during edit, validation or cancellation']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Four explicit parameter tables drive real local SQL and Python; SQL-looking text stays literal', async () => {
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type=file]').setInputFiles({ name: 'parameter-sales.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); sourceId = (await response.json()).dataset.datasetId; createdDatasets.add(sourceId);
    await upload.waitFor({ state: 'hidden' });
    const project = await manifest((value) => value.tables.length === 1 && value.files.length === 1);
    sourceBefore = await dataset(sourceId); assert.equal(sourceBefore.rows.length, 4);
    sourceEntryBefore = project.tables[0]; originalFiles = project.files;
    await start('data'); await editor().getByLabel('数据源', { exact: true }).selectOption(sourceId); await saveNew('data');
    const inputs = ['sales', 'minimum', 'since', 'chosen_region', 'note'];
    await start('sql'); await selectInputs(inputs); await editor().getByLabel('SQL', { exact: true }).fill(sql); await saveNew('sql');
    assert.deepEqual((await perform('sql')).run.cells.at(-1).table.rows, expected(350));
    await shot('07-real-sql-parameters-1440', cell('sql').locator('.notebook-result'), ['Dates, numeric threshold and choice filter two East rows', 'SQL-looking string returned unchanged, not interpolated or executed']);
    await start('python'); await selectInputs(inputs); await editor().getByLabel('Python', { exact: true }).fill(python); await saveNew('python');
    assert.deepEqual((await perform('python')).run.cells.at(-1).table.rows, expected(350));
    await shot('08-real-python-parameters-1440', cell('python').locator('.notebook-result'), ['Actual isolated Python reads five explicit DataFrame inputs', 'Independent pandas sum equals SQL total 350 and preserves the literal']);
    await start('chart'); await editor().getByLabel('上游输出', { exact: true }).selectOption(ids.sql);
    await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('total'); await saveNew('chart');
    assert.deepEqual((await perform('chart')).run.cells.at(-1).table.rows, expectedChart(350));
    await cell('chart').getByRole('img', { name: /图表下方提供对应数据表/ }).waitFor();
    await shot('09-real-chart-1440', cell('chart').locator('.notebook-plot'), ['Chart is backed by real parameterized local SQL result 350']);
  });
  await step('Changing a parameter invalidates only dependants, without automatic execution; manual rerun changes 350 to 200', async () => {
    const count = actions.length;
    assert.match(await cell('data').locator('.notebook-cell-status').innerText(), /✓/);
    await cell('number').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('180'); await save();
    await savedDocument((book) => book.cells.find((item) => item.id === ids.number).parameter.value === 180);
    assert.equal(actions.length, count);
    for (const key of ['number', 'sql', 'python', 'chart']) {
      assert.equal(await cell(key).locator('.notebook-cell-status').innerText(), '已失效 · 需重算');
    }
    for (const key of ['text', 'date', 'select', 'data']) assert.match(await cell(key).locator('.notebook-cell-status').innerText(), /✓/);
    assert.equal(await cell('chart').locator('.notebook-plot').count(), 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('10-parameter-stale-1024', cell('chart'), ['Changed threshold invalidates downstream chart and prevents old result reuse', 'Unrelated data and parameter outputs remain valid; no automatic run']);
    assert.deepEqual((await perform('chart')).run.cells.at(-1).table.rows, expectedChart(200));
    assert.equal(await cell('python').locator('.notebook-cell-status').innerText(), '已失效 · 需重算');
    await shot('11-manual-recomputed-chart-1024', cell('chart').locator('.notebook-plot'), ['Explicit run recomputes real total 200', 'Sibling Python output remains stale until it is requested']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Saving a computed Dataset reruns the dependency chain and persists source lineage; reopening retains parameter definitions', async () => {
    const priorRunId = runs.at(-1).runId;
    const saved = await perform('sql', 'dataset');
    assert.notEqual(saved.run.runId, priorRunId); assert.deepEqual(saved.snapshot.rows, expected(200));
    savedId = saved.snapshot.dataset.datasetId; createdDatasets.add(savedId);
    const provenance = saved.snapshot.dataset.provenance;
    assert.equal(provenance.runId, saved.run.runId); assert.equal(provenance.lineage.complete, true);
    assert.equal(provenance.lineage.rowCount, 1); assert.deepEqual(provenance.lineage.sourceDatasetIds, [sourceId]);
    const savedProject = await manifest((value) => value.tables.some((item) => item.descriptor.datasetId === savedId));
    assert.equal(savedProject.tables.length, 2);
    assert.deepEqual(savedProject.tables.find((item) => item.descriptor.datasetId === sourceId), sourceEntryBefore);
    assert.deepEqual(savedProject.files, originalFiles); assert.deepEqual(await dataset(sourceId), sourceBefore);
    const recent = page.getByRole('region', { name: '最近保存的数据集', exact: true });
    await recent.locator('.dataset-provenance > summary').click();
    assert.deepEqual(await recent.locator('ol > li > span').allTextContents(), ['参数', '参数', '参数', '参数', '源数据', '本地 SQL']);
    assert.equal(await recent.getByText('输入：参数值', { exact: true }).count(), 4);
    await shot('12-saved-dataset-lineage-1440', recent, ['Fresh execution saves 200 plus exact literal and source lineage', 'Original Dataset and file remain unchanged']);
    const before = await savedDocument();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), before);
    const reopened = await dataset(savedId); assert.deepEqual(reopened.rows, expected(200));
    assert.deepEqual(reopened.dataset.provenance, provenance);
    await openBrowser(); await dataBrowser().getByRole('button', { name: /已保存结果/ }).click();
    await dataBrowser().locator('.dataset-provenance > summary').click();
    assert.deepEqual(await dataBrowser().locator('ol > li > span').allTextContents(), ['参数', '参数', '参数', '参数', '源数据', '本地 SQL']);
    assert.equal(await dataBrowser().getByText('输入：参数值', { exact: true }).count(), 4);
    await shot('13-reopened-dataset-1440', dataBrowser(), ['Saved result and full source record reopened from the project']);
    await dataBrowser().getByRole('button', { name: '关闭数据浏览器', exact: true }).click();
    assert.deepEqual((await perform('chart')).run.cells.at(-1).table.rows, expectedChart(200));
    assert.deepEqual((await perform('python')).run.cells.at(-1).table.rows, expected(200));
    assert.deepEqual(await savedDocument(), before);
    const final = await manifest(); assert.equal(final.state.appSpec.pages[0].root.children.length, 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('14-reopened-python-1024', cell('python').locator('.notebook-result'), ['Restored parameters produce 200 in actual Python after reload', 'Dashboard unchanged; no AI model or warehouse requests']);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, runs, actions, ids,
    pageErrors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['New synthetic project and isolated browser only; actual parameter, CSV, HTTP, DuckDB, Python and persistence execution.',
      'Connections GET is an explicit empty-directory fixture. Model, external and warehouse requests are prohibited.',
      'Parameter values are explicit one-row tables, not SQL string interpolation; ordinary persisted values are not secrets.',
      'Validation failures and cancellation are real editor interactions, not synthetic server responses.',
      'All synthetic project files and evidence retained; no cleanup, service lifecycle, stable publication or mobile verification.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
