// Browser-only keyboard acceptance. All AI responses are explicit synthetic SSE fixtures.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/chat-shortcuts-20260926', `browser-${Date.now()}`);
const report = { passed: false, base, checks: [], screenshots: [], pageErrors: [], routeErrors: [],
  fixtures: [], paidRequests: 0, projectReads: 0,
  boundaries: ['Fresh browser storage; no persistent project, user data, database, or real model.',
    'Success/failure SSE and cancellation transport are browser fixtures, not provider acceptance.',
    'Composition is a synthetic DOM event; physical OS IME was not automated.'] };
await mkdir(directory, { recursive: true });
let browser, page;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
const input = () => page.getByRole('textbox', { name: 'AI 指令', exact: true });
const count = () => page.evaluate(() => window.__chatShortcutFixtures.length);
async function shot(file, scenario) {
  await page.mouse.move(1, 1);
  const layout = await page.evaluate(() => {
    const hint = document.querySelector('.prompt-shortcuts');
    const rect = hint.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      hint: hint.textContent, hintBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hintWithinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.hintWithinViewport, true);
  assert.match(layout.hint, /Enter 发送 · Shift\+Enter 换行/u);
  await page.screenshot({ path: join(directory, `${file}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${file}.png`, page: new URL(page.url()).pathname,
    scenario, viewport: page.viewportSize(), layout, actualImageReviewed: false });
}
async function guardChecks(label) {
  const before = await count();
  const turnsBefore = await page.locator('.conversation-turn').count();
  await input().fill('第一行');
  await input().press('End');
  await input().press('Shift+Enter');
  await input().press('b');
  assert.equal(await input().inputValue(), '第一行\nb');
  assert.equal(await count(), before);
  await input().fill('输入法候选测试');
  for (const variant of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await input().evaluate((element, variant) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...variant }));
    }, variant);
    assert.equal(await count(), before);
    assert.equal(await input().inputValue(), '输入法候选测试');
  }
  await input().fill('   ');
  await input().press('Enter');
  assert.equal(await input().inputValue(), '   ');
  assert.equal(await count(), before);
  assert.equal(await page.locator('.conversation-turn').count(), turnsBefore);
  report.checks.push(`${label}: Shift+Enter inserts a real newline; isComposing/keyCode 229/repeat/whitespace do not submit.`);
}
async function send(label, kind = 'success') {
  const before = await count();
  await page.evaluate(kind => { window.__chatShortcutKind = kind; }, kind);
  await input().fill(`键盘验收：${label}。这是隔离合成场景，请解释当前工作区。`);
  await input().press('Enter');
  await poll(async () => await count() === before + 1, `${label}: Enter did not send exactly once.`);
  assert.equal(await input().inputValue(), '');
  if (kind === 'cancel') {
    assert.equal(await input().isDisabled(), true);
    await input().evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(await count(), before + 1);
    await page.getByRole('button', { name: '取消 AI 请求', exact: true }).click();
    await poll(async () => !await input().isDisabled(), 'Cancellation did not release input.');
    await poll(async () => /取消/u.test(await page.locator('.conversation-turn').last().textContent()), 'Cancellation turn missing.');
  } else {
    const response = kind === 'failure' ? '隔离失败回执：本次请求未完成；未调用真实模型。' : '隔离成功回执：Enter 已发送一次；未调用真实模型。';
    await page.getByText(response, { exact: true }).first().waitFor();
    await poll(async () => !await input().isDisabled(), 'Input stayed disabled.');
  }
  await pause(200);
  assert.equal(await count(), before + 1);
  report.checks.push(`${label}: Enter sent exactly one ${kind} fixture; draft cleared without a newline.`);
}

try {
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
  for (const entry of ['/dsh', '/']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) return route.abort('blockedbyclient');
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (request.method() !== 'GET' || request.headers()['x-agentcanvas-project'] || url.pathname.startsWith('/api/ai/')) {
          report.routeErrors.push(`Prohibited request: ${request.method()} ${url.pathname}`);
          return route.abort('blockedbyclient');
        }
        if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
        if (url.pathname === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python') return route.continue();
        report.routeErrors.push(`Unexpected API read: ${url.pathname}`);
        return route.abort('blockedbyclient');
      });
      await context.addInitScript(() => {
        const native = window.fetch.bind(window);
        window.__chatShortcutFixtures = [];
        window.__chatShortcutKind = 'success';
        window.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (!['/api/ai/dsh/conversation/stream', '/api/ai/harness/stream'].includes(url.pathname)) return native(input, init);
          const request = JSON.parse(init.body), kind = window.__chatShortcutKind;
          window.__chatShortcutFixtures.push({ endpoint: url.pathname, kind, instruction: request.instruction });
          if (kind === 'cancel') return new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException('Cancelled synthetic transport', 'AbortError'));
            if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
          });
          const now = new Date().toISOString();
          const task = { id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
            instruction: request.instruction, pageId: request.pageId, role: 'editor',
            state: kind === 'failure' ? 'failed' : 'completed', createdAt: now, updatedAt: now,
            counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [],
            resultMessage: kind === 'failure' ? '隔离失败回执：本次请求未完成；未调用真实模型。' : '隔离成功回执：Enter 已发送一次；未调用真实模型。',
            ...(kind === 'failure' ? { error: '合成失败回执', terminationCode: 'verificationFailed' } : {}) };
          const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: task.state, message: task.resultMessage };
          return new Response(`event: completed\ndata: ${JSON.stringify({ event, task })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        };
      });
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => report.pageErrors.push(error.message));
      await page.goto(`${base}${entry}`, { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
      await guardChecks(`${entry} AI 工作台`);
      await send(`${entry} AI 工作台`);
      await shot(entry === '/dsh' ? '01-dsh-enter-success-1440' : '04-classic-enter-success-1440', 'Enter one-submit success, explicit synthetic reply.');
      await page.setViewportSize({ width: 1024, height: 1000 });
      if (entry === '/dsh') {
        await input().fill('第一行：这是合成输入');
        await input().press('End');
        await input().press('Shift+Enter');
        await input().press('b');
        assert.equal(await input().inputValue(), '第一行：这是合成输入\nb');
        await shot('02-dsh-shift-enter-1024', 'Shift+Enter inserts newline without sending; 1024 px shortcut hint.');
      }
      await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
      await page.getByRole('complementary', { name: 'AI 助手', exact: true }).waitFor();
      await guardChecks(`${entry} AI 侧栏`);
      await send(`${entry} AI 侧栏`, entry === '/dsh' ? 'failure' : 'cancel');
      await shot(entry === '/dsh' ? '03-dsh-sidebar-failure-1024' : '05-classic-sidebar-cancelled-1024', entry === '/dsh' ? 'Sidebar Enter submits once; explicit failed SSE fixture and readable hint.' : 'Sidebar pending fixture prevents extra Enter; cancellation restores input, readable hint.');
      report.fixtures.push(...await page.evaluate(() => window.__chatShortcutFixtures));
    } finally { await context.close(); }
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.routeErrors, []);
  assert.equal(report.fixtures.length, 4);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  console.log(JSON.stringify({ passed: report.passed, report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), failure: report.failure?.message }));
}
