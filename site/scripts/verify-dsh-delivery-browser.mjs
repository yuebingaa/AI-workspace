// Managed 3001, isolated synthetic project, real public HTTP and real paid DSH model.
// Preparation never sends an AI request. Paid execution requires a separate explicit flag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/dsh-delivery-browser-2026-09-22');
const args = process.argv.slice(2), paid = args[0] === '--allow-paid-model', reopenOnly = args[0] === '--verify-reopen';
assert.ok(args.length === 0 || ((paid || reopenOnly) && args.length === 2), 'Usage: node scripts/verify-dsh-delivery-browser.mjs [--allow-paid-model <prepared-directory> | --verify-reopen <completed-directory>]');
const directory = paid || reopenOnly ? resolve(args[1]) : join(root, `browser-${Date.now()}`);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true });
assert.equal((await lstat(directory)).isSymbolicLink(), false);
assert.equal(await realpath(directory), directory);
const projectPath = join(directory, 'project'), ownershipPath = join(directory, 'ownership.json');
const fileName = 'delivery-synthetic-sales.csv', csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
const expected = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
const instruction = '请分析当前 Notebook 的 sales_data 销售数据，按 region 汇总 amount，生成一个 SQL 单元、一个结果表单元和一个柱状图单元。汇总输出字段命名为 region 和 revenue，图表的 revenue 必须是数值字段。保留已有 Data 单元，试运行确认结果正确后提交可采用的 Notebook 草稿，不要修改正式看板。';
const finalTitle = '地区销售额 · 已确认交付';
const report = { passed: false, prepared: false, paid, reopenOnly, base, projectPath: relative(process.cwd(), projectPath).split(sep).join('/'),
  isolation: 'Fresh Edge context, new synthetic local project; no model or data response fixture. Unscoped recent-project and connection lists are filtered out only for privacy; external font CSS is empty.',
  checks: [], screenshots: [], requests: [], pageErrors: [], routeErrors: [], forbidden: [], runs: [], visualReview: 'pending actual image review' };
let browser, context, page, handle, pageId, projectId, datasetId, scenario = 'preflight', calls = 0, owner, task;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const draft = () => page.getByLabel('AI Notebook 草稿', { exact: true });
const receipt = () => page.getByLabel('Notebook 快照审阅', { exact: true });
const book = value => value.state.dataProduct.notebooks[pageId];
const dashboard = value => value.state.appSpec.pages.find(item => item.id === pageId);
async function status() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(value.handle, handle); assert.equal(resolve(value.path), projectPath);
  assert.equal(value.manifest.id, projectId); return value.manifest;
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 30000; let revision, stable;
  while (Date.now() < deadline) {
    const value = await manifest();
    // Narrow desktop hides this status visually; textContent retains its actual state.
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable > 650) return value;
    } else { revision = undefined; stable = undefined; }
    await sleep(100);
  }
  throw new Error(`Scoped project was not saved: ${scenario}`);
}
async function shot(name, evidence, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, name), fullPage: false });
  report.screenshots.push({ name, scenario, evidence, actualImageReviewed: false });
}
function observe(target) {
  target.setDefaultTimeout(20000);
  target.on('pageerror', error => report.pageErrors.push({ scenario, name: error.name, message: error.message }));
}
async function openBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog().waitFor();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
}
async function openOwned() {
  await openBrowser(); await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'open');
  await dialog().getByRole('button', { name: '打开已有项目', exact: true }).click(); assert.equal((await pending).status(), 200);
  await dialog().waitFor({ state: 'hidden' }); await saved();
  assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
}
async function mode(name) { await page.getByRole('tab', { name, exact: true }).click(); }
async function run(cell, snapshot = false) {
  const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 90000 });
  await (cell ? cell.getByRole('button', { name: snapshot ? '生成看板预览 ↗' : '▶ 运行', exact: true }) : page.getByRole('button', { name: '▶ 全部运行', exact: true })).click();
  const response = await responsePromise, value = await response.json(); assert.equal(response.status(), 200); assert.equal(value.run.status, 'success');
  const outputs = value.run.cells.filter(item => item.table?.rows?.[0]?.revenue !== undefined);
  assert.ok(outputs.length > 0);
  for (const output of outputs) assert.deepEqual([...output.table.rows].sort((a, b) => a.region.localeCompare(b.region)), expected);
  if (snapshot) assert.deepEqual([...value.snapshot.rows].sort((a, b) => a.region.localeCompare(b.region)), expected);
  report.runs.push({ action: snapshot ? 'snapshot' : 'run', run: value.run, snapshot: value.snapshot });
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return value;
}
try {
  report.initialEngine = await status(); assert.equal(report.initialEngine.engine, 'dsh'); assert.equal(report.initialEngine.activeTasks, 0);
  if (paid || reopenOnly) {
    owner = JSON.parse(await readFile(ownershipPath, 'utf8'));
    assert.equal(owner.kind, 'dsh-delivery-synthetic-v1'); assert.equal(owner.projectPath, projectPath); assert.equal(owner.csvSha256, checksum(csv));
    assert.equal(owner.paidAttemptStarted, reopenOnly, 'Never automatically retry a paid task');
    ({ handle, pageId, projectId, datasetId } = owner);
    const current = JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8'));
    assert.equal(current.id, projectId); assert.equal(current.files.length, 1);
    if (reopenOnly) {
      assert.equal(current.tables.length, 3);
      assert.equal(dashboard(current).root.children.length, 1); assert.equal(dashboard(current).root.children[0].props.title, finalTitle);
      assert.ok(book(current).lastDraftId); assert.equal(current.state.harnessTasks.length, 1);
      assert.equal(current.state.harnessTasks[0].state, 'completed');
      assert.equal(current.state.harnessTasks[0].notebookArtifact.id, book(current).lastDraftId);
      report.completedTask = { id: current.state.harnessTasks[0].id, counters: current.state.harnessTasks[0].counters };
      report.priorRun = 'report.json';
    } else {
      assert.equal(current.tables.length, 1); assert.deepEqual(book(current), owner.preparedDocument); assert.deepEqual(dashboard(current).root.children, []);
    }
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  // Chromium does not reliably expose fetch SSE bodies through Network.getResponseBody.
  // Observe a clone; return the untouched response immediately to the real UI consumer.
  await context.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...input) => {
      const response = await fetchOriginal(...input);
      if (new URL(response.url).pathname === '/api/ai/harness/stream') {
        window.__dshDeliveryObservation = { state: 'streaming' };
        void response.clone().text().then(body => { window.__dshDeliveryObservation = { state: 'complete', body }; },
          () => { window.__dshDeliveryObservation = { state: 'failed' }; });
      }
      return response;
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base, 'External browser origin blocked');
      if (method === 'GET' && url.pathname === '/api/projects' && !request.headers()[header]) return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.requests.push({ scenario, method, path: url.pathname });
      if (url.pathname === '/api/projects' && method === 'POST') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(paid, false); assert.equal(body.path, projectPath); }
        if (body.action === 'open') assert.equal(body.path, projectPath);
        if (body.action === 'save') { assert.ok(handle); assert.equal(request.headers()[header], handle); }
      } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname) && method === 'POST') {
        assert.equal(paid, false); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName); assert.equal(request.postData(), csv);
      } else if (url.pathname === '/api/ai/harness/stream' && method === 'POST') {
        assert.equal(paid, true); assert.equal(++calls, 1, 'Only one real paid request permitted'); assert.equal(request.headers()[header], handle);
        assert.equal(request.postDataJSON().instruction, instruction);
        owner.paidAttemptStarted = true; await writeFile(ownershipPath, JSON.stringify(owner, null, 2));
      } else if (url.pathname === '/api/notebook/run' && method === 'POST') {
        assert.equal(paid, true); assert.equal(request.headers()[header], handle); assert.equal(request.postDataJSON().document.id, owner.preparedDocument.id);
      } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation blocked'); }
      return await route.continue();
    } catch (error) { report.routeErrors.push({ scenario, method, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  if (reopenOnly) {
    scenario = 'Reopen already completed real model delivery; no AI or Notebook execution';
    const before = await manifest(); await openOwned(); await mode('看板');
    await page.setViewportSize({ width: 1024, height: 900 });
    const reopened = await saved(); assert.deepEqual(book(reopened), book(before)); assert.deepEqual(dashboard(reopened), dashboard(before));
    const node = dashboard(reopened).root.children[0];
    const entry = reopened.tables.find(item => item.descriptor.datasetId === node.props.binding.dataSourceId); assert.ok(entry);
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    const bytes = await readFile(join(projectPath, 'tables', entry.file)); assert.equal(checksum(bytes), entry.sha256);
    assert.deepEqual([...JSON.parse(bytes.toString('utf8')).rows].sort((a, b) => a.region.localeCompare(b.region)), expected);
    await page.locator('.canvas-area .chart-card').getByText(finalTitle, { exact: true }).waitFor();
    assert.match(await page.locator('.canvas-area .chart-card').innerText(), /150/u); assert.match(await page.locator('.canvas-area .chart-card').innerText(), /80/u);
    await shot('09-new-tab-reopened-1024.png', 'Fresh isolated context explicitly opened the completed project; persisted title, Notebook and 150/80 result bytes and binding verified. Zero new model or Notebook calls.', page.locator('.canvas-area .chart-card'));
    assert.equal(calls, 0); assert.equal(report.runs.length, 0);
    report.checks.push('Resumed only final reopen from a completed, adopted and saved real task; no paid retry.',
      'Exact Notebook/dashboard definitions retained; snapshot bytes match recorded digest and expected 150/80 rows.');
  } else if (!paid) {
    scenario = 'Create new isolated synthetic project';
    await openBrowser(); await dialog().getByLabel('项目名称', { exact: true }).fill('DSH 真实闭环合成验收');
    await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
    const creation = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'create');
    await dialog().getByRole('button', { name: '新建本地项目', exact: true }).click();
    const response = await creation, value = await response.json(); assert.equal(response.status(), 200, JSON.stringify(value.error));
    handle = value.handle; projectId = value.manifest.id;
    await dialog().waitFor({ state: 'hidden' });
    const initialized = await saved(value => Boolean(value.state?.appSpec.pages.length)); pageId = initialized.state.appSpec.pages[0].id;
    await mode('Notebook');
    scenario = 'Upload real synthetic CSV';
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const parsed = page.waitForResponse(response => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    const original = page.waitForResponse(response => response.url() === `${base}/api/projects/files` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const parsedResponse = await parsed; assert.equal(parsedResponse.status(), 201); datasetId = (await parsedResponse.json()).dataset.datasetId;
    assert.equal((await original).status(), 201); await upload.waitFor({ state: 'hidden' });
    await saved(value => value.tables.length === 1 && value.files.length === 1);
    scenario = 'Create only the source Data cell through its UI';
    await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: '＋ Data', exact: true }).click();
    const editor = page.locator('.notebook-editor');
    await editor.getByLabel('单元名称', { exact: true }).fill('合成销售源');
    await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data');
    await editor.getByLabel('数据源', { exact: true }).selectOption(datasetId); await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true }); if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    const prepared = await saved(value => book(value)?.cells.length === 1); assert.deepEqual(dashboard(prepared).root.children, []);
    owner = { kind: 'dsh-delivery-synthetic-v1', projectPath, projectId, handle, pageId, datasetId, csvSha256: checksum(csv), preparedDocument: book(prepared), paidAttemptStarted: false };
    await writeFile(ownershipPath, JSON.stringify(owner, null, 2), { flag: 'wx' });
    await shot('01-prepared-source-1440.png', 'Actual CSV import and one manually configured Data cell; no AI request yet.', page.getByRole('article', { name: 'Data单元 合成销售源', exact: true }));
    report.prepared = true; assert.equal(calls, 0);
  } else {
    await openOwned(); const before = await saved();
    scenario = 'Single real public HTTP DSH model request'; await mode('AI 工作台');
    await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
    const pending = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
    await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
    const response = await pending; assert.equal(response.status(), 200);
    await page.waitForFunction(() => ['complete', 'failed'].includes(window.__dshDeliveryObservation?.state), undefined, { timeout: 300000 });
    const observed = await page.evaluate(() => window.__dshDeliveryObservation);
    assert.equal(observed.state, 'complete', 'Real HTTP stream observation must complete'); const body = observed.body;
    const frames = body.split(/\r?\n\r?\n/u).flatMap(block => { const line = block.split(/\r?\n/u).find(value => value.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : []; });
    task = frames.findLast(frame => frame.task)?.task;
    await writeFile(join(directory, 'real-public-task.json'), JSON.stringify({ status: response.status(), frames }, null, 2));
    assert.ok(task, 'Real public stream must terminate with task'); report.task = { id: task.id, state: task.state, provider: task.provider, modelUsage: task.modelUsage };
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    await saved(value => value.state.harnessTasks.some(item => item.id === task.id && item.state === task.state));
    await shot('02-real-model-result-1440.png', 'Unmodified real public HTTP event stream, actual model task and trace.', page.locator('.conversation-turn').last());
    assert.equal(task.state, 'awaitingConfirmation', task.resultMessage); assert.ok(task.notebookArtifact);
    assert.deepEqual(book(await saved()), book(before)); assert.deepEqual(dashboard(await saved()).root.children, []);
    scenario = 'Review actual trial-verified model draft'; await mode('Notebook'); await draft().waitFor();
    assert.match(await draft().innerText(), /已通过数据试运行/u);
    await draft().getByText(/查看变更和步骤/u).click();
    await shot('03-real-draft-unadopted-1440.png', 'Real model draft with trial evidence; formal Notebook still only contains Data.', draft());
    for (const kind of ['sql', 'table', 'chart']) assert.equal(task.notebookArtifact.cells.filter(cell => cell.kind === kind).length, 1);
    await draft().getByRole('button', { name: '采用草稿', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
    const adopted = await saved(value => book(value)?.lastDraftId === task.notebookArtifact.id); assert.deepEqual(book(adopted).cells, task.notebookArtifact.cells);
    const chartDefinition = book(adopted).cells.find(cell => cell.kind === 'chart');
    const chart = () => page.getByRole('article', { name: `图表单元 ${chartDefinition.title}`, exact: true });
    scenario = 'Explicit actual Notebook HTTP run'; await run();
    await shot('04-real-notebook-results-1440.png', 'Actual local SQL, table and chart outputs checked against East 150 / South 80.', chart());
    scenario = 'Cancel actual chart snapshot review'; const formal = dashboard(await saved());
    await run(chart(), true); await receipt().waitFor();
    await shot('05-unconfirmed-snapshot-1440.png', 'Actual result snapshot is staged; formal dashboard is still empty.', receipt());
    await page.getByRole('button', { name: '取消预览', exact: true }).click(); await receipt().waitFor({ state: 'hidden' });
    assert.deepEqual(dashboard(await saved()), formal);
    await shot('06-cancel-keeps-formal-dashboard-1440.png', 'Cancel did not write the formal dashboard; the real result snapshot remains auditable.', page.locator('.canvas-toolbar'));
    scenario = 'Confirm actual chart snapshot'; await mode('Notebook'); const result = await run(chart(), true); await receipt().waitFor();
    await page.getByRole('button', { name: '确认加入看板', exact: true }).click(); await receipt().waitFor({ state: 'hidden' });
    const confirmed = await saved(value => dashboard(value).root.children.length === 1);
    const node = dashboard(confirmed).root.children[0]; assert.equal(node.type, 'BarChart'); assert.equal(node.props.binding.dataSourceId, result.snapshot.dataset.datasetId);
    await shot('07-confirmed-dashboard-1440.png', 'Confirmed chart reads its independent persisted result dataset.', page.locator('.canvas-area .chart-card'));
    scenario = 'Edit chart title through visual editor and confirm';
    await page.locator('.canvas-mode-switch').getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('.puck-editor-shell iframe').waitFor(); await page.frame({ name: 'preview-frame' }).getByText(node.props.title, { exact: true }).click();
    const title = page.locator('.puck-editor-shell input[id$="_text_title"]:visible'); await title.fill(finalTitle); await title.blur();
    await page.frame({ name: 'preview-frame' }).getByText(finalTitle, { exact: true }).waitFor();
    assert.equal(dashboard(await saved()).root.children[0].props.title, node.props.title);
    await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
    await page.getByRole('button', { name: '应用编辑', exact: true }).click();
    const completed = await saved(value => dashboard(value).root.children[0].props.title === finalTitle);
    assert.equal(dashboard(completed).root.children[0].props.binding.dataSourceId, node.props.binding.dataSourceId);
    await shot('08-title-edit-confirmed-1440.png', 'Title changed only after visual-edit preview and explicit application; binding preserved.', page.locator('.canvas-area .chart-card'));
    scenario = 'New browser tab explicitly reopens saved local project';
    const runCount = report.runs.length; await page.close(); page = await context.newPage(); observe(page);
    await page.setViewportSize({ width: 1024, height: 900 }); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 }); await openOwned(); await mode('看板');
    const reopened = await saved(); assert.deepEqual(book(reopened), book(completed)); assert.deepEqual(dashboard(reopened), dashboard(completed));
    assert.equal(report.runs.length, runCount); assert.equal(calls, 1);
    await page.locator('.canvas-area .chart-card').getByText(finalTitle, { exact: true }).waitFor();
    assert.match(await page.locator('.canvas-area .chart-card').innerText(), /150/u); assert.match(await page.locator('.canvas-area .chart-card').innerText(), /80/u);
    await shot('09-new-tab-reopened-1024.png', 'New tab reopened the same persisted chart, title and binding; no automatic Agent or Notebook execution.', page.locator('.canvas-area .chart-card'));
    report.checks.push('One real public model request; no model substitute or response replay.', 'Actual draft reviewed and adopted, then SQL/table/chart run against synthetic CSV.',
      'Cancel snapshot leaves formal dashboard unchanged; separate confirmation saves real result binding.', 'Visual title edit applied, saved and reopened in a new tab.');
  }
  report.finalEngine = await status(); assert.deepEqual(report.finalEngine, report.initialEngine);
  assert.equal(report.pageErrors.length, 0); assert.equal(report.routeErrors.length, 0); assert.equal(report.forbidden.length, 0);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Delivery verification failed'; report.failedScenario = scenario;
  process.exitCode = 1;
  if (page) await shot('failure.png', 'Actual stopped state; no automatic paid retry.').catch(() => {});
} finally {
  await browser?.close(); report.modelRequests = calls;
  await writeFile(join(directory, reopenOnly ? 'reopen-report.json' : paid ? 'report.json' : 'prepare-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, prepared: report.prepared, directory: relative(process.cwd(), directory).split(sep).join('/'), error: report.error }));
}
