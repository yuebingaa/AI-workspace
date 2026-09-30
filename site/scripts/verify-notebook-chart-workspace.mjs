// Managed 3001 only. Synthetic project; no AI, user project, or external database access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/notebook-chart-workspace-20260929', `browser-${Date.now()}`), projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, projectPath, screenshots: [], checks: [], errors: [], blocked: [], runs: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
let handle;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()[header];
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || ['/api/settings/ai', '/api/notebook/python', '/api/agent-engine'].includes(url.pathname))) return route.continue();
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON().action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath); const response = await route.fetch(); assert.equal(response.status(), 200);
      handle = (await response.json()).handle; return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') { assert.ok(handle && scope === handle); return route.continue(); }
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort(); }
});
const page = await context.newPage(); page.setDefaultTimeout(25000);
page.on('pageerror', error => report.errors.push(error.message));
const chart = () => page.locator('article[data-cell-kind="chart"]').first();
const editor = () => chart().locator('.notebook-editor');
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await nav.getByRole('textbox').fill(label); await nav.getByRole('button', { name: label, exact: true }).click();
}
async function definition() {
  const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  return Object.values((await response.json()).manifest.state.dataProduct.notebooks)[0];
}
async function settled(predicate) {
  for (let i = 0; i < 90; i++) { const doc = await definition(); if (doc && predicate(doc)) return doc; await page.waitForTimeout(150); }
  throw Error('Save did not settle');
}
async function select(label, option) { await editor().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
async function ready() { await editor().locator('.gw-canvas[data-state="ready"]').waitFor({ timeout: 45000 }); await editor().locator('.gw-plot svg').first().waitFor(); }
async function visiblePanels() {
  await editor().getByRole('complementary', { name: '数据字段库', exact: true }).waitFor();
  await editor().getByRole('complementary', { name: '图表配置面板', exact: true }).waitFor();
  assert.ok(await editor().getByRole('tab', { name: 'Data · 数据', exact: true }).isVisible());
  assert.ok(await editor().getByRole('tab', { name: 'Style · 样式', exact: true }).isVisible());
  assert.equal(await chart().locator('.notebook-inline-chart-workspace').evaluate(element => getComputedStyle(element).display), 'block', 'Legacy chart grid must not constrain the complete editor');
}
async function shot(name) {
  await chart().evaluate(element => element.scrollIntoView({ block: 'start' })); await page.waitForTimeout(350);
  await page.screenshot({ path: join(directory, name + '.png') }); report.screenshots.push({ name, viewed: false });
}
async function save() {
  const previous = (await definition()).revision; await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  const saved = await settled(doc => doc.revision > previous); await visiblePanels(); return saved;
}
async function run(button) {
  const pending = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 90000 });
  await button.click(); const response = await pending, data = await response.json(); assert.equal(response.status(), 200); assert.equal(data.run.status, 'success', JSON.stringify(data));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.runs.push(data.run); return data.run;
}
try {
  await page.goto(base); await menu('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('Notebook 常驻图表编辑 · 模拟验收');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  const rows = Array.from({ length: 8 }, (_, q) => ['企业客户', '中小企业', '个人客户'].flatMap((segment, i) => [1, 0.5].map(r => `${2024 + Math.floor(q / 4)}-${String(q % 4 * 3 + 1).padStart(2, '0')}-01,${(q + 1) * (i + 1) * 100000 * r},${segment}`))).flat();
  await upload.locator('input[type=file]').setInputFiles({ name: '模拟季度销售.csv', mimeType: 'text/csv', buffer: Buffer.from('季度,成交金额,客户类型\n' + rows.join('\n') + '\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  const dataEditor = page.locator('.notebook-editor');
  await dataEditor.getByLabel('单元名称', { exact: true }).fill('模拟销售明细');
  await dataEditor.getByRole('button', { name: '保存单元', exact: true }).click(); await dataEditor.waitFor({ state: 'hidden' });
  await run(page.locator('article[data-cell-kind="data"]').getByRole('button', { name: '▶ 运行', exact: true }));
  await page.getByRole('button', { name: '＋ 图表', exact: true }).click(); await ready(); await visiblePanels();
  await select('图表类型', '面积图'); await select('X 轴 季度 日期粒度', '季度');
  await editor().getByRole('button', { name: '添加字段 客户类型', exact: true }).dragTo(editor().getByRole('region', { name: '颜色', exact: true }));
  await editor().getByRole('button', { name: '移除 颜色 客户类型', exact: true }).waitFor();
  await editor().getByRole('tab', { name: 'Style · 样式', exact: true }).click();
  await editor().getByRole('textbox', { name: '图表标题', exact: true }).fill('季度成交金额 · 客户类型（模拟）'); await select('堆叠方式', '堆叠');
  await editor().getByRole('tab', { name: 'Data · 数据', exact: true }).click(); await ready();
  await save(); const saved = await definition();
  // CSV keeps Chinese display labels and assigns normalized internal field IDs.
  assert.equal(saved.cells.find(cell => cell.kind === 'chart').graphicWalker.channels.color.field, 'field_3');
  await shot('01-saved-editor-still-expanded');
  const executed = await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await ready(); await visiblePanels();
  const table = executed.cells.find(cell => cell.visualization).visualization.table;
  assert.equal(table.rows.length, 24);
  for (const row of table.rows) { const date = new Date(row.viz_x), q = (date.getUTCFullYear() - 2024) * 4 + date.getUTCMonth() / 3;
    const index = ['企业客户', '中小企业', '个人客户'].indexOf(row.viz_color); assert.equal(row.viz_y, (q + 1) * (index + 1) * 150000); }
  await shot('02-run-keeps-field-library-and-config');
  const resultToggle = chart().locator('.notebook-chart-saved-result > summary');
  await resultToggle.click(); await chart().locator('.gw-materialized-canvas[data-state="ready"]').waitFor();
  await visiblePanels(); await resultToggle.click();
  report.checks.push('No Edit click: save and real full-input run retain field library, Data/Style and canvas; 48 rows → 24 grouped sums independently checked.');
  await select('筛选字段', '客户类型'); await select('筛选值', '企业客户'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click();
  await select('选择水平分面字段', '客户类型'); await ready(); await shot('03-filter-and-facet-preview');
  assert.ok(await chart().getByRole('button', { name: '▶ 运行', exact: true }).isDisabled());
  assert.ok(await chart().getByRole('button', { name: '官方原生布局', exact: true }).isDisabled());
  await editor().getByRole('button', { name: '放弃修改', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '放弃未保存的图表修改？', exact: true }); await confirm.waitFor(); await shot('04-discard-confirmation');
  await confirm.getByRole('button', { name: '继续编辑', exact: true }).click();
  await editor().getByRole('button', { name: '放弃修改', exact: true }).click(); await confirm.getByRole('button', { name: '放弃修改并退出', exact: true }).click();
  await ready(); await visiblePanels(); assert.deepEqual(await definition(), saved);
  await editor().getByRole('button', { name: '移除 Y 轴 成交金额', exact: true }).click(); await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().getByRole('alert').filter({ hasText: 'Y 轴' }).waitFor(); assert.deepEqual(await definition(), saved); await shot('05-invalid-axis-refused');
  await editor().getByRole('button', { name: '撤销', exact: true }).click(); await ready();
  report.checks.push('Field drag, filters, facet, cancellation/continue/discard, invalid-axis refusal and undo verified without altering saved document. Dirty edits lock execution/layout switching.');
  await chart().getByRole('button', { name: '官方原生布局', exact: true }).click();
  await chart().getByRole('region', { name: 'Graphic Walker 官方编辑器', exact: true }).waitFor();
  await chart().locator('.native-chart-surface').getByText('字段列表', { exact: true }).waitFor(); await shot('06-official-layout-available');
  await chart().getByRole('button', { name: 'Data / Style 布局', exact: true }).click(); await ready();
  await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await visiblePanels();
  await editor().locator('.gw-canvas[data-state="waiting"]').waitFor(); assert.deepEqual(await definition(), saved); await shot('07-reopen-default-panels-no-stale-data');
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().getByRole('alert').filter({ hasText: '先运行上游' }).waitFor(); assert.deepEqual(await definition(), saved);
  await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await ready(); await visiblePanels();
  await editor().getByRole('alert').waitFor({ state: 'hidden' }); await shot('08-reopened-and-rerun');
  await page.setViewportSize({ width: 1024, height: 1000 }); await visiblePanels(); await shot('09-narrow-keeps-left-panels');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  report.checks.push('Official native editor is still available; reload defaults to expanded fields/config with honest empty state. Rerun restores data; 1024px never auto-hides field library, overflow stays inside editor.');
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.getByRole('button', { name: '＋ 图表', exact: true }).click();
  const second = page.locator('article[data-cell-kind="chart"]').nth(1);
  await second.getByRole('tab', { name: 'Style · 样式', exact: true }).click();
  const titleInput = second.getByRole('textbox', { name: '图表标题', exact: true }); await titleInput.fill('第二张图的局部编辑（模拟）');
  assert.ok(await titleInput.evaluate(element => document.activeElement === element));
  assert.ok(await chart().locator('.notebook-gw-host').evaluate(element => element.inert));
  assert.ok(await second.getByRole('button', { name: '保存单元', exact: true }).isEnabled());
  assert.deepEqual((await definition()).cells.find(cell => cell.id === saved.cells[1].id), saved.cells[1]);
  await second.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(directory, '10-second-chart-focus-and-lock.png') }); report.screenshots.push({ name: '10-second-chart-focus-and-lock', viewed: false });
  await second.getByRole('button', { name: '放弃修改', exact: true }).click(); await confirm.getByRole('button', { name: '放弃修改并退出', exact: true }).click();
  assert.ok(await chart().getByRole('button', { name: '▶ 运行', exact: true }).isEnabled());
  report.checks.push('Two always-open chart editors: editing the second retains focus, locks the first, leaves its saved config unchanged, and discard releases the run lock.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await writeFile(join(directory, 'failure-dom.txt'), await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
