// Existing managed 3001 only. Real parameter/SQL/text execution in newly created
// synthetic projects. No model, remote database, user project or service changes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-parameter-auto-run-2026-09-17', `browser-${Date.now()}`);
const cells = {
  input: { label: '参数', title: '自动重算的输入参数', output: 'seed' },
  shared: { label: '参数', title: '两个分支共享的固定参数', output: 'baseline' },
  independent: { label: '参数', title: '不受影响的独立参数', output: 'independent' },
  sql: { label: 'SQL', title: '自动参数的真实 SQL', output: 'summary' },
  sibling: { label: 'SQL', title: '共享祖先但未变化的独立 SQL', output: 'sibling' },
  text: { label: '说明', title: '自动重算的计算说明' },
  siblingText: { label: '说明', title: '独立分支的计算说明' },
  scratch: { label: '参数', title: '非数值修改不得触发', output: 'scratch' },
};
const sql = "SELECT CAST(CASE WHEN seed.value < 0 THEN 'synthetic-invalid-number' ELSE CAST(seed.value * 2 + baseline.value AS VARCHAR) END AS DOUBLE) AS total FROM seed CROSS JOIN baseline";
const siblingSql = 'SELECT baseline.value + independent.value AS total FROM baseline CROSS JOIN independent';
const expectedText = (value) => `当前计算：${value * 2 + 10}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const ids = {}, checks = [], screenshots = [], actions = [], runs = [], pageErrors = [], forbiddenRequests = [], injections = [], httpErrors = [];
const responseTasks = [], allowedHandles = new Set();
let scenario = 'setup', passed = false, failure, handle, pageId, firstProject, firstPage, secondPage, directoryReads = 0;
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
    assert.equal(body.action, 'run', 'Automatic recalculation may not create a Dataset or Dashboard');
    assert.ok(body.document.cells.every((item) => ['parameter', 'sql', 'text'].includes(item.kind)), 'Only synthetic parameter/SQL/text cells may execute');
    assert.ok(allowedHandles.has(request.headers()['x-agentcanvas-project']), 'Only this run\'s synthetic projects may execute');
    actions.push({ index: actions.length, scenario, at: Date.now(), action: body.action, targetCellId: body.targetCellId,
      pageId: body.pageId, revision: body.document.revision, cellIds: body.document.cells.map((item) => item.id),
      parameterValues: Object.fromEntries(body.document.cells.filter((item) => item.kind === 'parameter').map((item) => [item.id, item.parameter.value])) });
  }
  return route.continue();
});
page.on('response', (response) => {
  if (response.url() !== `${base}/api/notebook/run` || response.request().method() !== 'POST') return;
  const task = (async () => {
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body.error));
    assert.ok(body.run, 'Real Notebook HTTP must return a parsed execution receipt');
    runs.push(body.run);
  })().catch((error) => { httpErrors.push(String(error)); });
  responseTasks.push(task);
});
const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const auto = () => page.getByRole('checkbox', { name: '参数自动重算', exact: true });
const heading = () => page.locator('.notebook-heading');
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const rendered = (key = 'text') => cell(key).getByLabel('说明计算结果', { exact: true });

async function poll(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { assert.deepEqual(httpErrors, [], 'Notebook HTTP collection failed'); if (await predicate()) return; await pause(50); }
  throw new Error(message);
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
  await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
}
async function selectProject(path, create = false, name = '参数自动重算独立验收') {
  await openBrowser();
  await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(path);
  if (create) await dataBrowser().getByLabel('项目名称', { exact: true }).fill(name);
  await dataBrowser().getByRole('button', { name: create ? '新建本地项目' : '打开已有项目', exact: true }).click();
  await dataBrowser().waitFor({ state: 'hidden' });
  handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
  assert.ok(handle); allowedHandles.add(handle);
  const project = await manifest(); pageId = project.state.appSpec.pages[0].id;
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
}
async function manifest(predicate = (value) => Boolean(value.state)) {
  assert.ok(allowedHandles.has(handle), 'Only a newly created project may be read');
  let result;
  await poll(async () => {
    const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
    assert.equal(response.status(), 200); result = (await response.json()).manifest;
    return predicate(result) && /已保存到本地项目|已打开本地项目/.test(await page.locator('.top-actions').textContent());
  }, 'Synthetic project did not finish saving');
  return result;
}
async function savedDocument(predicate = () => true) {
  const project = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId]; return Boolean(book && predicate(book));
  }); return project.state.dataProduct.notebooks[pageId];
}
async function save({ rename = false } = {}) {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  if (rename) {
    await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
    const review = page.getByRole('region', { name: '确认输出变量改名', exact: true });
    if (await review.isVisible()) await review.getByRole('button', { name: '确认改名并保存', exact: true }).click();
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
  await save({ rename: true }); await cell(key).waitFor();
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
async function editValue(value, key = 'input') {
  await cell(key).getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByLabel('参数值', { exact: true }).fill(String(value)); await save();
}
async function waitIdle() { await poll(async () => !await heading().getByRole('button', { name: '停止运行', exact: true }).isVisible(), 'Notebook execution did not leave its busy state', 45000); }
async function noNewRuns(count, delay = 950) { await pause(delay); assert.equal(actions.length, count, 'No execution may be scheduled by this interaction'); }
async function waitReceipt(count, status = 'success') {
  await poll(() => runs.length > count, 'No actual Notebook response received', 45000);
  await waitIdle();
  assert.equal(runs.length, count + 1, 'Exactly one actual Notebook run expected');
  const run = runs[count]; assert.equal(run.status, status, JSON.stringify(run.cells.map((item) => item.error)));
  return run;
}
async function runManual(key) {
  const count = runs.length;
  if (key) await cell(key).getByRole('button', { name: '▶ 运行', exact: true }).click();
  else await heading().getByRole('button', { name: '▶ 全部运行', exact: true }).click();
  return waitReceipt(count);
}
async function assertMain(value) { await poll(async () => await rendered().count() === 1 && await rendered().textContent() === expectedText(value), 'Rendered text does not match the latest actual parameter'); }
async function assertIndependent() {
  for (const key of ['independent', 'sibling', 'siblingText']) assert.match(await cell(key).locator('.notebook-cell-status').innerText(), /✓/, `${key} should retain its verified result`);
  assert.equal(await rendered('siblingText').textContent(), '独立结果：17');
}
function assertAuto(index, value) {
  const action = actions[index]; assert.ok(action); assert.equal(action.action, 'run'); assert.equal(action.targetCellId, undefined);
  assert.equal(action.pageId, firstPage); assert.equal(action.parameterValues[ids.input], value);
  assert.deepEqual([...action.cellIds].sort(), [ids.input, ids.shared, ids.sql, ids.text].sort(), 'Automatic request is pruned to descendants and necessary ancestors');
}
async function createPage(name) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  await menu.getByRole('button', { name: '新建界面', exact: true }).click();
  await menu.getByLabel('工作界面名称', { exact: true }).fill(name);
  await menu.getByRole('button', { name: '创建', exact: true }).click();
  const project = await manifest((value) => value.state.appSpec.pages.some((item) => item.title === name));
  pageId = project.state.appSpec.pages.find((item) => item.title === name).id; return pageId;
}
async function selectPage(name, id) {
  await page.getByLabel('切换工作界面', { exact: true }).click();
  await page.getByRole('menu', { name: '工作界面列表', exact: true }).getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click();
  pageId = id; await auto().waitFor();
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a real parameter, shared-ancestor SQL and text graph; default stays manual', async () => {
    firstProject = resolve(directory, 'project'); await selectProject(firstProject, true); firstPage = pageId;
    assert.equal(await auto().isChecked(), false);
    for (const [key, value] of [['input', 2], ['shared', 10], ['independent', 7], ['scratch', 1]]) {
      await start(key); await editor().getByLabel('参数类型', { exact: true }).selectOption('number');
      await editor().getByLabel('参数值', { exact: true }).fill(String(value)); await saveNew(key);
    }
    for (const [key, names, query] of [['sql', ['seed', 'baseline'], sql], ['sibling', ['baseline', 'independent'], siblingSql]]) {
      await start(key); await selectInputs(names); await editor().getByLabel('SQL', { exact: true }).fill(query); await saveNew(key);
    }
    for (const [key, source, label] of [['text', 'sql', '当前计算'], ['siblingText', 'sibling', '独立结果']]) {
      await start(key); await editor().getByLabel('分析说明', { exact: true }).fill(`${label}：{{total}}`);
      await editor().getByRole('button', { name: '添加数据引用', exact: true }).click();
      await editor().getByLabel('引用键 1', { exact: true }).fill('total');
      await editor().getByLabel('引用单元 1', { exact: true }).selectOption(ids[source]);
      await editor().getByLabel('引用字段 1', { exact: true }).fill('total'); await saveNew(key);
    }
    assert.equal(actions.length, 0); await runManual(); await assertMain(2); await assertIndependent();
    await shot('01-default-manual-1440', heading(), ['Automatic recalculation is off initially', 'Creating and saving eight cells did not execute; explicit run gives 14 and independent 17']);
    const count = actions.length; await editValue(3); await noNewRuns(count);
    assert.equal(await rendered().count(), 0); assert.match(await cell('text').innerText(), /引用结果已失效/);
    await assertIndependent(); await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-manual-save-stale-1024', cell('text'), ['Default save invalidates only its dependants', 'No implicit query or stale text reuse']);
    await runManual(); await assertMain(3); await assertIndependent();
  });
  await step('Enabling is inert; pure value save runs only its dependency branch with real SQL and text', async () => {
    const count = actions.length; await auto().check(); await noNewRuns(count);
    await shot('02a-enabled-without-execution-1024', heading(), ['Opt-in checkbox is visibly on with the current-window-only explanation', 'Enabling alone issues no Notebook request']);
    // Creating a cell already inserts a default definition. Its first save must
    // still count as creation, not an existing parameter's approved value change.
    await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: '＋ 参数', exact: true }).click();
    await editor().waitFor(); const newOutput = await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).inputValue();
    await editor().getByLabel('参数值', { exact: true }).fill('initial-value-not-auto'); await save(); await noNewRuns(count);
    const created = await savedDocument((book) => book.cells.some((item) => item.kind === 'parameter' && item.outputName === newOutput));
    ids.newlyCreated = created.cells.find((item) => item.kind === 'parameter' && item.outputName === newOutput).id;
    const runCount = runs.length; await editValue(4); const run = await waitReceipt(runCount);
    assertAuto(count, 4); assert.equal(run.cells.find((item) => item.cellId === ids.text).text, expectedText(4));
    await assertMain(4); await assertIndependent();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('03-automatic-real-result-1440', cell('text'), ['Automatic real SQL and text give 18', 'No target, no Dataset, no Dashboard, no unrelated branch execution']);
    await shot('04-shared-ancestor-independent-result-1440', cell('siblingText'), ['Shared baseline is rerun with equal contents', 'Independent verified SQL/text remains 17 instead of becoming spuriously stale']);
  });
  await step('Two saved values coalesce; editing pauses the 600 ms queue and only the final value executes', async () => {
    const actionCount = actions.length, runCount = runs.length;
    await editValue(5);
    await cell('input').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('6');
    await noNewRuns(actionCount, 1000);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('05-editing-pauses-queue-1024', editor(), ['First saved value 5 is queued but the reopened editor pauses it', 'Unsaved 6 has not executed despite waiting longer than 600 ms']);
    await shot('05a-visible-paused-setting-1024', heading(), ['Visible automatic setting explains that the saved parameter waits until editing ends', 'No timer-driven query occurs while the parameter editor remains open']);
    await save(); await waitReceipt(runCount); assert.equal(actions.length, actionCount + 1); assertAuto(actionCount, 6);
    await assertMain(6); await assertIndependent(); await noNewRuns(actionCount + 1);
  });
  await step('Invalid, cancelled, same-value and structural parameter edits never trigger automatic runs', async () => {
    const count = actions.length, before = await savedDocument();
    await cell('input').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill(''); await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    await editor().getByRole('alert').waitFor(); await noNewRuns(count);
    assert.deepEqual(await savedDocument(), before);
    await shot('06-invalid-value-no-run-1024', editor(), ['Invalid numeric input is rejected before save', 'No background run is scheduled by failed validation']);
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await cell('input').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数值', { exact: true }).fill('999'); await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await savedDocument(), before); await editValue(6); await noNewRuns(count); await assertMain(6);
    await cell('scratch').getByRole('button', { name: '编辑', exact: true }).click();
    cells.scratch.title = '仅改名称与数值仍需手动';
    await editor().getByLabel('单元名称', { exact: true }).fill(cells.scratch.title);
    await editor().getByLabel('参数值', { exact: true }).fill('2'); await save(); await noNewRuns(count);
    await cell('scratch').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('scratch_renamed');
    await editor().getByLabel('参数值', { exact: true }).fill('3'); await save({ rename: true }); await noNewRuns(count);
    await cell('scratch').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('参数类型', { exact: true }).selectOption('select');
    await editor().getByLabel('单选选项 1', { exact: true }).fill('A'); await editor().getByLabel('单选选项 2', { exact: true }).fill('B');
    await editor().getByLabel('参数值', { exact: true }).selectOption('A'); await save(); await noNewRuns(count);
    await cell('scratch').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单选选项 2', { exact: true }).fill('C');
    await editor().getByLabel('参数值', { exact: true }).selectOption('C'); await save(); await noNewRuns(count);
    await shot('07-structural-save-stays-manual-1024', cell('scratch'), ['Title/output/type/options changes including simultaneous values do not auto-run', 'Existing output rename confirmation remains required']);
  });
  await step('Turning off clears queued work; turning it on again does not replay discarded values', async () => {
    const count = actions.length; await editValue(7); await auto().uncheck();
    await noNewRuns(count); assert.equal(await auto().isChecked(), false); assert.equal(await rendered().count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('08-disabled-clears-queue-1440', heading(), ['Off before the 600 ms deadline discards pending work', 'Saved parameter persists but no implicit run occurs']);
    await auto().check(); await noNewRuns(count); await runManual(); await assertMain(7); await assertIndependent();
  });
  await step('A real automatic SQL failure blocks text and does not loop; explicit retry can recover', async () => {
    const actionCount = actions.length, runCount = runs.length;
    await editValue(-1); const run = await waitReceipt(runCount, 'failure'); assertAuto(actionCount, -1);
    const sqlResult = run.cells.find((item) => item.cellId === ids.sql), textResult = run.cells.find((item) => item.cellId === ids.text);
    assert.equal(sqlResult.status, 'failure'); assert.match(sqlResult.error, /synthetic-invalid-number|转换|convert/i);
    assert.equal(textResult.status, 'blocked'); assert.equal(textResult.text, undefined);
    assert.equal(await rendered().count(), 0); await assertIndependent(); await noNewRuns(actionCount + 1, 1300);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('09-real-failure-no-retry-loop-1024', cell('text'), ['Negative input causes an actual SQL conversion failure', 'Dependent text is blocked, old output absent and there is no automatic retry loop']);
    await auto().uncheck(); await editValue(8); await noNewRuns(actionCount + 1);
    await runManual(); await assertMain(8); await assertIndependent();
    await shot('10-manual-retry-recovers-1024', cell('text'), ['Correcting the parameter with auto off still needs explicit retry', 'Real rerun restores calculated text 26']);
  });
  await step('A deliberately late real response after hiding Notebook cannot restore cancelled output', async () => {
    await auto().check(); const actionCount = actions.length, runCount = runs.length;
    await page.evaluate(() => {
      const original = window.fetch;
      window.__parameterAutoDelay = { ready: false, released: false };
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/api/notebook/run') && init?.method === 'POST') {
          window.fetch = original;
          // One explicit transport-resilience probe: perform the genuine request,
          // but ignore its AbortSignal and hold the genuine Response until released.
          const actual = await original(input, { ...init, signal: undefined });
          window.__parameterAutoDelay.ready = true;
          await new Promise((done) => { window.__parameterAutoDelay.release = () => { window.__parameterAutoDelay.released = true; done(); }; });
          return actual;
        }
        return original(input, init);
      };
    });
    injections.push({ type: 'single-real-response-delay', ignoredAbortAtTransport: true, purpose: 'Late genuine response after automatic cancellation must not update UI; no fabricated response or model' });
    await editValue(9); await page.waitForFunction(() => window.__parameterAutoDelay?.ready === true, undefined, { timeout: 45000 });
    assert.equal(actions.length, actionCount + 1); assertAuto(actionCount, 9);
    assert.equal(await cell('input').getByRole('button', { name: '编辑', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.equal(await auto().isChecked(), false); assert.equal(await rendered().count(), 0);
    await page.evaluate(() => window.__parameterAutoDelay.release()); await waitReceipt(runCount);
    await noNewRuns(actionCount + 1); assert.equal(await rendered().count(), 0);
    assert.match(await cell('text').innerText(), /失效|待运行|取消/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('11-late-response-ignored-1440', heading(), ['Hiding Notebook resets automatic mode and cancels its active run', 'A real successful late Response is deliberately delivered after cancellation but cannot populate results']);
    await runManual(); await assertMain(9); await assertIndependent();
  });
  await step('Retired presentation-role selector is absent; opening settings leaves automatic mode and document intact', async () => {
    const before = await savedDocument(), count = actions.length;
    await auto().check();
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.locator('.studio-navigation-settings > summary').click();
    assert.equal(await menu.getByLabel('界面演示角色，不影响服务端授权', { exact: true }).count(), 0);
    assert.equal(await menu.getByText('界面演示角色', { exact: true }).count(), 0);
    assert.equal(await auto().isChecked(), true); assert.equal(await auto().isDisabled(), false);
    await noNewRuns(count); assert.deepEqual(await savedDocument(), before);
    await shot('12a-settings-without-demo-role-1440', menu.locator('.studio-navigation-settings'), ['Presentation-role selector is absent from workspace settings', 'Opening settings leaves automatic mode and the project document unchanged']);
    await menu.getByRole('button', { name: '收起工作区菜单', exact: true }).click();
    await auto().uncheck(); assert.equal(await auto().isChecked(), false);
  });
  await step('Page, project and browser reload boundaries reset the non-persistent switch and leave documents intact', async () => {
    const old = await savedDocument(), beforeCount = actions.length;
    await auto().check(); secondPage = await createPage('自动重算隔离第二页');
    assert.equal(await auto().isChecked(), false); assert.equal(await page.locator('.notebook-cell').count(), 0);
    await auto().check(); await selectPage('空白工作界面', firstPage);
    assert.equal(await auto().isChecked(), false); assert.equal(await rendered().count(), 0);
    assert.deepEqual(await savedDocument(), old); await noNewRuns(beforeCount);
    await shot('12-page-switch-default-off-1440', heading(), ['Working-page keys remount the Notebook', 'Returning preserves definitions but resets the switch and computed results']);
    await auto().check(); await selectProject(resolve(directory, 'project-two'), true, '自动重算第二隔离项目');
    assert.equal(await auto().isChecked(), false); assert.equal(await page.locator('.notebook-cell').count(), 0);
    await auto().check(); await selectProject(firstProject);
    await selectPage('空白工作界面', firstPage);
    assert.equal(await auto().isChecked(), false); assert.deepEqual(await savedDocument(), old); await noNewRuns(beforeCount);
    await auto().check(); await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await dismissNotice();
    assert.equal(await auto().isChecked(), false); assert.equal(await rendered().count(), 0); assert.deepEqual(await savedDocument(), old);
    await noNewRuns(beforeCount); await page.setViewportSize({ width: 1024, height: 900 });
    await shot('13-project-reopen-default-off-1024', heading(), ['Switching projects and reloading do not persist or restore automatic permission', 'No historical parameter change is replayed']);
    await runManual(); await assertMain(9); await assertIndependent();
    const final = await manifest(); assert.equal(final.tables.length, 0); assert.equal(final.files.length, 0);
    assert.ok(final.state.appSpec.pages.every((item) => item.root.children.length === 0));
    assert.equal(JSON.stringify(final.state).includes('autoRecalculate'), false, 'UI preference is not written into project definitions');
    await shot('14-reopened-manual-result-1024', cell('text'), ['Explicit full rerun recovers actual text 28 and independent 17', 'Project has no Dataset/file additions or Dashboard applications']);
  });
  await Promise.all(responseTasks); assert.deepEqual(httpErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, runs, actions, ids, firstPage, secondPage,
    pageErrors, forbiddenRequests, httpErrors, injections, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['Existing managed 3001, isolated Edge and newly created synthetic local projects only.',
      'Actual parameter/SQL/text HTTP and persistence; connection-directory GET is an explicit empty fixture; no models or remote databases.',
      'Default manual and explicit opt-in only; request bodies record pruned automatic branches, latest saved values and page revision.',
      'The single late-response probe executes a real request, strips only its transport AbortSignal, and delays only delivery of its genuine Response.',
      'Queued cancellation, editor cancellation and actual automatic cancellation are distinct assertions; SQL failure is genuine, not an HTTP mock.',
      'No service lifecycle operations, stable publication, user-project changes, cleanup or mobile verification.'] }, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
