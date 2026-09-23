// M7: actual XLSX UI import and two separately authorized paid DSH tasks.
// Default preparation blocks all AI. Each paid phase owns an exclusive persisted once marker.
// Run serially with other project UI acceptance: opening another project can change its
// registry/lastOpenedAt entry. The strict whole-registry preservation check is intentional.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import writeXlsxFile from 'write-excel-file/node';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/m7-excel-live-2026-09-22'), args = process.argv.slice(2);
const phase = args.length === 0 ? 'prepare' : args[0] === '--allow-paid-first' ? 'first' : args[0] === '--allow-paid-second' ? 'second' : undefined;
assert.ok(phase && (phase === 'prepare' || args.length === 2), 'Usage: node scripts/verify-m7-excel-live-browser.mjs [--allow-paid-first <owned-directory> | --allow-paid-second <owned-directory>]');
const paid = phase !== 'prepare', directory = paid ? resolve(args[1]) : join(root, `browser-${Date.now()}`);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true });
assert.equal(await realpath(directory), directory); assert.equal((await lstat(directory)).isSymbolicLink(), false);
const projectPath = join(directory, 'project'), ownershipPath = join(directory, 'ownership.json');
const fileName = 'm7-synthetic-sales.xlsx', csvName = 'm7-synthetic-sales-Sales.csv';
const csv = '\ufeffregion,amount\r\nEast,100\r\nEast,50\r\nSouth,80';
const originalRows = [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }];
const expected = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
const doubled = [{ region: 'East', revenue: 300 }, { region: 'South', revenue: 160 }];
const titles = { data: 'Excel 销售数据', sql: '地区收入汇总', table: '地区收入结果', chart: '地区收入柱状图' };
const firstInstruction = '保留当前 Notebook 的四个已有单元原样不变。基于已导入的 sales_data 数据，新增一个 SQL 单元按 region 汇总 amount 后乘以 2，输出表名 twofold_sales，字段命名为 region 和 revenue，revenue 必须为数值。再新增一个引用该 SQL 的结果表和一个柱状图，共三个新增单元。不要读取原件或创建 Python。请真实试运行后提交可采用草稿，不修改正式看板。';
const secondInstruction = '帮我看一下，能不能给我一个分析的结论';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const delay = ms => new Promise(done => setTimeout(done, ms));
const report = { passed: false, phase, base, project: rel(projectPath), checks: [], screenshots: [], requests: [], runs: [],
  pageErrors: [], routeErrors: [], forbidden: [], visualReview: 'pending actual image inspection',
  boundaries: ['Actual public HTTP/SSE/model and actual persisted Dataset/SQL; no model or data fixture.',
    'XLSX selected sheet becomes a persisted Dataset; original XLSX bytes are separately verified. Original-file Python execution is not tested.',
    'Only the new owned project may be written. A paid phase permits one public AI request, no automatic retry, no model/engine setting changes.',
    'Fresh tab/context reopening is not service-restart memory. Public readonly trace proves a new run call but does not expose its private runId.'] };
let browser, context, page, owner, firstComplete, handle, projectId, pageId, datasetId, sessionId, workbook;
let scenario = 'preflight', calls = 0, currentTask, expectedRunDocument, indexPath, initialIndex;
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
const book = value => value.state.dataProduct.notebooks?.[pageId];
async function settings() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
function validateFormalState(state) {
  assert.equal(state.appSpec.pages.length, 1); assert.ok(state.harnessTasks.length <= 2);
  assert.deepEqual(state.appSpec.pages[0].root.children, []);
  if (!owner) return;
  assert.deepEqual(state.appSpec, owner.preparedAppSpec);
  assert.equal(state.assistantSessions.items.length, 1); assert.equal(state.assistantSessions.activeId, sessionId);
  const document = state.dataProduct.notebooks[pageId];
  assert.ok([4, 7].includes(document.cells.length));
  for (const original of owner.preparedDocument.cells) assert.deepEqual(document.cells.find(cell => cell.id === original.id), original);
  for (const cell of document.cells) assert.ok(['data', 'sql', 'table', 'chart'].includes(cell.kind));
  if (phase === 'second') assert.deepEqual(document, firstComplete.adoptedDocument);
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
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable > 650) { validateFormalState(value.state); return value; }
    } else { revision = undefined; stable = undefined; }
    await delay(100);
  }
  throw new Error(`Owned project not stably saved: ${scenario}`);
}
async function verifyResources(value) {
  assert.equal(value.tables.length, 1); assert.equal(value.files.length, 1);
  assert.equal(value.tables[0].descriptor.datasetId, datasetId);
  assert.equal(value.files[0].name, fileName); assert.deepEqual(value.files[0].datasetIds, [datasetId]);
  for (const [folder, entry] of [['tables', value.tables[0]], ['files', value.files[0]]]) {
    const path = join(projectPath, folder, entry.file); assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert.equal(bytes.length, entry.bytes); assert.equal(checksum(bytes), entry.sha256);
    if (folder === 'files') assert.deepEqual(bytes, workbook);
    else assert.deepEqual(JSON.parse(bytes).rows, originalRows);
  }
}
async function shot(name, assertions, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(directory, name), animations: 'disabled' });
  report.screenshots.push({ name, scenario, assertions, viewport: page.viewportSize(), actualImageReviewed: false });
}
function observe(target) {
  target.setDefaultTimeout(20000); target.on('pageerror', error => report.pageErrors.push({ scenario, message: error.message }));
}
async function mode(name) {
  await page.getByRole('tab', { name, exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
}
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
  await dialog().waitFor({ state: 'hidden' }); await saved();
  assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
}
async function finishCell() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
  if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function addCell(kind, sqlId) {
  const label = { data: 'Data', sql: 'SQL', table: '表格', chart: '图表' }[kind];
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(titles[kind]);
  if (kind === 'data' || kind === 'sql') await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(kind === 'data' ? 'sales_data' : 'sales_by_region');
  if (kind === 'data') await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId);
  if (kind === 'sql') {
    await editor().locator('.notebook-input-list').getByRole('checkbox').check();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region');
  }
  if (kind === 'table' || kind === 'chart') await editor().getByLabel('上游输出', { exact: true }).selectOption(sqlId);
  if (kind === 'table') await editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）', { exact: true }).fill('region, revenue');
  if (kind === 'chart') {
    await editor().getByLabel('图表类型', { exact: true }).selectOption('bar');
    await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('revenue');
  }
  await finishCell(); const value = await saved(item => book(item)?.cells.some(cell => cell.title === titles[kind]));
  return book(value).cells.find(cell => cell.title === titles[kind]).id;
}
async function runCurrent(document, additions = []) {
  expectedRunDocument = document;
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 90000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click();
  const response = await pending, value = await response.json(); assert.equal(response.status(), 200); assert.equal(value.run.status, 'success');
  assert.equal(value.run.revision, document.revision);
  for (const cell of document.cells.filter(cell => cell.kind !== 'data')) {
    const rows = value.run.cells.find(output => output.cellId === cell.id)?.table?.rows; assert.ok(rows);
    assert.deepEqual([...rows].sort((a, b) => a.region.localeCompare(b.region)), additions.includes(cell.id) ? doubled : expected);
  }
  report.runs.push(value.run); expectedRunDocument = undefined;
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return value.run;
}
async function sendPaid() {
  await mode('AI 工作台'); const instruction = phase === 'first' ? firstInstruction : secondInstruction;
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click(); const response = await pending; assert.equal(response.status(), 200);
  await page.waitForFunction(() => ['complete', 'failed'].includes(window.__m7ExcelLive?.state), undefined, { timeout: 300000 });
  const observed = await page.evaluate(() => window.__m7ExcelLive); assert.equal(observed.state, 'complete');
  const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => {
    const line = block.split(/\r?\n/u).find(value => value.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  currentTask = frames.findLast(frame => frame.task)?.task; assert.ok(currentTask);
  await writeFile(join(directory, `${phase}-public-task.json`), JSON.stringify({ frames }, null, 2), { flag: 'wx' });
  report.task = currentTask; await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  await saved(value => value.state.harnessTasks.some(task => task.id === currentTask.id && task.state === currentTask.state));
  await shot(`${phase}-01-real-answer-1440.png`, ['Unmodified real public HTTP/SSE/model; no response fixture'], page.locator('.conversation-turn').last());
  const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
  if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
  await shot(`${phase}-02-real-trace-1440.png`, ['Actual tool trace and finite failures, if any'], trace);
  assert.equal(currentTask.verification?.status, 'passed'); return currentTask;
}
try {
  report.initialEngine = await settings(); assert.equal(report.initialEngine.engine, 'dsh'); assert.equal(report.initialEngine.activeTasks, 0);
  const location = JSON.parse(await readFile(resolve('.runtime/runtime-location.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(location.root, 'config.json'), 'utf8'));
  indexPath = join(config.devState, 'local-projects.json'); initialIndex = JSON.parse(await readFile(indexPath, 'utf8'));
  if (paid) {
    owner = JSON.parse(await readFile(ownershipPath, 'utf8'));
    assert.equal(owner.kind, 'm7-excel-live-v1'); assert.equal(owner.projectPath, projectPath);
    ({ handle, projectId, pageId, datasetId, sessionId } = owner);
    workbook = await readFile(join(directory, fileName)); assert.equal(checksum(workbook), owner.xlsxSha256);
    await assert.rejects(lstat(join(directory, `${phase}-paid-attempt.json`)), error => error.code === 'ENOENT');
    const current = JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8'));
    if (phase === 'second') {
      assert.equal(JSON.parse(await readFile(join(directory, 'first-report.json'), 'utf8')).passed, true);
      firstComplete = JSON.parse(await readFile(join(directory, 'first-complete.json'), 'utf8'));
      assert.equal(firstComplete.sessionId, sessionId); assert.deepEqual(book(current), firstComplete.adoptedDocument);
      assert.equal(current.state.harnessTasks.length, 1); assert.equal(current.state.harnessTasks[0].state, 'completed');
    } else { assert.equal(current.state.harnessTasks.length, 0); assert.deepEqual(book(current), owner.preparedDocument); }
    validateFormalState(current.state); await verifyResources(current);
  } else {
    workbook = await writeXlsxFile([{ sheet: 'Sales', data: [
      [{ value: 'region', type: String }, { value: 'amount', type: String }],
      ...originalRows.map(row => [{ value: row.region, type: String }, { value: row.amount, type: Number }]),
    ] }]).toBuffer();
    await writeFile(join(directory, fileName), workbook, { flag: 'wx' });
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...input) => {
      const response = await original(...input);
      if (new URL(response.url).pathname === '/api/ai/harness/stream') {
        window.__m7ExcelLive = { state: 'streaming' };
        void response.clone().text().then(body => { window.__m7ExcelLive = { state: 'complete', body }; }, () => { window.__m7ExcelLive = { state: 'failed' }; });
      }
      return response;
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base); assert.equal(url.pathname.startsWith('/api/connections/'), false);
      if (method === 'GET' && url.pathname === '/api/projects' && !request.headers()[header]) return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.requests.push({ scenario, method, path: url.pathname });
      if (url.pathname === '/api/projects' && method === 'POST') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(paid, false); assert.equal(body.path, projectPath); }
        else if (body.action === 'open') assert.equal(body.path, projectPath);
        else { assert.equal(request.headers()[header], handle); validateFormalState(body.state); }
      } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname) && method === 'POST') {
        assert.equal(paid, false); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), url.pathname === '/api/datasets' ? csvName : fileName);
        assert.deepEqual(request.postDataBuffer(), url.pathname === '/api/datasets' ? Buffer.from(csv) : workbook);
      } else if (url.pathname === '/api/notebook/run' && method === 'POST') {
        assert.ok(expectedRunDocument); assert.equal(request.headers()[header], handle);
        assert.equal(request.postDataJSON().action, 'run'); assert.deepEqual(request.postDataJSON().document, expectedRunDocument);
      } else if (url.pathname === '/api/ai/harness/stream' && method === 'POST') {
        assert.equal(paid, true); assert.equal(++calls, 1); assert.equal(request.headers()[header], handle);
        const payload = request.postDataJSON(); assert.equal(payload.instruction, phase === 'first' ? firstInstruction : secondInstruction);
        assert.equal(payload.conversation_id, sessionId); assert.deepEqual(payload.notebookContext.document, phase === 'first' ? owner.preparedDocument : firstComplete.adoptedDocument);
        assert.deepEqual(payload.notebookContext.sourceIds, [datasetId]);
        assert.equal(payload.notebookContext.document.cells.some(cell => cell.kind === 'python'), false);
        report.publicRequest = { conversation_id: payload.conversation_id, idempotencyKey: payload.idempotencyKey, cellCount: payload.notebookContext.document.cells.length, sourceIds: payload.notebookContext.sourceIds };
        await writeFile(join(directory, `${phase}-paid-attempt.json`), JSON.stringify({ phase, startedAt: new Date().toISOString(),
          projectId, sessionId, idempotencyKey: payload.idempotencyKey, onceOnly: true }, null, 2), { flag: 'wx' });
      } else { report.forbidden.push({ method, path: url.pathname }); throw new Error('Unapproved mutation blocked'); }
      return await route.continue();
    } catch (error) { report.routeErrors.push({ scenario, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  if (!paid) {
    scenario = 'Create isolated Excel project'; await openBrowser(); await dialog().getByLabel('项目名称', { exact: true }).fill('M7 Excel 真实两轮分析验收');
    await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
    const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'create');
    await dialog().getByRole('button', { name: '新建本地项目', exact: true }).click(); const created = await pending; assert.equal(created.status(), 200);
    const value = await created.json(); handle = value.handle; projectId = value.manifest.id;
    await dialog().waitFor({ state: 'hidden' }); pageId = (await saved(value => Boolean(value.state?.appSpec.pages.length))).state.appSpec.pages[0].id;
    await mode('Notebook'); scenario = 'Actual single-sheet XLSX UI upload and original persistence';
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook });
    await upload.locator('.spreadsheet-upload-file label').filter({ hasText: '工作表' }).locator('select').selectOption('Sales');
    await shot('prepare-01-excel-upload-1440.png', ['Real selected Sales sheet from synthetic XLSX; no AI'], upload);
    const parsed = page.waitForResponse(response => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    const original = page.waitForResponse(response => response.url() === `${base}/api/projects/files` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); const dataset = await parsed; assert.equal(dataset.status(), 201);
    datasetId = (await dataset.json()).dataset.datasetId; assert.equal((await original).status(), 201);
    await upload.waitFor({ state: 'hidden' }); await verifyResources(await saved(value => value.tables.length === 1 && value.files.length === 1));
    scenario = 'Manual Data SQL Table Chart and real 150/80';
    await addCell('data'); const sqlId = await addCell('sql'); await runCurrent(book(await saved()));
    await addCell('table', sqlId); await addCell('chart', sqlId); await runCurrent(book(await saved()));
    const prepared = await saved(); assert.equal(book(prepared).cells.length, 4); assert.equal(prepared.state.harnessTasks.length, 0);
    sessionId = prepared.state.assistantSessions.activeId; assert.equal(prepared.state.assistantSessions.items.length, 1);
    owner = { kind: 'm7-excel-live-v1', projectPath, projectId, handle, pageId, datasetId, sessionId, xlsxSha256: checksum(workbook),
      preparedDocument: book(prepared), preparedAppSpec: prepared.state.appSpec };
    await writeFile(ownershipPath, JSON.stringify(owner, null, 2), { flag: 'wx' });
    const chart = page.getByRole('article', { name: `图表单元 ${titles.chart}`, exact: true });
    await chart.getByRole('img', { name: /图表下方提供对应数据表/u }).waitFor();
    await shot('prepare-02-real-chart-1440.png', ['Actual XLSX-derived Dataset and SQL/Table/Chart each East150 South80, original bytes persisted, 0 AI'], chart);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('prepare-03-real-chart-1024.png', ['Actual chart and result remain readable at 1024'], chart);
    report.checks.push('Actual XLSX UI import saved one original file and one typed Dataset; exact bytes/rows verified.', 'Four manual Data/SQL/Table/Chart definitions saved and run; 150/80, zero AI requests.');
  } else {
    scenario = 'Open owned saved project and same conversation'; await openOwned(); const before = await saved();
    assert.equal(before.state.assistantSessions.activeId, sessionId); assert.equal(before.state.assistantSessions.items[0].turns.length, phase === 'first' ? 0 : 1);
    scenario = `One real paid ${phase} task`; const task = await sendPaid();
    assert.deepEqual(book(await saved()), book(before)); assert.deepEqual((await saved()).state.appSpec, owner.preparedAppSpec);
    if (phase === 'first') {
      assert.equal(task.state, 'awaitingConfirmation'); const artifact = task.notebookArtifact; assert.ok(artifact);
      assert.equal(artifact.cells.length, 7); assert.equal(artifact.executionEvidence.status, 'success');
      for (const original of owner.preparedDocument.cells) assert.deepEqual(artifact.cells.find(cell => cell.id === original.id), original);
      const additions = artifact.cells.filter(cell => !owner.preparedDocument.cells.some(original => original.id === cell.id));
      assert.deepEqual(additions.map(cell => cell.kind).sort(), ['chart', 'sql', 'table']);
      for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft']) assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === name));
      scenario = 'Review and explicitly adopt first real draft'; await mode('Notebook'); await draft().waitFor();
      await draft().getByText(/查看变更和步骤/u).click(); await shot('first-03-unadopted-draft-1440.png', ['Three new trial-verified cells; four formal original cells unchanged'], draft());
      await draft().getByRole('button', { name: '采用草稿', exact: true }).click(); await draft().waitFor({ state: 'hidden' });
      const adopted = await saved(value => book(value)?.lastDraftId === artifact.id), document = book(adopted);
      assert.equal(document.revision, owner.preparedDocument.revision + 1); assert.deepEqual(document.cells, artifact.cells);
      scenario = 'Explicit manual run after adoption'; const run = await runCurrent(document, additions.map(cell => cell.id));
      assert.notEqual(run.runId, artifact.executionEvidence.runId);
      const newChart = additions.find(cell => cell.kind === 'chart');
      await shot('first-04-real-doubled-chart-1440.png', ['Actual post-adoption run; original outputs150/80 and added outputs300/160'], page.getByRole('article', { name: `图表单元 ${newChart.title}`, exact: true }));
      scenario = 'Fresh tab explicit reopen without autorun'; const runCount = report.runs.length;
      await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto(base, { waitUntil: 'networkidle' }); await openOwned(); await mode('AI 工作台');
      const reopened = await saved(); assert.deepEqual(book(reopened), document); assert.equal(reopened.state.assistantSessions.activeId, sessionId);
      assert.equal(reopened.state.assistantSessions.items[0].turns.length, 1); assert.equal(reopened.state.harnessTasks[0].state, 'completed');
      assert.equal(report.runs.length, runCount); assert.equal(calls, 1);
      await shot('first-05-reopened-conversation-1024.png', ['New tab opened the saved project; same adopted document and conversation, no extra AI/run'], page.locator('.conversation-turn').last());
      firstComplete = { projectId, sessionId, taskId: task.id, adoptedDocument: document, addedCellIds: additions.map(cell => cell.id),
        trialRunId: artifact.executionEvidence.runId, humanRunId: run.runId, exactRowsVerified: true };
      await writeFile(join(directory, 'first-complete.json'), JSON.stringify(firstComplete, null, 2), { flag: 'wx' });
      report.checks.push('Real first task proposed three additions, preserved original four, and produced verified draft.', 'Explicit adoption followed by actual human run verified 300/160 and preserved150/80.', 'Fresh tab reopened same session/7-cell definition without autorun.');
    } else {
      assert.equal(task.state, 'completed'); assert.equal(task.notebookArtifact, undefined); assert.notEqual(task.id, firstComplete.taskId);
      assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === 'runNotebookCells'));
      assert.equal(task.trace.some(event => ['editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), false);
      for (const number of [300, 160]) assert.match(task.resultMessage, new RegExp(`(?<!\\d)${number}(?!\\d)`, 'u'));
      assert.deepEqual(book(await saved()), firstComplete.adoptedDocument); assert.equal(await page.getByRole('button', { name: '采用草稿', exact: true }).count(), 0);
      await page.setViewportSize({ width: 1024, height: 900 });
      const trace = page.locator('.conversation-turn').last().locator('.harness-trace'); if (await trace.getAttribute('open') !== null) await trace.locator('summary').first().click();
      await shot('second-03-readonly-answer-1024.png', ['Second real task recomputed current results and explained300/160; no edit/submit/draft; original definitions retained'], page.locator('.conversation-turn').last());
      const completed = await saved(); assert.equal(completed.state.assistantSessions.items[0].turns.length, 2);
      report.checks.push('Same conversation second task made a new real run and returned passed readonly answer with current doubled results300/160; original150/80 was independently checked by the earlier manual run.', 'Seven-cell formal Notebook/AppSpec unchanged; no editor/submit attempt, no third paid request.');
    }
  }
  const final = await saved(); await verifyResources(final);
  report.finalState = { tables: final.tables.length, originalFiles: final.files.length, cells: book(final).cells.length,
    revision: book(final).revision, sessionId, tasks: final.state.harnessTasks.map(({ id, state }) => ({ id, state })) };
  assert.equal(calls, paid ? 1 : 0); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbidden, []);
  report.passed = true;
} catch (error) {
  report.failure = { scenario, message: String(error).replaceAll(process.cwd(), '<workspace>') }; process.exitCode = 1;
  if (page && !page.isClosed()) await shot(`${phase}-failure.png`, ['Actual stopped state; no automatic paid retry']).catch(() => {});
} finally {
  await browser?.close(); report.publicAiRequests = calls;
  report.modelCallCount = currentTask?.counters?.modelCallCount ?? (calls === 0 ? 0 : null);
  report.toolCallCount = currentTask?.counters?.toolCallCount ?? (calls === 0 ? 0 : null);
  try {
    report.finalEngine = await settings(); assert.deepEqual(report.finalEngine, report.initialEngine);
    const finalIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    const withoutOwn = index => index.entries.filter(entry => resolve(entry.path) !== projectPath).sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(withoutOwn(finalIndex), withoutOwn(initialIndex));
    report.registryPreservation = { before: initialIndex.entries.length, after: finalIndex.entries.length, onlyOwnChanged: true };
  } catch (error) { report.passed = false; report.preservationFailure = String(error); process.exitCode = 1; }
  await writeFile(join(directory, `${phase}-report.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, phase, publicAiRequests: calls, modelCallCount: report.modelCallCount, toolCallCount: report.toolCallCount,
    directory: rel(directory), failure: report.failure, preservationFailure: report.preservationFailure }));
}
