// Independent, synthetic, managed-3001 acceptance. No model requests without the explicit paid flag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const rawArgs = process.argv.slice(2), transform = rawArgs[0] === '--transform';
const args = transform ? rawArgs.slice(1) : rawArgs, paid = args[0] === '--allow-paid-model';
assert.ok(args.length === 0 || (paid && args.length === 2), 'Use no arguments to prepare; --allow-paid-model <owned-directory> permits one paid request.');
const root = resolve(`.runtime/dsh-${transform ? 'transform' : 'readonly'}-browser-2026-09-22`);
const directory = paid ? resolve(args[1]) : join(root, `browser-${Date.now()}`);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true }); assert.equal((await lstat(directory)).isSymbolicLink(), false); assert.equal(await realpath(directory), directory);
const projectPath = join(directory, 'project'), ownerPath = join(directory, 'ownership.json');
const csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n', fileName = transform ? 'input.csv' : 'readonly-synthetic-sales.csv';
const instruction = transform ? '分析input文件' : '现在是分析了什么东西出来';
const sql = transform ? 'SELECT region, revenue::DOUBLE AS revenue FROM recipe_totals ORDER BY region'
  : 'SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region';
const ownerKind = transform ? 'dsh-transform-synthetic-v1' : 'dsh-readonly-synthetic-v1';
const recipeSteps = [{ id: 'aggregate', type: 'groupAggregate', groupBy: ['region'], aggregations: [{ field: 'amount', aggregation: 'sum', as: 'revenue', label: '销售额' }] }];
const expected = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { passed: false, paid, transform, directory: relative(process.cwd(), directory).split(sep).join('/'),
  scope: 'Fresh Edge, new synthetic local project. Real model/API/SSE/data computation; only unscoped recent-project/connection lists are privacy-filtered and remote font CSS is empty.',
  screenshots: [], pageErrors: [], routeErrors: [], requests: [], runs: [], checks: [], visualReview: 'pending actual image review' };
let browser, context, page, owner, handle, projectId, pageId, datasetId, stage = 'preflight', calls = 0;
const book = manifest => manifest.state.dataProduct.notebooks[pageId];
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function settings() {
  const response = await fetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(value.handle, handle); assert.equal(value.manifest.id, projectId); assert.equal(resolve(value.path), projectPath);
  return value.manifest;
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 30000; let revision, stable;
  while (Date.now() < deadline) {
    const value = await manifest();
    if (predicate(value) && /已保存到本地项目|已打开本地项目|已确认上次修改保存到本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable > 650) return value;
    } else { revision = undefined; stable = undefined; }
    await sleep(100);
  }
  throw new Error(`Scoped project did not settle: ${stage}`);
}
async function shot(name, evidence, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(directory, name), fullPage: false });
  report.screenshots.push({ name, evidence, actualImageReviewed: false });
}
async function openDataBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dialog().waitFor();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
}
async function finishCell() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
  const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
  if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function runCurrent() {
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click(); const response = await pending;
  assert.equal(response.status(), 200); const result = await response.json(); assert.equal(result.run.status, 'success');
  for (const output of result.run.cells.filter(cell => cell.table?.rows?.[0]?.revenue !== undefined)) assert.deepEqual(output.table.rows, expected);
  assert.deepEqual(result.run.cells.at(-1).table.rows, expected); report.runs.push(result.run);
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
}
try {
  report.initialEngine = await settings(); assert.equal(report.initialEngine.engine, 'dsh'); assert.equal(report.initialEngine.activeTasks, 0);
  if (paid) {
    owner = JSON.parse(await readFile(ownerPath, 'utf8')); assert.equal(owner.kind, ownerKind); assert.equal(owner.projectPath, projectPath);
    assert.equal(owner.paidStarted, false, 'Never retry a paid request automatically'); assert.equal(owner.csvSha256, hash(csv));
    ({ handle, projectId, pageId, datasetId } = owner);
    const before = JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8'));
    assert.equal(before.id, projectId); assert.equal(before.tables.length, 1); assert.equal(before.files.length, 1);
    assert.deepEqual(before.state.appSpec, owner.appSpec); assert.deepEqual(book(before), owner.document);
    assert.equal(before.state.harnessTasks.length, 0);
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...input) => {
      const response = await original(...input);
      if (new URL(response.url).pathname === '/api/ai/harness/stream') {
        window.__dshReadonlyObservation = { state: 'streaming' };
        void response.clone().text().then(body => { window.__dshReadonlyObservation = { state: 'complete', body }; },
          () => { window.__dshReadonlyObservation = { state: 'failed' }; });
      }
      return response;
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base, 'No external browser traffic');
      if (method === 'GET' && url.pathname === '/api/projects' && !request.headers()[header]) return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.requests.push({ stage, method, path: url.pathname });
      if (method === 'POST' && url.pathname === '/api/projects') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(paid, false); assert.equal(body.path, projectPath); }
        if (body.action === 'open') { assert.equal(paid, true); assert.equal(body.path, projectPath); }
        if (body.action === 'save') { assert.ok(handle); assert.equal(request.headers()[header], handle); }
      } else if (method === 'POST' && ['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
        assert.equal(paid, false); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName); assert.equal(request.postData(), csv);
      } else if (method === 'POST' && url.pathname === '/api/notebook/run') {
        assert.equal(paid, false, 'Paid phase must not manually run Notebook behind the model'); assert.equal(request.headers()[header], handle);
      } else if (method === 'POST' && url.pathname === '/api/ai/harness/stream') {
        assert.equal(paid, true); assert.equal(++calls, 1); assert.equal(request.headers()[header], handle); assert.equal(request.postDataJSON().instruction, instruction);
        owner.paidStarted = true; await writeFile(ownerPath, JSON.stringify(owner, null, 2));
      } else throw new Error('Unapproved write blocked');
      return await route.continue();
    } catch (error) { report.routeErrors.push({ stage, method, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.pageErrors.push({ stage, name: error.name, message: error.message }));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 }); await openDataBrowser();
  await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  if (!paid) {
    stage = 'Create isolated project'; await dialog().getByLabel('项目名称', { exact: true }).fill(transform ? 'DSH DataRecipe 兼容验收' : 'DSH 已有分析只读解释验收');
    const creation = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'create');
    await dialog().getByRole('button', { name: '新建本地项目', exact: true }).click();
    const response = await creation; assert.equal(response.status(), 200); const value = await response.json(); handle = value.handle; projectId = value.manifest.id;
    await dialog().waitFor({ state: 'hidden' }); pageId = (await saved(value => Boolean(value.state?.appSpec.pages.length))).state.appSpec.pages[0].id;
    stage = 'Real UI upload and cell preparation'; await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const parsed = page.waitForResponse(response => response.url() === `${base}/api/datasets` && response.request().method() === 'POST');
    const original = page.waitForResponse(response => response.url() === `${base}/api/projects/files` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const parsedResponse = await parsed; assert.equal(parsedResponse.status(), 201); datasetId = (await parsedResponse.json()).dataset.datasetId;
    assert.equal((await original).status(), 201); await upload.waitFor({ state: 'hidden' }); await saved(value => value.tables.length === 1 && value.files.length === 1);
    const add = label => page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
    await add('Data'); await editor().getByLabel('单元名称', { exact: true }).fill('合成销售源');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data');
    await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await finishCell(); await saved(value => book(value)?.cells.length === 1);
    if (transform) {
      await add('DataRecipe'); await editor().getByLabel('单元名称', { exact: true }).fill('按地区处理规则');
      await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('recipe_totals');
      await editor().getByRole('group', { name: '处理规则编辑方式', exact: true }).getByRole('button', { name: '规则代码', exact: true }).click();
      await editor().getByLabel('DataRecipe 规则代码', { exact: true }).fill(JSON.stringify(recipeSteps, null, 2));
      await finishCell(); await saved(value => book(value)?.cells.length === 2);
    }
    await add('SQL'); await editor().getByLabel('单元名称', { exact: true }).fill('按地区汇总销售额');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_by_region');
    if (transform) {
      const inputs = editor().locator('.notebook-input-list');
      for (const checkbox of await inputs.getByRole('checkbox').all()) await checkbox.uncheck();
      await inputs.locator('label').filter({ hasText: 'recipe_totals' }).getByRole('checkbox').check();
    } else await editor().locator('.notebook-input-list').getByRole('checkbox').check();
    await editor().getByLabel('SQL', { exact: true }).fill(sql);
    await finishCell(); const two = await saved(value => book(value)?.cells.length === (transform ? 3 : 2)), sqlId = book(two).cells.find(cell => cell.kind === 'sql').id;
    // The real UI requires a successful upstream result before creating a result-table cell.
    await runCurrent();
    await add('表格'); await editor().getByLabel('单元名称', { exact: true }).fill('地区销售额结果');
    await editor().getByLabel('上游输出', { exact: true }).selectOption(sqlId);
    await editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）', { exact: true }).fill('region, revenue');
    await finishCell(); await saved(value => book(value)?.cells.length === (transform ? 4 : 3));
    stage = 'Run actual existing analysis'; await runCurrent();
    const prepared = await saved(); assert.deepEqual(prepared.state.appSpec.pages[0].root.children, []);
    owner = { kind: ownerKind, projectPath, handle, projectId, pageId, datasetId, csvSha256: hash(csv),
      document: book(prepared), appSpec: prepared.state.appSpec, paidStarted: false };
    await writeFile(ownerPath, JSON.stringify(owner, null, 2), { flag: 'wx' });
    await shot('01-existing-analysis-result-1440.png', `${transform ? 'Four Data/Transform/SQL/Table' : 'Three Data/SQL/Table'} manually created real cells ran through the public Notebook API. Numeric result East=150, South=80; no AI request.`, page.getByRole('article', { name: '表格单元 地区销售额结果', exact: true }));
    if (transform) await shot('01b-existing-transform-1440.png', 'Real persisted DataRecipe groupAggregate step and upstream source; preparation only, no model request.', page.getByRole('article', { name: 'DataRecipe单元 按地区处理规则', exact: true }));
    report.checks.push(`Preparation only: actual CSV/original persisted; ${transform ? 'Data/Transform/SQL/Table' : 'Data/SQL/Table'} definitions saved and run; zero model requests.`);
  } else {
    stage = 'Open owned prepared analysis'; const opening = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === 'open');
    await dialog().getByRole('button', { name: '打开已有项目', exact: true }).click(); assert.equal((await opening).status(), 200); await dialog().waitFor({ state: 'hidden' }); await saved();
    stage = transform ? 'One real model transform analysis' : 'One real model read-only question'; await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
    const responding = page.waitForResponse(response => response.url() === `${base}/api/ai/harness/stream`, { timeout: 300000 });
    await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click(); assert.equal((await responding).status(), 200);
    await page.waitForFunction(() => ['complete', 'failed'].includes(window.__dshReadonlyObservation?.state), undefined, { timeout: 300000 });
    const observed = await page.evaluate(() => window.__dshReadonlyObservation); assert.equal(observed.state, 'complete');
    const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => { const line = block.split(/\r?\n/u).find(line => line.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : []; });
    await writeFile(join(directory, 'real-public-task.json'), JSON.stringify({ frames }, null, 2));
    const task = frames.findLast(frame => frame.task)?.task; assert.ok(task);
    report.task = task; report.safeToolFailures = task.trace?.filter(event => event.type === 'tool_failed') ?? [];
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
    const after = await saved(value => value.state.harnessTasks.some(item => item.id === task.id && item.state === task.state));
    assert.deepEqual(book(after), owner.document); assert.deepEqual(after.state.appSpec, owner.appSpec); assert.equal(after.tables.length, 1); assert.equal(after.files.length, 1);
    report.formalState = { notebookUnchanged: true, appSpecUnchanged: true, sourceTables: 1, originalFiles: 1, adoptionAttempted: false };
    const turn = page.locator('.conversation-turn').last();
    await shot('02-real-answer-1440.png', 'Unmodified real public HTTP/SSE/model answer. Exact formal Notebook/AppSpec and source table count compared with baseline.', turn);
    const trace = turn.locator('.harness-trace'); if (await trace.count()) {
      if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
      await shot('03-real-trace-1440.png', 'Actual task trace, including any safe tool failure diagnostics. No fixture used in this phase.', trace);
    }
    if (transform && task.state === 'completed') {
      assert.equal(task.notebookArtifact, undefined); assert.equal(await page.getByRole('button', { name: '采用草稿', exact: true }).count(), 0);
      assert.equal(task.trace.some(event => ['editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), false, 'Direct answer must not hide an edit or submit');
      assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === 'runNotebookCells'), 'Require an actual run in this task');
      assert.match(task.resultMessage ?? '', /(?<!\d)150(?!\d)/u); assert.match(task.resultMessage ?? '', /(?<!\d)80(?!\d)/u);
      report.deliveryMode = 'verified-analysis-answer';
      report.checks.push('Ordinary file analysis completed with current-task execution evidence and numeric answer 150/80; no edits, draft or adoption.');
    } else if (transform) {
      assert.equal(task.state, 'awaitingConfirmation', task.resultMessage);
      report.deliveryMode = 'verified-notebook-draft';
      const artifact = task.notebookArtifact; assert.ok(artifact); assert.equal(artifact.executionEvidence?.status, 'success');
      const transforms = artifact.cells.filter(cell => cell.kind === 'transform'); assert.ok(transforms.length);
      const dependsOnTransform = (id, visited = new Set()) => {
        if (visited.has(id)) return false; visited.add(id);
        return transforms.some(cell => cell.id === id) || (artifact.lineage.find(cell => cell.cellId === id)?.dependsOn ?? []).some(upstream => dependsOnTransform(upstream, visited));
      };
      const downstream = artifact.cells.filter(cell => ['table', 'chart'].includes(cell.kind) && dependsOnTransform(cell.id));
      assert.ok(downstream.length, 'Draft must retain a real transform-to-output dependency');
      for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft']) assert.ok(task.trace.some(event => event.type === 'tool_completed' && event.toolCall?.name === name), `Missing successful ${name}`);
      assert.ok(await page.getByRole('button', { name: '采用草稿', exact: true }).count());
      stage = 'Independent numeric verification of unadopted candidate';
      const candidate = { name: artifact.name, revision: owner.document.revision, cells: artifact.cells };
      const response = await context.request.post(`${base}/api/notebook/run`, { headers: { [header]: handle }, data: { pageId, document: candidate, action: 'run' } });
      assert.equal(response.status(), 200); const result = await response.json(); assert.equal(result.run.status, 'success');
      const matchingSummary = output => {
        const rows = output?.table?.rows; if (rows?.length !== 2) return false;
        return expected.every(item => rows.some(row => Object.values(row).includes(item.region) && Object.values(row).includes(item.revenue)));
      };
      assert.ok(downstream.some(cell => matchingSummary(result.run.cells.find(output => output.cellId === cell.id))), 'Transform downstream must contain the actual East=150/South=80 summary, regardless of output field labels');
      assert.ok(transforms.every(cell => result.run.cells.some(output => output.cellId === cell.id && output.status === 'success')));
      report.candidateVerification = { source: 'Separate actual public Notebook run by verifier, not a model call or draft adoption', run: result.run };
      const unchanged = await manifest(); assert.deepEqual(book(unchanged), owner.document); assert.deepEqual(unchanged.state.appSpec, owner.appSpec);
      report.checks.push('Real model edited, ran and submitted a draft retaining the existing transform; no formal adoption.', 'Candidate independently executed through the public API: transform and downstream numeric outputs East=150, South=80.');
    } else {
      assert.equal(task.state, 'completed', task.resultMessage); assert.equal(task.notebookArtifact, undefined);
      assert.equal(await page.getByRole('button', { name: '采用草稿', exact: true }).count(), 0);
    }
    assert.ok(typeof task.resultMessage === 'string' && task.resultMessage.trim().length > 10);
    report.checks.push(transform ? `Original analysis phrase delivered ${report.deliveryMode} without modifying formal definitions.` : 'Original user phrase completed without requiring an edited/submitted draft.',
      'Formal Notebook and AppSpec byte-equivalent JSON to preparation; no new datasets or adoption actions.',
      'Safe failure DTOs retained only if present in the real trace; no invented historical arguments.');
    await page.setViewportSize({ width: 1024, height: 900 });
    if (await trace.count() && await trace.getAttribute('open') !== null) await trace.locator('summary').first().click();
    await shot('04-answer-1024.png', report.deliveryMode === 'verified-notebook-draft' ? 'Real draft awaiting confirmation at narrow desktop width; adoption deliberately not clicked.' : 'Real answer readable at narrow desktop width; no adoption prompt.', turn);
  }
  report.finalEngine = await settings(); assert.deepEqual(report.finalEngine, report.initialEngine);
  assert.equal(calls, paid ? 1 : 0); assert.equal(report.pageErrors.length, 0); assert.equal(report.routeErrors.length, 0); report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Readonly browser verification failed'; report.failedStage = stage; process.exitCode = 1;
  if (page) await shot('failure.png', 'Actual stopped state; no automatic paid retry.').catch(() => {});
} finally {
  await browser?.close(); report.modelRequests = calls;
  if (!report.finalEngine) {
    try { report.finalEngine = await settings(); } catch { report.finalEngineUnavailable = true; }
  }
  await writeFile(join(directory, paid ? 'report.json' : 'prepare-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, paid, directory: relative(process.cwd(), directory).split(sep).join('/'), error: report.error }));
}
