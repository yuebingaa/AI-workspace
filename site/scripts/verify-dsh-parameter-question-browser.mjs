// Managed 3001, new synthetic project only. No notebook runs, model replay, or settings changes.
// Preparation is free; each explicit paid phase forwards at most one task after an exclusive marker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { CELL_MODULES_CSV as csv } from './fixtures/cell-modules.mjs';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/dsh-parameter-question-browser-2026-09-22');
const args = process.argv.slice(2), startedAt = Date.now();
const phase = args.length === 0 ? 'prepare' : { '--allow-paid-first': 'first', '--allow-paid-second': 'second' }[args[0]];
assert.ok(phase && (phase === 'prepare' || args.length === 2), 'Usage: verify-dsh-parameter-question-browser.mjs [--allow-paid-first | --allow-paid-second] <owned-directory>');
const directory = phase === 'prepare' ? join(root, `browser-${startedAt}`) : resolve(args[1]);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true }); assert.equal(await realpath(directory), directory);
assert.equal((await lstat(directory)).isSymbolicLink(), false);
const projectPath = join(directory, 'project'), fileName = 'dsh-parameter-question-sales.csv';
const instruction = '当前参数值是多少？';
const titles = { data: '合成地区销售', parameter: '地区筛选参数' };
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = { kind: 'dsh-parameter-question-browser-v1', phase, base, startedAt, passed: false,
  checks: [], screenshots: [], requests: [], pageErrors: [], routeErrors: [], forbidden: [],
  visualReview: 'pending actual image inspection', boundaries: [
    'Real public HTTP/SSE/DSH, with no replacement model/task/persistence response.',
    'New synthetic CSV and Data/select cells only; notebook execution is blocked throughout.',
    'Preparation zero AI; one task per explicit paid phase, exclusive marker, no automatic retry.',
    'Only owned project registration may change; raw bytes, definitions, settings and other registrations checked.',
    'Public trace omits tool arguments; tool names and validation are observed, not private SDK request content.',
    'New-tab persistence is tested, not service-restart memory. No credentials or database configuration read.'],
};
let browser, context, page, owner, handle, projectId, pageId, sessionId, datasetId;
let initialIndex, indexPath, currentTask, nextDocument, requestDocument;
let calls = 0, created = 0, scenario = 'preflight';
const book = value => value.state.dataProduct.notebooks?.[pageId];
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const card = kind => page.getByRole('article', { name: `${kind === 'data' ? 'Data' : '参数'}单元 ${titles[kind]}`, exact: true });
async function settings() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
function validate(state) {
  assert.equal(state.appSpec.pages.length, 1); assert.deepEqual(state.appSpec.pages[0].root.children, []);
  assert.equal(state.dataProduct.semanticLayer.models.length, 0);
  const document = state.dataProduct.notebooks?.[pageId];
  assert.ok((document?.cells.length ?? 0) <= 2);
  for (const cell of document?.cells ?? []) assert.ok(['data', 'parameter'].includes(cell.kind));
  assert.ok(state.harnessTasks.length <= ({ prepare: 0, first: 1, second: 2 }[phase]));
  if (owner) {
    assert.deepEqual(state.appSpec, owner.appSpec); assert.deepEqual(state.dataProduct.semanticLayer, owner.semanticLayer);
    assert.equal(state.assistantSessions.items.length, 1); assert.equal(state.assistantSessions.activeId, sessionId);
    assert.equal(document.cells.length, 2);
    assert.deepEqual(document.cells.find(cell => cell.kind === 'data'), owner.document.cells.find(cell => cell.kind === 'data'));
    const original = owner.document.cells.find(cell => cell.kind === 'parameter');
    const current = document.cells.find(cell => cell.kind === 'parameter');
    assert.ok(['East', 'South'].includes(current.parameter.value));
    assert.deepEqual(current, { ...original, parameter: { ...original.parameter, value: current.parameter.value } });
    if (phase === 'second') assert.deepEqual(document, nextDocument);
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
  throw new Error(`Owned project save did not settle: ${scenario}`);
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
  if (create) await dialog().getByLabel('项目名称', { exact: true }).fill('DSH 当前参数只读问答');
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
        window.__dshParameterQuestion = { state: 'streaming' };
        void response.clone().text().then(body => { window.__dshParameterQuestion = { state: 'complete', body }; }, () => { window.__dshParameterQuestion = { state: 'failed' }; });
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
      } else if (url.pathname === '/api/ai/harness/stream') {
        assert.notEqual(phase, 'prepare'); assert.equal(request.headers()[header], handle); assert.equal(++calls, 1);
        const payload = request.postDataJSON(); assert.equal(payload.instruction, instruction); assert.equal(payload.conversation_id, sessionId);
        assert.deepEqual(payload.notebookContext.document, requestDocument); assert.deepEqual(payload.notebookContext.sourceIds, [datasetId]);
        assert.equal(payload.dataSourceId, datasetId); assert.equal(payload.semanticModel, undefined);
        report.publicRequest = { conversation_id: payload.conversation_id, idempotencyKey: payload.idempotencyKey, cells: payload.notebookContext.document.cells.length, sourceIds: payload.notebookContext.sourceIds };
        await saveJson(join(directory, `${phase}-attempt.json`), { phase, startedAt: new Date().toISOString(), projectId, sessionId,
          idempotencyKey: payload.idempotencyKey, onceOnly: true, expectedPaidModel: true });
      } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation or notebook run blocked'); }
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
  const label = kind === 'data' ? 'Data' : '参数';
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(titles[kind]); await configure(); await saveEditor();
  return book(await saved(value => book(value)?.cells.some(cell => cell.kind === kind && cell.title === titles[kind]))).cells.find(cell => cell.kind === kind);
}
async function reopen() {
  await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('Notebook'); return await saved();
}
async function prepare() {
  await assert.rejects(lstat(projectPath), error => error.code === 'ENOENT'); await startBrowser();
  scenario = 'New owned project with real synthetic CSV import'; await openOwned(true); await mode('Notebook');
  await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  const imported = await saved(value => value.tables.length === 1 && value.files.length === 1); datasetId = imported.tables[0].descriptor.datasetId; await resources(imported);
  await add('data', async () => { await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); });
  await add('parameter', async () => {
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('region_pick'); await editor().getByLabel('参数类型', { exact: true }).selectOption('select');
    await editor().getByLabel('单选选项 1', { exact: true }).fill('East'); await editor().getByLabel('单选选项 2', { exact: true }).fill('South');
    await editor().getByLabel('参数值', { exact: true }).selectOption('East');
  });
  const east = book(await saved());
  scenario = 'Saved East parameter, never run'; await shot('prepare-01-east-1440.png', ['Data and select East definitions saved; both have no computation output'], card('parameter'));
  scenario = 'Unsaved South edit is cancelled, stored East unchanged';
  await card('parameter').getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('参数值', { exact: true }).selectOption('South');
  assert.deepEqual(book(await manifest()), east); await shot('prepare-02-unsaved-south-1440.png', ['Editor shows unsaved South, server document still East'], editor());
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' }); assert.deepEqual(book(await saved()), east);
  await shot('prepare-03-cancel-east-1440.png', ['Cancel keeps exact saved East definition and revision'], card('parameter'));
  scenario = 'New tab reopens exact East document, no auto run'; const reopened = await reopen(); assert.deepEqual(book(reopened), east);
  await shot('prepare-04-reopened-east-1024.png', ['Fresh tab restores saved East, no execution or AI'], card('parameter'));
  owner = { kind: report.kind, directory, projectPath, handle, projectId, pageId, sessionId, datasetId, document: east,
    appSpec: reopened.state.appSpec, semanticLayer: reopened.state.dataProduct.semanticLayer, tables: reopened.tables, files: reopened.files };
  await resources(reopened); await saveJson(join(directory, 'ownership.json'), owner);
  report.finalState = { cells: 2, revision: east.revision, sessionId, parameter: 'East' };
  report.checks.push('Real import and manual Data/select creation; cancel unsaved South and reopen keeps East; zero notebook runs or AI.');
}
async function sendTask() {
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click(); assert.equal((await pending).status(), 200);
  await page.waitForFunction(() => ['complete', 'failed'].includes(window.__dshParameterQuestion?.state), undefined, { timeout: 300000 });
  const observed = await page.evaluate(() => window.__dshParameterQuestion); assert.equal(observed.state, 'complete');
  const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => {
    const line = block.split(/\r?\n/u).find(value => value.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  currentTask = frames.findLast(frame => frame.task)?.task; assert.ok(currentTask); report.task = currentTask;
  await saveJson(join(directory, `${phase}-public-task.json`), { frames });
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  await saved(value => value.state.harnessTasks.some(task => task.id === currentTask.id && task.state === currentTask.state));
  await shot(`${phase}-01-answer-1440.png`, ['Actual latest response from public HTTP/SSE, no replacement task'], page.locator('.conversation-turn').last());
  const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
  if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
  await shot(`${phase}-02-trace-1440.png`, ['Actual tool trace and verification; this is not private chain-of-thought'], trace);
  return currentTask;
}
async function paid() {
  owner = await readJson(join(directory, 'ownership.json')); assert.equal(owner.kind, report.kind); assert.equal(owner.directory, directory); assert.equal(owner.projectPath, projectPath);
  assert.equal((await readJson(join(directory, 'prepare-report.json'))).passed, true); assert.equal(await realpath(projectPath), projectPath);
  ({ handle, projectId, pageId, sessionId, datasetId } = owner); assert.equal(owner.document.cells.length, 2);
  await assert.rejects(lstat(join(directory, `${phase}-attempt.json`)), error => error.code === 'ENOENT');
  const before = await readJson(join(projectPath, 'agentcanvas.project.json')); await resources(before);
  if (phase === 'second') {
    assert.equal((await readJson(join(directory, 'first-report.json'))).passed, true);
    const first = await readJson(join(directory, 'first-complete.json')); assert.equal(first.sessionId, sessionId); nextDocument = first.nextDocument;
    assert.deepEqual(book(before), nextDocument); assert.equal(before.state.harnessTasks.length, 1);
  } else { assert.deepEqual(book(before), owner.document); assert.equal(before.state.harnessTasks.length, 0); }
  validate(before.state); requestDocument = book(before); await startBrowser(); scenario = 'Open exact saved owned document and same session'; await openOwned(); await mode('AI 工作台');
  scenario = `One real ${phase} current-parameter question`; const task = await sendTask();
  assert.deepEqual(book(await saved()), requestDocument); assert.equal(task.state, 'completed'); assert.equal(task.verification?.status, 'passed');
  assert.equal(task.notebookArtifact, undefined);
  const completed = task.trace.filter(event => event.type === 'tool_completed'); assert.ok(completed.length > 0);
  assert.ok(completed.every(event => event.toolCall?.name === 'cellSearch'));
  assert.equal(task.trace.some(event => event.type === 'tool_failed'), false);
  assert.equal(task.trace.some(event => ['runNotebookCells', 'editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), false);
  const expected = phase === 'first' ? 'East' : 'South'; assert.match(task.resultMessage, new RegExp(`\\b${expected}\\b`, 'u'));
  report.checks.push(`Exact original question completed using only cellSearch, current ${expected} answered, no artifact/run/edit/submit or formal definition changes.`);
  if (phase === 'first') {
    scenario = 'Human changes saved value East to South after first answer'; await mode('Notebook');
    await card('parameter').getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('参数值', { exact: true }).selectOption('South'); await saveEditor();
    const south = book(await saved(value => book(value).cells.find(cell => cell.kind === 'parameter').parameter.value === 'South'));
    assert.equal(south.revision, requestDocument.revision + 1);
    await shot('first-03-manual-south-1440.png', ['Only human changes parameter East→South; no run or AI change'], card('parameter'));
    scenario = 'Fresh tab reopens new South and prior same-session East answer'; const reopened = await reopen(); assert.deepEqual(book(reopened), south);
    assert.equal(reopened.state.assistantSessions.items[0].turns.length, 1);
    await shot('first-04-reopened-south-1024.png', ['New tab shows saved South and original two cells, same session with one prior answer'], card('parameter'));
    await saveJson(join(directory, 'first-complete.json'), { sessionId, taskId: task.id, nextDocument: south });
  } else {
    scenario = 'Current South answer shown at narrow desktop without changing document'; await page.setViewportSize({ width: 1024, height: 900 });
    const trace = page.locator('.conversation-turn').last().locator('.harness-trace'); if (await trace.getAttribute('open') !== null) await trace.locator('summary').first().click();
    await shot('second-03-south-answer-1024.png', ['Latest same-session answer states current South, not stale East; formal definition unchanged'], page.locator('.conversation-turn').last());
    scenario = 'Saved second answer reopens without additional calls'; const reopened = await reopen(); assert.deepEqual(book(reopened), nextDocument);
    assert.equal(reopened.state.assistantSessions.items[0].turns.length, 2); await mode('AI 工作台');
    await shot('second-04-reopened-answer-1024.png', ['Two saved answers in original session, latest South remains; reopen makes no additional model request'], page.locator('.conversation-turn').last());
  }
  const final = await saved(); await resources(final);
  report.finalState = { cells: book(final).cells.length, revision: book(final).revision, sessionId,
    parameter: book(final).cells.find(cell => cell.kind === 'parameter').parameter.value, tasks: final.state.harnessTasks.map(({ id, state }) => ({ id, state })) };
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
  if (page && !page.isClosed()) await shot(`${phase}-failure.png`, ['Actual stopped state, not successful evidence; no automatic retry']).catch(() => {});
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
