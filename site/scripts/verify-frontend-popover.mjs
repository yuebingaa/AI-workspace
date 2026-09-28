// Visual acceptance for the shared workspace popover. Fresh browser storage; no user project or AI requests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/frontend-popover-20260926', `browser-${Date.now()}`);
const report = { passed: false, base, screenshots: [], checks: [], pageErrors: [], blockedRequests: [] };
await mkdir(directory, { recursive: true });
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (request.method() === 'GET' && path === '/api/projects') return route.fulfill({ json: { projects: [] } });
  if (request.method() === 'GET' && path === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
  if (request.method() === 'GET' && path === '/api/connections') return route.fulfill({ json: { connections: [] } });
  if (request.method() === 'GET' && path === '/api/settings/ai') return route.fulfill({ json: {
    configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default',
    availableModels: [], modelsDiscovered: false, persistence: 'process-memory',
  } });
  if (request.method() === 'GET' && (path === '/api/notebook/python' || path === '/api/ai/dsh/web/document' || path.startsWith('/api/ai/dsh/web/assets/'))) return route.continue();
  report.blockedRequests.push(`${request.method()} ${path}`);
  return route.abort('blockedbyclient');
});
async function shot(file, scenario) {
  const layout = await page.evaluate(() => {
    const menu = document.querySelector('#studio-navigation-menu');
    const rect = menu?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      menu: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.equal(layout.overflow, false, `${scenario}: horizontal overflow`);
  if (layout.menu) {
    assert.ok(layout.menu.x >= 0 && layout.menu.y >= 0);
    assert.ok(layout.menu.x + layout.menu.width <= layout.viewport.width + 1);
    assert.ok(layout.menu.y + layout.menu.height <= layout.viewport.height + 1);
  }
  await page.screenshot({ path: join(directory, `${file}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${file}.png`, scenario, layout, actualImageReviewed: false });
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const trigger = page.getByRole('button', { name: '打开工作区菜单', exact: true });
  await trigger.waitFor();
  await trigger.click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.waitFor();
  const search = menu.getByRole('textbox', { name: '查找功能或工作界面', exact: true });
  assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Search must receive opening focus.');
  await shot('01-open-1440', 'Default open state at 1440 px; search is focused.');
  await menu.getByRole('button', { name: '导入表格', exact: true }).hover();
  await shot('02-hover-1440', 'Hover state on a quick action.');
  await search.fill('不存在的功能xyz');
  await menu.getByText('没有找到相关功能，试试“数据”或“历史”。').waitFor();
  await shot('03-empty-1440', 'Unsuccessful search has a readable empty state.');
  await search.fill('语义模型');
  await menu.getByRole('button', { name: '语义模型', exact: true }).waitFor();
  await shot('04-search-1440', 'A matching search returns the correct tool.');
  await search.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'Escape must restore trigger focus.');
  await shot('04b-dismissed-1440', 'Escape cancels the menu and restores focus to its trigger.');
  report.checks.push('Open/search focus, hover, empty result, Escape close and focus restoration passed.');
  await trigger.press('Enter');
  await menu.waitFor();
  await menu.getByText('设置与备份').click();
  const undo = menu.getByRole('button', { name: '撤销上一步', exact: true });
  assert.equal(await undo.isDisabled(), true);
  await undo.scrollIntoViewIfNeeded();
  await shot('05-disabled-1440', 'Disabled action remains distinguishable inside expanded settings.');
  await page.mouse.click(450, 28);
  await menu.waitFor({ state: 'hidden' });
  report.checks.push('Keyboard opening, disabled action and outside-click closing passed.');
  await trigger.click();
  await menu.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill('AI 接口配置');
  await menu.getByRole('button', { name: 'AI 接口配置', exact: true }).click();
  const apiDialog = page.getByRole('dialog', { name: 'AI 接口配置', exact: true });
  await apiDialog.waitFor();
  assert.equal(await apiDialog.evaluate(element => element.contains(document.activeElement)), true, 'Opening a dialog must keep focus inside that dialog.');
  await shot('06-dialog-action-1440', 'Choosing a menu action opens the existing API dialog with correct focus.');
  await apiDialog.getByRole('button', { name: '关闭 AI API 配置', exact: true }).click();
  await apiDialog.waitFor({ state: 'hidden' });
  report.checks.push('Menu action opens the API dialog without stealing dialog focus.');
  await page.setViewportSize({ width: 1024, height: 800 });
  await trigger.click();
  await menu.waitFor();
  await shot('07-open-1024', 'Menu remains within the minimum supported desktop viewport.');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blockedRequests, []);
  report.passed = true;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks, screenshots: report.screenshots.length }));
