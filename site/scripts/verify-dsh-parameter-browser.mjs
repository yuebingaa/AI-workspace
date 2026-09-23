// Managed 3001 only. Run serially with other project UI checks (registry lastOpenedAt).
// Preparation creates a new synthetic project with real UI and zero AI requests.
// Each explicit paid phase persists an exclusive once marker before its sole AI request; no retry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { CELL_MODULES_CSV as csv } from './fixtures/cell-modules.mjs';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/dsh-parameter-browser-2026-09-22'), args = process.argv.slice(2), startedAt = Date.now();
const phase = args.length === 0 ? 'prepare' : { '--allow-paid-first': 'first', '--allow-paid-second': 'second' }[args[0]];
assert.ok(phase && (phase === 'prepare' || args.length === 2), 'Usage: verify-dsh-parameter-browser.mjs [--allow-paid-first | --allow-paid-second] <new-owned-directory>');
const directory = phase === 'prepare' ? join(root, `browser-${startedAt}`) : resolve(args[1]);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true }); assert.equal(await realpath(directory), directory);
assert.equal((await lstat(directory)).isSymbolicLink(), false);
const projectPath = join(directory, 'project'), fileName = 'dsh-parameter-sales.csv';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const pause = ms => new Promise(done => setTimeout(done, ms));
const titles = { data: '合成地区销售', parameter: '地区筛选参数', sql: '所选地区总额', table: '地区销售结果' };
const sql = 'SELECT region, SUM(amount) AS revenue FROM sales_data WHERE region = (SELECT value FROM region_pick) GROUP BY region';
const instructions = {
  first: '请修改当前 Notebook：仅把已有 parameter 单元“地区筛选参数”的单选值从 South 改为 East，类型、选项、输出表名、ID、标题都保持原样。其余已有 Data、SQL、Table 三个单元保持原样。再新增一个 text 说明单元，markdown 必须为“所选地区收入：{{total}}”，references 只有一项：key 为 total，cellId 引用已有“所选地区总额”SQL 单元，field 为 revenue。不要在 SQL 文本里拼接参数值，不要改成硬编码结果，不创建新数据源、连接或模型。请真实试运行后提交可采用草稿，不修改正式看板。',
  second: '帮我看一下，能不能给我一个分析的结论',
};
const report = { kind: 'dsh-parameter-browser-v1', phase, passed: false, base, startedAt,
  checks: [], screenshots: [], runs: [], requests: [], pageErrors: [], routeErrors: [], forbidden: [],
  visualReview: 'pending actual image inspection', boundaries: [
    'Real UI, public HTTP/SSE/DSH and local SQL; no model, run or persistence response fixture.',
    'Only the new owned synthetic CSV project. Original bytes and other project registrations are checked.',
    'Zero AI during preparation, one paid task per explicit phase, exclusive marker before forwarding, no automatic retry.',
    'No settings or service changes, external database or user-project reads. New tabs are not service-restart memory.',
    'Parameter values are saved business data, not secrets or SQL interpolation. Automatic recompute is not enabled.'],
};
let browser, context, page, owner, handle, projectId, pageId, sessionId, datasetId;
let initialIndex, indexPath, calls = 0, created = 0, scenario = 'preflight', expectedRunDocument, requestDocument, firstComplete, currentTask;
const book = value => value.state.dataProduct.notebooks?.[pageId];
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const card = kind => page.getByRole('article', { name: `${{ data: 'Data', parameter: '参数', sql: 'SQL', table: '表格' }[kind]}单元 ${titles[kind]}`, exact: true });
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
async function settings() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
function validate(state) {
  assert.equal(state.appSpec.pages.length, 1); assert.deepEqual(state.appSpec.pages[0].root.children, []);
  assert.equal(state.dataProduct.semanticLayer.models.length, 0);
  const document = state.dataProduct.notebooks?.[pageId];
  assert.ok((document?.cells.length ?? 0) <= (phase === 'prepare' ? 4 : 5));
  for (const cell of document?.cells ?? []) assert.ok(['data', 'parameter', 'sql', 'table', 'text'].includes(cell.kind));
  assert.ok(state.harnessTasks.length <= ({ prepare: 0, first: 1, second: 2 }[phase]));
  if (owner?.preparedDocument) {
    assert.deepEqual(state.appSpec, owner.preparedAppSpec); assert.deepEqual(state.dataProduct.semanticLayer, owner.preparedSemanticLayer);
    for (const original of owner.preparedDocument.cells) {
      const current = document.cells.find(cell => cell.id === original.id);
      if (original.kind !== 'parameter') assert.deepEqual(current, original);
      else assert.ok([original.parameter.value, 'East'].includes(current.parameter.value));
    }
    assert.equal(state.assistantSessions.items.length, 1); assert.equal(state.assistantSessions.activeId, sessionId);
    if (phase === 'second') assert.deepEqual(document, firstComplete.adoptedDocument);
  }
}
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(value.handle, handle); assert.equal(resolve(value.path), projectPath); assert.equal(value.manifest.id, projectId);
  return value.manifest;
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 30000; let revision, stableAt;
  while (Date.now() < deadline) {
    const value = await manifest();
    if (predicate(value) && /已保存到本地项目|已打开本地项目|已确认上次修改保存到本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stableAt = Date.now(); }
      if (Date.now() - stableAt > 600) { validate(value.state); return value; }
    } else { revision = undefined; stableAt = undefined; }
    await pause(100);
  }
  throw new Error(`Owned project did not finish saving: ${scenario}`);
}
async function resources(value) {
  assert.equal(value.tables.length, 1); assert.equal(value.files.length, 1);
  if (owner) { assert.deepEqual(value.tables, owner.tables); assert.deepEqual(value.files, owner.files); }
  assert.equal(value.tables[0].descriptor.datasetId, datasetId);
  for (const [folder, entry] of [['tables', value.tables[0]], ['files', value.files[0]]]) {
    const path = join(projectPath, folder, entry.file); assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert.equal(bytes.length, entry.bytes); assert.equal(checksum(bytes), entry.sha256);
    if (folder === 'files') assert.equal(bytes.toString('utf8'), csv);
    else assert.deepEqual(JSON.parse(bytes).rows, [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }]);
  }
}
async function shot(name, assertions, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(directory, name), animations: 'disabled' });
  report.screenshots.push({ name, scenario, assertions, viewport: page.viewportSize(), actualImageReviewed: false });
}
function observe(target) { target.setDefaultTimeout(20000); target.on('pageerror', error => report.pageErrors.push({ scenario, message: error.message })); }
async function mode(name) {
  await page.getByRole('tab', { name, exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
}
async function openOwned(create = false) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
  await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  if (create) await dialog().getByLabel('项目名称', { exact: true }).fill('DSH 地区参数验收');
  const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === (create ? 'create' : 'open'));
  await dialog().getByRole('button', { name: create ? '新建本地项目' : '打开已有项目', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200); const value = await response.json();
  if (create) { handle = value.handle; projectId = value.manifest.id; }
  await dialog().waitFor({ state: 'hidden' }); const current = await saved();
  if (create) { pageId = current.state.appSpec.pages[0].id; sessionId = current.state.assistantSessions.activeId; }
  assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
}
async function startBrowser() {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const original = window.fetch.bind(window); window.fetch = async (...input) => {
      const response = await original(...input);
      if (new URL(response.url).pathname === '/api/ai/harness/stream') {
        window.__dshParameter = { state: 'streaming' };
        void response.clone().text().then(body => { window.__dshParameter = { state: 'complete', body }; }, () => { window.__dshParameter = { state: 'failed' }; });
      } return response;
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base); assert.equal(url.pathname.startsWith('/api/connections/'), false);
      if (method === 'GET' && ['/api/projects', '/api/datasets', '/api/connections'].includes(url.pathname) && !request.headers()[header]) {
        const key = url.pathname.split('/').at(-1); return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ [key]: [] }) });
      }
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.requests.push({ scenario, method, path: url.pathname }); assert.equal(method, 'POST');
      if (url.pathname === '/api/projects') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(phase, 'prepare'); assert.equal(++created, 1); assert.equal(body.path, projectPath); }
        else if (body.action === 'open') assert.equal(body.path, projectPath);
        else { assert.equal(request.headers()[header], handle); validate(body.state); }
      } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
        assert.equal(phase, 'prepare'); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName); assert.equal(request.postData(), csv);
      } else if (url.pathname === '/api/notebook/run') {
        assert.equal(request.headers()[header], handle); assert.ok(expectedRunDocument); const body = request.postDataJSON(); assert.equal(body.action, 'run');
        assert.deepEqual(body.document, expectedRunDocument); assert.deepEqual(body.semanticModels, []);
      } else if (url.pathname === '/api/ai/harness/stream') {
        assert.notEqual(phase, 'prepare'); assert.equal(request.headers()[header], handle); assert.equal(++calls, 1);
        const payload = request.postDataJSON(); assert.equal(payload.instruction, instructions[phase]); assert.equal(payload.conversation_id, sessionId);
        assert.deepEqual(payload.notebookContext.document, requestDocument); assert.deepEqual(payload.notebookContext.sourceIds, [datasetId]);
        assert.equal(payload.dataSourceId, datasetId); assert.equal(payload.semanticModel, undefined);
        report.publicRequest = { conversation_id: payload.conversation_id, idempotencyKey: payload.idempotencyKey, cells: payload.notebookContext.document.cells.length, sourceIds: payload.notebookContext.sourceIds };
        await saveJson(join(directory, `${phase}-attempt.json`), { phase, startedAt: new Date().toISOString(), projectId, sessionId,
          idempotencyKey: payload.idempotencyKey, onceOnly: true, expectedPaidModel: true });
      } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation blocked'); }
      return await route.continue();
    } catch (error) { report.routeErrors.push({ scenario, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
}
async function saveEditor() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
  if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function add(kind, configure) {
  const label = { data: 'Data', parameter: '参数', sql: 'SQL', table: '表格' }[kind];
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(titles[kind]); await configure(); await saveEditor();
  return book(await saved(value => book(value)?.cells.some(cell => cell.kind === kind && cell.title === titles[kind]))).cells.find(cell => cell.kind === kind);
}
async function humanRun(document) {
  expectedRunDocument = document;
  const selected = document.cells.find(cell => cell.kind === 'parameter').parameter.value, amount = selected === 'East' ? 150 : 80;
  assert.ok(['East', 'South'].includes(selected));
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 90000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200); assert.equal(result.run.status, 'success'); assert.equal(result.run.revision, document.revision);
  for (const cell of document.cells) {
    const output = result.run.cells.find(output => output.cellId === cell.id); assert.equal(output.status, 'success');
    if (cell.kind === 'text') { assert.equal(output.table, undefined); assert.equal(output.text, `所选地区收入：${amount}`); }
    else {
      const expected = cell.kind === 'data' ? [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }]
        : cell.kind === 'parameter' ? [{ value: selected }] : [{ region: selected, revenue: amount }];
      assert.deepEqual(output.table.rows, expected); assert.equal(output.resultRef.accessMode, 'user'); assert.equal(output.resultRef.complete, true);
    }
  }
  report.runs.push(result.run); expectedRunDocument = undefined;
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return result.run;
}
async function prepare() {
  await assert.rejects(lstat(projectPath), error => error.code === 'ENOENT'); await startBrowser();
  scenario = 'Create new isolated project and import actual synthetic CSV'; await openOwned(true); await mode('Notebook');
  await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  const imported = await saved(value => value.tables.length === 1 && value.files.length === 1); datasetId = imported.tables[0].descriptor.datasetId; await resources(imported);
  scenario = 'Configure real Data, select parameter, declared SQL inputs and Table';
  const data = await add('data', async () => { await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); });
  const parameter = await add('parameter', async () => {
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('region_pick'); await editor().getByLabel('参数类型', { exact: true }).selectOption('select');
    await editor().getByLabel('单选选项 1', { exact: true }).fill('East'); await editor().getByLabel('单选选项 2', { exact: true }).fill('South');
    await editor().getByLabel('参数值', { exact: true }).selectOption('East');
  });
  const query = await add('sql', async () => {
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('selected_sales');
    for (const name of ['sales_data', 'region_pick']) await editor().locator('.notebook-input-list label').filter({ hasText: name }).getByRole('checkbox').check();
    await editor().getByRole('textbox', { name: 'SQL', exact: true }).fill(sql);
  });
  assert.deepEqual(query.inputCellIds.slice().sort(), [data.id, parameter.id].sort());
  await humanRun(book(await saved()));
  await add('table', async () => { await editor().getByLabel('上游输出', { exact: true }).selectOption(query.id); await editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）', { exact: true }).fill('region, revenue'); });
  const east = book(await saved()); await humanRun(east);
  await shot('prepare-01-east150-1440.png', ['Real select value East → local SQL scalar subquery → result150; no SQL interpolation or AI'], card('table'));
  scenario = 'Invalid select membership rejected, no definition change';
  await card('parameter').getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByLabel('单选选项 1', { exact: true }).fill('West');
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').textContent(), /参数值必须属于选项/u); assert.deepEqual(book(await manifest()), east);
  await shot('prepare-02-invalid-select-1440.png', ['Actual editor validation: East is not a member after editing option to West; stored East and revision unchanged'], editor().getByRole('alert'));
  scenario = 'Cancel invalid edit preserves exact valid parameter and results';
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  assert.deepEqual(book(await saved()), east);
  await shot('prepare-03-cancel-1440.png', ['Cancelled invalid option edit, actual saved select remains East; no new run or AI'], card('parameter'));
  scenario = 'Valid parameter value South saved and manually recomputed';
  await card('parameter').getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByLabel('参数值', { exact: true }).selectOption('South'); await saveEditor();
  const south = book(await saved(value => book(value).cells.find(cell => cell.id === parameter.id).parameter.value === 'South'));
  assert.equal(south.revision, east.revision + 1); assert.equal(south.cells.find(cell => cell.id === query.id).sql, sql);
  const southRun = await humanRun(south);
  await shot('prepare-04-south80-1440.png', ['Only literal parameter value changed; explicit new run returns South80 and SQL source unchanged'], card('table'));
  scenario = 'Fresh tab reopens South and reruns exact saved four-cell definition';
  await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('Notebook');
  const reopened = await saved(); assert.deepEqual(book(reopened), south); const rerun = await humanRun(south); assert.notEqual(rerun.runId, southRun.runId);
  await shot('prepare-05-reopened-south80-1024.png', ['Fresh saved definition, new run returns South80, no AI or automatic recompute'], card('table'));
  owner = { kind: report.kind, directory, projectPath, handle, projectId, pageId, sessionId, datasetId,
    preparedDocument: south, preparedAppSpec: reopened.state.appSpec, preparedSemanticLayer: reopened.state.dataProduct.semanticLayer,
    tables: reopened.tables, files: reopened.files };
  await resources(reopened); await saveJson(join(directory, 'ownership.json'), owner);
  report.finalState = { cells: 4, revision: south.revision, sessionId, parameter: 'South', actualRevenue: 80 };
  report.checks.push('All four cells created manually; East150 / invalid membership refusal / cancel / South80 / new-tab South80 rerun, zero AI.');
}
async function sendTask() {
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instructions[phase]);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click(); assert.equal((await pending).status(), 200);
  await page.waitForFunction(() => ['complete', 'failed'].includes(window.__dshParameter?.state), undefined, { timeout: 300000 });
  const observed = await page.evaluate(() => window.__dshParameter); assert.equal(observed.state, 'complete');
  const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => {
    const line = block.split(/\r?\n/u).find(value => value.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  currentTask = frames.findLast(frame => frame.task)?.task; assert.ok(currentTask); report.task = currentTask;
  await saveJson(join(directory, `${phase}-public-task.json`), { frames });
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  await saved(value => value.state.harnessTasks.some(task => task.id === currentTask.id && task.state === currentTask.state));
  await shot(`${phase}-01-answer-1440.png`, ['Actual public HTTP/SSE task with no replacement response'], page.locator('.conversation-turn').last());
  const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
  if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
  await shot(`${phase}-02-trace-1440.png`, ['Actual trace with executed tools and verification, not private chain-of-thought'], trace); return currentTask;
}
async function paid() {
  owner = await readJson(join(directory, 'ownership.json')); assert.equal(owner.kind, report.kind); assert.equal(owner.directory, directory); assert.equal(owner.projectPath, projectPath);
  assert.equal((await readJson(join(directory, 'prepare-report.json'))).passed, true); assert.equal(await realpath(projectPath), projectPath);
  ({ handle, projectId, pageId, sessionId, datasetId } = owner); assert.equal(owner.preparedDocument.cells.length, 4);
  await assert.rejects(lstat(join(directory, `${phase}-attempt.json`)), error => error.code === 'ENOENT');
  const before = await readJson(join(projectPath, 'agentcanvas.project.json')); await resources(before);
  if (phase === 'second') {
    assert.equal((await readJson(join(directory, 'first-report.json'))).passed, true); firstComplete = await readJson(join(directory, 'first-complete.json'));
    assert.deepEqual(book(before), firstComplete.adoptedDocument); assert.equal(before.state.harnessTasks.length, 1);
  } else { assert.deepEqual(book(before), owner.preparedDocument); assert.equal(before.state.harnessTasks.length, 0); }
  validate(before.state); requestDocument = book(before); await startBrowser(); scenario = 'Open owned project, same saved session'; await openOwned(); await mode('AI 工作台');
  scenario = `One real ${phase} DSH task`; const task = await sendTask(); assert.deepEqual(book(await saved()), book(before));
  assert.equal(task.verification?.status, 'passed');
  if (phase === 'first') {
    assert.equal(task.state, 'awaitingConfirmation'); const artifact = task.notebookArtifact; assert.ok(artifact); assert.equal(artifact.executionEvidence.status, 'success'); assert.equal(artifact.cells.length, 5);
    for (const original of owner.preparedDocument.cells) assert.deepEqual(artifact.cells.find(cell => cell.id === original.id), original.kind === 'parameter' ? { ...original, parameter: { ...original.parameter, value: 'East' } } : original);
    const note = artifact.cells.find(cell => cell.kind === 'text'), query = artifact.cells.find(cell => cell.kind === 'sql');
    assert.equal(note.markdown, '所选地区收入：{{total}}'); assert.deepEqual(note.references, [{ key: 'total', cellId: query.id, field: 'revenue' }]);
    for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft']) assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === name));
    scenario = 'Review parameter value diff and text addition before adoption'; await mode('Notebook'); await draft().waitFor(); await draft().getByText(/查看变更和步骤/u).click();
    await shot('first-03-draft-review-1440.png', ['Actual parameter South→East change and one reference-text addition; unchanged SQL/Data/Table'], draft());
    await draft().getByRole('button', { name: '采用草稿', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
    const document = book(await saved(value => book(value).lastDraftId === artifact.id)); assert.equal(document.revision, owner.preparedDocument.revision + 1); assert.deepEqual(document.cells, artifact.cells);
    scenario = 'Human rerun after adopting actual parameterized draft'; const run = await humanRun(document); assert.notEqual(run.runId, artifact.executionEvidence.runId);
    await shot('first-04-east150-text-1440.png', ['Actual post-adoption SQL result East150 and reference text150, original CSV unchanged'], page.getByRole('article', { name: `说明单元 ${note.title}`, exact: true }));
    scenario = 'Fresh tab reopens five cells and same completed conversation'; await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('AI 工作台');
    const reopened = await saved(); assert.deepEqual(book(reopened), document); assert.equal(reopened.state.harnessTasks[0].state, 'completed'); assert.equal(reopened.state.assistantSessions.items[0].turns.length, 1);
    assert.equal(calls, 1); assert.equal(report.runs.length, 1);
    await shot('first-05-reopened-1024.png', ['Same conversation and exact adopted five-cell definition, no additional AI or automatic run'], page.locator('.conversation-turn').last());
    await saveJson(join(directory, 'first-complete.json'), { sessionId, taskId: task.id, adoptedDocument: document, trialRunId: artifact.executionEvidence.runId, humanRunId: run.runId });
    report.checks.push('Real DSH edited canonical parameter, ran and submitted draft; explicit adoption + human run yielded East150 and reference150, saved/reopened same session.');
  } else {
    assert.equal(task.state, 'completed'); assert.equal(task.notebookArtifact, undefined);
    assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === 'runNotebookCells'));
    assert.equal(task.trace.some(event => ['editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), false);
    assert.match(task.resultMessage, /(?<!\d)150(?!\d)/u); assert.deepEqual(book(await saved()), firstComplete.adoptedDocument);
    await page.setViewportSize({ width: 1024, height: 900 }); await shot('second-03-answer-1024.png', ['Same-session readonly result; saved parameter East and five cells unchanged. Long answer may continue below viewport.'], page.locator('.conversation-turn').last());
    scenario = 'Inspect parameter capability settings without changing settings'; await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click(); const nav = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
    await nav.locator('summary').filter({ hasText: '设置与备份' }).click(); await nav.getByRole('button', { name: 'Agent 执行与插件', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Agent 执行与插件', exact: true }); await panel.locator('.agent-engine-current').waitFor();
    assert.equal(await panel.locator('input[name="agent-execution-engine"][value="dsh"]').isChecked(), true);
    assert.equal(await panel.getByRole('button', { name: '应用执行引擎', exact: true }).isDisabled(), true);
    const notebookPlugin = panel.locator('.agent-engine-plugins article').filter({ hasText: 'Notebook 数据分析' }); assert.match(await notebookPlugin.textContent(), /参数/u);
    await shot('second-04-parameter-plugin-1440.png', ['Actual GET-only Notebook plugin description contains parameter support; apply disabled, settings unchanged'], notebookPlugin);
    await panel.getByRole('button', { name: '关闭 Agent 执行与插件', exact: true }).click();
    report.checks.push('Second same-session DSH task freshly ran existing cells, answered150 without edit/submit/artifact; settings inspected GET-only.');
  }
  const final = await saved(); await resources(final);
  report.finalState = { cells: book(final).cells.length, revision: book(final).revision, sessionId, parameter: book(final).cells.find(cell => cell.kind === 'parameter').parameter.value,
    tasks: final.state.harnessTasks.map(({ id, state }) => ({ id, state })) };
}
try {
  report.initialEngine = await settings(); assert.equal(report.initialEngine.engine, 'dsh'); assert.equal(report.initialEngine.activeTasks, 0);
  const location = await readJson(resolve('.runtime/runtime-location.json')), config = await readJson(join(location.root, 'config.json'));
  indexPath = join(config.devState, 'local-projects.json'); initialIndex = await readJson(indexPath);
  if (phase === 'prepare') await prepare(); else await paid();
  assert.equal(calls, phase === 'prepare' ? 0 : 1); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.forbidden, []);
  report.passed = true;
} catch (error) {
  report.failure = { scenario, message: String(error).replaceAll(process.cwd(), '<workspace>') }; process.exitCode = 1;
  if (page && !page.isClosed()) await shot(`${phase}-failure.png`, ['Actual stopped state; not passing evidence, no automatic retry']).catch(() => {});
} finally {
  await browser?.close(); report.publicAiRequests = calls;
  report.modelCallCount = currentTask?.counters?.modelCallCount ?? (calls === 0 ? 0 : null);
  report.toolCallCount = currentTask?.counters?.toolCallCount ?? (calls === 0 ? 0 : null);
  try {
    report.finalEngine = await settings(); assert.deepEqual(report.finalEngine, report.initialEngine);
    const finalIndex = await readJson(indexPath), withoutOwn = index => index.entries.filter(entry => resolve(entry.path) !== projectPath).sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(withoutOwn(finalIndex), withoutOwn(initialIndex));
    report.registryPreservation = { before: initialIndex.entries.length, after: finalIndex.entries.length, onlyOwnChanged: true };
  } catch (error) { report.passed = false; report.preservationFailure = String(error).replaceAll(process.cwd(), '<workspace>'); process.exitCode = 1; }
  await saveJson(join(directory, `${phase}-report.json`), report);
  console.log(JSON.stringify({ passed: report.passed, phase, directory: rel(directory), publicAiRequests: calls, modelCallCount: report.modelCallCount,
    toolCallCount: report.toolCallCount, failure: report.failure, preservationFailure: report.preservationFailure }));
}
