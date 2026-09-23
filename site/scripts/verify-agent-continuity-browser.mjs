// M7 resumed acceptance: fresh owned synthetic project, real 3001 UI and SQL.
// Only model choices are fixed; the existing fixture runs actual Harness tools.
// Default prepares UI data only; --run <owned-directory> permits two offline tasks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { AGENT_CONTINUITY_FILE_NAME as fileName, AGENT_CONTINUITY_CSV as csv,
  AGENT_CONTINUITY_TITLES as titles, AGENT_CONTINUITY_EXPECTED as expected,
  createAgentContinuityRunner } from './fixtures/agent-continuity.mjs';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/m7-agent-continuity-2026-09-22');
const args = process.argv.slice(2), run = args[0] === '--run';
assert.ok(args.length === 0 || (run && args.length === 2), 'Usage: node scripts/verify-agent-continuity-browser.mjs [--run <owned-directory>]');
const directory = run ? resolve(args[1]) : join(root, `browser-${Date.now()}`);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true });
assert.equal(await realpath(directory), directory); assert.equal((await lstat(directory)).isSymbolicLink(), false);
const projectPath = join(directory, 'project'), ownershipPath = join(directory, 'ownership.json');
const firstInstruction = '检查现有单元，按地区汇总 CSV，添加 SQL、表格和图表单元，先验证再让我采用。';
const followupInstruction = '保留现有地区汇总和图表单元，再计算其两倍收入并生成新的 SQL、表格和图表单元，先不要采用。';
const oldProject = resolve('.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project');
const oldId = 'c5613c9c-1509-4542-a272-fe5aac668d52';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const report = { passed: false, prepared: false, run, base, project: rel(projectPath), checks: [], screenshots: [],
  requests: [], tasks: [], runs: [], routeErrors: [], pageErrors: [], consoleErrors: [], forbidden: [],
  boundaries: ['New synthetic project; does not resume or alter old failed M7 resources.',
    'Two offline tasks only. Actual browser payload, real Harness/SQL, buffered formal SSE. No paid model, public-handler authorization, realtime transport or process-restart claim.',
    'Second draft dismissal hides it in the current window; its task remains awaitingConfirmation.'], visualReview: 'pending actual screenshot inspection' };
let browser, context, page, owner, handle, projectId, pageId, datasetId, sessionId, firstDocument, adoptedDocument, runner;
let scenario = 'preflight', phase, calls = 0, oldSnapshot, indexPath, initialIndex;
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
const chart = () => page.getByRole('article', { name: `图表单元 ${titles.firstChart}`, exact: true });
const book = value => value.state.dataProduct.notebooks?.[pageId];
const dashboard = value => value.state.appSpec.pages.find(item => item.id === pageId);
async function snapshotOld() {
  assert.equal(await realpath(oldProject), oldProject);
  const ownership = JSON.parse(await readFile(join(oldProject, '..', 'report.json'), 'utf8'));
  assert.equal(resolve(ownership.projectPath), oldProject);
  const bytes = await readFile(join(oldProject, 'agentcanvas.project.json')), value = JSON.parse(bytes);
  assert.equal(value.id, oldId); assert.equal(value.stateRevision, 160);
  assert.equal(value.tables.length, 41); assert.equal(value.files.length, 17);
  assert.equal(value.state.harnessTasks.length, 1); assert.equal(value.state.harnessTasks[0].state, 'failed');
  const files = [];
  for (const kind of ['tables', 'files']) for (const entry of value[kind]) {
    const path = join(oldProject, kind, entry.file); assert.equal(await realpath(path), path);
    const raw = await readFile(path); assert.equal(raw.length, entry.bytes); assert.equal(checksum(raw), entry.sha256);
    files.push({ path: rel(path), sha256: checksum(raw) });
  }
  return { manifestSha256: checksum(bytes), id: value.id, revision: value.stateRevision, tasks: value.state.harnessTasks.map(({ id, state }) => ({ id, state })), files };
}
async function engineStatus() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(value.handle, handle); assert.equal(resolve(value.path), projectPath);
  assert.equal(value.manifest.id, projectId); return value.manifest;
}
function validateState(state) {
  assert.ok(state.appSpec.pages.length <= 1); assert.ok(state.harnessTasks.length <= 2);
  for (const app of [state.appSpec, state.dataProduct.appSpec]) for (const item of app.pages) assert.deepEqual(item.root.children, []);
  for (const definition of Object.values(state.dataProduct.notebooks ?? {})) {
    assert.ok(definition.cells.length <= 4, 'Follow-up draft must not be adopted');
    for (const cell of definition.cells) {
      assert.ok(['data', 'sql', 'table', 'chart'].includes(cell.kind));
      if (cell.kind === 'data' && datasetId) assert.equal(cell.sourceDataSourceId, datasetId);
      else if (cell.kind !== 'data') assert.equal(cell.id, `m7_agent_first_${cell.kind}`);
    }
  }
  if (owner) {
    assert.deepEqual(state.dataProduct.semanticLayer, owner.preparedState.dataProduct.semanticLayer);
    assert.deepEqual(state.changeHistory, owner.preparedState.changeHistory);
    assert.deepEqual(state.edsWorkspace, owner.preparedState.edsWorkspace);
    assert.equal(state.assistantSessions.items.length, 1);
    assert.equal(state.assistantSessions.items[0].id, sessionId);
  }
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 30000; let revision, stable;
  while (Date.now() < deadline) {
    const value = await manifest();
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable > 650) { validateState(value.state); return value; }
    } else { revision = undefined; stable = undefined; }
    await sleep(100);
  }
  throw new Error(`Scoped project was not stably saved: ${scenario}`);
}
async function shot(name, assertions, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(directory, name), animations: 'disabled' });
  report.screenshots.push({ name, scenario, viewport: page.viewportSize(), assertions, actualImageReviewed: false });
}
async function step(name, action) { scenario = name; await action(); report.checks.push(name); console.log(`PASS ${name}`); }
function observe(target) {
  target.setDefaultTimeout(20000);
  target.on('pageerror', error => report.pageErrors.push({ scenario, message: error.message }));
  target.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ scenario, message: message.text() }); });
}
async function dismissNotice() {
  const button = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await button.isVisible()) await button.click();
}
async function mode(name) { await page.getByRole('tab', { name, exact: true }).click(); await dismissNotice(); }
async function openBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
}
async function openOwned() {
  await openBrowser(); await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'open');
  await dialog().getByRole('button', { name: '打开已有项目', exact: true }).click(); assert.equal((await pending).status(), 200);
  await dialog().waitFor({ state: 'hidden' }); await saved(); await dismissNotice();
  assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
}
async function verifyResources(value) {
  assert.equal(value.tables.length, 1); assert.equal(value.files.length, 1);
  const table = value.tables[0], original = value.files[0]; assert.equal(table.descriptor.datasetId, datasetId);
  assert.equal(original.name, fileName); assert.deepEqual(original.datasetIds, [datasetId]);
  for (const [folder, entry] of [['tables', table], ['files', original]]) {
    const path = join(projectPath, folder, entry.file); assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert.equal(checksum(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
    if (folder === 'files') assert.equal(bytes.toString('utf8'), csv);
    else assert.deepEqual(JSON.parse(bytes).rows, [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }]);
  }
}
async function sendAgent(nextPhase, instruction) {
  phase = nextPhase; await mode('AI 工作台');
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await page.locator('.conversation-turn').last().locator('.harness-trace.waiting').waitFor({ timeout: 70000 });
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(report.tasks.length, nextPhase === 'first' ? 1 : 2); const receipt = report.tasks.at(-1);
  await saved(value => value.state.harnessTasks.some(task => task.id === receipt.task.id && task.state === 'awaitingConfirmation'));
  return receipt;
}
async function realRun() {
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click(); const response = await pending, value = await response.json();
  assert.equal(response.status(), 200); assert.equal(value.run.status, 'success'); assert.equal(value.run.revision, adoptedDocument.revision);
  for (const kind of ['sql', 'table', 'chart']) assert.deepEqual(value.run.cells.find(cell => cell.cellId === `m7_agent_first_${kind}`).table.rows, expected);
  report.runs.push(value.run); await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  await chart().getByRole('img', { name: /图表下方提供对应数据表/u }).waitFor();
}
try {
  oldSnapshot = await snapshotOld(); report.oldProjectBefore = oldSnapshot;
  const location = JSON.parse(await readFile(resolve('.runtime/runtime-location.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(location.root, 'config.json'), 'utf8'));
  indexPath = join(config.devState, 'local-projects.json'); initialIndex = JSON.parse(await readFile(indexPath, 'utf8'));
  report.initialEngine = await engineStatus(); assert.equal(report.initialEngine.activeTasks, 0);
  if (run) {
    owner = JSON.parse(await readFile(ownershipPath, 'utf8'));
    assert.equal(owner.kind, 'm7-agent-continuity-v1'); assert.equal(owner.projectPath, projectPath); assert.equal(owner.csvSha256, checksum(csv));
    assert.equal(owner.started, false, 'Do not retry tasks, clear failures or rebase a started acceptance');
    ({ handle, projectId, pageId, datasetId, sessionId } = owner); firstDocument = owner.preparedDocument;
    const bytes = await readFile(join(projectPath, 'agentcanvas.project.json')); assert.equal(checksum(bytes), owner.preparedManifestSha256);
    const value = JSON.parse(bytes); assert.equal(value.state.harnessTasks.length, 0); assert.deepEqual(book(value), firstDocument);
    await verifyResources(value);
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base, 'External origins blocked');
      if (method === 'GET' && url.pathname === '/api/projects' && !request.headers()[header]) return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (url.pathname.startsWith('/api/connections/')) throw new Error('External connections blocked');
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.requests.push({ scenario, method, path: url.pathname });
      if (url.pathname === '/api/projects' && method === 'POST') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(run, false); assert.equal(body.path, projectPath); }
        else if (body.action === 'open') assert.equal(body.path, projectPath);
        else { assert.equal(request.headers()[header], handle); validateState(body.state); }
      } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname) && method === 'POST') {
        assert.equal(run, false); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName); assert.equal(request.postData(), csv);
      } else if (url.pathname === '/api/ai/harness/stream' && method === 'POST') {
        assert.equal(run, true); assert.ok(runner); assert.equal(request.headers()[header], handle); assert.ok(++calls <= 2);
        const payload = request.postDataJSON(); assert.equal(payload.instruction, phase === 'first' ? firstInstruction : followupInstruction);
        assert.equal(payload.conversation_id, sessionId); assert.equal(payload.recipes.length, 1);
        if (!owner.started) { owner.started = true; await writeFile(ownershipPath, JSON.stringify(owner, null, 2)); }
        const result = await runner.run({ payload, projectHandle: handle, phase });
        report.tasks.push(result); await writeFile(join(directory, `${phase}-receipt.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
        return await route.fulfill({ status: 200, headers: result.headers, body: result.body });
      } else if (url.pathname === '/api/notebook/run' && method === 'POST') {
        assert.equal(run, true); assert.equal(request.headers()[header], handle);
        const body = request.postDataJSON(); assert.equal(body.action, 'run'); assert.deepEqual(body.document, adoptedDocument);
      } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation blocked'); }
      return await route.continue();
    } catch (error) { report.routeErrors.push({ scenario, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  if (!run) {
    await step('Create one fresh isolated project through actual UI', async () => {
      await openBrowser(); await dialog().getByLabel('项目名称', { exact: true }).fill('M7 连续追问合成验收');
      await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
      const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'create');
      await dialog().getByRole('button', { name: '新建本地项目', exact: true }).click(); const response = await pending, value = await response.json();
      assert.equal(response.status(), 200); handle = value.handle; projectId = value.manifest.id;
      await dialog().waitFor({ state: 'hidden' }); const initialized = await saved(value => Boolean(value.state?.appSpec.pages.length));
      assert.equal(initialized.state.appSpec.pages.length, 1); pageId = initialized.state.appSpec.pages[0].id; await mode('Notebook');
    });
    await step('Import three-row synthetic CSV and original through real upload UI', async () => {
      await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
      const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
      await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await shot('01-upload-ready-1440.png', ['New CSV selected in real upload UI'], upload);
      const parsed = page.waitForResponse(response => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
      const original = page.waitForResponse(response => response.url() === `${base}/api/projects/files` && response.request().method() === 'POST');
      await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); const response = await parsed;
      assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId; assert.equal((await original).status(), 201);
      await upload.waitFor({ state: 'hidden' }); await verifyResources(await saved(value => value.tables.length === 1 && value.files.length === 1));
    });
    await step('Create one Data definition without invoking any AI task', async () => {
      await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: '＋ Data', exact: true }).click();
      await editor().getByLabel('单元名称', { exact: true }).fill('M7 合成销售源');
      await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data');
      await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await editor().getByRole('button', { name: '保存单元', exact: true }).click();
      const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true }); if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
      await editor().waitFor({ state: 'hidden' }); const prepared = await saved(value => book(value)?.cells.length === 1);
      assert.equal(prepared.state.harnessTasks.length, 0); assert.equal(prepared.state.assistantSessions.items.length, 1);
      sessionId = prepared.state.assistantSessions.activeId; assert.equal(prepared.state.assistantSessions.items[0].turns.length, 0);
      firstDocument = book(prepared); await verifyResources(prepared);
      owner = { kind: 'm7-agent-continuity-v1', projectPath, projectId, handle, pageId, datasetId, sessionId,
        csvSha256: checksum(csv), preparedDocument: firstDocument, preparedState: prepared.state,
        preparedManifestSha256: checksum(await readFile(join(projectPath, 'agentcanvas.project.json'))), started: false };
      await writeFile(ownershipPath, JSON.stringify(owner, null, 2), { flag: 'wx' });
      await shot('02-prepared-data-1440.png', ['Actual Dataset/original 201, exact bytes, one manually saved Data, zero AI calls'], page.getByRole('article', { name: 'Data单元 M7 合成销售源', exact: true }));
      report.prepared = true;
    });
  } else {
    await openOwned();
    runner = await createAgentContinuityRunner({ directory: join(directory, 'harness'), scope: { projectHandle: handle, pageId, datasetId },
      loadSyntheticDataset: async scope => {
        assert.deepEqual(scope, { projectHandle: handle, pageId, datasetId });
        const current = JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8')); await verifyResources(current);
        return { descriptor: current.tables[0].descriptor, rows: JSON.parse(await readFile(join(projectPath, 'tables', current.tables[0].file), 'utf8')).rows };
      } });
    await step('First actual browser payload produces verified unadopted draft', async () => {
      await sendAgent('first', firstInstruction); assert.deepEqual(book(await saved()), firstDocument);
      await shot('03-first-trace-1440.png', ['Actual browser request; fixed model decisions; real search/edit/run/submit and formal buffered SSE'], page.locator('.conversation-turn').last());
      await mode('Notebook'); await draft().waitFor(); await draft().getByText(/查看变更和步骤/u).click();
      assert.equal(await draft().getByRole('article').count(), 3);
      await shot('04-first-draft-1440.png', ['Three proposed additions; formal Notebook still one Data'], draft());
    });
    await step('Explicit first adoption and human HTTP run return 150/80', async () => {
      const artifact = report.tasks[0].task.notebookArtifact;
      await draft().getByRole('button', { name: '采用草稿', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
      adoptedDocument = book(await saved(value => book(value)?.lastDraftId === artifact.id));
      assert.equal(adoptedDocument.revision, firstDocument.revision + 1); assert.deepEqual(adoptedDocument.cells, artifact.cells);
      assert.equal(report.runs.length, 0); assert.equal(await chart().locator('.notebook-plot').count(), 0);
      await shot('05-adopted-before-run-1440.png', ['Explicit adoption saves four cells without running'], chart());
      await realRun(); await shot('06-real-results-1440.png', ['Real 3001 run; SQL/table/chart each East150 South80; no snapshots'], chart());
    });
    await step('Reload and fresh tab explicit reopen retain same conversation without autorun', async () => {
      const requestCount = report.requests.filter(item => item.path === '/api/notebook/run').length;
      await page.reload({ waitUntil: 'networkidle' }); await mode('Notebook');
      assert.deepEqual(book(await saved()), adoptedDocument); assert.equal(await chart().locator('.notebook-plot').count(), 0);
      await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('AI 工作台');
      const reopened = await saved(); assert.deepEqual(book(reopened), adoptedDocument); assert.equal(reopened.state.assistantSessions.activeId, sessionId);
      assert.equal(reopened.state.assistantSessions.items[0].turns.length, 1);
      assert.equal(reopened.state.harnessTasks[0].state, 'completed'); assert.equal(calls, 1);
      assert.equal(report.requests.filter(item => item.path === '/api/notebook/run').length, requestCount);
      await shot('07-reopened-conversation-1024.png', ['Fresh tab explicit project open; same conversation and adopted definition; no autorun'], page.locator('.conversation-turn').last());
      await mode('Notebook'); assert.equal(await chart().locator('.notebook-plot').count(), 0); await realRun();
    });
    await step('Same-conversation follow-up computes new 300/160 evidence and remains unadopted', async () => {
      const second = await sendAgent('followup', followupInstruction);
      assert.equal(second.request.conversation_id, report.tasks[0].request.conversation_id);
      assert.notEqual(second.trials[0].runId, report.tasks[0].trials[0].runId); assert.deepEqual(book(await saved()), adoptedDocument);
      await mode('Notebook'); await draft().waitFor(); await draft().getByText(/查看变更和步骤/u).click();
      assert.equal(await draft().getByRole('article').count(), 3); assert.equal(second.task.notebookArtifact.cells.length, 7);
      await shot('08-followup-draft-1024.png', ['New actual trial 300/160; same conversation; formal four-cell revision unchanged'], draft());
      await draft().getByRole('button', { name: '暂不采用', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
      const after = await saved(); assert.deepEqual(book(after), adoptedDocument); assert.deepEqual(dashboard(after).root.children, []);
      assert.equal(after.state.harnessTasks.find(task => task.id === second.task.id).state, 'awaitingConfirmation');
      assert.equal(after.state.assistantSessions.items[0].turns.length, 2);
      await chart().getByRole('img', { name: /图表下方提供对应数据表/u }).waitFor();
      await shot('09-dismiss-retains-results-1024.png', ['Temporarily dismissed draft; original four definitions and 150/80 result remain'], chart());
    });
    assert.equal(calls, 2); assert.equal(report.runs.length, 2);
    assert.deepEqual(runner.getStats(), { executions: 2, trials: 2, modelActions: 8, networkAttempts: 0 });
  }
  const final = await saved(); await verifyResources(final); report.final = { revision: final.stateRevision, tables: final.tables.length, files: final.files.length,
    pages: final.state.appSpec.pages.length, tasks: final.state.harnessTasks.map(({ id, state }) => ({ id, state })), cells: book(final).cells.length };
  assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.forbidden, []);
  report.passed = true;
} catch (error) {
  report.failure = { scenario, message: String(error).replaceAll(process.cwd(), '<workspace>') }; console.error(report.failure); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, `${run ? 'run' : 'prepare'}-failure.png`) }).catch(() => {});
} finally {
  await browser?.close().catch(() => {}); report.runnerStats = runner?.getStats(); await runner?.close().catch(() => {});
  report.calls = calls;
  try {
    report.oldProjectAfter = await snapshotOld(); assert.deepEqual(report.oldProjectAfter, oldSnapshot); report.oldResourcesPreserved = true;
    report.finalEngine = await engineStatus(); assert.deepEqual(report.finalEngine, report.initialEngine);
    const currentIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    const withoutOwn = index => index.entries.filter(entry => resolve(entry.path) !== projectPath).sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(withoutOwn(currentIndex), withoutOwn(initialIndex));
    assert.equal(currentIndex.entries.filter(entry => resolve(entry.path) === projectPath).length, 1);
    report.projectRegistrations = { before: initialIndex.entries.length, after: currentIndex.entries.length, onlyOwnChanged: true };
  } catch (error) { report.passed = false; report.preservationFailure = String(error); process.exitCode = 1; }
  await writeFile(join(directory, run ? 'report.json' : 'prepare-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, prepared: report.prepared, checks: report.checks.length, calls, directory: rel(directory), failure: report.failure, preservationFailure: report.preservationFailure }));
}
