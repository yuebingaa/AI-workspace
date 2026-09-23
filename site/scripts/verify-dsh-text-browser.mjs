// DSH static and referenced text; managed 3001 only. Run serially with all other project UI acceptance (registry/lastOpenedAt).
// Default preparation reuses the manual UI preparer and blocks AI. Subsequent phases are explicit.
// Each phase persists an exclusive once marker before its sole public AI request; no automatic retry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { CELL_MODULES_CSV as csv } from './fixtures/cell-modules.mjs';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/dsh-text-browser-2026-09-22'), args = process.argv.slice(2), startedAt = Date.now();
const phases = { '--allow-paid-first': 'first', '--allow-paid-second': 'second' };
const phase = args.length === 0 ? 'prepare' : phases[args[0]];
assert.ok(phase && (phase === 'prepare' || args.length === 2), 'Usage: verify-dsh-text-browser.mjs [--allow-paid-first | --allow-paid-second] <new-owned-directory>');
const directory = phase === 'prepare' ? join(root, `browser-${startedAt}`) : resolve(args[1]);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true }); assert.equal(await realpath(directory), directory);
assert.equal((await lstat(directory)).isSymbolicLink(), false);
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const pause = ms => new Promise(done => setTimeout(done, ms));
const instructions = {
  first: '保留当前 Notebook 已有的五个单元原样不变，包括静态说明。使用本次选中的单表语义模型，在已有 Data 单元上新增一个 semanticQuery，dimensions 为空数组，measures 只有 revenue，modelId/modelVersion 使用本次选中的模型，输出表名 semantic_total。再新增一个 text 说明单元，markdown 必须为“销售总收入：{{total}}”，references 只有一项：key 为 total，cellId 引用本次新增的语义总额单元，field 为 revenue。共新增两个单元，不新增参数，不用 SQL/Python 或静态硬编码数值替代引用。请真实试运行后提交可采用草稿，不修改正式看板。',
  second: '帮我看一下，能不能给我一个分析的结论',
};
const report = { kind: 'dsh-text-browser-v1', phase, passed: false, base, startedAt,
  checks: [], screenshots: [], runs: [], requests: [], pageErrors: [], routeErrors: [], forbidden: [],
  visualReview: 'pending actual image inspection', boundaries: [
    'Static text and bounded single-row references with synthetic semantic totals; actual HTTP/SSE/DSH, no response fixture.',
    'Original semanticQuery modelId/version and source binding remain fixed; old-draft adoption compatibility is not changed or tested here.',
    'Preparation uses manual UI only and blocks all AI. One paid request per explicit phase; no automatic retries.',
    'No settings changes, service operations, external database, old project reads or automatic paid retry.',
    'Fresh tabs/contexts are not service-restart memory; public readonly trace has no private runId.'],
};
let browser, context, page, owner, firstComplete, currentTask, projectPath, handle, projectId, pageId, sessionId;
let initialIndex, indexPath, calls = 0, scenario = 'preflight', expectedRunDocument, requestDocument;
const staticTitle = '已有静态说明', staticMarkdown = '合成销售口径说明：仅包含 East 与 South。';
const book = value => value.state.dataProduct.notebooks[pageId];
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
async function settings() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
function validate(state) {
  assert.deepEqual(state.appSpec, owner.preparedAppSpec);
  assert.deepEqual(state.dataProduct.semanticLayer.models, owner.preparedSemanticLayer.models);
  assert.deepEqual(state.dataProduct.semanticLayer.selectedByWorkspace, owner.preparedSemanticLayer.selectedByWorkspace);
  const document = state.dataProduct.notebooks[pageId]; assert.ok([4, 5, 7].includes(document.cells.length));
  for (const original of owner.preparedDocument.cells) assert.deepEqual(document.cells.find(cell => cell.id === original.id), original);
  for (const cell of document.cells) assert.ok(['data', 'semanticQuery', 'table', 'chart', 'text'].includes(cell.kind));
  if (phase === 'prepare') {
    assert.ok(document.cells.length <= 5);
    const texts = document.cells.filter(cell => cell.kind === 'text');
    assert.ok(texts.length <= 1); for (const text of texts) assert.equal(text.references?.length ?? 0, 0);
  }
  if (phase === 'second') assert.deepEqual(document, firstComplete.adoptedDocument);
  assert.equal(state.assistantSessions.items.length, 1); assert.equal(state.assistantSessions.activeId, sessionId);
  assert.ok(state.harnessTasks.length <= ({ prepare: 0, first: 1, second: 2 }[phase]));
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
  assert.deepEqual(value.tables, owner.tables); assert.deepEqual(value.files, owner.files);
  assert.equal(value.tables[0].descriptor.datasetId, owner.datasetId);
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
async function openOwned() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
  await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'open');
  await dialog().getByRole('button', { name: '打开已有项目', exact: true }).click(); assert.equal((await pending).status(), 200);
  await dialog().waitFor({ state: 'hidden' }); await saved();
  assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
}
async function sendTask() {
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instructions[phase]);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click(); assert.equal((await pending).status(), 200);
  await page.waitForFunction(() => ['complete', 'failed'].includes(window.__dshText?.state), undefined, { timeout: 300000 });
  const observed = await page.evaluate(() => window.__dshText); assert.equal(observed.state, 'complete');
  const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => {
    const line = block.split(/\r?\n/u).find(value => value.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  currentTask = frames.findLast(frame => frame.task)?.task; assert.ok(currentTask); report.task = currentTask;
  await saveJson(join(directory, `${phase}-public-task.json`), { frames });
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  await saved(value => value.state.harnessTasks.some(task => task.id === currentTask.id && task.state === currentTask.state));
  await shot(`${phase}-01-answer-1440.png`, ['Actual unmodified public HTTP/SSE response; no driver replay'], page.locator('.conversation-turn').last());
  const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
  if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
  await shot(`${phase}-02-trace-1440.png`, ['Actual task counters, tools and verification'], trace); return currentTask;
}
async function startBrowser() {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window); window.fetch = async (...input) => {
        const response = await original(...input);
        if (new URL(response.url).pathname === '/api/ai/harness/stream') {
          window.__dshText = { state: 'streaming' };
          void response.clone().text().then(body => { window.__dshText = { state: 'complete', body }; }, () => { window.__dshText = { state: 'failed' }; });
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
          const body = request.postDataJSON(); assert.ok(['open', 'save'].includes(body.action));
          if (body.action === 'open') assert.equal(body.path, projectPath); else { assert.equal(request.headers()[header], handle); validate(body.state); }
        } else if (url.pathname === '/api/notebook/run') {
          assert.equal(request.headers()[header], handle); assert.ok(expectedRunDocument); const body = request.postDataJSON(); assert.equal(body.action, 'run');
          assert.deepEqual(body.document, expectedRunDocument); assert.deepEqual(body.semanticModels, owner.preparedSemanticLayer.models);
        } else if (url.pathname === '/api/ai/harness/stream') {
          assert.notEqual(phase, 'prepare', 'Preparation must not call AI'); assert.equal(request.headers()[header], handle); assert.equal(++calls, 1); const payload = request.postDataJSON(); assert.equal(payload.instruction, instructions[phase]);
          assert.equal(payload.conversation_id, sessionId); assert.deepEqual(payload.notebookContext.document, requestDocument);
          assert.deepEqual(payload.notebookContext.sourceIds, [owner.datasetId]); assert.equal(payload.dataSourceId, owner.datasetId);
          assert.deepEqual(payload.semanticModel, owner.preparedSemanticLayer.models[0]);
          report.publicRequest = { conversation_id: payload.conversation_id, idempotencyKey: payload.idempotencyKey, cellCount: payload.notebookContext.document.cells.length,
            sourceIds: payload.notebookContext.sourceIds, selectedModel: payload.semanticModel ?? null };
          await saveJson(join(directory, `${phase}-attempt.json`), { phase, startedAt: new Date().toISOString(), projectId, sessionId,
            idempotencyKey: payload.idempotencyKey, onceOnly: true, expectedPaidModel: true });
        } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation blocked'); }
        return await route.continue();
      } catch (error) { report.routeErrors.push({ scenario, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
    });
    page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
}

async function humanRun(document) {
  expectedRunDocument = document;
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 90000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200); assert.equal(result.run.status, 'success'); assert.equal(result.run.revision, document.revision);
  for (const cell of document.cells.filter(cell => cell.kind !== 'data')) {
    const output = result.run.cells.find(output => output.cellId === cell.id); assert.equal(output.status, 'success');
    if (cell.kind === 'text') {
      assert.equal(output.table, undefined); assert.equal(output.text, cell.references?.length ? '销售总收入：230' : undefined);
    } else assert.deepEqual(output.table.rows, cell.kind === 'semanticQuery' && cell.dimensions.length === 0
      ? [{ revenue: 230 }] : [{ area: 'East', revenue: 150 }, { area: 'South', revenue: 80 }]);
  }
  report.runs.push(result.run); expectedRunDocument = undefined;
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return result.run;
}
async function prepareText() {
  await startBrowser(); scenario = 'Open new manual project and add one static text'; await openOwned(); await mode('Notebook');
  const editor = () => page.getByRole('form', { name: '说明单元编辑器', exact: true });
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: '＋ 说明', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(staticTitle);
  await editor().getByLabel('分析说明', { exact: true }).fill(staticMarkdown);
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  const prepared = await saved(value => book(value).cells.some(cell => cell.kind === 'text' && cell.markdown === staticMarkdown));
  const text = book(prepared).cells.find(cell => cell.kind === 'text'), baseline = book(prepared);
  const card = () => page.getByRole('article', { name: `说明单元 ${staticTitle}`, exact: true });
  scenario = 'Existing static text invalid reference template rejected by real editor';
  await card().getByRole('button', { name: '编辑', exact: true }).click();
  await editor().getByRole('button', { name: '添加数据引用', exact: true }).click();
  await editor().getByLabel('引用键 1', { exact: true }).fill('total');
  await editor().getByLabel('引用单元 1', { exact: true }).selectOption(owner.preparedDocument.cells.find(cell => cell.kind === 'semanticQuery').id);
  await editor().getByLabel('引用字段 1', { exact: true }).fill('revenue');
  await editor().getByLabel('分析说明', { exact: true }).fill('非法表达式：{{total + 1}}');
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').textContent(), /文本模板只支持/u);
  assert.deepEqual(book(await manifest()), baseline);
  await shot('prepare-05-invalid-template-1440.png', ['Actual UI rejects expression in referenced template; saved static definition unchanged, no AI'], editor().getByRole('alert'));
  scenario = 'Cancel invalid edit and retain static definition';
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  assert.deepEqual(book(await saved()), baseline);
  await card().getByText(staticMarkdown, { exact: true }).waitFor();
  await shot('prepare-06-cancel-retains-static-1440.png', ['Actual cancel returns to original static text; malformed template was not saved'], card());
  scenario = 'Run five cells including existing static text'; const run = await humanRun(baseline);
  assert.equal(run.cells.find(output => output.cellId === text.id).status, 'success');
  owner.semanticBaselineDocument = owner.preparedDocument; owner.preparedDocument = baseline; owner.staticCellId = text.id;
  const oldPage = page; page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('Notebook');
  const reopened = await saved(); assert.deepEqual(book(reopened), baseline); assert.deepEqual(reopened.state.dataProduct.semanticLayer, owner.preparedSemanticLayer);
  scenario = 'Fresh tab rerun same five definitions with static text'; const rerun = await humanRun(baseline); assert.notEqual(rerun.runId, run.runId); await oldPage.close();
  await shot('prepare-07-reopened-static-1024.png', ['Actual saved static text and original four semantic cells reopen; new human run keeps150/80'], card());
  await resources(await saved());
  await saveJson(join(directory, 'ownership.json'), owner);
  report.finalState = { cells: baseline.cells.length, revision: baseline.revision, sessionId, originalSemanticCells: 4, staticCellId: text.id, modelCount: 1 };
  report.checks.push('Actual UI added static text; illegal referenced expression save rejected and cancelled without changing its definition.',
    'Five manual cells reran successfully; new-tab save/reopen/rerun retained static text and original150/80, zero AI.');
}

async function prepare() {
  const child = spawn(process.execPath, ['scripts/verify-m7-semantic-browser.mjs'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); }); child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  await writeFile(join(directory, 'manual-prepare-stdout.log'), stdout, { flag: 'wx' });
  await writeFile(join(directory, 'manual-prepare-stderr.log'), stderr, { flag: 'wx' });
  const output = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1));
  const preparedDirectory = resolve(output.directory), manualRoot = resolve('.runtime/m7-semantic-browser-2026-09-22');
  assert.match(relative(manualRoot, preparedDirectory), /^browser-\d+$/u);
  const attempt = Number(basename(preparedDirectory).slice('browser-'.length)); assert.ok(attempt >= startedAt && attempt <= Date.now());
  assert.equal(await realpath(preparedDirectory), preparedDirectory);
  report.manualPreparation = { directory: rel(preparedDirectory), exitCode: code, report: rel(join(preparedDirectory, 'report.json')) };
  assert.equal(code, 0); const prepared = await readJson(join(preparedDirectory, 'report.json')); assert.equal(prepared.passed, true);
  assert.equal(prepared.attempt, attempt); assert.ok(prepared.stepEvidence.every(step => step.status === 'executed'));
  const manualOwner = await readJson(join(preparedDirectory, 'ownership.json')); assert.equal(manualOwner.kind, 'm7-semantic-ui-v1');
  projectPath = join(preparedDirectory, 'project'); assert.equal(manualOwner.projectPath, projectPath);
  ({ handle, projectId, pageId } = manualOwner); const value = await readJson(join(projectPath, 'agentcanvas.project.json'));
  assert.equal(value.id, projectId); assert.equal(value.state.harnessTasks.length, 0); assert.equal(book(value).cells.length, 4);
  assert.deepEqual(book(value), prepared.final.document); assert.deepEqual(value.state.dataProduct.semanticLayer, prepared.final.semanticLayer);
  sessionId = value.state.assistantSessions.activeId; const model = value.state.dataProduct.semanticLayer.models[0];
  assert.equal(value.state.dataProduct.semanticLayer.models.length, 1); assert.equal(model.sourceDatasetId, prepared.final.datasetId);
  assert.equal(model.dimensions[0].key, 'area'); assert.equal(model.measures[0].key, 'revenue'); assert.equal(model.measures[0].aggregation, 'sum');
  assert.equal(value.state.dataProduct.semanticLayer.selectedByWorkspace[pageId], model.id);
  owner = { kind: report.kind, directory, preparedDirectory, preparationAttempt: attempt, projectPath, handle, projectId, pageId, sessionId,
    datasetId: prepared.final.datasetId, preparedDocument: book(value), preparedAppSpec: value.state.appSpec,
    preparedSemanticLayer: value.state.dataProduct.semanticLayer, tables: value.tables, files: value.files };
  validate(value.state); await resources(value);
  report.screenshots = prepared.screenshots.map(shot => ({ ...shot, sourceDirectory: rel(preparedDirectory) }));
  report.runs = prepared.runs; report.checks.push('Reused existing UI preparer without resume: new CSV/original/model/four cells, actual150/80, save/new-tab reopen/run, zero AI.');
}
try {
  report.initialEngine = await settings(); assert.equal(report.initialEngine.engine, 'dsh'); assert.equal(report.initialEngine.activeTasks, 0);
  const location = await readJson(resolve('.runtime/runtime-location.json')), config = await readJson(join(location.root, 'config.json'));
  indexPath = join(config.devState, 'local-projects.json'); initialIndex = await readJson(indexPath);
  if (phase === 'prepare') { await prepare(); await prepareText(); }
  else {
    owner = await readJson(join(directory, 'ownership.json')); assert.equal(owner.kind, report.kind); assert.equal(owner.directory, directory);
    assert.equal((await readJson(join(directory, 'prepare-report.json'))).passed, true);
    assert.equal(owner.preparedDocument.cells.length, 5);
    const staticCell = owner.preparedDocument.cells.find(cell => cell.id === owner.staticCellId);
    assert.equal(staticCell.kind, 'text'); assert.equal(staticCell.markdown, staticMarkdown); assert.equal(staticCell.references?.length ?? 0, 0);
    assert.equal(owner.preparationAttempt, Number(basename(owner.preparedDirectory).slice('browser-'.length)));
    assert.ok(owner.preparationAttempt >= Number(basename(directory).slice('browser-'.length)));
    assert.match(relative(resolve('.runtime/m7-semantic-browser-2026-09-22'), owner.preparedDirectory), /^browser-\d+$/u);
    assert.equal(owner.projectPath, join(owner.preparedDirectory, 'project'));
    ({ projectPath, handle, projectId, pageId, sessionId } = owner); assert.equal(await realpath(projectPath), projectPath);
    await assert.rejects(lstat(join(directory, `${phase}-attempt.json`)), error => error.code === 'ENOENT');
    const before = await readJson(join(projectPath, 'agentcanvas.project.json')); await resources(before);
    if (phase === 'second') {
      assert.equal((await readJson(join(directory, 'first-report.json'))).passed, true); firstComplete = await readJson(join(directory, 'first-complete.json'));
      assert.deepEqual(book(before), firstComplete.adoptedDocument); assert.equal(before.state.harnessTasks.length, 1);
    } else { assert.deepEqual(book(before), owner.preparedDocument); assert.equal(before.state.harnessTasks.length, 0); }
    validate(before.state);
    requestDocument = book(before); await startBrowser();
    scenario = 'Reopen newly prepared owned project'; await openOwned(); await mode('AI 工作台');
    scenario = `One real ${phase} task`; const task = await sendTask(); assert.deepEqual(book(await saved()), book(before));
    if (phase === 'first') {
      assert.equal(task.state, 'awaitingConfirmation'); assert.equal(task.verification?.status, 'passed'); const artifact = task.notebookArtifact; assert.ok(artifact);
      assert.equal(artifact.executionEvidence.status, 'success'); assert.equal(artifact.cells.length, 7);
      for (const original of owner.preparedDocument.cells) assert.deepEqual(artifact.cells.find(cell => cell.id === original.id), original);
      const additions = artifact.cells.filter(cell => !owner.preparedDocument.cells.some(original => original.id === cell.id));
      assert.deepEqual(additions.map(cell => cell.kind).sort(), ['semanticQuery', 'text']); const total = additions.find(cell => cell.kind === 'semanticQuery');
      assert.equal(total.modelId, owner.preparedSemanticLayer.models[0].id); assert.equal(total.modelVersion, owner.preparedSemanticLayer.models[0].version);
      assert.deepEqual(total.dimensions, []); assert.deepEqual(total.measures, ['revenue']); assert.equal(total.inputCellId, owner.preparedDocument.cells.find(cell => cell.kind === 'data').id);
      const note = additions.find(cell => cell.kind === 'text'); assert.equal(note.markdown, '销售总收入：{{total}}');
      assert.deepEqual(note.references, [{ key: 'total', cellId: total.id, field: 'revenue' }]);
      for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft']) assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === name));
      scenario = 'Review and explicitly adopt actual two-cell draft'; await mode('Notebook'); await draft().waitFor();
      await draft().getByText(/查看变更和步骤/u).click(); await shot('first-03-draft-review-1440.png', ['Two actual additions including bounded text references; original five cells unchanged, trial verified'], draft());
      await draft().getByRole('button', { name: '采用草稿', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
      const adopted = await saved(value => book(value).lastDraftId === artifact.id), document = book(adopted);
      assert.equal(document.revision, owner.preparedDocument.revision + 1); assert.deepEqual(document.cells, artifact.cells);
      scenario = 'Explicit human run after adoption'; const result = await humanRun(document);
      assert.notEqual(result.runId, artifact.executionEvidence.runId);
      await shot('first-04-text230-1440.png', ['Actual post-adoption referenced text reads销售总收入：230; old150/80 and static text retained'], page.getByRole('article', { name: `说明单元 ${note.title}`, exact: true }));
      scenario = 'Fresh tab reopen same conversation and saved seven cells'; await page.close(); page = await context.newPage(); observe(page);
      await page.setViewportSize({ width: 1024, height: 900 }); await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('AI 工作台');
      const reopened = await saved(); assert.deepEqual(book(reopened), document); assert.equal(reopened.state.harnessTasks[0].state, 'completed');
      assert.equal(reopened.state.assistantSessions.items[0].turns.length, 1); assert.equal(calls, 1); assert.equal(report.runs.length, 1);
      await shot('first-05-reopened-1024.png', ['Same conversation and adopted definitions reopened, no extra AI or automatic run'], page.locator('.conversation-turn').last());
      await saveJson(join(directory, 'first-complete.json'), { sessionId, taskId: task.id, adoptedDocument: document,
        trialRunId: artifact.executionEvidence.runId, humanRunId: result.runId });
      report.checks.push('Actual DSH edit/run/submit added semantic total/text; adoption and human run verified reference text230, original150/80 and static text.', 'Saved/new-tab reopened exact seven-cell document and same conversation.');
    } else {
      assert.equal(task.state, 'completed'); assert.equal(task.verification?.status, 'passed'); assert.equal(task.notebookArtifact, undefined);
      assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === 'runNotebookCells'));
      assert.equal(task.trace.some(event => ['editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), false);
      assert.match(task.resultMessage, /(?<!\d)230(?!\d)/u); assert.deepEqual(book(await saved()), firstComplete.adoptedDocument);
      await page.setViewportSize({ width: 1024, height: 900 }); await shot('second-03-answer-1024.png', ['Same conversation, new readonly run and current total230; formal seven cells/model/dashboard unchanged'], page.locator('.conversation-turn').last());
      report.checks.push('Second same-session task performed a new run and returned a passed readonly conclusion, no edit or submit.');
      scenario = 'Read-only Agent settings text capability description'; await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
      const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
      await navigation.locator('summary').filter({ hasText: '设置与备份' }).click();
      await navigation.getByRole('button', { name: 'Agent 执行与插件', exact: true }).click();
      const settingsDialog = page.getByRole('dialog', { name: 'Agent 执行与插件', exact: true });
      await settingsDialog.locator('.agent-engine-current').waitFor();
      assert.equal(await settingsDialog.locator('input[name="agent-execution-engine"][value="dsh"]').isChecked(), true);
      assert.equal(await settingsDialog.getByRole('button', { name: '应用执行引擎', exact: true }).isDisabled(), true);
      const notebookPlugin = settingsDialog.locator('.agent-engine-plugins article').filter({ hasText: 'Notebook 数据分析' });
      assert.match(await notebookPlugin.textContent(), /说明|文本/u);
      await shot('second-04-text-plugin-1440.png', ['Actual settings GET and text capability description; no apply or settings mutation'], notebookPlugin);
      await settingsDialog.getByRole('button', { name: '关闭 Agent 执行与插件', exact: true }).click();
      report.checks.push('Opened actual Agent settings read-only; Notebook plugin explains text support, settings unchanged.');
    }
    const final = await saved(); await resources(final); assert.deepEqual(final.state.dataProduct.semanticLayer, owner.preparedSemanticLayer);
    report.finalState = { tables: final.tables.length, originalFiles: final.files.length, cells: book(final).cells.length,
      revision: book(final).revision, sessionId, tasks: final.state.harnessTasks.map(({ id, state }) => ({ id, state })) };
  }
  assert.equal(calls, phase === 'prepare' ? 0 : 1); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.forbidden, []);
  report.passed = true;
} catch (error) {
  report.failure = { scenario, message: String(error).replaceAll(process.cwd(), '<workspace>') }; process.exitCode = 1;
  if (page && !page.isClosed()) await shot(`${phase}-failure.png`, ['Actual stopped state; no automatic retry']).catch(() => {});
} finally {
  await browser?.close(); report.publicAiRequests = calls;
  report.modelCallCount = currentTask?.counters?.modelCallCount ?? (calls === 0 ? 0 : null);
  report.toolCallCount = currentTask?.counters?.toolCallCount ?? (calls === 0 ? 0 : null);
  try {
    report.finalEngine = await settings(); assert.deepEqual(report.finalEngine, report.initialEngine);
    const finalIndex = await readJson(indexPath), withoutOwn = index => index.entries.filter(entry => resolve(entry.path) !== projectPath).sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(withoutOwn(finalIndex), withoutOwn(initialIndex));
    report.registryPreservation = { before: initialIndex.entries.length, after: finalIndex.entries.length, onlyOwnChanged: true };
  } catch (error) { report.passed = false; report.preservationFailure = String(error); process.exitCode = 1; }
  await saveJson(join(directory, `${phase}-report.json`), report);
  console.log(JSON.stringify({ passed: report.passed, phase, directory: rel(directory), publicAiRequests: calls, modelCallCount: report.modelCallCount,
    toolCallCount: report.toolCallCount, failure: report.failure, preservationFailure: report.preservationFailure }));
}
