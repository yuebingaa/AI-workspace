import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

// Real local-project persistence; only AI events are explicitly synthetic.
const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/interface-conversations-2026-09-23', `browser-${Date.now()}`);
const projectPath = join(directory, 'project'), header = 'x-agentcanvas-project';
await mkdir(directory, { recursive: true });
const report = { passed: false, screenshots: [], checks: [], pageErrors: [], routeErrors: [], requests: [], realModels: 0,
  boundaries: ['One owned synthetic local project, real create/save/read.', 'Synthetic SSE via real client parser, no real model or Notebook execution.', 'Separate temporary-browser fixture for legacy v6 migration; no user data.'] };
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
let handle, created = 0;
async function setup(temporary = false, seed) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      if (request.method() === 'GET') {
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (url.pathname === '/api/projects' && (temporary || !request.headers()[header])) return route.fulfill({ json: { projects: [] } });
        if (url.pathname === '/api/datasets' && !request.headers()[header]) return route.fulfill({ json: { datasets: [] } });
        if (request.headers()[header]) assert.equal(request.headers()[header], handle);
        return route.continue();
      }
      assert.equal(temporary, false); assert.equal(url.pathname, '/api/projects');
      const body = request.postDataJSON();
      if (body.action === 'create') {
        assert.equal(++created, 1); assert.equal(body.path, projectPath);
        const response = await route.fetch(); assert.equal(response.status(), 200);
        handle = (await response.json()).handle; return route.fulfill({ response });
      }
      assert.equal(body.action, 'save'); assert.equal(request.headers()[header], handle);
      assert.ok(body.state.appSpec.pages.length <= 3);
      return route.continue();
    } catch (error) { report.routeErrors.push(error.message); return route.abort(); }
  });
  await context.addInitScript(({ seed }) => {
    if (seed && !localStorage.getItem('interface-conversation-fixture')) {
      localStorage.setItem('datacanvas-ai:studio:v1', JSON.stringify(seed));
      localStorage.setItem('datacanvas-ai:workspace-mode:v1', 'notebook');
      localStorage.setItem('interface-conversation-fixture', 'installed');
    }
    const nativeFetch = window.fetch.bind(window);
    window.__interfaceChat = { next: null, requests: [], clears: [] };
    window.fetch = async (resource, init = {}) => {
      const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
      if (url.pathname === '/api/ai/harness/conversation') {
        window.__interfaceChat.clears.push(JSON.parse(init.body)); return Response.json({ cleared: true });
      }
      if (url.pathname !== '/api/ai/harness/stream') return nativeFetch(resource, init);
      const fixture = window.__interfaceChat, choice = fixture.next;
      if (!choice) throw new Error('Unarmed AI request; real models forbidden');
      fixture.next = null;
      const input = JSON.parse(init.body); fixture.requests.push(input);
      const now = new Date().toISOString();
      const task = { id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey, instruction: input.instruction,
        pageId: input.pageId, role: 'editor', state: 'planning', createdAt: now, updatedAt: now, events: [], trace: [],
        counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 } };
      let closed = false;
      return new Response(new ReadableStream({ start(controller) {
        const emit = (type, message, terminal = false) => {
          const event = { id: `${task.id}:${task.trace.length + 1}`, sequence: task.trace.length + 1, taskId: task.id,
            timestamp: now, type, message, taskState: task.state };
          task.trace.push(event);
          controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`));
        };
        emit('task_started', '隔离会话验收：合成事件，无实际分析。');
        init.signal?.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new DOMException('Cancelled synthetic task', 'AbortError')); } }, { once: true });
        if (choice.hold) return;
        task.state = choice.state; task.resultMessage = choice.response;
        if (choice.state === 'failed') { task.error = choice.response; task.terminationCode = 'toolExecutionFailed'; }
        emit('completed', '合成会话回执', true); closed = true; controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { seed });
  const page = await context.newPage();
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  return { page, context };
}
let { page, context } = await setup();
const prompt = () => page.getByRole('textbox', { name: 'AI 指令', exact: true });
const chat = () => page.getByRole('log', { name: 'AI 对话上下文', exact: true });
const nav = () => page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
const picker = () => page.getByRole('complementary', { name: '工作界面选择', exact: true });
const menu = () => page.getByRole('menu', { name: '当前界面的会话', exact: true });
async function shot(name, scenario, dismissNotice = true) {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (dismissNotice && await notice.isVisible()) await notice.click();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${name}.png`, scenario, actualImageReviewed: false });
}
async function choose(name) {
  if (!await picker().isVisible()) await page.getByRole('button', { name: '选择工作界面', exact: true }).click();
  await picker().getByRole('button', { name, exact: true }).click();
}
async function ready(name) {
  await page.waitForFunction(name => document.querySelector('.interface-switcher summary')?.textContent?.includes(name), name);
}
async function send(instruction, response, state = 'completed', hold = false) {
  await page.evaluate(next => { window.__interfaceChat.next = next; }, { response, state, hold });
  await prompt().fill(instruction);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  if (hold) await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor();
  else await chat().getByText(response, { exact: true }).last().waitFor();
}
async function snapshot(predicate = () => true) {
  for (let i = 0; i < 60; i++) {
    const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
    assert.equal(response.status(), 200);
    const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    if (value.manifest.state && predicate(value.manifest.state)) return value.manifest.state;
    await page.waitForTimeout(100);
  }
  throw new Error('Expected scoped snapshot was not saved');
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await nav().getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/ }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('按界面隔离会话验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await snapshot();
  for (const name of ['DES', 'EDS']) {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    await nav().getByRole('button', { name: '新建界面', exact: true }).click();
    await nav().getByLabel('工作界面名称', { exact: true }).fill(name);
    await nav().getByRole('button', { name: '创建', exact: true }).click();
  }
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await choose('DES'); await ready('DES');
  await send('DES：第一段隔离会话', 'DES 的合成回复，仅属于 DES。');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await send('DES：失败回执验收', 'DES 合成失败：请手动重试。', 'failed');
  await prompt().fill('DES 未发送草稿');
  await shot('01-des-failure-1440', 'DES has its own failed thread, retry action and unsent draft.');
  await choose('EDS'); await ready('EDS');
  assert.equal(await chat().locator('.conversation-turn').count(), 0); assert.equal(await prompt().inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '重试这次任务', exact: true }).count(), 0);
  await send('EDS：独立会话验收', 'EDS 的合成回复，不包含 DES 的历史。');
  await prompt().fill('EDS 未发送草稿');
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await menu().getByRole('menuitemradio').count(), 1);
  assert.ok(!(await menu().textContent()).includes('DES：'));
  await shot('02-eds-only-menu-1440', 'EDS menu lists only EDS conversations and explicitly says only this interface.');
  await page.keyboard.press('Escape');
  await choose('DES'); await ready('DES');
  assert.equal(await prompt().inputValue(), 'DES 未发送草稿');
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  assert.ok(!(await chat().textContent()).includes('EDS 的合成回复'));
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await menu().getByRole('menuitemradio').count(), 2);
  await menu().getByRole('menuitemradio', { name: 'DES：第一段隔离会话', exact: true }).click();
  await chat().getByText('DES 的合成回复，仅属于 DES。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重试这次任务', exact: true }).count(), 0);
  await choose('EDS'); await ready('EDS');
  assert.equal(await prompt().inputValue(), 'EDS 未发送草稿');
  await choose('DES'); await ready('DES');
  await chat().getByText('DES 的合成回复，仅属于 DES。', { exact: true }).waitFor();
  report.checks.push('Separate page histories, drafts, errors, menus and remembered thread selection.');

  await choose('EDS'); await ready('EDS');
  await send('EDS：在途取消验收', '', 'completed', true);
  await picker().getByRole('button', { name: 'DES', exact: true }).click();
  await ready('EDS');
  await page.locator('.persistence-notice').filter({ hasText: '请等待当前任务结束' }).waitFor();
  await shot('03-inflight-switch-blocked-1440', 'Interface switching is rejected while the synthetic EDS task runs; the reason is visible.', false);
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  await shot('04-eds-cancelled-1440', 'Cancellation remains in EDS and is retryable without starting another request.');
  await choose('DES'); await ready('DES');
  assert.ok(!(await chat().textContent()).includes('在途取消验收'));
  assert.equal(await page.getByRole('button', { name: '重试这次任务', exact: true }).count(), 0);
  await choose('EDS'); await ready('EDS');
  await prompt().fill('EDS 保存后草稿');
  const before = await snapshot(state => state.assistantSessions?.items.some(item => item.draft === 'EDS 保存后草稿'));
  const requests = await page.evaluate(() => window.__interfaceChat.requests);
  report.requests.push(...requests.map(item => ({ pageId: item.pageId, conversation_id: item.conversation_id, instruction: item.instruction })));
  assert.equal(requests.length, 4);
  assert.notEqual(requests[0].conversation_id, requests[2].conversation_id);
  assert.equal(requests[2].conversationContext, undefined);
  assert.ok(!JSON.stringify(requests[3].conversationContext).includes('DES：'));
  await page.reload({ waitUntil: 'networkidle' }); await ready('EDS');
  assert.equal(await prompt().inputValue(), 'EDS 保存后草稿');
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__interfaceChat.requests.length), 0);
  const after = await snapshot();
  assert.deepEqual(after.assistantSessions, before.assistantSessions);
  await page.setViewportSize({ width: 1024, height: 900 });
  await shot('05-eds-refresh-1024', 'Refresh restores EDS, its cancelled task, retry and saved draft without a request.');
  report.checks.push('In-flight rejection, cancellation, request-context separation and real project reload.');

  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  assert.equal(await prompt().inputValue(), 'EDS 保存后草稿');
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await menu().getByRole('menuitemradio').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await page.evaluate(() => { window.__interfaceChat.next = { state: 'completed', response: 'EDS 手动重试成功，仍属于 EDS。' }; });
  await page.getByRole('button', { name: '重试这次任务', exact: true }).click();
  await chat().getByText('EDS 手动重试成功，仍属于 EDS。', { exact: true }).waitFor();
  const retried = await page.evaluate(() => window.__interfaceChat.requests);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].pageId, requests[3].pageId);
  assert.equal(retried[0].conversation_id, requests[3].conversation_id);
  assert.equal(retried[0].instruction, requests[3].instruction);
  assert.ok(retried[0].retryOfTaskId);
  report.requests.push({ pageId: retried[0].pageId, conversation_id: retried[0].conversation_id, instruction: retried[0].instruction, retry: true });
  await shot('08-eds-retry-success-1024', 'Manual retry after restore submits exactly once using EDS context and succeeds.');
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await nav().getByRole('textbox', { name: '查找功能或工作界面' }).fill('清除上下文');
  await nav().getByRole('button', { name: '清除上下文', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.conversation-turn'));
  const clears = await page.evaluate(() => window.__interfaceChat.clears);
  assert.equal(clears.length, 1); assert.equal(clears[0].pageId, requests[3].pageId);
  assert.equal(clears[0].conversation_id, requests[3].conversation_id);
  const cleared = await snapshot(state => state.assistantSessions.items.find(item => item.id === state.assistantSessions.activeId)?.turns.length === 0);
  assert.deepEqual(cleared.assistantSessions.items.filter(item => item.pageId !== requests[3].pageId), before.assistantSessions.items.filter(item => item.pageId !== requests[3].pageId));
  await choose('DES'); await ready('DES');
  await chat().getByText('DES 的合成回复，仅属于 DES。', { exact: true }).waitFor();
  await shot('09-des-survives-eds-clear-1024', 'Clearing EDS does not remove DES history or change its selected thread.');
  report.checks.push('AI workbench shares the same scoped state; restored retry and clear touch only EDS, leaving DES intact.');

  const pageA = before.appSpec.navigation.find(item => item.title === 'DES').pageId;
  const pageB = before.appSpec.navigation.find(item => item.title === 'EDS').pageId;
  const now = new Date().toISOString();
  const legacyTurns = [
    { id: 'legacy_des_turn', pageId: pageA, instruction: '旧 DES 问题', response: '旧 DES 回复保留。', state: 'success', createdAt: now },
    { id: 'legacy_unknown_turn', instruction: '旧未标记问题', response: '无归属记录只保留一次。', state: 'success', createdAt: now },
    { id: 'legacy_eds_turn', pageId: pageB, instruction: '旧 EDS 问题', response: '旧 EDS 回复保留。', state: 'failed', createdAt: now },
  ];
  const legacy = { ...before, version: 6, harnessTasks: [], assistantConversation: legacyTurns,
    assistantSessions: { activeId: 'legacy_conversation', items: [{ id: 'legacy_conversation', contextId: 'legacy_context',
      title: '旧 DES 问题', createdAt: now, updatedAt: now, draft: '旧版未发送草稿', pageIds: [pageA, pageB], turns: legacyTurns }] } };
  await context.close();
  ({ page, context } = await setup(true, legacy));
  await page.goto(base, { waitUntil: 'networkidle' }); await ready('EDS');
  await chat().getByText('旧 EDS 回复保留。', { exact: true }).waitFor();
  assert.ok(!(await chat().textContent()).includes('旧 DES 回复'));
  assert.equal(await prompt().inputValue(), '旧版未发送草稿');
  await shot('06-legacy-eds-migrated-1440', 'Legacy mixed chat splits into EDS with its own failure and the single ambiguous record/draft.');
  await choose('DES'); await ready('DES');
  await chat().getByText('旧 DES 回复保留。', { exact: true }).waitFor();
  assert.ok(!(await chat().textContent()).includes('旧 EDS 回复'));
  assert.equal(await prompt().inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '重试这次任务', exact: true }).count(), 0);
  await shot('07-legacy-des-migrated-1440', 'Legacy DES message remains available only on DES; no copied EDS error or draft.');
  const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
  assert.equal(migrated.version, 7);
  assert.equal(migrated.assistantSessions.items.flatMap(item => item.turns).length, 3);
  assert.equal(await page.evaluate(() => window.__interfaceChat.requests.length), 0);
  report.checks.push('Real v6 browser restore splits known pages, preserves unscoped history once, and saves v7 without model requests.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error?.message }, null, 2));
}
