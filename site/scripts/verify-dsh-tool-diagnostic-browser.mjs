// Explicit fixture-only error presentation, separate from the real paid readonly acceptance.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const unsupported = process.argv[2] === '--unsupported-cell';
assert.ok(process.argv.length === 2 || (unsupported && process.argv.length === 3), 'Only --unsupported-cell accepted; no user project, credentials or model options');
const base = 'http://127.0.0.1:3001', siteRoot = process.cwd();
const directory = resolve(`.runtime/dsh-${unsupported ? 'unsupported' : 'diagnostic'}-browser-2026-09-22`, `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const instruction = unsupported ? '离线验收：检查不支持的 Notebook 单元，不调用模型或工具。' : '离线验收：检查 Notebook 工具参数错误提示，不生成或采用草稿。';
const diagnostic = unsupported ? /notebook_cell_unsupported/u : /query: invalid_type/u;
const report = { passed: false, fixture: true, scope: `Actual DSH engine + ${unsupported ? 'real bridge unsupported-cell preflight' : 'cellSearch validation'} + public-safe trace renderer. Fixed driver and synthetic trusted context; buffered browser SSE replay. Not public handler/SDK/model/DB verification.`,
  screenshots: [], pageErrors: [], routeErrors: [], forbidden: [], visualReview: 'pending actual image review' };
const environment = process.env, originalFetch = globalThis.fetch;
const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'localappdata']);
process.env = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toLowerCase())));
for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) if (environment[key]) process.env[key] = environment[key];
process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'state');
globalThis.fetch = async () => { throw new Error('Network prohibited in isolated diagnostic engine'); };
let browser, server, page, calls = 0;
async function status() {
  const response = await originalFetch(`${base}/api/settings/agent-engine`); assert.equal(response.status, 200);
  const value = await response.json(); return { engine: value.engine, revision: value.revision, activeTasks: value.activeTasks };
}
async function shot(name, evidence) {
  await page.screenshot({ path: join(directory, name), fullPage: false }); report.screenshots.push({ name, evidence, actualImageReviewed: false });
}
try {
  report.initialEngine = await status(); assert.equal(report.initialEngine.activeTasks, 0);
  server = await createServer({ root: siteRoot, configFile: false, envFile: false, logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
    resolve: { alias: { '@': siteRoot } }, server: { middlewareMode: true, hmr: false, watch: null } });
  const { createToolDiagnosticFixture } = await server.ssrLoadModule('/scripts/dsh-tool-diagnostic-fixture.ts');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === 'https://rsms.me/inter/inter.css') return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      assert.equal(url.origin, base);
      if (method === 'GET' && url.pathname === '/api/projects') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      if (method === 'GET' && url.pathname === '/api/connections') return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      if (method === 'POST' && url.pathname === '/api/ai/harness/stream') {
        assert.equal(++calls, 1); assert.equal(request.headers()['x-agentcanvas-project'], undefined);
        const payload = request.postDataJSON(); assert.equal(payload.instruction, instruction);
        const result = await createToolDiagnosticFixture(payload, unsupported); report.engineEvidence = result.evidence;
        await writeFile(join(directory, 'fixture-task.json'), JSON.stringify(result.task, null, 2));
        return await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: result.body });
      }
      if (!['GET', 'HEAD'].includes(method) || url.pathname.startsWith('/api/ai/') || url.pathname === '/api/notebook/run') {
        report.forbidden.push({ method, path: url.pathname }); throw new Error('No model, project or Notebook writes');
      }
      return await route.continue();
    } catch (error) { report.routeErrors.push({ method, path: url.pathname, message: error.message }); return await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.pageErrors.push(error.name));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 }); await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction); await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  const trace = page.locator('.conversation-turn').last().locator('.harness-trace'); await trace.waitFor();
  await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
  if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
  await trace.getByText(diagnostic).waitFor(); assert.match(await trace.innerText(), unsupported ? /未启动模型或工具/u : /invalid_tool_arguments/u);
  assert.equal(await page.locator('.notebook-assistant-artifact').count(), 0);
  await trace.getByText(diagnostic).scrollIntoViewIfNeeded();
  await shot('01-safe-diagnostic-1440.png', unsupported ? 'Actual engine/bridge rejected a synthetic text cell before any model/tool call; explicit trusted-context SSE fixture.' : 'Actual engine caught invalid query:null, emitted only safe query/invalid_type, then actual corrected search succeeded. Explicit fixed-driver SSE fixture.');
  await page.setViewportSize({ width: 1024, height: 900 }); await trace.getByText(diagnostic).scrollIntoViewIfNeeded();
  await shot('02-safe-diagnostic-1024.png', 'Safe diagnostic remains readable at narrow desktop width; explicitly fixture-only, not a reconstruction of historical model arguments.');
  report.finalEngine = await status(); assert.deepEqual(report.finalEngine, report.initialEngine);
  assert.equal(calls, 1); assert.equal(report.routeErrors.length, 0); assert.equal(report.pageErrors.length, 0); assert.equal(report.forbidden.length, 0); report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Diagnostic fixture failed'; process.exitCode = 1;
  if (page) await shot('failure.png', 'Actual stopped fixture state, not paid execution.').catch(() => {});
} finally {
  await browser?.close(); await server?.close(); globalThis.fetch = originalFetch; process.env = environment;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, directory: relative(siteRoot, directory).replaceAll('\\', '/'), error: report.error }));
}
