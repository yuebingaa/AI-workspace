// Real 3001, synthetic run-owned project; never opens user projects or calls a model.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/notebook-document-20260927', `${baseline ? 'before' : 'after'}-${Date.now()}`);
const projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, baseline, base, projectPath, screenshots: [], checks: [], errors: [], blocked: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on('pageerror', error => report.errors.push(error.message));
let handle, held = false, release;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()['x-agentcanvas-project'];
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && url.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON()?.action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath);
      const response = await route.fetch(); assert.equal(response.status(), 200); handle = (await response.json()).handle;
      return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') {
      assert.ok(handle && scope === handle, 'Outside owned project');
      if (url.pathname === '/api/notebook/run' && held) { await new Promise(done => { release = done; }); return route.abort('aborted'); }
      return route.continue();
    }
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    throw Error(`Unexpected API: ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox').fill(label); await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function manifest() {
  assert.ok(handle);
  const response = await context.request.get(base + '/api/projects', { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return (await response.json()).manifest;
}
async function shot(name, scenario) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator('[data-vinext-dev-error-overlay]').count(), 0, 'Development build overlay must not be counted as a passing screenshot');
  const bounds = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
    cellHeights: [...document.querySelectorAll('.notebook-cells > article')].slice(0, 3).map(element => Math.round(element.getBoundingClientRect().height)),
    header: document.querySelector('.notebook-heading').getBoundingClientRect().toJSON() }));
  assert.ok(bounds.overflow <= 1, JSON.stringify(bounds));
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${name}.png`, scenario, bounds, visuallyReviewed: false });
}
async function runAll() {
  const result = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 45000 });
  await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click();
  const response = await result, body = await response.json();
  assert.equal(body.run.status, 'success', JSON.stringify(body)); assert.equal(body.run.cells.length, 10);
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.checks.push('Ten synthetic cells execute via real Notebook API');
}
const panel = () => page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const cell = id => page.locator(`.notebook-cells > article[data-cell-id="${id}"]`);
try {
  await page.goto(base, { waitUntil: 'networkidle' }); await menu('数据浏览器');
  const browserDialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await browserDialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await browserDialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await browserDialog.getByLabel('项目名称', { exact: true }).fill('文档布局隔离验收');
  await browserDialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await browserDialog.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  const rows = Array.from({ length: 8 }, (_, i) => ['企业客户', '成长客户', '小型客户'].map((segment, j) => `${2024 + Math.floor(i / 4)} Q${i % 4 + 1},${segment},${(i + 1) * (j + 1) * 900},${(i + 1) * (j + 1) * 500}`)).flat();
  await upload.locator('input[type=file]').setInputFiles({ name: 'synthetic-sales.csv', mimeType: 'text/csv', buffer: Buffer.from('quarter,segment,amount,cost\n' + rows.join('\n') + '\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await page.locator('.notebook-editor').getByRole('button', { name: '保存单元', exact: true }).click();
  await page.locator('.notebook-editor').waitFor({ state: 'hidden' });
  let data, key;
  for (let i = 0; i < 60; i++) {
    data = await manifest(); key = Object.keys(data.state?.dataProduct.notebooks ?? {}).find(id => data.state.dataProduct.notebooks[id].cells.length);
    if (key) break; await page.waitForTimeout(100);
  }
  assert.ok(key); const source = data.state.dataProduct.notebooks[key].cells[0];
  const sql = (id, title, outputName, query) => ({ id, kind: 'sql', title, outputName, inputCellIds: ['source'], sql: query });
  const cells = [
    { ...source, id: 'source', title: '季度销售明细', outputName: 'sales' },
    { ...source, id: 'reference', title: '客户分层参考', outputName: 'reference_sales' },
    sql('overview', '数据概览', 'overview', 'SELECT COUNT(*) AS records, SUM(amount) AS revenue, SUM(cost) AS cost\nFROM sales'),
    sql('quarters', '按季度汇总销售额与成本', 'quarterly', 'SELECT quarter, SUM(amount) AS revenue, SUM(cost) AS cost\nFROM sales\nGROUP BY quarter\nORDER BY quarter'),
    { id: 'trend', kind: 'chart', title: '季度销售趋势', inputCellId: 'quarters', chartType: 'area', categoryField: 'quarter', valueFields: ['revenue', 'cost'] },
    sql('segments', '客户分层收入贡献', 'segments', 'SELECT segment, SUM(amount) AS revenue\nFROM sales GROUP BY segment ORDER BY revenue DESC'),
    { id: 'contribution', kind: 'chart', title: '客户分层对比', inputCellId: 'segments', chartType: 'bar', categoryField: 'segment', valueFields: ['revenue'] },
    { id: 'summary', kind: 'table', title: '分层汇总明细', inputCellId: 'segments', columns: ['segment', 'revenue'] },
    { id: 'note', kind: 'text', title: '分析口径', markdown: '本页使用隔离的合成数据，按季度和客户分层汇总销售额与成本。\n金额仅用于验证界面，不代表业务结论。' },
    sql('latest', '最近季度明细', 'latest', "SELECT segment, amount, cost FROM sales\nWHERE quarter = '2025 Q4' ORDER BY amount DESC"),
  ];
  data.state.dataProduct.notebooks[key] = { ...data.state.dataProduct.notebooks[key], name: '季度销售分析', revision: 2, cells };
  const saved = await context.request.post(base + '/api/projects', { headers: { 'x-agentcanvas-project': handle, origin: base }, data: { action: 'save', stateRevision: data.stateRevision, state: data.state } });
  assert.equal(saved.status(), 200, await saved.text());
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.notebook-cells > article').length === 10);
  await shot('01-default-before-run', 'Ten-cell document opens with its default browsing layout, no forced source preference');
  await runAll(); await panel().evaluate(element => { element.scrollTop = 0; });
  await shot('02-default-results', 'Real results in the default document layout');
  if (!baseline) {
    const formal = (await manifest()).state.dataProduct.notebooks[key];
    assert.equal(await cell('source').locator('.notebook-cell-output').isVisible(), false);
    await cell('source').getByRole('button', { name: '展开结果', exact: true }).click();
    assert.equal(await cell('source').locator('.notebook-table-scroll').isVisible(), true);
    await cell('source').getByRole('button', { name: '收起结果', exact: true }).click();
    assert.equal(await cell('quarters').getByRole('region', { name: '按季度汇总销售额与成本 SQL', exact: true }).isVisible(), true);
    const outline = page.getByRole('navigation', { name: 'Notebook 文档大纲', exact: true });
    await outline.getByRole('button', { name: /季度销售趋势/u }).click();
    await cell('trend').locator('.recharts-surface').first().waitFor();
    assert.equal(await cell('trend').locator('.notebook-table-scroll').isVisible(), false);
    await shot('03-chart-default', 'Outline jumps to a chart; chart shown without duplicating its table');
    await cell('trend').getByRole('button', { name: '数据', exact: true }).click();
    await cell('trend').getByRole('searchbox').waitFor();
    await shot('04-chart-data', 'Chart data can be inspected using the mature table');
    await cell('trend').getByRole('button', { name: '图表', exact: true }).click();
    await cell('trend').getByRole('button', { name: '更多操作', exact: true }).click();
    const actions = page.getByRole('dialog', { name: '季度销售趋势的更多操作', exact: true });
    await shot('05-cell-menu', 'Low-frequency actions grouped in a keyboard-accessible Radix popover');
    await page.keyboard.press('Escape'); assert.equal(await cell('trend').getByRole('button', { name: '更多操作', exact: true }).evaluate(element => element === document.activeElement), true);
    await cell('trend').getByRole('button', { name: '更多操作', exact: true }).click();
    await actions.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '保留', exact: true }).click();
    assert.deepEqual((await manifest()).state.dataProduct.notebooks[key], formal);
    report.checks.push('Default sources collapsed, SQL visible, chart/data switching, outline navigation, menu focus and cancelled deletion preserve formal document');
    await outline.getByRole('button', { name: /数据概览/u }).click();
    await cell('overview').getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.locator('.notebook-editor');
    await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill('SELECT missing_column FROM sales');
    await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    const failure = page.waitForResponse(response => response.url() === base + '/api/notebook/run');
    await cell('overview').getByRole('button', { name: '▶ 运行', exact: true }).click();
    assert.equal((await (await failure).json()).run.status, 'failure');
    await shot('06-query-failed', 'Actual invalid SQL remains visible with its execution error');
    await cell('overview').getByRole('button', { name: '编辑', exact: true }).click();
    await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill(cells[2].sql); await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    held = true; await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.notebook-cell-status')].filter(element => element.textContent.includes('等待结果')).length === 10);
    assert.equal(await page.locator('.notebook-cell-status').filter({ hasText: '运行中' }).count(), 0);
    await panel().evaluate(element => { element.scrollTop = 0; }); await shot('07-waiting-results', 'Held HTTP response; cells honestly wait for results rather than pretending to run concurrently');
    await page.getByRole('button', { name: '停止运行', exact: true }).click(); release?.(); held = false;
    await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
    await shot('08-cancelled', 'Cancellation restores controls and keeps the document usable');
    await runAll(); report.checks.push('Actual SQL failure and recovery; explicit held-response cancellation; no fabricated cell progress');
    await page.setViewportSize({ width: 1024, height: 1000 }); await panel().evaluate(element => { element.scrollTop = 0; });
    await shot('09-default-1024', 'Minimum desktop width; compact title, controls and source/result layout');
    await page.getByLabel('Notebook 设置', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'AI 分析后自动运行 Notebook', exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: '参数自动重算', exact: true }).isChecked(), false);
    await shot('09a-settings-1024', 'Runtime settings remain accessible in the compact header; opening settings does not enable parameter execution');
    await page.getByRole('checkbox', { name: '参数自动重算', exact: true }).focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.notebook-document-options').evaluate(element => element.open), false);
    assert.equal(await page.getByLabel('Notebook 设置', { exact: true }).evaluate(element => element === document.activeElement), true);
    report.checks.push('Settings remain accessible at 1024px; Escape returns focus without changing execution switches');
    await page.setViewportSize({ width: 1680, height: 1080 }); await outline.getByRole('button', { name: /最近季度明细/u }).click();
    const header = await page.locator('.notebook-heading').boundingBox(), viewport = await panel().boundingBox();
    assert.ok(Math.abs(header.y - viewport.y) < 3, 'Notebook controls must remain reachable while scrolling');
    await shot('10-sticky-toolbar', 'Scrolled document keeps title and run/stop controls in view');
    const beforeReload = (await manifest()).state.dataProduct.notebooks[key];
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.deepEqual((await manifest()).state.dataProduct.notebooks[key], beforeReload);
    report.checks.push('Project reload preserves all ten cells; layout preferences do not write the definition');
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
} finally {
  release?.(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }, null, 2)); await browser.close();
}
