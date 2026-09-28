// Uses a new browser and run-owned project with synthetic CSVs on 3001 only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chooseUiOption } from './fixtures/ui-controls.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/semantic-form-ui-20260927', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, base, projectPath, checks: [], screenshots: [], pageErrors: [], blocked: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => report.pageErrors.push(error.message));
let handle;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  try {
    assert.equal(url.origin, base, 'External requests prohibited');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()['x-agentcanvas-project'];
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && !scope && url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
    if (method === 'GET' && !scope && url.pathname === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON()?.action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath);
      const response = await route.fetch(); assert.equal(response.status(), 200, await response.text());
      handle = (await response.json()).handle; assert.ok(handle);
      return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets')) {
      assert.ok(handle && handle === scope, 'Request outside run-owned project');
      return route.continue();
    }
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    throw new Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
async function menu(label) {
  const notices = page.getByRole('button', { name: '知道了', exact: true });
  while (await notices.count()) await notices.first().click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await nav.getByRole('textbox').fill(label);
  await nav.getByRole('button', { name: label, exact: true }).click();
}
const manager = page.getByRole('dialog', { name: '语义模型管理', exact: true });
async function focused(locator) {
  for (let i = 0; i < 60; i++) {
    if (await locator.evaluate(el => document.activeElement === el)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Focus did not move to ' + await locator.getAttribute('aria-label'));
}
async function shot(file, scenario) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await page.locator('.semantic-dialog').evaluate(element => {
    const rect = element.getBoundingClientRect(), footer = element.querySelector('footer').getBoundingClientRect();
    const form = element.querySelector('form');
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, footerBottom: footer.bottom,
      width: innerWidth, height: innerHeight, formOverflow: form.scrollWidth - form.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, JSON.stringify(bounds));
  assert.ok(bounds.footerBottom <= bounds.height && bounds.formOverflow <= 1 && bounds.pageOverflow <= 1);
  await page.screenshot({ path: join(directory, file + '.png'), animations: 'disabled' });
  report.screenshots.push({ file: file + '.png', scenario, bounds, visuallyReviewed: false });
}
async function models() {
  const response = await context.request.get(base + '/api/projects', { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200);
  const state = (await response.json()).manifest.state;
  assert.ok(state, 'Initial project state must have persisted before checking model changes');
  return state.dataProduct.semanticLayer.models;
}
async function waitSaved(count) {
  for (let i = 0; i < 100; i++) { const value = await models(); if (value.length === count) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Model not persisted');
}
async function chooseSource(name) {
  await manager.getByRole('combobox', { name: '来源数据表', exact: true }).click();
  await page.getByRole('option').filter({ hasText: name }).click();
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await menu('数据浏览器');
  const browserDialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await browserDialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await browserDialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await browserDialog.getByLabel('项目名称', { exact: true }).fill('语义表单隔离验收');
  await browserDialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await browserDialog.waitFor({ state: 'hidden' });
  await menu('导入表格');
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles([
    { name: 'semantic-primary.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\n华东,100\n华东,50\n华南,80\n') },
    { name: 'semantic-alternate.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\n华北,20\n') },
  ]);
  await upload.getByRole('button', { name: '导入 2 份文件', exact: true }).click();
  await upload.waitFor({ state: 'hidden' });
  // Project autosave is debounced; a freshly created manifest starts with state: null.
  await page.getByText('已保存到本地项目', { exact: true }).first().waitFor();
  await menu('语义模型'); await manager.waitFor();
  await shot('01-empty-form-1440', 'Three sections, consistent controls and visible footer.');
  await manager.getByRole('button', { name: '保存并选择', exact: true }).click();
  await manager.getByText('至少添加一个指标，最多 20 个。', { exact: true }).waitFor();
  await focused(manager.getByLabel('模型名称', { exact: true }));
  assert.equal(await models().then(value => value.length), 0);
  await shot('02-required-error-1440', 'Missing name and measure are explained beside their controls; first invalid field receives focus.');
  await manager.getByLabel('模型名称', { exact: true }).fill('地区金额分析');
  await chooseSource('semantic-primary');
  await manager.getByRole('button', { name: '＋ 添加维度', exact: true }).click();
  await manager.getByRole('button', { name: '＋ 添加指标', exact: true }).click();
  await manager.getByLabel('维度1名称', { exact: true }).fill('地区');
  await manager.getByLabel('指标1名称', { exact: true }).fill('金额合计');
  assert.match(await manager.getByRole('combobox', { name: '指标1计算方式', exact: true }).innerText(), /求和/u);
  await chooseUiOption(page, manager.getByRole('combobox', { name: '指标1计算方式', exact: true }), 'sum');
  const field = manager.getByRole('combobox', { name: '指标1字段', exact: true });
  await field.click();
  await page.getByRole('combobox', { name: '搜索指标1字段', exact: true }).fill('不存在xyz');
  await page.getByText('没有匹配项，换个关键词试试。', { exact: true }).waitFor();
  await shot('03-search-empty-1440', 'Searchable field picker with readable empty state.');
  await page.keyboard.press('Escape');
  await page.locator('.ui-combobox-content').waitFor({ state: 'hidden' });
  await focused(field);
  await field.press('ArrowDown');
  await page.getByRole('combobox', { name: '搜索指标1字段', exact: true }).fill('amount');
  await page.keyboard.press('Enter');
  await page.locator('.ui-combobox-content').waitFor({ state: 'hidden' });
  await manager.getByLabel('指标1标识', { exact: true }).fill('dimension_1');
  await manager.getByRole('button', { name: '预览计算', exact: true }).click();
  assert.equal(await manager.getByText('这个标识已被使用，维度和指标的标识需各不相同。', { exact: true }).count(), 2);
  await shot('04-duplicate-key-1440', 'Duplicate cross-kind identifiers are marked at both fields.');
  await manager.getByLabel('指标1标识', { exact: true }).fill('total_amount');
  await manager.getByRole('button', { name: '预览计算', exact: true }).click();
  await manager.locator('.semantic-preview').getByText('150', { exact: true }).waitFor();
  assert.equal(await manager.locator('.semantic-preview').getByText('80', { exact: true }).count(), 1);
  await shot('05-preview-success-1440', 'Real local preview groups 100 + 50 into 150 and keeps 80 in its region.');
  report.checks.push('Required and duplicate validation; numeric default; keyboard search/selection/Escape/focus; real aggregation preview.');
  await chooseSource('semantic-alternate');
  const confirmation = page.getByRole('alertdialog', { name: '更换来源数据表？', exact: true });
  await confirmation.waitFor();
  await focused(confirmation.getByRole('button', { name: '保留当前数据表', exact: true }));
  await shot('06-source-confirmation-1440', 'Nested Radix confirmation focuses the non-destructive action.');
  await confirmation.getByRole('button', { name: '保留当前数据表', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.match(await manager.getByRole('combobox', { name: '来源数据表', exact: true }).innerText(), /semantic-primary/u);
  assert.equal(await manager.getByLabel('指标1标识', { exact: true }).inputValue(), 'total_amount');
  await shot('07-source-cancelled-1440', 'Cancelling source change retains draft members and selected source.');
  await manager.getByRole('button', { name: '保存并选择', exact: true }).click();
  await manager.waitFor({ state: 'hidden' });
  const saved = (await waitSaved(1))[0]; assert.equal(saved.name, '地区金额分析');
  await menu('语义模型');
  await manager.getByRole('button', { name: /地区金额分析.*1 个指标/u }).click();
  assert.equal(await manager.getByLabel('模型名称', { exact: true }).inputValue(), saved.name);
  await chooseSource('semantic-alternate');
  await confirmation.getByRole('button', { name: '更换并重新定义', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(await manager.locator('.semantic-member').count(), 0);
  assert.deepEqual((await models())[0], saved);
  await manager.getByRole('button', { name: '取消', exact: true }).click();
  await manager.waitFor({ state: 'hidden' });
  await menu('语义模型');
  await manager.getByRole('button', { name: /地区金额分析.*1 个指标/u }).click();
  assert.equal(await manager.locator('.semantic-member').count(), 2);
  await page.setViewportSize({ width: 1024, height: 800 });
  await shot('08-saved-model-1024', 'Saved model reopens unchanged after cancelling a source-reset draft; desktop 1024 width.');
  await manager.getByRole('button', { name: '预览计算', exact: true }).click();
  await manager.locator('.semantic-preview').getByText('150', { exact: true }).waitFor();
  await shot('09-preview-1024', 'Preview remains readable and footer available at 1024 px.');
  await page.keyboard.press('Escape');
  await manager.waitFor({ state: 'hidden' });
  report.checks.push('Nested source confirmation cancel preserves draft; confirmed source reset only changes draft; save persists; cancel discards edits; reopen and 1024 layout; outer Escape closes.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blocked, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error);
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks }));
}
