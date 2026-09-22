import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

if (process.argv.length !== 2) throw new Error('No external project/model input is accepted.');
const base = 'http://127.0.0.1:3001', siteRoot = process.cwd();
const directory = resolve('.runtime', 'dsh-tool-limit-browser-2026-09-22', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const expected = 'DSH 已达到工具调用次数保护（6 次），未交付可采用草稿；正式 Notebook 与看板未修改。';
const instruction = '离线验收：连续检查空白 Notebook，验证工具调用次数保护提示。';
const report = { passed: false, base, scope: 'Real 3001 UI; real isolated DSH engine and business tools with simulated driver; buffered actual SSE replay. No public handler, SDK, real model or DB execution.',
  screenshots: [], checks: [], pageErrors: [], routeErrors: [], forbiddenRequests: [], engineRuns: [],
  visualReview: { status: 'pending', note: 'Every new screenshot must be opened separately.' } };
const previousEnvironment = process.env, originalFetch = globalThis.fetch;
const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'localappdata']);
process.env = Object.fromEntries(Object.entries(previousEnvironment).filter(([key]) => allowed.has(key.toLowerCase())));
// Plain-object env isolation loses Windows' case-insensitive lookup used by Playwright.
for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
  if (previousEnvironment[key]) process.env[key] = previousEnvironment[key];
}
process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'state');
globalThis.fetch = async () => { throw new Error('Network fetch is forbidden in the isolated engine fixture.'); };
let server, browser, page, calls = 0;
async function settings() {
  const response = await originalFetch(`${base}/api/settings/agent-engine`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const value = await response.json();
  return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
async function screenshot(file, scenario) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(directory, file), fullPage: false, animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), reviewed: false });
}
try {
  report.initialEngine = await settings();
  assert.equal(report.initialEngine.activeTasks, 0);
  server = await createServer({ root: siteRoot, configFile: false, envFile: false, logLevel: 'error',
    cacheDir: join(directory, 'vite-cache'), resolve: { alias: { '@': siteRoot } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  const { createToolLimitFixture } = await server.ssrLoadModule('/scripts/dsh-tool-limit-fixture.ts');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      if (url.origin !== base) throw new Error('External origin prohibited.');
      if (url.pathname === '/api/projects' && method === 'GET') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (url.pathname === '/api/connections' && method === 'GET') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (url.pathname === '/api/ai/harness/stream' && method === 'POST') {
        assert.equal(++calls, 1, 'No retry or second task permitted.');
        const payload = request.postDataJSON();
        assert.equal(payload.instruction, instruction);
        assert.equal(request.headers()['x-agentcanvas-project'], undefined, 'No real project may be opened.');
        const result = await createToolLimitFixture(payload);
        report.engineRuns.push(result.evidence);
        await writeFile(join(directory, 'isolated-task.json'), JSON.stringify(result.task, null, 2));
        return await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: result.body });
      }
      if (!['GET', 'HEAD'].includes(method) || url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/projects/')
        || url.pathname.startsWith('/api/datasets') || url.pathname.startsWith('/api/connections/') || url.pathname === '/api/notebook/run') {
        report.forbiddenRequests.push({ method, path: url.pathname }); return await route.abort('blockedbyclient');
      }
      return await route.continue();
    } catch (error) {
      report.routeErrors.push({ method, path: url.pathname, message: error instanceof Error ? error.message : 'Route failed' });
      return await route.abort('failed').catch(() => {});
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ name: error.name }));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  const turn = page.locator('.conversation-turn').last(), trace = turn.locator('.harness-trace.failed');
  await trace.waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await turn.locator('.assistant-message p').innerText(), expected);
  assert.equal(await trace.getAttribute('open'), null);
  assert.equal(await page.locator('.notebook-assistant-artifact').count(), 0);
  assert.equal(await page.getByRole('button', { name: /打开 Notebook 查看草稿/ }).count(), 0);
  await turn.locator('.assistant-message').scrollIntoViewIfNeeded();
  await screenshot('01-tool-limit-collapsed-1440.png', 'Full terminal reason visible; trace collapsed by default; no draft.');
  await trace.locator('summary').first().click();
  assert.notEqual(await trace.getAttribute('open'), null);
  assert.equal(await trace.getByRole('list', { name: '真实执行记录' }).locator('small').filter({ hasText: 'cellSearch' }).count(), 6);
  assert.equal(await trace.locator('.trace-failure-detail').innerText(), expected);
  await trace.locator('summary').first().scrollIntoViewIfNeeded();
  await screenshot('02-tool-limit-trace-1440.png', 'Expanded actual engine trace contains six successful cellSearch receipts.');
  await trace.locator('.trace-failure-detail').scrollIntoViewIfNeeded();
  await screenshot('03-tool-limit-trace-reason-1440.png', 'Expanded trace terminal error and unchanged formal-document notice.');
  await trace.locator('summary').first().click();
  await page.setViewportSize({ width: 1024, height: 900 });
  await turn.locator('.assistant-message').scrollIntoViewIfNeeded();
  await screenshot('04-tool-limit-collapsed-1024.png', 'Desktop minimum width retains full failure message and no draft.');
  report.checks.push('One intercepted request; real engine rejected seventh call after six real cellSearch completions.',
    'Full result and expandable actual trace visible at 1440/1024; no adoptable Notebook artifact.');
  report.finalEngine = await settings();
  assert.deepEqual(report.finalEngine, report.initialEngine);
  assert.equal(report.forbiddenRequests.length, 0);
  assert.equal(report.routeErrors.length, 0);
  assert.equal(report.pageErrors.length, 0);
  assert.equal(calls, 1);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Browser verification failed';
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: false }).catch(() => {});
} finally {
  await browser?.close(); await server?.close(); globalThis.fetch = originalFetch; process.env = previousEnvironment;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: relative(siteRoot, join(directory, 'report.json')).replaceAll('\\', '/') }));
}
