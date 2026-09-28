// Explicit single paid task, or offline engine fixture. Never a user project.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const offline = process.argv[2] === '--offline';
assert.ok(process.argv.length === 3 && (offline || process.argv[2] === '--confirm-paid-model'), 'Choose --offline or explicit --confirm-paid-model.');
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/dsh-autonomy-20260926', `browser-${Date.now()}`), projectPath = join(directory, 'project');
const csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n', filename = 'dsh-autonomy-synthetic.csv';
const report = { passed: false, base, offline, checks: [], screenshots: [], pageErrors: [], routeErrors: [], paidTasks: 0, analysisRequests: 0, notebookRuns: [],
  boundaries: [offline ? 'Offline fixed model driver, real engine/bridge/SQL/SSE; browser transport replay. No paid model.' : 'One explicit paid analysis; no automatic retry.',
    'New synthetic project only; no user data or configuration changes.',
    offline ? 'Not a claim of SDK or public AI handler verification.' : 'Paid request uses the real website handler, DSH SDK and provider. No model fixture for the success path.'] };
await mkdir(directory, { recursive: true });
let fixtureServer, fixture;
const environment = process.env, originalFetch = globalThis.fetch;
if (offline) {
  const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'localappdata']);
  process.env = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toLowerCase())));
  process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'fixture-state');
  globalThis.fetch = async () => { throw new Error('Network prohibited inside offline DSH fixture.'); };
  fixtureServer = await createServer({ root: process.cwd(), configFile: false, envFile: false, logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
    resolve: { alias: { '@': process.cwd() } }, server: { middlewareMode: true, hmr: false, watch: null } });
  fixture = (await fixtureServer.ssrLoadModule('/scripts/dsh-autonomy-fixture.ts')).createAutonomyFixture;
}
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
let handle, created = 0, pageId, datasetId, dashboard, engineBefore, syntheticKind;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    if (request.method() === 'GET') {
      if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
      if (['/api/projects', '/api/datasets'].includes(url.pathname) && !request.headers()[header]) {
        return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
      }
      if (request.headers()[header]) assert.equal(request.headers()[header], handle);
      return route.continue();
    }
    if (url.pathname === '/api/projects') {
      const body = request.postDataJSON();
      if (body.action === 'create') {
        assert.equal(++created, 1); assert.equal(body.path, projectPath);
        const response = await route.fetch(); assert.equal(response.status(), 200);
        handle = (await response.json()).handle;
        return route.fulfill({ response });
      }
      assert.equal(body.action, 'save'); assert.equal(request.headers()[header], handle);
      if (dashboard) assert.deepEqual(body.state.appSpec, dashboard);
      return route.continue();
    }
    assert.ok(handle && request.headers()[header] === handle, 'Only the owned project may be mutated.');
    if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
      assert.equal(decodeURIComponent(request.headers()['x-file-name']), filename); assert.equal(request.postData(), csv);
      return route.continue();
    }
    if (url.pathname === '/api/notebook/run') {
      const response = await route.fetch({ timeout: 45_000 });
      const value = await response.json(); report.notebookRuns.push(value.run);
      return route.fulfill({ response });
    }
    if (url.pathname === '/api/ai/harness/stream') {
      assert.ok(!syntheticKind, 'Synthetic failure/cancel must be intercepted before network.');
      assert.equal(++report.analysisRequests, 1, 'No second analysis is authorized by this verifier.');
      const body = request.postDataJSON();
      assert.equal(body.pageId, pageId); assert.equal(body.dataSourceId, datasetId);
      assert.deepEqual(body.notebookContext.sourceIds, [datasetId]);
      assert.ok(!body.rawWorkbookManifest && !body.imageAttachmentManifest && !body.mcpTools);
      if (offline) {
        const result = await fixture(body); report.fixtureEvidence = result.evidence;
        await writeFile(join(directory, 'fixture-task.json'), JSON.stringify(result.task, null, 2));
        return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: result.body });
      }
      report.paidTasks++;
      return route.continue();
    }
    throw new Error(`Unexpected mutation: ${url.pathname}`);
  } catch (error) { report.routeErrors.push(error.message); return route.abort('blockedbyclient').catch(() => {}); }
});

// Explicit negative UI fixtures after the single paid success; never reach the provider.
await context.addInitScript(() => {
  const native = window.fetch.bind(window);
  window.__dshAutonomyNegative = null;
  window.__dshAutonomyReceipt = null;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const kind = window.__dshAutonomyNegative;
    if (url.pathname !== '/api/ai/harness/stream') return native(input, init);
    if (!kind) {
      const response = await native(input, init);
      // Read a clone immediately: CDP getResponseBody can lose a streaming response
      // when the workbench switches to Notebook. Never replay a paid request.
      void response.clone().text().then(body => {
        window.__dshAutonomyReceipt = { status: response.status, body };
      }, error => { window.__dshAutonomyReceipt = { error: error.message }; });
      return response;
    }
    window.__dshAutonomyNegative = null;
    const request = JSON.parse(init.body);
    if (kind === 'cancel') return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled synthetic transport', 'AbortError'));
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
    });
    const now = new Date().toISOString(), task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
      instruction: request.instruction, pageId: request.pageId, role: 'editor', state: 'failed', createdAt: now, updatedAt: now,
      counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [],
      resultMessage: '隔离失败演示：没有取得成功草稿，正式 Notebook 与看板未修改。', error: '合成失败回执', terminationCode: 'verificationFailed' };
    const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: 'failed', message: task.resultMessage };
    return new Response(`event: completed\ndata: ${JSON.stringify({ event, task })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
});
const page = await context.newPage(); page.setDefaultTimeout(25_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const notebook = () => page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(150); }
  throw new Error(message);
}
async function snapshot(predicate = () => true) {
  let state;
  await poll(async () => {
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200); const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    state = value.manifest.state;
    return state && predicate(state) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent());
  }, 'Owned project save did not settle.');
  if (dashboard) assert.deepEqual(state.appSpec, dashboard);
  return state;
}
const documentOf = state => state.dataProduct.notebooks[pageId];
async function shot(name, scenario, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const file = `${name}.png`; await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), actualImageReviewed: false });
}
async function send(instruction) {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
}
try {
  engineBefore = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineBefore.engine, 'dsh'); assert.equal(engineBefore.dsh.available, true); assert.equal(engineBefore.activeTasks, 0);
  if (!offline) {
    const settings = await (await context.request.get(`${base}/api/settings/ai`)).json(); assert.equal(settings.configured, true);
    report.model = settings.model; report.sdkVersion = engineBefore.dsh.version;
  } else report.model = 'offline-fixed-driver';
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await page.getByRole('navigation', { name: '工作区功能菜单', exact: true }).getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 独立上下文与分析说明 · 合成验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  pageId = (await snapshot()).appSpec.pages[0].id;
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  await notebook().locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: /导入 1 份文件/u }).click(); await upload.waitFor({ state: 'hidden' });
  const imported = await snapshot(state => state.appSpec.dataSources.some(source => source.name.includes('dsh-autonomy-synthetic')));
  datasetId = imported.appSpec.dataSources.find(source => source.name.includes('dsh-autonomy-synthetic')).id;
  await notebook().getByRole('button', { name: '＋ Data', exact: true }).click();
  const editor = notebook().locator('.notebook-editor');
  await editor.getByLabel('单元名称', { exact: true }).fill('合成销售明细');
  await editor.getByRole('button', { name: '保存单元', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const prepared = await snapshot(state => documentOf(state)?.cells.length === 1);
  let baseline = documentOf(prepared); dashboard = structuredClone(prepared.appSpec);
  await send('这是隔离合成销售数据。请保留Data单元，新增按region分组、amount求和的SQL和表格、柱状图，真实运行后提交草稿。在最终回答解释两地区销售额、总额与样本局限。请不要只返回完成通知，也不要说已经保存或发布。');
  await page.waitForFunction(() => window.__dshAutonomyReceipt !== null, undefined, { timeout: 190_000 });
  const receipt = await page.evaluate(() => window.__dshAutonomyReceipt);
  assert.equal(receipt.error, undefined); assert.equal(receipt.status, 200);
  const sse = receipt.body;
  const frames = sse.split(/\r?\n\r?\n/u).filter(frame => frame.includes('data: ')).map(frame => JSON.parse(frame.split(/\r?\n/u).find(line => line.startsWith('data: ')).slice(6)));
  const task = frames.findLast(frame => frame.event?.type === 'completed')?.task;
  report.task = task;
  await writeFile(join(directory, 'analysis-task.json'), JSON.stringify(task, null, 2));
  assert.equal(task?.state, 'awaitingConfirmation', 'Analysis did not produce a verified draft; do not retry automatically.');
  assert.equal(task.notebookArtifact.executionEvidence.status, 'success');
  assert.match(task.resultMessage, /AI 分析说明/u); assert.match(task.resultMessage, /150/u); assert.match(task.resultMessage, /80/u); assert.match(task.resultMessage, /230/u);
  assert.match(task.resultMessage, /待你确认后才保存/u);
  await notebook().waitFor();
  await notebook().getByRole('button', { name: '确认更改', exact: true }).waitFor({ timeout: 45_000 });
  await poll(async () => await notebook().getByRole('button', { name: '确认更改', exact: true }).isEnabled(), 'Automatic preview did not succeed.');
  assert.deepEqual(documentOf(await snapshot()), baseline);
  assert.equal(report.notebookRuns.length, 1); assert.equal(report.notebookRuns[0].status, 'success');
  await shot('01-dsh-analysis-pending', `${offline ? 'Offline driver, real engine' : 'Paid model'} findings and verified draft remain pending confirmation.`, notebook().getByRole('region', { name: 'AI Notebook 草稿', exact: true }));
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('02-analysis-narrow', `${offline ? 'Offline driver' : 'Paid model'} findings at narrow desktop, no horizontal overflow.`);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await notebook().getByRole('button', { name: '确认更改', exact: true }).click();
  baseline = documentOf(await snapshot(state => documentOf(state)?.lastDraftId === task.notebookArtifact.id));
  await shot('03-confirmed-analysis', 'User confirmation persists steps and retains analysis explanation.');
  assert.equal(report.notebookRuns.length, 1);
  report.checks.push(`One ${offline ? 'fixed-driver' : 'paid'} DSH task generated a verified SQL/table/chart draft and analysis explanation; explicit confirmation saves without another run.`);
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(documentOf(await snapshot()), baseline); assert.equal(report.paidTasks, offline ? 0 : 1); assert.equal(report.notebookRuns.length, 1);
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByText(/AI 分析说明/u).first().waitFor();
  await shot('04-reopened-explanation', 'Persisted model explanation survives reopen without re-running AI or Notebook.');
  report.checks.push('Saved explanations survive reload; no historical task reruns.');
  syntheticKind = 'failure'; await page.evaluate(() => { window.__dshAutonomyNegative = 'failure'; });
  await send('隔离失败演示，不调用真实模型。');
  await page.getByText('隔离失败演示：没有取得成功草稿，正式 Notebook 与看板未修改。', { exact: true }).first().waitFor();
  await shot('05-failure-no-analysis', 'Explicit negative SSE fixture: no successful analysis is attached to the failed task.');
  assert.deepEqual(documentOf(await snapshot()), baseline);
  syntheticKind = 'cancel'; await page.evaluate(() => { window.__dshAutonomyNegative = 'cancel'; });
  await send('隔离取消演示，不调用真实模型。');
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  await shot('06-cancelled-no-analysis', 'Explicit held-transport cancellation fixture: no draft adopted or model called.');
  assert.deepEqual(documentOf(await snapshot()), baseline);
  report.checks.push('Separate injected failure/cancel display preserves definitions; not a claim of provider or database cancellation testing.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.equal(report.paidTasks, offline ? 0 : 1);
  const engineAfter = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineAfter.engine, engineBefore.engine); assert.equal(engineAfter.revision, engineBefore.revision); assert.equal(engineAfter.activeTasks, 0);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  await page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await fixtureServer?.close(); globalThis.fetch = originalFetch; process.env = environment;
  console.log(JSON.stringify({ passed: report.passed, paidTasks: report.paidTasks,
    report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), failure: report.failure?.message }));
}
