// Official DSH Web acceptance: default browser-only SSE fixtures; paid mode is explicit and capped at two requests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const resumeMode = process.argv[2] === '--resume-paid-run';
assert.ok(resumeMode ? process.argv.length === 4 : process.argv.length <= 3 && [undefined, '--offline', '--confirm-paid-model'].includes(process.argv[2]),
  'Usage: node scripts/verify-dsh-web.mjs [--offline | --confirm-paid-model | --resume-paid-run .runtime/dsh-web-20260926/browser-TIMESTAMP]');
const resumeSource = resumeMode ? process.argv[3].replaceAll('\\', '/') : undefined;
if (resumeMode) assert.match(resumeSource, /^\.runtime\/dsh-web-20260926\/browser-\d{13}$/u, 'Resume source must be a script-owned relative evidence directory.');
const offline = !resumeMode && process.argv[2] !== '--confirm-paid-model';
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/dsh-web-20260926', `browser-${Date.now()}`);
const sourceDirectory = resumeMode ? resolve(resumeSource) : undefined, projectPath = join(sourceDirectory ?? directory, 'project');
const instructions = ['你是ds吗？先不要分析数据。记住本次合成测试代号晨星42。', '刚才让你记住的测试代号是什么？只回复代号，不分析数据。'];
const failureInstruction = '隔离失败演示，不调用真实模型。', cancelInstruction = '隔离取消演示，不调用真实模型。';
const failureMessage = '隔离失败回执：DSH 本轮未成功完成；没有读取数据或修改正式文档。';
const report = { passed: false, base, offline, checks: [], screenshots: [], pageErrors: [], routeErrors: [], resourceFailures: [], expectedResourceFailures: [],
  paidTasks: 0, reusedPaidTasks: 0, newPaidTasks: 0, conversationRequests: 0, clearRequests: [], tasks: [], negativeFixtures: [],
  boundaries: [offline ? 'Success uses explicit browser-only SSE fixtures, not the model, SDK or execution engine.'
    : resumeMode ? 'Explicit resume of one completed paid round; only the second round may be sent once, with a durable exclusive claim and no retry.'
      : 'At most two explicitly authorized paid requests to the real DSH conversation endpoint; no automatic retry.',
  resumeMode ? 'Writes are limited to the validated prior script-owned empty project and evidence directories; no user project, database or settings access.'
    : 'All writes are guarded to a new synthetic empty project; no existing project, user data, database, settings or definitions are changed.',
  'Official frontend resources and postMessage presentation bridge are real; failure and cancellation are browser-only transport fixtures.',
  'Screenshots are captured but actualImageReviewed remains false until a human or the parent agent has viewed them.'] };
await mkdir(directory, { recursive: true });
let browser, context, page, handle, pageId, dashboard, notebooks, engineBefore, expectedClearContext, sourceReport, sourceManifest;
let created = 0, opened = 0, negativeKind, documentFailureArmed = false, documentFailureCount = 0;
const expectedFailedRequests = new WeakSet();
const pause = ms => new Promise(done => setTimeout(done, ms));
const activeOf = state => state.assistantSessions.items.find(item => item.id === state.assistantSessions.activeId);
const frame = () => page.frameLocator('iframe[title="官方 DSH 聊天"]');
const composer = () => frame().locator('[data-composer-input="true"]');
// Only paired strong markers and whitespace differ between source Markdown and rendered text.
const renderedText = value => value.replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/\s+/gu, ' ').trim();
async function plainPath(path, kind) {
  const absolute = resolve(path), parts = relative(process.cwd(), absolute).split(/[\\/]/u);
  assert.ok(parts.length && !parts.includes('..'), 'Evidence path escaped the workspace.');
  let current = process.cwd();
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    assert.equal(stat.isSymbolicLink(), false, 'Linked evidence paths are forbidden.');
    if (index < parts.length - 1 || kind === 'directory') assert.equal(stat.isDirectory(), true);
    else { assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); assert.ok(stat.size < 8 * 1024 * 1024); }
  }
  assert.equal(resolve(await realpath(absolute)).toLowerCase(), absolute.toLowerCase(), 'Evidence path was redirected.');
}
function assertResumeProject(manifest) {
  assert.equal(manifest.name, 'DSH 官方 Web · 隔离验收');
  assert.deepEqual(manifest.tables, []); assert.deepEqual(manifest.files, []);
  const state = manifest.state;
  assert.deepEqual(state.appSpec.dataSources, []); assert.deepEqual(state.dataProduct.notebooks, {});
  for (const field of ['changeHistory', 'appliedChangeSetIds', 'auditRecords', 'queryRecords']) assert.deepEqual(state[field], []);
  const turns = state.assistantSessions.items.flatMap(item => item.turns);
  assert.equal(turns.length, 1); assert.equal(state.harnessTasks.length, 1);
  const active = activeOf(state), task = sourceReport.tasks[0];
  assert.match(active.id, /^dshconversation_/u); assert.equal(active.contextId, active.id);
  assert.equal(active.pageId, sourceReport.project.pageId); assert.equal(active.turns.length, 1);
  assert.equal(active.turns[0].taskId, task.id); assert.equal(active.turns[0].state, 'success');
  assert.equal(active.turns[0].instruction, instructions[0]); assert.equal(active.turns[0].response, task.resultMessage);
  assert.equal(state.harnessTasks[0].id, task.id); assert.equal(state.harnessTasks[0].state, 'completed');
  assert.equal(state.harnessTasks[0].resultMessage, task.resultMessage);
}
async function validateResumeSource() {
  await plainPath(sourceDirectory, 'directory');
  for (const file of ['report.json', 'round-1-receipt.json', 'project/agentcanvas.project.json']) await plainPath(join(sourceDirectory, file), 'file');
  sourceReport = JSON.parse(await readFile(join(sourceDirectory, 'report.json'), 'utf8'));
  assert.equal(sourceReport.base, base); assert.equal(sourceReport.offline, false); assert.equal(sourceReport.passed, false);
  assert.equal(sourceReport.paidTasks, 1); assert.equal(sourceReport.conversationRequests, 1);
  assert.equal(sourceReport.tasks.length, 1); assert.deepEqual(sourceReport.clearRequests, []); assert.deepEqual(sourceReport.negativeFixtures, []);
  for (const field of ['pageErrors', 'routeErrors', 'resourceFailures']) assert.deepEqual(sourceReport[field], []);
  assert.equal(sourceReport.failure?.message, 'Official rendered history is missing expected text.');
  assert.equal(resolve(sourceReport.project.path), projectPath); assert.match(sourceReport.project.handle, /^[a-f\d-]{36}$/iu);
  const task = sourceReport.tasks[0];
  assert.equal(task.instruction, instructions[0]); assert.equal(task.state, 'completed'); assert.equal(task.nativeConversation, 'new');
  assert.equal(task.counters.toolCallCount, 0); assert.equal(task.counters.modelCallCount, 1);
  assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
  assert.match(task.idempotencyKey, /^dshconversation_request_/u); assert.equal(task.id, `harness_${task.idempotencyKey}`);
  assert.deepEqual(taskFromReceipt(JSON.parse(await readFile(join(sourceDirectory, 'round-1-receipt.json'), 'utf8'))), task);
  sourceManifest = JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8'));
  assertResumeProject(sourceManifest);
  for (const folder of ['files', 'tables']) {
    await plainPath(join(projectPath, folder), 'directory'); assert.deepEqual(await readdir(join(projectPath, folder)), []);
  }
  assert.equal(existsSync(join(sourceDirectory, 'resume-paid.claim.json')), false, 'This source already attempted its one permitted paid continuation. Do not resend.');
  report.reusedPaidTasks = 1; report.tasks.push(structuredClone(task));
  report.sourceEvidence = { directory: resumeSource, report: `${resumeSource}/report.json`, reusedTaskId: task.id };
}
async function poll(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(150); }
  throw new Error(message);
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
  }, 'Owned project save did not settle.');
  if (dashboard) assert.deepEqual(state.appSpec, dashboard);
  if (notebooks) assert.deepEqual(state.dataProduct.notebooks, notebooks);
  return state;
}
async function menu(label) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill(label);
  await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function readyComposer() {
  await frame().locator('[data-agentcanvas-dsh-native-web="true"]').waitFor();
  await composer().waitFor();
  await poll(async () => await composer().getAttribute('contenteditable') === 'true', 'Official composer did not become editable.');
}
async function readyOfficial() {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await readyComposer();
}
async function officialText(expected = []) {
  let text = '';
  await poll(async () => {
    text = await frame().locator('body').innerText();
    return expected.every(value => renderedText(text).includes(renderedText(value)));
  }, 'Official rendered history is missing expected text.');
  return text;
}
async function shot(name, scenario, { expectUnavailable = false } = {}) {
  await page.mouse.move(1, 1);
  const outerFits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  assert.ok(outerFits, 'Website horizontal overflow.');
  const official = new URL(page.url()).pathname === '/dsh/web';
  const layout = official ? await frame().locator('body').evaluate(() => {
    const input = document.querySelector('[data-composer-input]'), bounds = input?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      composerVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1) };
  }) : { overflow: false };
  assert.equal(layout.overflow, false, 'Official iframe horizontal overflow.');
  if (official && !expectUnavailable) assert.equal(layout.composerVisible, true, 'Official input is outside the iframe viewport.');
  if (expectUnavailable) {
    assert.equal(layout.composerVisible, false, 'Unavailable document must not display a working composer.');
    assert.equal(await page.locator('.dsh-web-load-error').isVisible(), true);
    layout.expectedUnavailable = true;
  }
  const file = `${name}.png`;
  await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, page: new URL(page.url()).pathname, scenario, viewport: page.viewportSize(), layout, actualImageReviewed: false });
}
function fixture(body, round) {
  const now = new Date().toISOString(), resultMessage = round === 1
    ? '合成成功回执：我是通过 DeepSeek Harness 接入的助手。已记住本次合成测试代号晨星42。' : '晨星42';
  const task = { id: `harness_${body.idempotencyKey}`, idempotencyKey: body.idempotencyKey, instruction: body.instruction,
    pageId: body.pageId, role: 'editor', state: 'completed', createdAt: now, updatedAt: now,
    counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [], resultMessage };
  const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: task.state, message: resultMessage };
  return `event: completed\ndata: ${JSON.stringify({ event, task })}\n\n`;
}
function taskFromReceipt(receipt) {
  assert.equal(receipt.error, undefined); assert.equal(receipt.status, 200);
  const frames = receipt.body.split(/\r?\n\r?\n/u).flatMap(value => {
    const data = value.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  const task = frames.findLast(value => value.event?.type === 'completed')?.task;
  assert.ok(task, 'No completed task in captured SSE. Do not automatically resend.');
  return task;
}
async function sendEnter(text) {
  await composer().fill(text);
  await composer().press('Enter'); // Real official composer keyboard path, not a direct API request.
}
async function openTransition() {
  await page.getByRole('button', { name: '返回过渡入口', exact: true }).click();
  await page.waitForURL(`${base}/dsh`);
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
}
async function openOfficial() {
  await page.getByRole('button', { name: '试用官方对话界面', exact: true }).click();
  await page.waitForURL(`${base}/dsh/web`); await readyOfficial();
}

try {
  if (resumeMode) await validateResumeSource();
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
      if (project) assert.equal(project, handle, 'Foreign project access is forbidden.');
      if (request.method() === 'GET') {
        if (url.pathname === '/api/ai/dsh/web/document' && documentFailureArmed) {
          assert.equal(++documentFailureCount, 1, 'Failed official document must not retry automatically.');
          expectedFailedRequests.add(request);
          return route.fulfill({ status: 503, contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>隔离加载失败演示：官方 DSH 界面资源暂不可用，未发送模型请求。</body></html>' });
        }
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (['/api/projects', '/api/datasets'].includes(url.pathname)) {
          if (!project) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
          assert.ok(handle); return route.continue();
        }
        if (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python') return route.continue();
        throw new Error(`Unexpected API read: ${url.pathname}`);
      }
      if (url.pathname === '/api/projects') {
        const body = request.postDataJSON(); assert.equal(request.method(), 'POST');
        if (body.action === 'create') {
          assert.equal(resumeMode, false, 'Resume must never create a different project.');
          assert.equal(++created, 1); assert.equal(body.path, projectPath);
          const response = await route.fetch(); assert.equal(response.status(), 200);
          handle = (await response.json()).handle; assert.ok(handle);
          return route.fulfill({ response });
        }
        if (body.action === 'open') {
          assert.equal(resumeMode, true); assert.equal(++opened, 1); assert.equal(body.path, projectPath);
          await plainPath(join(projectPath, 'agentcanvas.project.json'), 'file');
          assertResumeProject(JSON.parse(await readFile(join(projectPath, 'agentcanvas.project.json'), 'utf8')));
          const response = await route.fetch(); assert.equal(response.status(), 200);
          const session = await response.json(); assert.equal(resolve(session.path), projectPath);
          assert.equal(session.handle, sourceReport.project.handle, 'Resume must retain the original server namespace.');
          assertResumeProject(session.manifest); handle = session.handle;
          return route.fulfill({ response });
        }
        assert.equal(body.action, 'save'); assert.ok(handle); assert.equal(project, handle);
        if (dashboard) assert.deepEqual(body.state.appSpec, dashboard);
        if (notebooks) assert.deepEqual(body.state.dataProduct.notebooks, notebooks);
        return route.continue();
      }
      assert.ok(handle && project === handle, 'Only the owned project may be mutated.');
      if (url.pathname === '/api/ai/dsh/conversation/stream') {
        assert.equal(request.method(), 'POST'); assert.ok(!negativeKind, 'Negative fixtures must never reach the network.');
        const round = ++report.conversationRequests + report.reusedPaidTasks;
        assert.ok(round <= 2, 'Only two paid or offline success rounds are permitted; no retries.');
        const body = request.postDataJSON(); assert.equal(body.pageId, pageId); assert.equal(body.instruction, instructions[round - 1]);
        assert.match(body.conversation_id, /^dshconversation_/u); assert.deepEqual(body.appSpec.dataSources, []); assert.deepEqual(body.recipes, []);
        assert.ok(!body.dataSourceId && !body.rawWorkbookManifest && !body.imageAttachmentManifest && !body.mcpTools);
        if (resumeMode) assert.equal(body.conversation_id, activeOf(sourceManifest.state).contextId);
        if (round === 2) assert.equal(body.conversationContext?.recentMessages?.[0]?.instruction, instructions[0]);
        if (offline) return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: fixture(body, round) });
        if (resumeMode) {
          assert.equal(round, 2); assert.equal(report.newPaidTasks, 0);
          // A second invocation cannot resend an uncertain/failed continuation.
          // The marker is deliberately never auto-removed, including on failure.
          await plainPath(sourceDirectory, 'directory');
          const claim = await open(join(sourceDirectory, 'resume-paid.claim.json'), 'wx');
          try { await claim.writeFile(JSON.stringify({ sourceTaskId: sourceReport.tasks[0].id,
            evidence: relative(process.cwd(), directory).replaceAll('\\', '/'), claimedAt: new Date().toISOString() }, null, 2)); }
          finally { await claim.close(); }
        }
        report.paidTasks++; report.newPaidTasks++; return route.continue();
      }
      if (url.pathname === '/api/ai/dsh/conversation/clear') {
        assert.equal(request.method(), 'DELETE'); assert.equal(report.clearRequests.length, 0);
        const body = request.postDataJSON(); assert.deepEqual(body, { pageId, conversation_id: expectedClearContext });
        report.clearRequests.push({ endpoint: url.pathname, ...body }); return route.continue();
      }
      throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`);
    } catch (error) { report.routeErrors.push(error.message); return route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.addInitScript(({ endpoint, failureMessage }) => {
    // The official iframe never calls the provider; only the parent fetch is intercepted.
    if (window !== window.top) return;
    const original = window.fetch.bind(window);
    window.__dshWebNegative = null; window.__dshWebReceipts = []; window.__dshWebFixtureCalls = [];
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== endpoint) return original(input, init);
      const kind = window.__dshWebNegative;
      if (!kind) {
        const response = await original(input, init);
        void response.clone().text().then(body => window.__dshWebReceipts.push({ status: response.status, body }),
          error => window.__dshWebReceipts.push({ error: error.message }));
        return response;
      }
      window.__dshWebNegative = null;
      const request = JSON.parse(init.body);
      window.__dshWebFixtureCalls.push({ kind, instruction: request.instruction, project: new Headers(init.headers).get('x-agentcanvas-project'),
        pageId: request.pageId, conversationId: request.conversation_id, dataSourceCount: request.appSpec.dataSources.length });
      if (kind === 'cancel') return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled synthetic transport', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      const now = new Date().toISOString(), task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
        instruction: request.instruction, pageId: request.pageId, role: 'editor', state: 'failed', createdAt: now, updatedAt: now,
        counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [], resultMessage: failureMessage,
        error: '合成失败回执', terminationCode: 'verificationFailed' };
      const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: 'failed', message: failureMessage };
      return new Response(`event: completed\ndata: ${JSON.stringify({ event, task })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { endpoint: '/api/ai/dsh/conversation/stream', failureMessage });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400 || new URL(response.url()).origin !== base) return;
    const failure = { path: new URL(response.url()).pathname, status: response.status() };
    if (expectedFailedRequests.has(response.request()) && failure.path === '/api/ai/dsh/web/document' && failure.status === 503) {
      report.expectedResourceFailures.push({ ...failure, fixture: 'official-document-unavailable' });
    } else report.resourceFailures.push(failure);
  });
  engineBefore = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineBefore.activeTasks, 0);
  report.engineBefore = { engine: engineBefore.engine, revision: engineBefore.revision, activeTasks: engineBefore.activeTasks };
  if (!offline) {
    assert.equal(engineBefore.dsh.available, true);
    const settings = await (await context.request.get(`${base}/api/settings/ai`)).json(); assert.equal(settings.configured, true);
    if (resumeMode) { assert.equal(settings.model, sourceReport.model); assert.equal(engineBefore.dsh.version, sourceReport.sdkVersion); }
    report.model = settings.model; report.sdkVersion = engineBefore.dsh.version;
  } else report.model = 'browser-sse-fixture';
  await page.goto(`${base}/dsh/web`, { waitUntil: 'networkidle' });
  await menu('数据浏览器');
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  if (!resumeMode) await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 官方 Web · 隔离验收');
  await dialog.getByRole('button', { name: resumeMode ? '打开已有项目' : '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const prepared = await snapshot(); pageId = activeOf(prepared).pageId;
  assert.equal(prepared.appSpec.dataSources.length, 0); assert.ok(pageId);
  dashboard = structuredClone(prepared.appSpec); notebooks = structuredClone(prepared.dataProduct.notebooks);
  if (resumeMode) {
    assert.equal(created, 0); assert.equal(opened, 1); assert.equal(pageId, sourceReport.project.pageId);
    assert.deepEqual(activeOf(prepared).turns, activeOf(sourceManifest.state).turns);
  }
  report.project = { path: projectPath, handle, pageId };
  await readyOfficial();
  if (resumeMode) {
    await officialText([instructions[0], sourceReport.tasks[0].resultMessage]);
    await shot('01-official-resumed-first-round-1440', 'Validated prior paid first round rendered after UI opens the original owned project; no repeated first request.');
    report.checks.push('The original paid first round is reused verbatim from its SSE/task and persisted turn, not regenerated; rendered Markdown comparison normalizes paired strong markers and whitespace only.');
  } else await shot('01-official-empty-1440', 'Actual official frontend composer embedded in the website, empty synthetic project.');

  await composer().fill('第一行：合成输入'); await composer().press('End'); await composer().press('Shift+Enter'); await composer().press('b');
  assert.equal(await composer().innerText(), '第一行：合成输入\nb'); assert.equal(report.conversationRequests, 0);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('02-shift-enter-1024', 'Official Shift+Enter inserts a newline without sending; composer fits at 1024 px.');
  await composer().fill(''); await page.setViewportSize({ width: 1440, height: 1100 });
  report.checks.push('Official composer Shift+Enter creates a real newline and causes no request.');
  for (const [index, instruction] of instructions.entries()) {
    if (resumeMode && index === 0) continue;
    if (index === 1) {
      await page.reload({ waitUntil: 'networkidle' }); await readyOfficial(); await officialText([instructions[0]]);
      await snapshot(state => activeOf(state)?.turns.length === 1);
    }
    const before = await page.evaluate(() => window.__dshWebReceipts.length);
    await sendEnter(instruction);
    await page.waitForFunction(count => window.__dshWebReceipts.length > count, before, { timeout: 190_000 });
    const receipt = await page.evaluate(index => window.__dshWebReceipts[index], before);
    await writeFile(join(directory, `round-${index + 1}-receipt.json`), JSON.stringify(receipt, null, 2));
    const task = taskFromReceipt(receipt); report.tasks.push(task);
    assert.equal(task.state, 'completed', 'Conversation did not complete; automatic retries are forbidden.');
    assert.equal(task.counters.toolCallCount, 0); assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
    if (index === 1) assert.match(task.resultMessage, /晨星42/u);
    if (resumeMode) assert.equal(task.nativeConversation, 'resumed', 'The continuation must resume the original accepted native session.');
    if (!offline && task.nativeConversation) assert.equal(task.nativeConversation, index === 0 ? 'new' : 'resumed');
    const resultState = await snapshot(state => activeOf(state)?.turns.length === index + 1);
    const resultTurn = activeOf(resultState).turns[index];
    assert.equal(resultTurn.taskId, task.id); assert.equal(resultTurn.instruction, task.instruction);
    assert.equal(resultTurn.response, task.resultMessage, 'Persisted turn must preserve the exact original model Markdown.');
    await officialText([...instructions.slice(0, index + 1), task.resultMessage]);
    await readyOfficial(); assert.equal(report.conversationRequests + report.reusedPaidTasks, index + 1);
    await shot(`03-round-${index + 1}-1440`, `Official Enter sends exactly once; ${offline ? 'synthetic' : 'real provider'} completed round ${index + 1}.`);
  }
  const completed = await snapshot(), savedDsh = structuredClone(activeOf(completed));
  report.checks.push(resumeMode
    ? 'Across source evidence and this continuation, both rounds completed with zero tools and no draft; only the second Enter request was sent here, and it resumed the native session and remembered the code.'
    : 'Two Enter submissions each complete once with zero tools and no draft; second answer remembers the synthetic code.');
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.reload({ waitUntil: 'networkidle' }); await readyOfficial(); await officialText(instructions);
  const reloaded = await snapshot(); assert.deepEqual(activeOf(reloaded).turns, savedDsh.turns);
  await shot('04-reloaded-1024', 'Two saved turns survive refresh and render in official UI at 1024 px.');
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const assistantToggle = page.getByRole('button', { name: 'AI 助手', exact: true });
  if (await assistantToggle.getAttribute('aria-expanded') === 'false') await assistantToggle.click();
  await readyComposer(); await officialText(instructions);
  assert.equal(activeOf(await snapshot()).id, savedDsh.id);
  assert.equal(report.conversationRequests + report.reusedPaidTasks, 2);
  await shot('04b-notebook-sidebar-1024', 'Same official composer and history in the Notebook sidebar at 1024 px; no Notebook cell executed.');
  await readyOfficial();
  report.checks.push('Notebook sidebar renders the same official conversation at 1024 px without execution or definition changes.');
  await openTransition();
  const log = page.getByRole('log', { name: 'AI 对话上下文', exact: true });
  await poll(async () => await log.locator('.conversation-turn').count() === 2, 'Transition entrance did not restore two shared turns.');
  for (const instruction of instructions) assert.ok((await log.innerText()).includes(instruction));
  assert.equal(activeOf(await snapshot()).id, savedDsh.id);
  await shot('05-shared-transition-1024', 'The existing /dsh entrance renders exactly the same saved conversation, not a second history.');
  await openOfficial(); await officialText(instructions);
  assert.equal(activeOf(await snapshot()).id, savedDsh.id);
  report.checks.push('Reload and same-tab /dsh ↔ /dsh/web navigation preserve the same session id and turns without any extra request.');

  negativeKind = 'failure'; await page.evaluate(() => { window.__dshWebNegative = 'failure'; });
  await sendEnter(failureInstruction); await snapshot(state => activeOf(state)?.turns.at(-1)?.state === 'failed');
  await officialText([failureMessage]); await readyOfficial();
  await shot('06-failure-fixture-1024', 'Explicit failed SSE fixture renders in the official conversation. No provider request.');
  await page.setViewportSize({ width: 1440, height: 1100 });
  negativeKind = 'cancel'; await page.evaluate(() => { window.__dshWebNegative = 'cancel'; });
  await sendEnter(cancelInstruction);
  await frame().getByRole('button', { name: /^(停止生成|Stop generating)$/u }).first().click();
  await snapshot(state => activeOf(state)?.turns.at(-1)?.state === 'cancelled');
  await officialText([cancelInstruction]); await readyOfficial();
  await shot('07-cancel-fixture-1440', 'Official stop button cancels an explicitly held browser fixture; provider cancellation is not claimed.');
  const negativeCalls = await page.evaluate(() => window.__dshWebFixtureCalls);
  assert.equal(negativeCalls.length, 2);
  for (const [index, call] of negativeCalls.entries()) {
    assert.equal(call.kind, ['failure', 'cancel'][index]); assert.equal(call.project, handle); assert.equal(call.pageId, pageId);
    assert.equal(call.instruction, [failureInstruction, cancelInstruction][index]); assert.equal(call.dataSourceCount, 0);
    report.negativeFixtures.push(call);
  }
  report.checks.push('Failure and cancel use browser-only fixtures; formal Notebook and AppSpec remain unchanged.');

  expectedClearContext = activeOf(await snapshot()).contextId;
  await menu('清除上下文');
  const cleared = await snapshot(state => activeOf(state)?.id === savedDsh.id && activeOf(state).turns.length === 0);
  assert.equal(report.clearRequests.length, 1); assert.notEqual(activeOf(cleared).contextId, expectedClearContext);
  assert.match(activeOf(cleared).contextId, /^dshconversation_/u);
  await readyOfficial();
  await poll(async () => !(await frame().locator('body').innerText()).includes('晨星42'), 'Official UI still shows cleared history.');
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('08-cleared-official-1024', 'Dedicated DSH clear rotates only the context; official UI no longer displays the old history.');
  await openTransition();
  await poll(async () => await page.locator('.conversation-turn').count() === 0, 'Shared transition history was not cleared.');
  await shot('09-cleared-transition-1024', 'Shared /dsh history is also empty after clearing from the official UI shell.');
  await openOfficial(); await readyOfficial();
  const beforeLoadFailure = await snapshot();
  assert.equal(activeOf(beforeLoadFailure).turns.length, 0);
  report.checks.push('A single dedicated clear rotates the context and empties both official and transition displays.');
  const conversationBeforeFailure = structuredClone(activeOf(beforeLoadFailure));
  const requestsBeforeFailure = report.conversationRequests, paidBeforeFailure = report.paidTasks;
  documentFailureArmed = true;
  const loadFailureStarted = Date.now();
  await page.reload({ waitUntil: 'networkidle' });
  const loadError = page.locator('.dsh-web-load-error');
  await loadError.waitFor({ state: 'visible', timeout: 45_000 });
  const waitedMs = Date.now() - loadFailureStarted;
  assert.ok(waitedMs >= 29_000, 'Load failure must wait for the real 30-second UI timer; do not replace timers.');
  assert.match(await loadError.innerText(), /官方对话界面未完成加载.*不会自动发送请求/u);
  assert.equal(documentFailureCount, 1);
  assert.equal(report.conversationRequests, requestsBeforeFailure); assert.equal(report.paidTasks, paidBeforeFailure);
  assert.deepEqual(activeOf(await snapshot()), conversationBeforeFailure);
  await shot('10-official-document-unavailable-1024', 'Exactly one controlled document 503; the real 30-second timeout displays manual reload and sends no chat request.', { expectUnavailable: true });
  documentFailureArmed = false;
  await loadError.getByRole('button', { name: '重载界面', exact: true }).click();
  await readyComposer(); await loadError.waitFor({ state: 'hidden' });
  await shot('11-official-document-recovered-1024', 'After lifting the controlled 503, the user reload button restores official composer without resending any task.');
  const finalState = await snapshot();
  assert.deepEqual(activeOf(finalState), conversationBeforeFailure);
  assert.equal(report.conversationRequests, requestsBeforeFailure); assert.equal(report.paidTasks, paidBeforeFailure);
  report.loadRecovery = { waitedMs, documentFailures: documentFailureCount, manualReload: true, resentTasks: 0 };
  report.checks.push('One explicitly expected document 503 triggers the real load timeout; manual reload recovers the UI without retries, paid calls or changes to cleared history.');
  assert.deepEqual(report.expectedResourceFailures, [{ path: '/api/ai/dsh/web/document', status: 503, fixture: 'official-document-unavailable' }]);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.resourceFailures, []);
  assert.equal(report.conversationRequests + report.reusedPaidTasks, 2);
  assert.equal(report.paidTasks, offline ? 0 : resumeMode ? 1 : 2);
  assert.equal(report.newPaidTasks, report.paidTasks);
  report.totalPaidTasks = report.reusedPaidTasks + report.newPaidTasks;
  report.totalConversationRounds = report.tasks.length;
  const engineAfter = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineAfter.engine, engineBefore.engine); assert.equal(engineAfter.revision, engineBefore.revision); assert.equal(engineAfter.activeTasks, 0);
  report.engineAfter = { engine: engineAfter.engine, revision: engineAfter.revision, activeTasks: engineAfter.activeTasks };
  await writeFile(join(directory, 'final-synthetic-state.json'), JSON.stringify(finalState, null, 2));
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  if (page) {
    await page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
    await writeFile(join(directory, 'failure-dom.json'), JSON.stringify(await Promise.all(page.frames().map(async item => ({
      page: new URL(item.url()).pathname, text: await item.locator('body').innerText().catch(() => ''),
    }))), null, 2)).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  console.log(JSON.stringify({ passed: report.passed, paidTasks: report.paidTasks, reusedPaidTasks: report.reusedPaidTasks, newPaidTasks: report.newPaidTasks,
    report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), failure: report.failure?.message }));
}
