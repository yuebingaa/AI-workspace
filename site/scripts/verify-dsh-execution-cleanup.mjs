// Offline acceptance of actual official UI, persistence and cancellation. No model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const endpoint = '/api/ai/dsh/conversation/stream';
const directory = resolve('.runtime/dsh-execution-cleanup-20260928', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
const longAnswer = '# 完整回答验收（合成）\n\n' + Array.from({ length: 36 }, (_, i) =>
  `### 第 ${i + 1} 项：分析说明\n\n这是隔离测试文本，不是实际业务结论。用于检查超过原来 1000、1600、2000 字符后，表述仍完整保留，且网页刷新和项目保存不会丢失后半段。\n\n`).join('')
  + '**完整回答终点：晨星42，最后一段未被截断。**';
assert.ok(longAnswer.length > 3000);
const report = { passed: false, paidTasks: 0, screenshots: [], pageErrors: [], routeErrors: [], requests: [],
  boundary: 'Actual official UI and new local synthetic project; all AI replies are browser transport fixtures, not paid-model or server execution proof.' };
await mkdir(directory, { recursive: true });
let browser, context, page, handle, initial, creates = 0;
const frame = () => page.frameLocator('iframe[title="官方 DSH 聊天"]');
const composer = () => frame().locator('[data-composer-input="true"]');
const active = state => state.assistantSessions.items.find(item => item.id === state.assistantSessions.activeId);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(predicate, message) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(150); }
  throw new Error(message);
}
async function ready() {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await composer().waitFor();
  await poll(async () => await composer().getAttribute('contenteditable') === 'true', 'Composer not ready');
}
function preserve(state) {
  if (!initial) return;
  assert.deepEqual(state.appSpec, initial.appSpec);
  assert.deepEqual(state.dataProduct.notebooks, initial.dataProduct.notebooks);
}
async function snapshot(predicate = () => true) {
  let state;
  await poll(async () => {
    assert.ok(handle);
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200);
    const project = await response.json(); assert.equal(resolve(project.path), projectPath);
    state = project.manifest.state;
    return state && predicate(state);
  }, 'Synthetic project save did not settle');
  preserve(state); return state;
}
async function shot(file, scenario) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.ok(await frame().locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(directory, `${file}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${file}.png`, scenario, actualImageReviewed: false });
}
async function send(text) { await composer().fill(text); await composer().press('Enter'); }
async function showEnding() {
  const end = frame().getByText('完整回答终点：晨星42，最后一段未被截断。', { exact: true }).last();
  await end.waitFor(); await end.scrollIntoViewIfNeeded();
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      const project = request.headers()[header]; if (project) assert.equal(project, handle);
      if (request.method() === 'GET') {
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (['/api/projects', '/api/datasets'].includes(url.pathname)) {
          if (!project) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
          return route.continue();
        }
        if (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python') return route.continue();
      }
      if (url.pathname === '/api/projects' && request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.action === 'create') {
          assert.equal(++creates, 1); assert.equal(body.path, projectPath);
          const response = await route.fetch(); assert.equal(response.status(), 200);
          handle = (await response.json()).handle; assert.ok(handle); return route.fulfill({ response });
        }
        assert.equal(body.action, 'save'); assert.ok(handle); assert.equal(project, handle);
        preserve(body.state); return route.continue();
      }
      throw new Error(`Unexpected API operation: ${request.method()} ${url.pathname}`);
    } catch (error) { report.routeErrors.push(error.message); return route.abort(); }
  });
  await context.exposeBinding('__dshCleanupFixture', async (_source, { payload, project }) => {
    assert.ok(handle); assert.equal(project, handle); preserve({ appSpec: payload.appSpec, dataProduct: initial.dataProduct });
    const count = report.requests.length;
    report.requests.push({ instruction: payload.instruction, contextLengths: payload.conversationContext?.recentMessages?.map(turn => turn.response.length) });
    assert.ok(count < 4, 'Unexpected repeated request');
    assert.ok(payload.conversationContext?.recentMessages?.every(turn => turn.response.length <= 2000) ?? true);
    if (count === 2) return { held: true };
    const now = new Date().toISOString(), state = count === 3 ? 'failed' : 'completed';
    const resultMessage = count === 0 ? longAnswer : count === 1 ? '续聊成功：长回答保存后，下一轮仍可发送。' : '合成失败回执：执行失败仍明确显示，不冒充成功。';
    const task = { id: `harness_${payload.idempotencyKey}`, idempotencyKey: payload.idempotencyKey,
      instruction: payload.instruction, pageId: payload.pageId, role: 'editor', state, createdAt: now, updatedAt: now,
      counters: { modelCallCount: 0, toolCallCount: 0, loopCount: 0 }, events: [], resultMessage };
    const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'task_started', message: '合成任务开始', clientTimeoutMs: null };
    const final = { ...event, id: `${task.id}:2`, sequence: 2, type: 'completed', taskState: state, message: '合成任务结束' };
    return { body: `event: task_started\ndata: ${JSON.stringify({ event })}\n\nevent: completed\ndata: ${JSON.stringify({ event: final, task })}\n\n` };
  });
  await context.addInitScript(({ endpoint }) => {
    if (window !== window.top) return;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== endpoint) return original(input, init);
      const result = await window.__dshCleanupFixture({ payload: JSON.parse(init.body), project: new Headers(init.headers).get('x-agentcanvas-project') });
      if (result.held) return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Synthetic cancellation', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      return new Response(result.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }, { endpoint });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' }); await ready();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill('数据浏览器');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 约束清理 · 隔离验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  initial = await snapshot(); await ready();
  await send('合成长回答验收，不调用真实模型。');
  const saved = await snapshot(state => active(state)?.turns[0]?.response === longAnswer);
  assert.equal(saved.harnessTasks[0].resultMessage, longAnswer);
  await showEnding(); await shot('01-long-answer-ending', 'Official Markdown displays the end of a >3000 character response.');
  await page.reload({ waitUntil: 'networkidle' }); await ready();
  assert.equal(active(await snapshot()).turns[0].response, longAnswer);
  await showEnding(); await shot('02-reopened-ending', 'Reload restores exact full text from the synthetic project.');
  await send('合成续聊验收。');
  await snapshot(state => active(state)?.turns.length === 2); await ready();
  await frame().getByText('续聊成功：长回答保存后，下一轮仍可发送。', { exact: true }).waitFor();
  await shot('03-followup', 'The next request uses bounded context without cutting the stored full reply.');
  await send('合成取消验收。');
  await frame().getByRole('button', { name: /^(停止生成|Stop generating)$/u }).first().waitFor();
  await shot('04-cancellable', 'Official stop remains available for a held request.');
  await frame().getByRole('button', { name: /^(停止生成|Stop generating)$/u }).first().click();
  await snapshot(state => active(state)?.turns.at(-1)?.state === 'cancelled'); await ready();
  await shot('05-cancelled', 'Cancellation is persisted and does not mark the run as successful.');
  await send('合成失败验收。');
  await snapshot(state => active(state)?.turns.at(-1)?.state === 'failed'); await ready();
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  await shot('06-failed', 'Failures still display a failure state and retry control.');
  assert.equal(report.requests.length, 4); assert.equal(creates, 1);
  assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []);
  report.responseLength = longAnswer.length;
  report.passed = true;
} catch (error) {
  report.failure = error.message.replaceAll(process.cwd(), '<workspace>');
  await page?.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  console.log(JSON.stringify({ passed: report.passed, report: relative(process.cwd(), join(directory, 'report.json')), failure: report.failure }));
}
