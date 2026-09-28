// Retired page acceptance: isolated empty browser; no project/model/database writes.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.argv.length, 2, 'This check accepts no user project or model input.');
const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/visualization-lab-removal', `browser-${Date.now()}`);
const report = { passed: false, base, screenshots: [], checks: [], pageErrors: [], blockedRequests: [] };
await mkdir(directory, { recursive: true });
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) { report.blockedRequests.push(`${request.method()} external origin`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const path = url.pathname;
  if (request.method() === 'GET') {
    if (path === '/api/projects') return route.fulfill({ json: { projects: [] } });
    if (path === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
    if (path === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (path === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat',
      modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (path === '/api/notebook/python' || path === '/api/ai/dsh/web/document' || path.startsWith('/api/ai/dsh/web/assets/')) return route.continue();
  }
  report.blockedRequests.push(`${request.method()} ${path}`); return route.abort();
});
const page = await context.newPage(); page.setDefaultTimeout(20_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
async function shot(file, scenario) {
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow.');
  await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, actualImageReviewed: false });
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const trigger = page.getByRole('button', { name: '打开工作区菜单', exact: true });
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await trigger.click(); await menu.waitFor();
  assert.equal(await menu.getByRole('link', { name: /可视化测试/u }).count(), 0);
  assert.equal(await menu.locator('a[href="/visualization-lab"]').count(), 0);
  for (const name of ['数据浏览器', '语义模型', '任务与变更历史']) await menu.getByRole('button', { name, exact: true }).waitFor();
  await shot('01-menu-without-lab.png', 'Menu no longer contains the retired experiment; ordinary workspace tools remain.');
  const search = menu.getByRole('textbox', { name: '查找功能或工作界面', exact: true });
  for (const query of ['可视化测试', 'Lab']) {
    await search.fill(query);
    await menu.getByText('没有找到相关功能，试试“数据”或“历史”。', { exact: true }).waitFor();
    assert.equal(await menu.locator('a[href="/visualization-lab"]').count(), 0);
  }
  await shot('02-retired-search-empty.png', 'Retired experiment names return the normal empty search state.');
  await search.press('Escape'); await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await page.getByRole('region', { name: 'Notebook 分析文档', exact: true }).waitFor();
  await shot('03-notebook-unchanged.png', 'Notebook remains available with ordinary analysis controls; no execution request.');
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '看板', exact: true }).getAttribute('aria-selected'), 'true');
  report.checks.push('Menu removal, empty search, Escape focus restoration, Notebook and dashboard navigation passed.');
  const response = await page.goto(`${base}/visualization-lab`, { waitUntil: 'networkidle' });
  report.retiredPageStatus = response.status(); assert.equal(response.status(), 404);
  await shot('04-retired-page-404.png', 'The old page URL returns real HTTP 404, not a hidden but still available experiment.');
  report.checks.push('Direct navigation to the retired page returns HTTP404.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blockedRequests, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await shot('failure.png', 'Actual verifier failure; see report.').catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ passed: report.passed, directory: relative(process.cwd(), directory), failure: report.failure?.message }));
