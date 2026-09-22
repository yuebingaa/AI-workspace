// Existing managed 3001 only. New synthetic project, real parameter/SQL/text
// execution and persistence; no model, warehouse, user-project or service writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-text-references-2026-09-17', `browser-${Date.now()}`);
const cells = {
  input: { label: '参数', title: '计算参数', output: 'seed' },
  literal: { label: '参数', title: '需按字面量显示的文本', output: 'literal_value' },
  independent: { label: '参数', title: '独立未受影响分支', output: 'independent' },
  sql: { label: 'SQL', title: '受控引用的单行汇总', output: 'summary' },
  static: { label: '说明', title: '旧静态说明原样保留' },
  text: { label: '说明', title: '带数据依据的计算说明' },
};
const payload = '001 / 2026-09-17 / <img src=x onerror="window.__textReferenceXss=1"> {{amount}} 中文\n下一行';
const staticText = '这是静态文字 {{literal}}，不是表达式 {{1 + 2}}。';
const template = '计算结果：{{amount}}\n空值：{{empty}}\n精确文本：{{precise}}\n原样文本：{{payload}}';
const query = "SELECT (value * 2)::DOUBLE AS total, NULL::VARCHAR AS missing, '9007199254740993'::VARCHAR AS exact FROM seed";
const expectedText = (amount) => `计算结果：${amount}\n空值：NULL\n精确文本：9007199254740993\n原样文本：${payload}`;

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], runs = [], actions = [], ids = {};
let scenario = 'setup', passed = false, failure, handle, pageId, directoryReads = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/connections/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection write prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.ok(body.document.cells.every((cell) => ['parameter', 'sql', 'text'].includes(cell.kind)), 'Only the synthetic parameter/SQL/text chain may execute');
    actions.push({ action: body.action, targetCellId: body.targetCellId, revision: body.document.revision });
  }
  return route.continue();
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const rendered = () => cell('text').getByLabel('说明计算结果', { exact: true });
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
  const project = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId]; return Boolean(book && predicate(book));
  }); return project.state.dataProduct.notebooks[pageId];
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
async function addReference(index, key, cellId, field) {
  await editor().getByRole('button', { name: '添加数据引用', exact: true }).click();
  await editor().getByLabel(`引用键 ${index}`, { exact: true }).fill(key);
  await editor().getByLabel(`引用单元 ${index}`, { exact: true }).selectOption(cellId);
  await editor().getByLabel(`引用字段 ${index}`, { exact: true }).fill(field);
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
async function assertText(amount) {
  const result = (await run('text')).cells.at(-1);
  assert.equal(result.text, expectedText(amount)); assert.equal(result.table, undefined);
  assert.equal(await rendered().textContent(), expectedText(amount));
  assert.equal(await cell('text').locator('img, script, iframe, a').count(), 0);
  assert.equal(await page.evaluate(() => window.__textReferenceXss), undefined);
  return result;
}
async function editSql(sql) {
  await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByLabel('SQL', { exact: true }).fill(sql); await save();
}
async function failedText() {
  const result = (await run('text', 'failure')).cells.at(-1);
  assert.equal(result.status, 'failure'); assert.equal(result.text, undefined);
  assert.equal(await rendered().count(), 0); assert.match(await cell('text').innerText(), /引用说明计算失败/);
  return result;
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a synthetic project with independent parameters, real SQL and a structured text editor', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
    await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 受控文本引用独立验收');
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click(); await dataBrowser().waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')); pageId = (await manifest()).state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    for (const [key, type, value] of [['input', 'number', '100'], ['literal', 'text', payload], ['independent', 'number', '7']]) {
      await start(key); await editor().getByLabel('参数类型', { exact: true }).selectOption(type);
      await editor().getByLabel('参数值', { exact: true }).fill(value); await saveNew(key);
    }
    assert.deepEqual((await run('independent')).cells.at(-1).table.rows, [{ value: 7 }]);
    await start('sql'); await selectOnlyInput('seed'); await editor().getByLabel('SQL', { exact: true }).fill(query); await saveNew('sql');
    await start('static'); await editor().getByLabel('分析说明', { exact: true }).fill(staticText); await saveNew('static');
    assert.ok((await cell('static').innerText()).includes(staticText));
    await start('text'); await editor().getByLabel('分析说明', { exact: true }).fill('计算结果：');
    await addReference(1, 'amount', ids.sql, 'total');
    await editor().getByRole('button', { name: '插入占位符 1', exact: true }).click();
    assert.ok((await editor().getByLabel('分析说明', { exact: true }).inputValue()).includes('{{amount}}'));
    await addReference(2, 'empty', ids.sql, 'missing'); await addReference(3, 'precise', ids.sql, 'exact'); await addReference(4, 'payload', ids.literal, 'value');
    await editor().getByLabel('分析说明', { exact: true }).fill(template);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('01-text-reference-editor-1024', editor().getByRole('group', { name: '数据引用 1', exact: true }), ['Explicit keys, stable source cell IDs and fields', 'Only declared placeholders are bound; no expression language']);
    await shot('02-multiple-reference-inputs-1024', editor().getByRole('group', { name: '数据引用 4', exact: true }), ['Four declared references across SQL and parameter outputs', 'Source field names entered explicitly; input insertion is a real editor interaction']);
    await saveNew('text');
  });
  await step('Real parameter to SQL to text preserves NULL, precision and HTML-looking literal values', async () => {
    await assertText(200);
    assert.match(await cell('independent').locator('.notebook-cell-status').innerText(), /✓/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('03-real-text-output-1440', rendered(), ['Actual SQL gives 200; NULL displays explicitly and large integer remains exact text', 'HTML-looking payload and nested {{amount}} stay literal, without DOM nodes or script execution']);
    assert.ok((await cell('static').innerText()).includes(staticText));
  });
  await step('Undeclared placeholders are rejected before saving and cancellation retains the verified definition', async () => {
    const before = await savedDocument(), count = actions.length;
    await cell('text').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('分析说明', { exact: true }).fill(`${template}\n未知：{{not_bound}}`);
    await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').waitFor();
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('04-invalid-placeholder-rejected-1024', editor().getByRole('alert'), ['Unknown placeholder is rejected locally and cannot silently resolve', 'Saved document and prior execution stay untouched']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before); assert.equal(actions.length, count);
    assert.equal(await rendered().textContent(), expectedText(200));
    await shot('05-cancelled-template-edit-1024', rendered(), ['Cancellation preserves the original template and verified result', 'No save, auto execution or discarded current value']);
  });
  await step('A missing source field fails at execution, exposes no old rendered value, and can be repaired', async () => {
    await cell('text').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('引用字段 1', { exact: true }).fill('unknown_field'); await save();
    assert.equal(await rendered().count(), 0);
    const failed = await failedText(); assert.match(failed.error, /字段/);
    await shot('06-missing-field-failure-1024', cell('text'), ['Real source is present but the requested field is missing', 'Failed receipt has no text and stale successful text is not reused']);
    await cell('text').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('引用字段 1', { exact: true }).fill('total'); await save(); await assertText(200);
  });
  await step('Multi-row, empty and truncated SQL sources are explicitly rejected, never implicitly reduced', async () => {
    await editSql(`${query} UNION ALL ${query}`); const multi = await failedText(); assert.match(multi.error, /一行|1 行|单行/);
    await shot('07-multi-row-rejected-1024', cell('text'), ['Actual two-row SQL source is rejected; no hidden first-row selection or aggregation']);
    await editSql(`${query} WHERE false`); const empty = await failedText(); assert.match(empty.error, /一行|1 行|单行|空/);
    await shot('08-empty-source-rejected-1024', cell('text'), ['A successful empty SQL result cannot provide a scalar field']);
    await editSql('SELECT range::DOUBLE AS total FROM seed, range(2000)'); const truncated = await failedText();
    const source = runs.at(-1).cells.find((result) => result.cellId === ids.sql);
    assert.equal(source.table.truncated, true); assert.equal(source.resultRef.complete, false); assert.match(truncated.error, /完整|截断/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('09-truncated-source-rejected-1440', cell('text'), ['Real 2000-row query is truncated to 1000 and is not accepted as scalar evidence']);
    await editSql(query); await assertText(200);
  });
  await step('Changing an upstream value invalidates text; stable ID references survive an output rename', async () => {
    const count = actions.length, before = await savedDocument();
    await cell('input').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('200'); await save();
    await savedDocument((book) => book.cells.find((item) => item.id === ids.input).parameter.value === 200);
    assert.equal(actions.length, count); assert.equal(await rendered().count(), 0);
    assert.match(await cell('text').innerText(), /引用结果已失效/); assert.match(await cell('independent').locator('.notebook-cell-status').innerText(), /✓/);
    await shot('10-upstream-change-stale-1440', cell('text'), ['Changed source makes rendered text stale until explicit rerun', 'Unrelated parameter branch remains valid and no run occurs automatically']);
    await assertText(400);
    await cell('sql').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('renamed_summary');
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    const review = page.getByRole('region', { name: '确认输出变量改名', exact: true }); await review.waitFor();
    assert.ok((await review.innerText()).includes(cells.text.title));
    await shot('11-stable-reference-rename-review-1440', review, ['Renamed SQL output retains text linkage by stable cell ID', 'Existing explicit rename confirmation remains in place']);
    await review.getByRole('button', { name: '确认改名并保存', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
    const renamed = await savedDocument((book) => book.cells.find((item) => item.id === ids.sql).outputName === 'renamed_summary');
    assert.deepEqual(renamed.cells.find((item) => item.id === ids.text).references, before.cells.find((item) => item.id === ids.text).references);
    await assertText(400);
  });
  await step('Reopening preserves templates and references but requires new execution for a calculated text result', async () => {
    const before = await savedDocument(); await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.deepEqual(await savedDocument(), before); assert.equal(await rendered().count(), 0);
    assert.ok((await cell('static').innerText()).includes(staticText));
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('12-reopened-uncomputed-text-1024', cell('text'), ['Template and stable references persist, computed results do not', 'Static legacy braces remain ordinary text']);
    await assertText(400); await shot('13-reopened-real-text-1024', rendered(), ['New real parameter and SQL run restores 400 with exact literal data', 'No HTML execution, model call or Dashboard application']);
    assert.deepEqual(await savedDocument(), before);
    const project = await manifest(); assert.equal(project.files.length, 0); assert.equal(project.tables.length, 0);
    assert.equal(project.state.appSpec.pages[0].root.children.length, 0);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, runs, actions, ids,
    pageErrors, forbiddenRequests, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['Only a newly created synthetic project and isolated browser; real parameter, SQL, text HTTP and project persistence.',
      'Connections GET is an explicit empty-directory fixture. All model, external connection and network requests prohibited.',
      'Rendered text must come from the current complete single-row source results; missing/multirow/empty/truncated cases actually execute.',
      'HTML-like data is tested as escaped literal text, including nested placeholder syntax; no expression or HTML execution.',
      'Cancellation covers editor cancellation, not interruption of a running task. No real model draft is used.',
      'Evidence and synthetic project retained; no deletion, service operation, stable publication or mobile verification.'] }, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
