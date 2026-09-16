import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/project-conversations-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], checks = [], screenshots = [], unexpectedModelRequests = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/ai/harness/**', route => {
  unexpectedModelRequests.push(route.request().url()); return route.abort();
});
await page.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  window.__sessionsTest = { requests: [], clears: [], release: null };
  window.fetch = async (resource, init) => {
    const url = typeof resource === 'string' ? resource : resource.url;
    if (url === '/api/ai/harness/conversation') {
      window.__sessionsTest.clears.push({ ...JSON.parse(init.body), project: init.headers['x-agentcanvas-project'] });
      return Response.json({ cleared: true });
    }
    if (url !== '/api/ai/harness/stream') return originalFetch(resource, init);
    const input = JSON.parse(init.body), now = new Date().toISOString();
    window.__sessionsTest.requests.push({ ...input, project: init.headers['x-agentcanvas-project'] });
    const task = { id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey,
      instruction: input.instruction, pageId: input.pageId, role: 'editor', state: 'planning', createdAt: now, updatedAt: now,
      events: [], counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 }, trace: [] };
    let closed = false;
    return new Response(new ReadableStream({ start(controller) {
      const emit = (type, message, terminal = false) => {
        const event = { id: `${task.id}:${task.trace.length + 1}`, sequence: task.trace.length + 1,
          taskId: task.id, timestamp: now, type, message, taskState: task.state };
        task.trace.push(event);
        controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`));
      };
      emit('task_started', '隔离测试任务已开始');
      init.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); } }, { once: true });
      window.__sessionsTest.release = () => {
        if (closed) return;
        task.state = 'completed'; task.resultMessage = `测试回执：${input.instruction}`;
        emit('completed', '隔离测试任务已完成', true); closed = true; controller.close();
      };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
});
const trigger = () => page.getByRole('button', { name: '切换会话', exact: true });
const newButton = () => page.getByRole('button', { name: '新建会话', exact: true });
const menu = () => page.getByRole('menu', { name: '当前项目的会话', exact: true });
const prompt = () => page.getByRole('textbox', { name: 'AI 指令', exact: true });
const chat = () => page.getByRole('log', { name: 'AI 对话上下文', exact: true });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
async function step(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name) { await page.mouse.move(1, 1); await page.screenshot({ path: resolve(directory, `${name}.png`) }); screenshots.push(name); }
async function send(text, remote = false) {
  await prompt().fill(text); await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  if (remote) await page.locator('.harness-trace.running').waitFor();
  else await chat().locator('.conversation-turn').last().getByText(text, { exact: true }).waitFor();
}
async function complete(text) {
  await page.evaluate(() => window.__sessionsTest.release());
  await chat().getByText(`测试回执：${text}`, { exact: true }).waitFor();
}
async function select(title) {
  await trigger().click(); await menu().getByRole('menuitemradio', { name: title, exact: true }).click();
  await menu().waitFor({ state: 'hidden' });
}
async function openDataBrowser() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '工作区功能菜单' });
  await nav.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await nav.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
  await dataBrowser().getByRole('button', { name: /项目文件夹/ }).first().click();
}
async function createProject(name, folder) {
  await openDataBrowser();
  await dataBrowser().getByLabel('项目名称', { exact: true }).fill(name);
  await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, folder));
  await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dataBrowser().waitFor({ state: 'hidden' }); await trigger().waitFor();
  await page.waitForFunction(() => !document.querySelector('.conversation-switch-trigger')?.disabled);
  return page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
}
async function waitSaved(handle) {
  await page.waitForFunction(() => /已保存到本地项目|已打开本地项目/.test(document.querySelector('.top-actions')?.textContent ?? ''), null, { timeout: 15000 });
  const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return (await response.json()).manifest.state;
}
async function layout() {
  const box = await menu().boundingBox(), size = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
let handleA, handleB;
const titleA = '检查项目甲销售数据', titleA2 = '检查项目甲库存数据', titleB = '检查项目乙专属数据';
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await step('Temporary threads preserve messages and drafts; v5 history migrates to one thread', async () => {
    await send('你好'); await prompt().fill('尚未发送的临时草稿'); await newButton().click();
    assert.equal(await prompt().inputValue(), ''); await send('谢谢');
    await select('你好'); assert.equal(await prompt().inputValue(), '尚未发送的临时草稿');
    assert.ok(!(await chat().innerText()).includes('谢谢'));
    await page.reload({ waitUntil: 'networkidle' }); assert.equal(await prompt().inputValue(), '尚未发送的临时草稿');
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1'));
      state.version = 5; delete state.assistantSessions; localStorage.setItem('datacanvas-ai:studio:v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'networkidle' }); await trigger().click();
    assert.equal(await menu().getByRole('menuitemradio').count(), 1); await menu().getByRole('menuitemradio', { name: '你好', exact: true }).waitFor();
    await page.keyboard.press('Escape');
  });
  await step('New project starts clean and independent threads use separate request contexts', async () => {
    handleA = await createProject('会话验收项目甲', 'project-a');
    assert.equal(await chat().locator('.conversation-turn').count(), 0);
    await send(titleA, true); assert.ok(await trigger().isDisabled()); assert.ok(await newButton().isDisabled()); await complete(titleA);
    await prompt().fill('项目甲销售草稿'); await newButton().click(); assert.equal(await prompt().inputValue(), '');
    await send(titleA2, true); await complete(titleA2);
    const requests = await page.evaluate(() => window.__sessionsTest.requests);
    assert.notEqual(requests[0].conversation_id, requests[1].conversation_id);
    assert.equal(requests[1].conversationContext, undefined); assert.equal(requests[1].project, handleA);
    await select(titleA); assert.equal(await prompt().inputValue(), '项目甲销售草稿');
    assert.ok(!(await chat().innerText()).includes(titleA2));
    await send('继续项目甲销售分析', true);
    const last = await page.evaluate(() => window.__sessionsTest.requests.at(-1));
    assert.equal(last.conversation_id, requests[0].conversation_id);
    assert.equal(last.conversationContext.previousInstruction, titleA);
    assert.ok(!JSON.stringify(last.conversationContext).includes(titleA2)); await complete('继续项目甲销售分析');
    await waitSaved(handleA);
  });
  await step('Dropdown supports keyboard selection, Escape, outside click and both layouts', async () => {
    await trigger().click(); await layout(); await shot('01-workspace-menu');
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await menu().waitFor({ state: 'hidden' });
    await trigger().click(); await page.keyboard.press('Escape');
    assert.equal(await trigger().evaluate(el => el === document.activeElement), true);
    await trigger().click(); await prompt().click(); await menu().waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    if (!(await trigger().isVisible())) await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await trigger().click(); await layout(); await shot('02-notebook-menu'); await page.keyboard.press('Escape');
    assert.ok(await trigger().isVisible());
    await select(titleA2); await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 844 }); await trigger().click(); await layout(); await shot(`03-menu-${width}`);
      await page.keyboard.press('Escape'); assert.ok(await prompt().isVisible());
    }
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await step('Project switching and disk refresh preserve selection and never list another project', async () => {
    const beforeA = await waitSaved(handleA);
    handleB = await createProject('会话验收项目乙', 'project-b');
    await trigger().click(); assert.equal(await menu().getByRole('menuitemradio').count(), 1);
    assert.ok(!(await menu().innerText()).includes(titleA)); await page.keyboard.press('Escape');
    await send(titleB, true); await complete(titleB); await waitSaved(handleB);
    const onlyB = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handleA } });
    assert.deepEqual((await onlyB.json()).manifest.state.assistantSessions, beforeA.assistantSessions);
    await openDataBrowser(); await dataBrowser().locator('.project-recent-list').getByRole('button', { name: /会话验收项目甲/ }).filter({ hasText: resolve(directory, 'project-a') }).click();
    await dataBrowser().waitFor({ state: 'hidden' });
    await page.waitForFunction(title => document.querySelector('.conversation-switch-trigger')?.textContent === title, titleA2);
    assert.equal(await trigger().innerText(), titleA2);
    await trigger().click(); assert.equal(await menu().getByRole('menuitemradio').count(), 2);
    assert.ok(!(await menu().innerText()).includes(titleB)); await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'networkidle' }); assert.equal(await trigger().innerText(), titleA2);
    await chat().getByText(`测试回执：${titleA2}`, { exact: true }).waitFor();
    await trigger().click(); await shot('04-restored-project'); await page.keyboard.press('Escape');
  });
  await step('Clear rotates only the active context and leaves the other thread intact', async () => {
    const saved = await waitSaved(handleA), current = saved.assistantSessions.items.find(item => item.id === saved.assistantSessions.activeId);
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '工作区功能菜单' });
    await nav.getByRole('textbox', { name: '查找功能或工作界面' }).fill('清除上下文');
    await nav.getByRole('button', { name: '清除上下文', exact: true }).click();
    await page.getByRole('heading', { name: '今天，想了解什么？', exact: true }).waitFor();
    const clears = await page.evaluate(() => window.__sessionsTest.clears);
    assert.ok(clears.length > 0 && clears.every(item => item.conversation_id === current.contextId && item.project === handleA));
    await select(titleA); assert.equal(await chat().locator('.conversation-turn').count(), 2);
    await select('新会话'); await send('独立的新问题', true);
    const input = await page.evaluate(() => window.__sessionsTest.requests.at(-1));
    assert.notEqual(input.conversation_id, current.contextId); assert.equal(input.conversationContext, undefined);
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
    await page.locator('.harness-trace.cancelled').waitFor();
    await waitSaved(handleA); assert.ok(await trigger().isEnabled());
  });
  await step('Refresh recovers an interrupted first task in its own thread without restarting it', async () => {
    await newButton().click(); await send('刷新期间的独立测试任务', true); await waitSaved(handleA);
    await page.reload({ waitUntil: 'networkidle' });
    await chat().getByText('刷新期间的独立测试任务', { exact: true }).waitFor();
    await page.locator('.harness-trace.cancelled').waitFor();
    assert.ok(await trigger().isEnabled());
    assert.equal(await page.evaluate(() => window.__sessionsTest.requests.length), 0);
    await select(titleA); assert.equal(await chat().locator('.conversation-turn').count(), 2);
    await waitSaved(handleA); await shot('05-recovered-thread');
  });
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedModelRequests, []);
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, errors, unexpectedModelRequests, handleA, handleB,
    note: 'Isolated synthetic projects; gated SSE/clear replacements; real project persistence; no paid model or user data.' }, null, 2));
  console.log(JSON.stringify({ passed: true, directory, checks: checks.length, screenshots: screenshots.length }));
} catch (error) {
  await shot('failure'); await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error), errors, directory }, null, 2)); throw error;
} finally { await browser.close(); }
