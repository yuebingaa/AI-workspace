// Two explicit paid conversation rounds, or fixed-driver engine replay; owned empty project only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const offline = process.argv[2] === '--offline';
const native = process.argv[2] === '--confirm-paid-native';
assert.ok(process.argv.length === 3 && (offline || native || process.argv[2] === '--confirm-paid-model'), 'Choose --offline, --confirm-paid-model or --confirm-paid-native.');
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve(native ? '.runtime/dsh-native-conversation-20260926' : '.runtime/dsh-conversation-20260926', `browser-${Date.now()}`), projectPath = join(directory, 'project');
const instructions = ['你是ds吗？先不要分析数据。记住本次合成测试代号晨星42。', '刚才让你记住的测试代号是什么？只回复代号，不分析数据。'];
const report = { passed: false, base, offline, native, checks: [], screenshots: [], pageErrors: [], routeErrors: [], resourceFailures: [], paidTasks: 0,
  conversationRequests: 0, clearRequests: [], tasks: [], fixtureEvidence: [], negativeFixtures: [],
  boundaries: [offline ? 'Offline fixed driver, actual conversation-mode engine/context/SSE, browser transport replay; no paid model.' : 'At most two explicitly authorized paid rounds, no automatic retry or configuration changes.',
    'New empty synthetic project only; no user data, file import, Notebook execution or production definition edits.',
    'Failure and cancellation use explicit browser-only transport fixtures and do not call any model.',
    offline ? 'Does not verify the official SDK, public AI handler, provider quality or server conversation memory.' : 'Success requests use the real independent HTTP endpoint, official SDK and configured provider.'] };
await mkdir(directory, { recursive: true });
let fixtureServer, fixture, browser, context, page;
const environment = process.env, originalFetch = globalThis.fetch;
let handle, created = 0, pageId, dashboard, notebooks, engineBefore, expectedClearContext, negativeKind;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(150); }
  throw new Error(message);
}
const sessionsOf = state => state.assistantSessions;
const dshItems = state => sessionsOf(state).items.filter(item => item.id.startsWith('dshconversation_'));
const classicItems = state => sessionsOf(state).items.filter(item => !item.id.startsWith('dshconversation_'));
const activeOf = state => sessionsOf(state).items.find(item => item.id === sessionsOf(state).activeId);
async function snapshot(predicate = () => true) {
  let state;
  await poll(async () => {
    assert.ok(handle);
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200); const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    state = value.manifest.state;
    return state && predicate(state) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent());
  }, 'Owned project save did not settle.');
  if (dashboard) assert.deepEqual(state.appSpec, dashboard);
  if (notebooks) assert.deepEqual(state.dataProduct.notebooks, notebooks);
  return state;
}
async function shot(name, scenario, target = page) {
  await target.mouse.move(1, 1);
  assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Unexpected horizontal overflow.');
  const file = `${name}.png`; await target.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, page: new URL(target.url()).pathname, scenario, viewport: target.viewportSize(), actualImageReviewed: false });
}
async function menu(label) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  if (typeof label === 'string') await navigation.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill(label);
  await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function send(instruction) {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
}
async function visibleTurns(count, expected = []) {
  const log = page.getByRole('log', { name: 'AI 对话上下文', exact: true });
  await poll(async () => await log.locator('.conversation-turn').count() === count, `Expected ${count} visible turns.`);
  const text = await log.textContent();
  for (const instruction of expected) assert.ok(text.includes(instruction), `Missing visible instruction: ${instruction}`);
  return text;
}
async function openClassic() {
  await page.getByRole('button', { name: '返回原工作台 →', exact: true }).click();
  await page.waitForURL(`${base}/`); await page.getByRole('textbox', { name: 'AI 指令', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
}
async function openDsh() {
  await menu(/^DSH 对话 · 预览版/u); await page.waitForURL(`${base}/dsh`);
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
}
function taskFromReceipt(receipt) {
  assert.equal(receipt.error, undefined); assert.equal(receipt.status, 200);
  const frames = receipt.body.split(/\r?\n\r?\n/u).flatMap(frame => {
    const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  const task = frames.findLast(frame => frame.event?.type === 'completed')?.task;
  assert.ok(task, 'No completed task in captured SSE; do not resend.'); return task;
}

try {
  if (offline) {
    const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'localappdata']);
    process.env = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toLowerCase())));
    process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'fixture-state');
    globalThis.fetch = async () => { throw new Error('Network prohibited inside offline DSH fixture.'); };
    fixtureServer = await createServer({ root: process.cwd(), configFile: false, envFile: false, logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
      resolve: { alias: { '@': process.cwd() } }, server: { middlewareMode: true, hmr: false, watch: null } });
    fixture = (await fixtureServer.ssrLoadModule('/scripts/dsh-conversation-fixture.ts')).createConversationFixture;
  }
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
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
          handle = (await response.json()).handle; return route.fulfill({ response });
        }
        assert.equal(body.action, 'save'); assert.equal(request.headers()[header], handle);
        if (dashboard) assert.deepEqual(body.state.appSpec, dashboard);
        if (notebooks) assert.deepEqual(body.state.dataProduct.notebooks, notebooks);
        return route.continue();
      }
      assert.ok(handle && request.headers()[header] === handle, 'Only the owned project may be mutated.');
      if (url.pathname === '/api/ai/dsh/conversation/stream') {
        assert.equal(request.method(), 'POST'); assert.ok(!negativeKind, 'Negative UI fixtures must never reach network.');
        const round = ++report.conversationRequests; assert.ok(round <= 2, 'Only two conversation rounds are authorized; no automatic retry.');
        const body = request.postDataJSON(); assert.equal(body.pageId, pageId); assert.equal(body.instruction, instructions[round - 1]);
        assert.match(body.conversation_id, /^dshconversation_/u); assert.deepEqual(body.appSpec.dataSources, []); assert.deepEqual(body.recipes, []);
        assert.ok(!body.dataSourceId && !body.rawWorkbookManifest && !body.imageAttachmentManifest && !body.mcpTools);
        if (round === 2) assert.equal(body.conversationContext?.recentMessages?.[0]?.instruction, instructions[0]);
        if (offline) {
          const result = await fixture(body, round); report.fixtureEvidence.push(result.evidence);
          await writeFile(join(directory, `round-${round}-fixture-task.json`), JSON.stringify(result.task, null, 2));
          return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: result.body });
        }
        report.paidTasks++; return route.continue();
      }
      if (url.pathname === '/api/ai/dsh/conversation/clear') {
        assert.equal(request.method(), 'DELETE'); assert.equal(report.clearRequests.length, 0);
        const body = request.postDataJSON(); assert.deepEqual(body, { pageId, conversation_id: expectedClearContext });
        report.clearRequests.push({ endpoint: url.pathname, ...body }); return route.continue();
      }
      throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`);
    } catch (error) { report.routeErrors.push(error.message); return route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.addInitScript(() => {
    const native = window.fetch.bind(window);
    window.__dshConversationNegative = null; window.__dshConversationReceipts = [];
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/api/ai/dsh/conversation/stream') return native(input, init);
      const kind = window.__dshConversationNegative;
      if (!kind) {
        const response = await native(input, init);
        void response.clone().text().then(body => window.__dshConversationReceipts.push({ status: response.status, body }),
          error => window.__dshConversationReceipts.push({ error: error.message }));
        return response;
      }
      window.__dshConversationNegative = null;
      const request = JSON.parse(init.body);
      if (kind === 'cancel') return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled synthetic transport', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      const now = new Date().toISOString(), task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
        instruction: request.instruction, pageId: request.pageId, role: 'editor', state: 'failed', createdAt: now, updatedAt: now,
        counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [],
        resultMessage: '隔离失败演示：DSH 本轮未成功完成；没有读取数据或修改正式文档。', error: '合成失败回执', terminationCode: 'verificationFailed' };
      const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: 'failed', message: task.resultMessage };
      return new Response(`event: completed\ndata: ${JSON.stringify({ event, task })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(25_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).origin === base) report.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  engineBefore = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineBefore.activeTasks, 0);
  report.engineBefore = { engine: engineBefore.engine, revision: engineBefore.revision, activeTasks: engineBefore.activeTasks };
  if (!offline) {
    assert.equal(engineBefore.dsh.available, true);
    const settings = await (await context.request.get(`${base}/api/settings/ai`)).json(); assert.equal(settings.configured, true);
    report.model = settings.model; report.sdkVersion = engineBefore.dsh.version;
  } else report.model = 'offline-fixed-driver';
  await page.goto(`${base}/dsh`, { waitUntil: 'networkidle' });
  await menu('数据浏览器');
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 独立对话 · 两轮合成验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const prepared = await snapshot(); pageId = activeOf(prepared).pageId;
  assert.equal(prepared.appSpec.dataSources.length, 0); assert.ok(pageId);
  dashboard = structuredClone(prepared.appSpec); notebooks = structuredClone(prepared.dataProduct.notebooks);
  report.project = { path: projectPath, handle, pageId };
  for (const [index, instruction] of instructions.entries()) {
    if (native && index === 1) {
      await page.reload({ waitUntil: 'networkidle' }); await visibleTurns(1, [instructions[0]]);
      await snapshot(state => activeOf(state)?.turns.length === 1);
    }
    const previousReceipts = await page.evaluate(() => window.__dshConversationReceipts.length);
    await send(instruction);
    await page.waitForFunction(count => window.__dshConversationReceipts.length > count, previousReceipts, { timeout: 190_000 });
    const receipt = await page.evaluate(index => window.__dshConversationReceipts[index], previousReceipts);
    await writeFile(join(directory, `round-${index + 1}-receipt.json`), JSON.stringify(receipt, null, 2));
    const task = taskFromReceipt(receipt); report.tasks.push(task);
    await writeFile(join(directory, `round-${index + 1}-task.json`), JSON.stringify(task, null, 2));
    assert.equal(task.state, 'completed', 'Conversation did not complete; no automatic retry is permitted.');
    assert.equal(task.counters.toolCallCount, 0); assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
    if (index === 1) assert.match(task.resultMessage, /晨星42/u);
    await visibleTurns(index + 1, instructions.slice(0, index + 1));
    await snapshot(state => activeOf(state)?.turns.length === index + 1);
    if (native) {
      assert.equal(task.nativeConversation, index === 0 ? 'new' : 'resumed');
      await page.locator('.harness-trace').last().locator('summary').first().click();
      await page.locator('.native-conversation-note').last().waitFor({ state: 'visible' });
      await shot(`native-${index + 1}-checkpoint`, index === 0 ? 'Real provider: accepted new SDK native session.' : 'Real provider: native session resumed in a new SDK child after browser reload; prior nonce remembered.');
      report.checks.push(`Native round ${index + 1}: ${task.nativeConversation}; browser history is not the model history source.`);
    }
  }
  const completed = await snapshot(state => activeOf(state)?.turns.length === 2), savedDsh = structuredClone(activeOf(completed));
  await shot('01-two-rounds-1440', 'Two completed DSH conversation rounds; no tool call or Notebook draft.');
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('02-two-rounds-1024', 'Same two-round conversation at 1024 px without horizontal overflow.');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload({ waitUntil: 'networkidle' }); await visibleTurns(2, instructions);
  const reloaded = await snapshot();
  assert.deepEqual(activeOf(reloaded).turns, savedDsh.turns);
  for (const task of report.tasks) assert.equal(reloaded.harnessTasks.find(item => item.id === task.id)?.state, 'completed', 'Plain DSH chat must remain completed after refresh.');
  await shot('03-reloaded-dsh', 'Saved DSH conversation restores two turns without another model request.');
  report.checks.push('Both rounds completed with zero tools and no draft; the second answer contains the remembered code. Saved turns survive reload.');

  await openClassic(); assert.ok(!(await visibleTurns(0)).includes('晨星42'));
  await send('你好'); const classicState = await snapshot(state => activeOf(state)?.turns.length === 1);
  const savedClassic = structuredClone(activeOf(classicState));
  assert.ok(!savedClassic.id.startsWith('dshconversation_')); assert.equal(savedClassic.turns[0].taskId, undefined);
  assert.deepEqual(dshItems(classicState).find(item => item.id === savedDsh.id).turns, savedDsh.turns);
  await visibleTurns(1, ['你好']);
  assert.ok(!(await page.getByRole('log', { name: 'AI 对话上下文', exact: true }).textContent()).includes('晨星42'));
  await shot('04-classic-isolated', 'Same-tab original entrance shows only its local hello; both DSH turns remain saved.');
  await openDsh(); await visibleTurns(2, instructions);
  assert.equal((await snapshot()).assistantSessions.activeId, savedDsh.id);
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await page.getByRole('menuitemradio').count(), 1);
  assert.ok((await page.getByRole('menu', { name: '当前界面的会话', exact: true }).textContent()).includes('DSH 对话'));
  await page.keyboard.press('Escape');
  await shot('05-dsh-restored-isolation', 'Returning through the menu restores only DSH history; its picker excludes the classic conversation.');
  report.checks.push('Same-tab entry navigation preserves both lists. Classic hello stays local; the DSH picker and visible history exclude it.');

  expectedClearContext = activeOf(await snapshot()).contextId;
  await menu('清除上下文'); await visibleTurns(0);
  const cleared = await snapshot(state => activeOf(state)?.id === savedDsh.id && activeOf(state).turns.length === 0);
  assert.equal(report.clearRequests.length, 1); assert.notEqual(activeOf(cleared).contextId, expectedClearContext);
  assert.match(activeOf(cleared).contextId, /^dshconversation_/u);
  assert.deepEqual(classicItems(cleared).find(item => item.id === savedClassic.id), savedClassic);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('06-dsh-cleared-1024', 'DSH clear uses its dedicated endpoint, rotates only its context, and preserves classic history.');
  await openClassic(); await visibleTurns(1, ['你好']);
  await shot('07-classic-survives-clear', 'Classic local hello remains visible after DSH context clearing.');
  await openDsh(); await visibleTurns(0);
  report.checks.push('Dedicated DSH clear succeeds; session identity stays, context rotates within DSH, and classic hello survives reopening.');

  negativeKind = 'failure'; report.negativeFixtures.push(negativeKind);
  await page.evaluate(() => { window.__dshConversationNegative = 'failure'; });
  await send('隔离失败演示，不调用真实模型。');
  await page.getByText('隔离失败演示：DSH 本轮未成功完成；没有读取数据或修改正式文档。', { exact: true }).first().waitFor();
  await snapshot(state => activeOf(state)?.turns.at(-1)?.state === 'failed');
  await shot('08-failure-fixture-1024', 'Explicit browser-only failed SSE receipt; no model call or successful draft.');
  await page.setViewportSize({ width: 1440, height: 1100 });
  negativeKind = 'cancel'; report.negativeFixtures.push(negativeKind);
  await page.evaluate(() => { window.__dshConversationNegative = 'cancel'; });
  await send('隔离取消演示，不调用真实模型。');
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  const finalState = await snapshot(state => activeOf(state)?.turns.at(-1)?.state === 'cancelled');
  await shot('09-cancelled-fixture-1440', 'Explicit held-transport cancellation fixture; browser abort ends the task without a model call.');
  assert.deepEqual(classicItems(finalState).find(item => item.id === savedClassic.id), savedClassic);
  report.checks.push('Explicit failure and cancellation UI fixtures preserve Notebook/AppSpec and classic history; provider cancellation is not claimed.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []);
  assert.equal(report.conversationRequests, 2); assert.equal(report.paidTasks, offline ? 0 : 2);
  const engineAfter = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineAfter.engine, engineBefore.engine); assert.equal(engineAfter.revision, engineBefore.revision); assert.equal(engineAfter.activeTasks, 0);
  report.engineAfter = { engine: engineAfter.engine, revision: engineAfter.revision, activeTasks: engineAfter.activeTasks };
  await writeFile(join(directory, 'final-synthetic-state.json'), JSON.stringify(finalState, null, 2));
  // Separate browser storage: a valid full classic snapshot must not be replaced
  // by the new entrance's initial empty DSH session when capacity is exhausted.
  const capacityContext = await browser.newContext({ viewport: { width: 1024, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  try {
    const capacityItems = Array.from({ length: 1050 }, (_, index) => ({
      id: `conversation_capacity_${index}`, contextId: `conversation_capacity_${index}`, title: `合成容量 ${index}`,
      createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z', draft: '', pageId, pageIds: [pageId], turns: [],
    }));
    const capacityState = { ...finalState, harnessTasks: [], assistantConversation: [],
      assistantSessions: { activeId: capacityItems[0].id, items: capacityItems, activeByPage: { [pageId]: capacityItems[0].id } } };
    const serialized = JSON.stringify(capacityState), capacityStorageKey = 'datacanvas-ai:studio:v1';
    await capacityContext.addInitScript(({ key, value }) => { window.localStorage.setItem(key, value); }, { key: capacityStorageKey, value: serialized });
    await capacityContext.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET' || request.headers()[header]) {
        report.routeErrors.push('Capacity-only fixture attempted a mutation or project access.'); return route.abort();
      }
      if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
      if (url.pathname === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
      if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
      return route.continue();
    });
    const capacityPage = await capacityContext.newPage();
    capacityPage.on('pageerror', error => report.pageErrors.push(error.message));
    capacityPage.on('response', response => { if (response.status() >= 400 && new URL(response.url()).origin === base) report.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    await capacityPage.goto(`${base}/dsh`, { waitUntil: 'networkidle' });
    await capacityPage.getByRole('heading', { name: '暂时无法打开对话入口', exact: true }).waitFor();
    assert.match(await capacityPage.getByRole('alert').textContent(), /项目会话容量已满/u);
    assert.equal(await capacityPage.evaluate(key => window.localStorage.getItem(key), capacityStorageKey), serialized);
    await shot('10-capacity-blocked-1024', 'Independent synthetic 1050-classic-session snapshot: DSH entry displays capacity error and storage remains byte-for-byte unchanged.', capacityPage);
    report.checks.push('A separate valid 1050-classic-session temporary snapshot blocks DSH entry clearly without overwriting browser storage or accessing a project.');
  } finally { await capacityContext.close(); }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.resourceFailures, []);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  await page?.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await fixtureServer?.close(); globalThis.fetch = originalFetch; process.env = environment;
  console.log(JSON.stringify({ passed: report.passed, paidTasks: report.paidTasks,
    report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), failure: report.failure?.message }));
}
