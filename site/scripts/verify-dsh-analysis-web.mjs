// Real paid DSH -> Notebook acceptance on managed 3001. No user project or database.
// Exactly two user turns at most; an uncertain/failed paid turn is never resent.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const resume = process.argv[2] === '--resume-paid-run';
if (resume) {
  assert.equal(process.argv.length, 4);
  assert.match(process.argv[3], /^\.runtime\/dsh-analysis-web\/browser-\d{13}$/u);
} else assert.deepEqual(process.argv.slice(2), ['--confirm-paid-model'], 'Explicit --confirm-paid-model is required.');
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/dsh-analysis-web', `browser-${Date.now()}`);
const sourceDirectory = resume ? resolve(process.argv[3]) : undefined;
const projectPath = join(sourceDirectory ?? directory, 'project'), filename = 'dsh-sales-synthetic.csv';
const csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
const instructions = [
  '分析当前合成销售数据。保留已有 Data 单元，在 Notebook 中新增按 region 汇总 amount 的 SQL、结果表和柱状图。汇总输出列命名为 region 和 revenue。请实际运行验证并提交 Notebook 草稿供我确认，不要修改看板。最后说明各地区金额和合计。',
  '现在重新运行并核对当前 Notebook，告诉我 East、South 和合计的金额。只读回答，不修改单元，不创建或提交新草稿，不修改看板。',
];
const report = { passed: false, base, projectPath: relative(process.cwd(), projectPath).replaceAll('\\', '/'),
  tasks: [], runs: [], checks: [], screenshots: [], routeErrors: [], pageErrors: [], paidTasks: 0,
  boundaries: ['At most two real paid DSH user turns; no automatic paid retry.',
    'Fresh synthetic CSV and owned local project only; connections hidden and no external browser traffic.',
    'Actual SDK/model, server-side tool trial, automatic browser Notebook run and explicit confirmation.',
    'Screenshots require actual viewing before actualImageReviewed is marked true.'] };
await mkdir(directory, { recursive: true });
let browser, context, page, handle, pageId, datasetId, dashboard, sourceReport, created = 0, opened = 0;
const pause = ms => new Promise(done => setTimeout(done, ms));
const notebook = () => page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const frame = () => page.frameLocator('iframe[title="官方 DSH 聊天"]');
const composer = () => frame().locator('[data-composer-input="true"]');
const documentOf = state => state.dataProduct.notebooks[pageId];
async function poll(predicate, message, timeout = 45_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(150); }
  throw new Error(message);
}
async function saveReport() { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); }
async function validateResume() {
  for (const path of [sourceDirectory, projectPath, join(sourceDirectory, 'report.json'), join(projectPath, 'agentcanvas.project.json')]) {
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.equal(resolve(await realpath(path)).toLowerCase(), resolve(path).toLowerCase());
  }
  sourceReport = JSON.parse(await readFile(join(sourceDirectory, 'report.json'), 'utf8'));
  assert.equal(sourceReport.passed, false); assert.equal(sourceReport.paidTasks, 1); assert.equal(sourceReport.tasks.length, 1);
  assert.match(sourceReport.failure.message, /svg\.recharts-surface.*resolved to 2 elements/su);
  assert.deepEqual(sourceReport.routeErrors, []); assert.deepEqual(sourceReport.pageErrors, []);
  assert.equal(sourceReport.tasks[0].instruction, instructions[0]); assert.equal(sourceReport.tasks[0].state, 'awaitingConfirmation');
  assert.equal(sourceReport.runs.length, 1); assertTotals(sourceReport.runs[0].body.run);
  assert.equal(resolve(sourceReport.projectPath), projectPath);
  assert.equal(existsSync(join(sourceDirectory, 'resume-paid.claim.json')), false, 'Continuation already attempted; do not resend.');
  report.tasks.push(sourceReport.tasks[0]);
  report.reusedPaidTasks = 1; report.sourceEvidence = process.argv[3];
  report.boundaries.push('Resumes the original successful paid draft after a screenshot-selector error; adopts historical draft and explicitly reruns it. Original live auto-preview evidence is retained in sourceEvidence. Only one new paid follow-up is allowed.');
}
async function snapshot(predicate = () => true) {
  let state;
  await poll(async () => {
    assert.ok(handle);
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200);
    const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    state = value.manifest.state;
    return state && predicate(state) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent());
  }, 'Owned project did not finish saving.');
  if (dashboard) assert.deepEqual(state.appSpec, dashboard, 'Dashboard changed.');
  return state;
}
async function shot(name, scenario, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const file = `${name}.png`; await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, actualImageReviewed: false }); await saveReport();
}
async function send(round) {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await frame().locator('[data-agentcanvas-dsh-native-web="true"]').waitFor();
  await poll(async () => await composer().getAttribute('contenteditable') === 'true', 'Composer not ready.');
  const before = await page.evaluate(() => window.__dshAnalysisReceipts.length);
  await composer().fill(instructions[round - 1]); await composer().press('Enter');
  console.log(`Paid turn ${round} sent once.`);
  await poll(() => page.evaluate(count => window.__dshAnalysisReceipts.length > count, before),
    'Paid SSE did not finish. Receipt uncertain: do not resend.', 205_000);
  const receipt = await page.evaluate(index => window.__dshAnalysisReceipts[index], before);
  await writeFile(join(directory, `round-${round}-receipt.json`), JSON.stringify(receipt, null, 2));
  assert.equal(receipt.status, 200); assert.ok(receipt.body);
  const frames = receipt.body.split(/\r?\n\r?\n/u).flatMap(block => {
    const data = block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  const task = frames.findLast(value => value.event?.type === 'completed')?.task;
  assert.ok(task, 'No terminal task; do not resend.'); report.tasks.push(task); await saveReport();
  console.log(`Paid turn ${round}: ${task.state}; ${JSON.stringify(task.counters)}`);
  return task;
}
function assertTotals(run) {
  assert.equal(run.status, 'success');
  const tables = run.cells.flatMap(cell => cell.table ? [cell.table] : []);
  const totals = tables.find(table => table.rows?.length === 2 && table.rows.every(row => 'region' in row && 'revenue' in row));
  assert.ok(totals, 'No computed regional totals table.');
  assert.deepEqual(totals.rows.map(row => ({ region: row.region, revenue: row.revenue })).sort((a, b) => a.region.localeCompare(b.region)),
    [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
}
try {
  if (resume) await validateResume();
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      const project = request.headers()[header];
      if (project) assert.equal(project, handle, 'Foreign project access.');
      if (request.method() === 'GET') {
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (['/api/projects', '/api/datasets'].includes(url.pathname) && !project)
          return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
        if (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python') return route.continue();
        if (project && (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets'))) return route.continue();
        throw new Error(`Unexpected API read ${url.pathname}`);
      }
      if (url.pathname === '/api/projects') {
        assert.equal(request.method(), 'POST'); const body = request.postDataJSON();
        if (body.action === 'create') {
          assert.equal(resume, false);
          assert.equal(++created, 1); assert.equal(body.path, projectPath);
          const response = await route.fetch(); assert.equal(response.status(), 200);
          handle = (await response.json()).handle; assert.ok(handle); return route.fulfill({ response });
        }
        if (body.action === 'open') {
          assert.equal(resume, true); assert.equal(++opened, 1); assert.equal(body.path, projectPath);
          const response = await route.fetch(); assert.equal(response.status(), 200);
          const value = await response.json(); handle = value.handle;
          assert.equal(handle, sourceReport.project.handle); assert.equal(resolve(value.path), projectPath);
          const state = value.manifest.state; assert.equal(state.harnessTasks.length, 1);
          assert.deepEqual(state.harnessTasks[0], sourceReport.tasks[0]);
          assert.equal(state.appSpec.dataSources.length, 1); assert.equal(value.manifest.tables.length, 1);
          assert.equal(value.manifest.tables[0].descriptor.originalFileName, filename);
          assert.equal(state.dataProduct.notebooks[sourceReport.project.pageId].cells.length, 1);
          return route.fulfill({ response });
        }
        assert.equal(body.action, 'save'); assert.ok(handle && project === handle);
        if (dashboard) assert.deepEqual(body.state.appSpec, dashboard); return route.continue();
      }
      assert.ok(handle && project === handle, 'Only owned project mutations allowed.');
      if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
        assert.equal(request.method(), 'POST');
        assert.equal(decodeURIComponent(request.headers()['x-file-name']), filename); assert.equal(request.postData(), csv);
        return route.continue();
      }
      if (url.pathname === '/api/ai/dsh/conversation/stream') {
        assert.equal(request.method(), 'POST'); const body = request.postDataJSON();
        const round = report.paidTasks + 1 + (resume ? 1 : 0); assert.ok(round <= 2, 'Paid task cap; no retry.');
        assert.equal(body.instruction, instructions[round - 1]); assert.equal(body.pageId, pageId);
        assert.match(body.conversation_id, /^dshconversation_/u); assert.equal(body.dataSourceId, datasetId);
        assert.deepEqual(body.appSpec.dataSources.map(source => source.id), [datasetId]);
        assert.ok(!body.rawWorkbookManifest && !body.imageAttachmentManifest && !body.mcpTools);
        assert.equal(body.notebookContext?.connections?.length ?? 0, 0);
        if (resume) {
          const claim = await open(join(sourceDirectory, 'resume-paid.claim.json'), 'wx');
          try { await claim.writeFile(JSON.stringify({ sourceTaskId: sourceReport.tasks[0].id, at: new Date().toISOString(), evidence: relative(process.cwd(), directory) })); }
          finally { await claim.close(); }
        }
        report.paidTasks++; await saveReport();
        return route.continue();
      }
      if (url.pathname === '/api/notebook/run') {
        const body = request.postDataJSON(); assert.equal(body.pageId, pageId); assert.equal(body.action, 'run');
        assert.equal(report.runs.length, 0, 'Only one automatic preview run; no retry.');
        assert.ok(body.document.cells.some(cell => cell.kind === 'data' && cell.sourceDataSourceId === datasetId));
        const record = { document: body.document }; report.runs.push(record);
        const response = await route.fetch({ timeout: 45_000 }); record.status = response.status(); record.body = await response.json();
        await saveReport(); return route.fulfill({ response });
      }
      throw new Error(`Unexpected mutation ${request.method()} ${url.pathname}`);
    } catch (error) { report.routeErrors.push(error.message); await saveReport(); return route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    const original = window.fetch.bind(window); window.__dshAnalysisReceipts = [];
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/ai/dsh/conversation/stream')
        void response.clone().text().then(body => window.__dshAnalysisReceipts.push({ status: response.status, body }),
          error => window.__dshAnalysisReceipts.push({ error: error.message }));
      return response;
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const engine = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engine.activeTasks, 0); assert.equal(engine.dsh.available, true);
  const settings = await (await context.request.get(`${base}/api/settings/ai`)).json(); assert.equal(settings.configured, true);
  if (resume) { assert.equal(settings.model, sourceReport.model); assert.equal(engine.dsh.version, sourceReport.sdkVersion); }
  report.model = settings.model; report.sdkVersion = engine.dsh.version;
  await page.goto(`${base}/dsh/web`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill('数据浏览器');
  await navigation.getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  if (!resume) await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 真实模型数据链路 · 合成验收');
  await dialog.getByRole('button', { name: resume ? '打开已有项目' : '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  pageId = (await snapshot()).appSpec.pages[0].id;
  report.project = { pageId, handle }; await saveReport();
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  let first, confirmed;
  if (resume) {
    const restored = await snapshot(); datasetId = restored.appSpec.dataSources[0].id;
    dashboard = structuredClone(restored.appSpec); first = sourceReport.tasks[0];
    assert.equal(pageId, sourceReport.project.pageId);
    assert.equal(report.runs.length, 0); assert.equal(report.paidTasks, 0);
    await shot('01-resumed-historical-draft', 'Original paid draft restored after browser closed; no model or automatic replay.', page.getByRole('region', { name: 'AI Notebook 草稿', exact: true }));
    await notebook().getByRole('button', { name: '采用草稿', exact: true }).click();
    confirmed = documentOf(await snapshot(state => documentOf(state)?.lastDraftId === first.notebookArtifact.id));
    assert.deepEqual(confirmed.cells, first.notebookArtifact.cells); assert.equal(report.runs.length, 0);
    await notebook().getByRole('button', { name: '▶ 全部运行', exact: true }).click();
    await poll(() => report.runs[0]?.body?.run, 'Explicit resumed run did not complete.'); assertTotals(report.runs[0].body.run);
    const chartDefinition = first.notebookArtifact.cells.find(cell => cell.kind === 'chart');
    assertTotals({ ...report.runs[0].body.run, cells: report.runs[0].body.run.cells.filter(cell => cell.cellId === chartDefinition.id) });
    const chart = notebook().getByRole('article', { name: `图表单元 ${chartDefinition.title}`, exact: true });
    await chart.locator('svg.recharts-surface[role="application"]').waitFor();
    await shot('02-resumed-confirmed-chart', 'Historical paid draft explicitly adopted then run once; real regional chart 150/80.', chart);
    report.checks.push('Prior live paid draft/automatic-preview receipts reused without another model call; reopened historical draft is adopted then explicitly rerun successfully. This is recovery evidence, not continuous-window preview confirmation.');
  } else {
  await notebook().locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: /导入 1 份文件/u }).click(); await upload.waitFor({ state: 'hidden' });
  const imported = await snapshot(state => state.appSpec.dataSources.length === 1); datasetId = imported.appSpec.dataSources[0].id;
  await notebook().getByRole('button', { name: '＋ Data', exact: true }).click();
  const editor = page.locator('.notebook-editor');
  await editor.getByLabel('数据源', { exact: true }).selectOption(datasetId);
  await editor.getByLabel('单元名称', { exact: true }).fill('合成三行销售数据');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales_input');
  await editor.getByRole('button', { name: '保存单元', exact: true }).click();
  await notebook().getByRole('button', { name: '确认改名并保存', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const prepared = await snapshot(state => documentOf(state)?.cells.length === 1);
  const baseline = structuredClone(documentOf(prepared)); dashboard = structuredClone(prepared.appSpec);
  assert.equal(baseline.cells[0].sourceDataSourceId, datasetId);
  assert.equal(await page.getByRole('checkbox', { name: 'AI 分析后自动运行 Notebook', exact: true }).isChecked(), true);
  await shot('01-prepared-synthetic-data', 'Imported three synthetic records and saved one Data cell before any model call.', notebook().locator('.notebook-heading'));
  first = await send(1);
  assert.equal(first.state, 'awaitingConfirmation', first.error ?? first.resultMessage);
  for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft'])
    assert.ok(first.events.some(event => event.type === 'observation' && event.toolCall?.name === name && event.toolCall.status === 'success'), `Missing successful ${name}.`);
  assert.ok(first.notebookArtifact, 'Real model did not deliver a draft.'); assert.equal(first.pendingChangeSet, undefined);
  assert.equal(first.notebookArtifact.executionEvidence?.status, 'success');
  assert.ok(first.notebookArtifact.cells.some(cell => cell.kind === 'table'));
  assert.ok(first.notebookArtifact.cells.some(cell => cell.kind === 'chart'));
  await poll(() => report.runs[0]?.body?.run, 'Automatic preview not completed.'); assertTotals(report.runs[0].body.run);
  const chartDefinition = first.notebookArtifact.cells.find(cell => cell.kind === 'chart');
  assert.equal(chartDefinition.categoryField, 'region'); assert.deepEqual(chartDefinition.valueFields, ['revenue']);
  assertTotals({ ...report.runs[0].body.run, cells: report.runs[0].body.run.cells.filter(cell => cell.cellId === chartDefinition.id) });
  await notebook().getByRole('button', { name: '确认更改', exact: true }).waitFor();
  assert.deepEqual(documentOf(await snapshot()), baseline);
  await shot('02-preview-awaiting-confirmation', 'Real paid DSH draft has successful automatic preview; formal Notebook unchanged.', page.getByRole('region', { name: 'AI Notebook 草稿', exact: true }));
  const chart = notebook().getByRole('article').filter({ has: page.locator('.recharts-wrapper') }).first();
  await chart.waitFor(); await chart.locator('svg.recharts-surface[role="application"]').waitFor();
  assert.ok(await chart.locator('svg.recharts-surface[role="application"]').evaluate(svg => { const box = svg.getBoundingClientRect(); return box.width > 0 && box.height > 0; }));
  await shot('03-real-chart-preview', 'Real SQL regional totals rendered as a chart before confirmation.', chart);
  await notebook().getByRole('button', { name: '确认更改', exact: true }).click();
  confirmed = documentOf(await snapshot(state => documentOf(state)?.lastDraftId === first.notebookArtifact.id));
  assert.deepEqual(confirmed.cells, first.notebookArtifact.cells); assert.equal(report.runs.length, 1);
  await shot('04-confirmed-results', 'Explicit confirmation persists the draft and reuses computed preview without rerunning.', chart);
  report.checks.push('Paid DSH created and tried the draft; browser auto-ran once; exact East150/South80 result; explicit confirmation alone persisted it.');
  }
  await page.reload({ waitUntil: 'networkidle' }); await notebook().waitFor();
  assert.deepEqual(documentOf(await snapshot()), confirmed); await pause(1500); assert.equal(report.runs.length, 1); assert.equal(report.paidTasks, resume ? 0 : 1);
  await shot('05-refresh-no-auto-replay', 'Reload preserves Notebook definitions but deliberately does not replay historical AI tasks or run results.', notebook().locator('.notebook-heading'));
  report.checks.push('Reload preserves confirmed definitions and causes no new Notebook execution.');
  const second = await send(2);
  assert.equal(second.state, 'completed', second.error ?? second.resultMessage);
  assert.equal(second.notebookArtifact, undefined); assert.equal(second.pendingChangeSet, undefined);
  assert.match(second.resultMessage, /150/u); assert.match(second.resultMessage, /80/u); assert.match(second.resultMessage, /230/u);
  assert.ok(second.events.some(event => event.type === 'observation' && event.toolCall?.name === 'runNotebookCells' && event.toolCall.status === 'success'), 'Follow-up lacks successful real trial evidence.');
  assert.ok(!second.events.some(event => ['editNotebookCells', 'submitNotebookDraft'].includes(event.toolCall?.name)), 'Read-only follow-up attempted a mutation.');
  assert.deepEqual(documentOf(await snapshot()), confirmed); await pause(1200); assert.equal(report.runs.length, 1);
  await shot('06-readonly-followup', 'Paid follow-up reruns current cells with tools and answers 150/80/230 without new draft or browser auto-run.');
  report.checks.push('Second paid turn uses saved conversation and real execution evidence, returns exact amounts and never changes Notebook/dashboard.');
  assert.equal(report.paidTasks, resume ? 1 : 2); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page) { await writeFile(join(directory, 'failure-visible.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
    await shot('failure', 'Actual failure state; no automatic paid retry.').catch(() => {}); }
  process.exitCode = 1;
} finally {
  await saveReport(); console.log(JSON.stringify({ passed: report.passed, directory: relative(process.cwd(), directory), paidTasks: report.paidTasks, failure: report.failure?.message }));
  await browser?.close();
}
