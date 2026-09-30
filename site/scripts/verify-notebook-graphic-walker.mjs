// Existing managed 3001; isolated local project, synthetic CSV and real SQL. No model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/graphic-walker-20260929', `notebook-${Date.now()}`), projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, checks: [], screenshots: [], errors: [], blocked: [], runs: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000); let handle, chartId;
page.on('pageerror', error => report.errors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()[header];
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && url.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON().action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath); const response = await route.fetch(); assert.equal(response.status(), 200); handle = (await response.json()).handle; return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') {
      assert.ok(handle && scope === handle); return route.continue();
    }
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox').fill(label); await navigation.getByRole('button', { name: label, exact: true }).click();
}
const editor = () => page.locator('.notebook-editor');
const chart = () => page.locator(`article[data-cell-id="${chartId}"]`);
async function snapshot(name, target = chart()) {
  await target.evaluate(element => element.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await page.screenshot({ path: join(directory, `${name}.png`) }); report.screenshots.push({ name, viewed: false });
}
async function ready(target = editor()) {
  await target.locator('.gw-canvas[data-state="ready"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(200); await target.locator('.gw-plot').getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' });
  await target.locator('.gw-plot svg').first().waitFor();
}
async function select(label, option) { await editor().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
async function save() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('.notebook-output-rename-confirmation'));
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true }); if (await rename.isVisible()) await rename.click();
  await editor().waitFor({ state: 'hidden' });
}
async function definition() {
  const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  return Object.values((await response.json()).manifest.state.dataProduct.notebooks)[0];
}
async function persisted(predicate) {
  for (let i = 0; i < 60; i++) { const doc = await definition(); if (doc && predicate(doc)) return doc; await page.waitForTimeout(150); } throw Error('Project save did not settle');
}
async function run(button, expected = 'success') {
  const promise = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 45000 });
  await button.click(); const response = await promise, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, expected, JSON.stringify(body)); await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.runs.push({ status: body.run.status, cells: body.run.cells.map(cell => ({ id: cell.cellId, status: cell.status, rows: cell.table?.rows.length })) }); return body;
}
const title = '季度成交金额 · 客户类型（模拟）';
try {
  await page.goto(base); await menu('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('Notebook Graphic Walker 隔离验收');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  const rows = Array.from({ length: 8 }, (_, q) => ['企业客户', '中小企业', '个人客户'].flatMap((segment, i) => [1, 0.5].map(r => `${2024 + Math.floor(q / 4)}-${String(q % 4 * 3 + 1).padStart(2, '0')}-01,${(q + 1) * (i + 1) * 100000 * r},${segment}`))).flat();
  await upload.locator('input[type=file]').setInputFiles({ name: 'notebook-chart-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('quarter,amount,customer\n' + rows.join('\n') + '\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill('模拟销售明细'); await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales'); await save();
  await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill('准备图表数据'); await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('chart_data');
  await editor().getByRole('textbox', { name: 'SQL', exact: true }).fill('SELECT CAST(quarter AS DATE) AS quarter, amount, customer FROM sales ORDER BY quarter'); await save();
  const sql = page.locator('article[data-cell-kind="sql"]');
  await run(sql.getByRole('button', { name: '▶ 运行', exact: true }));
  await page.getByRole('button', { name: '＋ 图表', exact: true }).click(); await ready();
  chartId = await page.locator('article[data-cell-kind="chart"]').getAttribute('data-cell-id');
  // A newly inserted, unsaved chart has the same legacy definition as an old
  // project/AI chart. Verify discovery without hover, focus or active selection.
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  const legacy = await persisted(doc => Boolean(doc.cells.find(cell => cell.id === chartId)));
  assert.equal(legacy.cells.find(cell => cell.id === chartId).graphicWalker, undefined);
  await run(chart().getByRole('button', { name: '▶ 运行', exact: true }));
  await chart().locator('.recharts-wrapper').waitFor();
  await page.getByRole('navigation', { name: 'Notebook 文档大纲' }).getByRole('button', { name: /准备图表数据/ }).click();
  await chart().evaluate(element => element.scrollIntoView({ block: 'start' })); await page.mouse.move(2, 2);
  assert.equal(await chart().evaluate(element => element.matches(':hover, :focus-within, .is-selected')), false);
  const chartEdit = chart().getByRole('button', { name: '编辑图表', exact: true });
  assert.equal(await chartEdit.evaluate(element => getComputedStyle(element).opacity), '1');
  await snapshot('00-legacy-visible-entry');
  await chartEdit.click(); await ready(); await snapshot('00-legacy-inline-editor');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  assert.deepEqual(await definition(), legacy, 'Opening and cancelling the new editor must not migrate the legacy chart');
  await chartEdit.click(); await ready();
  report.checks.push('Legacy chart has an always-visible Edit chart button without hover/focus/selection; opens inline GW; cancelling preserves the exact legacy Notebook definition.');
  await select('图表类型', '面积图'); await select('选择颜色字段', 'customer'); await select('X 轴 quarter 日期粒度', '季度');
  await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await editor().getByRole('textbox', { name: '图表标题' }).fill(title); await select('堆叠方式', '堆叠');
  await editor().getByRole('tab', { name: 'Data · 数据' }).click(); await ready();
  assert.match(await editor().locator('.gw-canvas footer').innerText(), /48 行.*24 个/s);
  assert.ok((await editor().locator('.gw-results tbody').textContent()).includes('150,000'));
  const quarters = await editor().locator('.gw-results tbody tr td:first-child').allTextContents();
  assert.equal(quarters[0], '2024 Q1'); assert.equal(quarters.at(-1), '2025 Q4');
  assert.match(await editor().locator('.gw-plot path[aria-label]').first().getAttribute('aria-label'), /2024 Q1/);
  await snapshot('01-notebook-inline-area');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '放弃未保存的图表修改？' }); await confirmation.waitFor(); await snapshot('02-cancel-confirmation');
  await confirmation.getByRole('button', { name: '继续编辑' }).click(); await ready();
  await editor().getByRole('button', { name: '移除 Y 轴 amount', exact: true }).click(); await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().getByRole('alert').filter({ hasText: 'Y 轴' }).waitFor(); await snapshot('03-missing-axis');
  await editor().getByRole('button', { name: '撤销', exact: true }).click(); await ready(); await save();
  const doc = await persisted(doc => Boolean(doc.cells.find(cell => cell.id === chartId)?.graphicWalker));
  const config = doc.cells.find(cell => cell.id === chartId).graphicWalker;
  assert.equal(config.channels.color.field, 'customer'); assert.equal(config.style.stack, 'stack');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('datacanvas:chart-editor:')).length), 0);
  const body = await run(chart().getByRole('button', { name: '▶ 运行', exact: true }));
  assert.deepEqual(body.run.cells.at(-1).table.fields.map(field => field.name), ['quarter', 'amount', 'customer']); await ready(chart());
  assert.match(await chart().locator('.gw-canvas footer').innerText(), /48 行.*24 个/s); await snapshot('04-saved-notebook-chart');
  assert.equal(await chart().getByRole('button', { name: '生成看板预览 ↗', exact: true }).count(), 0);
  report.checks.push('Real CSV → SQL → inline GW, color/quarter/stack aggregation, cancel-continue, missing-axis refusal, save into Notebook (not local chart cache), run preserves 3 columns and 48 input rows → 24 groups.');
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready();
  await select('筛选字段', 'customer'); await select('筛选值', '企业客户'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click(); await ready();
  assert.match(await editor().locator('.gw-canvas footer').innerText(), /8 个/); await snapshot('05-filter');
  await select('选择水平分面字段', 'customer'); await ready(); await snapshot('06-facet');
  await editor().getByRole('button', { name: '移除 水平分面 customer' }).click();
  await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await select('配色', '湖蓝'); await ready(); await save();
  await persisted(doc => doc.cells.find(cell => cell.id === chartId)?.graphicWalker.style.palette === 'blue');
  await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await ready(chart()); assert.match(await chart().locator('.gw-canvas footer').innerText(), /8 个/);
  const downloadPromise = page.waitForEvent('download'); await chart().getByRole('button', { name: '导出 PNG', exact: true }).click(); const download = await downloadPromise; await download.saveAs(join(directory, 'notebook-chart.png'));
  assert.ok((await readFile(join(directory, 'notebook-chart.png'))).length > 1000);
  report.checks.push('Filter/facet/style use same configuration; rerun keeps filter; PNG export yields a real image.');
  await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  assert.deepEqual((await definition()).cells.find(cell => cell.id === chartId).graphicWalker.filters, [{ field: 'customer', kind: 'oneOf', values: ['企业客户'] }]);
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await editor().getByText(/等待上游数据/).first().waitFor();
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').filter({ hasText: '先运行上游' }).waitFor(); await snapshot('07-reopen-no-stale-data');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await ready(chart()); assert.match(await chart().locator('.gw-canvas footer').innerText(), /8 个/); await snapshot('08-restored-chart');
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready();
  await page.setViewportSize({ width: 1024, height: 1080 }); await ready(); await snapshot('09-notebook-1024');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.setViewportSize({ width: 1680, height: 1080 }); await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await editor().getByRole('textbox', { name: '图表标题' }).fill('将被取消');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await confirmation.getByRole('button', { name: '放弃修改并退出' }).click();
  assert.equal((await definition()).cells.find(cell => cell.id === chartId).title, title);
  report.checks.push('Local project reload retains config, no stale upstream data displayed; rerun restores chart; 1024px and discard preserve saved definition.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
