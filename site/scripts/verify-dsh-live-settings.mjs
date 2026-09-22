import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

if (process.argv.length !== 2) throw new Error('This read-only acceptance accepts no project, credential or model input.');
const base = 'http://127.0.0.1:3001';
const endpoint = `${base}/api/settings/agent-engine`;
const directory = resolve('.runtime', 'dsh-live-settings-2026-09-22', `browser-${Date.now()}`);
const summary = value => ({ engine: value.engine, revision: value.revision, activeTasks: value.activeTasks,
  dsh: { available: value.dsh.available, version: value.dsh.version } });
const report = { passed: false, base, startedAt: new Date().toISOString(),
  scope: 'Read-only settings regression after isolated SDK installation. Not browser analysis, model, database or draft-adoption end-to-end verification.',
  realSettingsRequests: [], fixtures: { emptyRecentProjects: 0, emptyConnections: 0, emptyFontCss: 0 },
  forbiddenRequests: [], pageErrors: [], routeErrors: [], screenshots: [],
  visualReview: { status: 'pending', note: 'Open both new screenshots separately before marking reviewed.' },
};
await mkdir(directory, { recursive: true });
let browser, page;
async function settings(source) {
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const value = await response.json();
  report.realSettingsRequests.push({ source, method: 'GET', status: response.status, ...summary(value) });
  return value;
}
function dialog() { return page.getByRole('dialog', { name: 'Agent 执行与插件', exact: true }); }
async function snapshot(file, scenario) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await dialog().evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: resolve(directory, file), fullPage: false, animations: 'disabled' });
  report.screenshots.push({ file, scenario, source: 'actual development settings API and UI',
    viewport: page.viewportSize(), reviewed: false });
}
try {
  const initial = await settings('before');
  report.initial = summary(initial);
  assert.equal(initial.engine, 'dsh');
  assert.equal(initial.activeTasks, 0, 'Only inspect idle settings; do not interrupt tasks.');
  assert.equal(initial.dsh.available, true);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        report.forbiddenRequests.push({ method, path: url.pathname }); return await route.abort('blockedbyclient');
      }
      if (url.href === 'https://rsms.me/inter/inter.css') {
        report.fixtures.emptyFontCss++; return await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      }
      if (url.origin !== base) {
        report.forbiddenRequests.push({ method, path: 'external-origin' }); return await route.abort('blockedbyclient');
      }
      if (url.pathname === '/api/projects') {
        report.fixtures.emptyRecentProjects++; return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
      }
      if (url.pathname === '/api/connections') {
        report.fixtures.emptyConnections++; return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connections":[]}' });
      }
      if (url.href === endpoint) {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const value = await response.json();
        report.realSettingsRequests.push({ source: 'browser', method, status: response.status(), ...summary(value) });
        return await route.fulfill({ response });
      }
      if (url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/projects/')
        || url.pathname.startsWith('/api/datasets') || url.pathname.startsWith('/api/connections/')
        || url.pathname === '/api/notebook/run') {
        report.forbiddenRequests.push({ method, path: url.pathname }); return await route.abort('blockedbyclient');
      }
      return await route.continue();
    } catch (error) {
      report.routeErrors.push({ method, path: url.pathname, kind: error instanceof Error ? error.name : 'UnknownError' });
      return await route.abort('failed').catch(() => {});
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ kind: error.name }));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.locator('summary').filter({ hasText: '设置与备份' }).click();
  await navigation.getByRole('button', { name: 'Agent 执行与插件', exact: true }).click();
  await dialog().waitFor({ state: 'visible' });
  await dialog().locator('.agent-engine-current').waitFor();
  await dialog().getByText('正在读取执行引擎状态…', { exact: true }).waitFor({ state: 'hidden' });
  const selected = dialog().locator('input[name="agent-execution-engine"][value="dsh"]');
  assert.equal(await selected.isChecked(), true);
  assert.equal(await selected.isDisabled(), false);
  assert.equal(await dialog().getByRole('button', { name: '应用执行引擎', exact: true }).isDisabled(), true);
  await dialog().evaluate(element => { element.scrollTop = 0; });
  await snapshot('01-dsh-available-top-1440.png', 'Actual DSH selection and available runtime; no settings mutation.');
  const cards = dialog().locator('.agent-engine-plugins article');
  assert.equal(await cards.count(), 3);
  const actualNames = await cards.locator('h4').allTextContents();
  assert.deepEqual(actualNames, ['Notebook 数据分析', 'Excel 原件与 Python', '只读数据库分析']);
  // At 1000px the entire dialog fits; use a shorter desktop view so this is a
  // distinct lower-section capture rather than a duplicate full-dialog image.
  await page.setViewportSize({ width: 1440, height: 800 });
  await cards.last().scrollIntoViewIfNeeded();
  const visibility = await dialog().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('.agent-engine-plugins article')].map(card => {
      const box = card.getBoundingClientRect();
      return { fullyVisible: box.top >= bounds.top && box.bottom <= bounds.bottom, overflow: card.scrollWidth > card.clientWidth };
    });
  });
  assert.ok(visibility.every(card => card.fullyVisible && !card.overflow));
  await snapshot('02-capability-catalog-bottom-1440.png', 'Actual three capability cards; availability and authorization conditions, not execution evidence.');
  report.plugins = initial.plugins.map(({ id, name, tools }) => ({ id, name, tools }));
  const final = await settings('after');
  report.final = summary(final);
  assert.deepEqual(report.final, report.initial, 'Read-only verification must not change engine, revision or active tasks.');
  assert.equal(report.realSettingsRequests.filter(entry => entry.source === 'browser').length > 0, true);
  assert.equal(report.forbiddenRequests.length, 0);
  assert.equal(report.pageErrors.length, 0);
  assert.equal(report.routeErrors.length, 0);
  report.settingsPreserved = true;
  report.mutations = 0;
  report.realModelCalls = 0;
  report.passed = true;
} catch (error) {
  report.failure = { kind: error instanceof Error ? error.name : 'UnknownError' };
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, report: relative(process.cwd(), resolve(directory, 'report.json')).replaceAll('\\', '/') }));
}
