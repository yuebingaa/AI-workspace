// Managed 3001, owned synthetic project, entirely manual UI. No Agent/model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { CELL_MODULES_CSV as csv } from './fixtures/cell-modules.mjs';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const root = resolve('.runtime/m7-semantic-browser-2026-09-22'), args = process.argv.slice(2), attempt = Date.now();
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--resume'), 'Usage: verify-m7-semantic-browser.mjs [--resume <owned-directory>]');
const directory = args.length ? resolve(args[1]) : join(root, `browser-${attempt}`);
assert.match(relative(root, directory), /^browser-\d+$/u);
await mkdir(directory, { recursive: true }); assert.equal(await realpath(directory), directory);
assert.equal((await lstat(directory)).isSymbolicLink(), false);
const projectPath = join(directory, 'project'), ownershipPath = join(directory, 'ownership.json');
const fileName = 'm7-semantic-sales.csv', modelName = 'M7 地区销售口径';
const titles = { data: 'M7 合成销售源', semanticQuery: 'M7 地区销售语义汇总', table: 'M7 语义结果表', chart: 'M7 语义销售图' };
const expected = [{ area: 'East', revenue: 150 }, { area: 'South', revenue: 80 }];
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const rel = path => relative(process.cwd(), path).split(sep).join('/');
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = { kind: 'm7-semantic-ui-v1', passed: false, base, project: rel(projectPath), attempt,
  checks: [], stepEvidence: [], screenshots: [], runs: [], mutations: [], routeErrors: [], pageErrors: [], consoleErrors: [],
  boundaries: ['Real 3001 UI import, model and all Notebook cell editors; real semantic execution and persistence.',
    'No Agent/model calls, external database, ChangeSet, publishing or service operations.',
    'Unscoped project/data/connection catalogs and remote font are isolated. No response fixture for analysis, project save or semantic preview.'],
  visualReview: 'pending actual image inspection' };
let browser, context, page, handle, projectId, pageId, datasetId, scenario = 'preflight', created = 0;
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
const definition = manifest => manifest.state.dataProduct.notebooks?.[pageId];
const state = async () => {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
  assert.equal(response.status(), 200); const value = await response.json();
  assert.equal(value.handle, handle); assert.equal(resolve(value.path), projectPath); assert.equal(value.manifest.id, projectId);
  return value.manifest;
};
async function saveOwner() { await writeFile(ownershipPath, JSON.stringify({ kind: report.kind, projectPath, handle, projectId, pageId, csvSha256: checksum(csv) }, null, 2)); }
function validate(manifest) {
  assert.ok(manifest.tables.length <= 1 && manifest.files.length <= 1);
  assert.equal(manifest.state.appSpec.pages.length, 1); assert.equal(manifest.state.harnessTasks.length, 0);
  assert.deepEqual(manifest.state.appSpec.pages[0].root.children, []);
  assert.ok((manifest.state.dataProduct.semanticLayer?.models.length ?? 0) <= 1);
  for (const cell of definition(manifest)?.cells ?? []) assert.ok(Object.keys(titles).includes(cell.kind) && cell.title === titles[cell.kind]);
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 25000; let previous, stableAt;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value) && /已保存到本地项目|已打开本地项目|已确认上次修改保存到本地项目/u.test(await page.locator('.top-actions').textContent())) {
      if (previous !== value.stateRevision) { previous = value.stateRevision; stableAt = Date.now(); }
      if (Date.now() - stableAt > 600) return value;
    } else { previous = undefined; stableAt = undefined; }
    await pause(100);
  }
  throw new Error(`Project was not stably saved: ${scenario}`);
}
async function step(name, action) {
  scenario = name;
  const evidence = await action() ?? { status: 'executed' };
  assert.ok(['executed', 'reusedExisting'].includes(evidence.status));
  report.stepEvidence.push({ name, ...evidence });
  report.checks.push(`${evidence.status}: ${name}`); console.log(`PASS [${evidence.status}] ${name}`);
}
async function shot(name, locator, assertions) {
  if (locator) await locator.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const file = `${attempt}-${name}.png`; await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), assertions, actualImageReviewed: false });
}
async function notice() { const button = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await button.isVisible()) await button.click(); }
async function notebook() { await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await notice(); }
async function projectDialog() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
}
function observe(target) {
  target.setDefaultTimeout(20000); target.on('pageerror', error => report.pageErrors.push({ scenario, message: error.message }));
  target.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ scenario, message: message.text() }); });
}
async function saveEditor() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
  if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function add(kind, configure) {
  const current = await state();
  if (definition(current)?.cells.some(cell => cell.kind === kind)) return { kind, status: 'reusedExisting' };
  const label = { data: 'Data', semanticQuery: '语义查询', table: '表格', chart: '图表' }[kind];
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(titles[kind]); await configure(); await saveEditor();
  await saved(value => definition(value)?.cells.some(cell => cell.kind === kind && cell.title === titles[kind]));
  return { kind, status: 'executed' };
}
async function run() {
  const pending = page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click(); const response = await pending, value = await response.json();
  assert.equal(response.status(), 200); assert.equal(value.run.status, 'success');
  const book = definition(await state());
  for (const cell of book.cells.filter(cell => cell.kind !== 'data')) {
    const result = value.run.cells.find(result => result.cellId === cell.id);
    assert.equal(result.status, 'success'); assert.deepEqual(result.table.rows, expected);
    assert.equal(result.resultRef.accessMode, 'user'); assert.equal(result.resultRef.complete, true);
  }
  report.runs.push(value.run); await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
}
try {
  if (args.length) {
    const owner = JSON.parse(await readFile(ownershipPath, 'utf8'));
    assert.equal(owner.kind, report.kind); assert.equal(owner.projectPath, projectPath); assert.equal(owner.csvSha256, checksum(csv));
    ({ handle, projectId, pageId } = owner);
  }
  const engineResponse = await fetch(`${base}/api/settings/agent-engine`); assert.equal(engineResponse.status, 200);
  const engine = await engineResponse.json(); report.engineBefore = { engine: engine.engine, revision: engine.revision };
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base, 'External origin blocked');
      if (url.pathname.startsWith('/api/ai/')) throw new Error('No AI task authorized in this manual acceptance');
      if (method === 'GET' && ['/api/projects', '/api/datasets', '/api/connections'].includes(url.pathname) && !request.headers()[header]) {
        const key = url.pathname.split('/').at(-1); return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ [key]: [] }) });
      }
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (['GET', 'HEAD'].includes(method)) return await route.continue();
      report.mutations.push({ scenario, method, path: url.pathname });
      assert.equal(method, 'POST');
      if (url.pathname === '/api/projects') {
        const body = request.postDataJSON(); assert.ok(['create', 'open', 'save'].includes(body.action));
        if (body.action === 'create') { assert.equal(args.length, 0); assert.equal(++created, 1); assert.equal(body.path, projectPath); }
        else if (body.action === 'open') assert.equal(body.path, projectPath);
        else { assert.equal(request.headers()[header], handle); assert.equal(body.state.appSpec.pages.length, 1); assert.equal(body.state.harnessTasks.length, 0); }
      } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
        assert.equal(request.headers()[header], handle); assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName); assert.equal(request.postData(), csv);
      } else if (url.pathname === '/api/notebook/run') {
        assert.equal(request.headers()[header], handle); const body = request.postDataJSON(); assert.equal(body.action, 'run');
        assert.ok(body.document.cells.every(cell => Object.keys(titles).includes(cell.kind))); assert.ok(body.document.cells.length <= 4);
      } else throw new Error('Unapproved mutation blocked');
      return await route.continue();
    } catch (error) { report.routeErrors.push({ scenario, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step(args.length ? 'Open owned project through UI' : 'Create one isolated project through UI', async () => {
    await projectDialog(); await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
    const action = args.length ? 'open' : 'create';
    if (!args.length) await dialog().getByLabel('项目名称', { exact: true }).fill('M7 语义模型手工验收');
    const pending = page.waitForResponse(response => response.url() === `${base}/api/projects` && response.request().postDataJSON()?.action === action);
    await dialog().getByRole('button', { name: args.length ? '打开已有项目' : '新建本地项目', exact: true }).click();
    const response = await pending, value = await response.json(); assert.equal(response.status(), 200);
    handle = value.handle; projectId = value.manifest.id; await dialog().waitFor({ state: 'hidden' });
    const initialized = await saved(value => value.state?.appSpec.pages.length === 1); pageId = initialized.state.appSpec.pages[0].id;
    await saveOwner(); await notebook();
  });
  await step('Import synthetic CSV and preserve original through UI', async () => {
    let current = await state(); const importedThisAttempt = current.tables.length === 0;
    if (!current.tables.length) {
      await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
      const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
      await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
      current = await saved(value => value.tables.length === 1 && value.files.length === 1);
    }
    datasetId = current.tables[0].descriptor.datasetId; assert.equal(current.files[0].name, fileName);
    assert.equal(checksum(await readFile(join(projectPath, 'files', current.files[0].file))), checksum(csv));
    assert.equal(current.tables[0].descriptor.source.rowCount, 3);
    return { status: importedThisAttempt ? 'executed' : 'reusedExisting', verifiedThisAttempt: ['original bytes', 'three-row dataset'],
      importPerformedThisAttempt: importedThisAttempt };
  });
  await step('Create and preview one single-table semantic model through UI', async () => {
    const current = await state(), createdThisAttempt = !(current.state.dataProduct.semanticLayer?.models.length);
    if (!(current.state.dataProduct.semanticLayer?.models.length)) {
      await page.getByRole('button', { name: '语义模型', exact: true }).click();
      const manager = page.getByRole('dialog', { name: '语义模型管理', exact: true });
      await manager.getByLabel('模型名称', { exact: true }).fill(modelName);
      await manager.locator('.semantic-basics select').selectOption(datasetId);
      await manager.getByRole('button', { name: '＋ 添加维度', exact: true }).click();
      await manager.getByLabel('维度1名称', { exact: true }).fill('销售地区'); await manager.getByLabel('维度1标识', { exact: true }).fill('area');
      await manager.getByLabel('维度1字段', { exact: true }).selectOption('region');
      await manager.getByRole('button', { name: '＋ 添加指标', exact: true }).click();
      await manager.getByLabel('指标1名称', { exact: true }).fill('销售总额'); await manager.getByLabel('指标1标识', { exact: true }).fill('revenue');
      await manager.getByLabel('指标1字段', { exact: true }).selectOption('amount'); await manager.getByLabel('指标1计算方式', { exact: true }).selectOption('sum');
      await manager.getByRole('button', { name: '预览计算', exact: true }).click();
      for (const amount of ['150', '80']) await manager.locator('.semantic-preview').getByText(amount, { exact: true }).waitFor();
      await shot('01-model-preview-1440', manager, ['Model configuration after successful preview; business aliases and sum. Preview rows may be below the visible scroll area.']);
      await manager.getByRole('button', { name: '保存并选择', exact: true }).click(); await manager.waitFor({ state: 'hidden' });
    }
    const value = await saved(value => value.state.dataProduct.semanticLayer?.models.length === 1);
    assert.equal(value.state.dataProduct.semanticLayer.models[0].name, modelName);
    assert.equal(value.state.dataProduct.semanticLayer.models[0].measures[0].aggregation, 'sum');
    return { status: createdThisAttempt ? 'executed' : 'reusedExisting', creationAndPreviewPerformedThisAttempt: createdThisAttempt,
      verifiedThisAttempt: ['saved model name', 'saved sum measure'] };
  });
  await step('Prepare Data and semanticQuery, then run real semantic results', async () => {
    const data = await add('data', async () => { await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_data'); await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); });
    const semanticQuery = await add('semanticQuery', async () => {
      await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('semantic_sales');
      await editor().getByLabel('维度标识（逗号分隔）', { exact: true }).fill('area');
      await editor().getByLabel('指标标识（逗号分隔）', { exact: true }).fill('revenue');
      await shot('02-semantic-editor-1440', editor(), ['Actual semanticQuery configuration, selected model and member identifiers']);
    }); await run();
    return { status: 'executed', cellPreparation: [data, semanticQuery], runPerformedThisAttempt: true };
  });
  await step('Prepare table and chart, then run exact 150/80 results', async () => {
    const table = await add('table', async () => { await editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）', { exact: true }).fill('area, revenue'); });
    const chartPreparation = await add('chart', async () => {
      await editor().getByLabel('分类字段', { exact: true }).fill('area'); await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('revenue');
    }); await run();
    const chart = page.getByRole('article', { name: `图表单元 ${titles.chart}`, exact: true });
    await chart.getByRole('img', { name: /图表下方提供对应数据表/u }).waitFor();
    await shot('03-semantic-results-1440', chart, ['Real semanticQuery→table/chart, East 150 and South 80']);
    return { status: 'executed', cellPreparation: [table, chartPreparation], runPerformedThisAttempt: true };
  });
  await step('Save and reopen the same project in a fresh browser tab, then rerun', async () => {
    const before = await saved(); validate(before); const savedBook = definition(before), savedModel = before.state.dataProduct.semanticLayer;
    const oldPage = page; page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
    await notebook(); await saved(); assert.equal(await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')), handle);
    const reopened = await state(); assert.deepEqual(definition(reopened), savedBook); assert.deepEqual(reopened.state.dataProduct.semanticLayer, savedModel);
    await run(); assert.notEqual(report.runs.at(-1).runId, report.runs.at(-2).runId); await oldPage.close();
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('04-reopened-results-1024', page.getByRole('article', { name: `图表单元 ${titles.chart}`, exact: true }), ['New tab, same saved model/definition and fresh 150/80 result']);
    report.final = { handle, projectId, pageId, datasetId, revision: reopened.stateRevision, tableCount: reopened.tables.length, originalCount: reopened.files.length, document: savedBook, semanticLayer: savedModel };
  });
  assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  const finalEngine = await (await fetch(`${base}/api/settings/agent-engine`)).json();
  report.engineAfter = { engine: finalEngine.engine, revision: finalEngine.revision }; assert.deepEqual(report.engineAfter, report.engineBefore);
  report.passed = true;
} catch (error) {
  report.failure = { scenario, name: error.name, message: error.message };
  if (page) await shot('failure', undefined, ['Actual failure state; not passing evidence']).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, `report-${attempt}.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close();
  console.log(JSON.stringify({ passed: report.passed, directory: rel(directory), failure: report.failure, checks: report.checks, screenshots: report.screenshots.map(item => item.file) }, null, 2));
}
