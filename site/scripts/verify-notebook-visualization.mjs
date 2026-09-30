// Product UI, real project/CSV/SQL on managed 3001. Synthetic data only, no model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const legacyOnly = process.argv.includes('--legacy');
const facetsOnly = process.argv.includes('--facets');
const directory = resolve('.runtime/visualization-notebook-20260929', `browser-${Date.now()}`), projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, projectPath, checks: [], screenshots: [], errors: [], blocked: [], runs: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(25000); let handle, chartId;
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
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') { assert.ok(handle && scope === handle); return route.continue(); }
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
async function snapshot(name) {
  await chart().evaluate(element => element.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await page.screenshot({ path: join(directory, `${name}.png`) }); report.screenshots.push({ name, viewed: false });
}
async function ready(target = editor()) {
  await target.locator('.gw-canvas[data-state="ready"]').waitFor({ timeout: 45000 }); await page.waitForTimeout(250);
  await target.locator('.gw-plot').getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' }); await target.locator('.gw-plot svg').first().waitFor();
}
async function select(label, option) { await editor().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
async function save() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('.notebook-output-rename-confirmation'));
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true }); if (await rename.isVisible()) await rename.click(); await editor().waitFor({ state: 'hidden' });
}
async function definition() {
  const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  return Object.values((await response.json()).manifest.state.dataProduct.notebooks)[0];
}
async function persisted(predicate) {
  for (let i = 0; i < 60; i++) { const doc = await definition(); if (doc && predicate(doc)) return doc; await page.waitForTimeout(150); } throw Error('Project save did not settle');
}
async function run(button) {
  const promise = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 45000 });
  await button.click(); const response = await promise, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, 'success', JSON.stringify(body)); await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.runs.push({ status: body.run.status, cells: body.run.cells.map(cell => ({ id: cell.cellId, status: cell.status, preview: cell.table?.rows.length, visual: cell.visualization?.visualResult, notice: cell.visualizationNotice })) }); return body.run;
}
const title = '季度成交金额 · 客户类型（模拟数据）';
const rows = Array.from({ length: legacyOnly ? 8 : facetsOnly ? 2500 : 1250 }, (_, i) => { const q = i % 8; return {
  quarter: `${2024 + Math.floor(q / 4)}-${String(q % 4 * 3 + 1).padStart(2, '0')}-01`, amount: (q + 1) * 1000 + i,
  segment: ['企业客户', '中小企业', '个人客户'][Math.floor(i / 8) % 3],
  ...(facetsOnly ? { region: ['东区', '西区'][Math.floor(i / 24) % 2], channel: ['直销', '伙伴'][Math.floor(i / 48) % 2], customer: `客户${i % 50}` } : {}),
}; });
const totals = new Map(); for (const row of rows) { const key = row.quarter + '|' + row.segment; totals.set(key, (totals.get(key) ?? 0) + row.amount); }
try {
  await page.goto(base); await menu('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('完整图表计算 · 隔离模拟项目');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type=file]').setInputFiles({ name: `synthetic-sales-${rows.length}.csv`, mimeType: 'text/csv', buffer: Buffer.from(`季度,成交金额,客户类型${facetsOnly ? ',地区,渠道,客户编号' : ''}\n` + rows.map(r => `${r.quarter},${r.amount},${r.segment}${facetsOnly ? `,${r.region},${r.channel},${r.customer}` : ''}`).join('\n') + '\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(`模拟销售明细 · ${rows.length} 行`); await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales'); await save();
  const sourceRun = await run(page.locator('article[data-cell-kind="data"]').getByRole('button', { name: '▶ 运行', exact: true }));
  assert.equal(sourceRun.cells[0].table.rows.length, Math.min(100, rows.length)); assert.equal(sourceRun.cells[0].resultRef.rowCount, rows.length);
  await page.getByRole('button', { name: '＋ 图表', exact: true }).click(); await ready();
  chartId = await page.locator('article[data-cell-kind="chart"]').getAttribute('data-cell-id');
  if (legacyOnly) {
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
    const before = await persisted(doc => Boolean(doc.cells.find(cell => cell.id === chartId)));
    assert.equal(before.cells.find(cell => cell.id === chartId).graphicWalker, undefined);
    const result = (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1);
    assert.equal(result.visualization.visualResult.mode, 'rows'); assert.equal(result.visualization.table.rows.length, 8);
    assert.deepEqual(result.visualization.table.rows.map(row => row.viz_y), rows.map(row => row.amount));
    await ready(chart()); await snapshot('12-legacy-formal-gw');
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await snapshot('13-legacy-editor');
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
    assert.deepEqual(await definition(), before);
    report.checks.push('Legacy chart without graphicWalker renders using formal GW rows mode; all eight amounts and exact saved definition preserved after opening/cancelling editor.');
  } else if (facetsOnly) {
    const validate = (result, xFacet = true, yFacet = true, segment) => {
      assert.equal(result.visualization.visualResult.inputRowCount, 2500);
      assert.equal(result.visualizationNotice, undefined);
      const expected = new Map();
      for (const row of rows.filter(row => !segment || row.segment === segment)) {
        const key = JSON.stringify([row.quarter, row.segment, ...(xFacet ? [row.region] : []), ...(yFacet ? [row.channel] : [])]);
        const value = expected.get(key) ?? { sum: 0, count: 0 }; value.sum += row.amount; value.count++; expected.set(key, value);
      }
      assert.equal(result.visualization.table.rows.length, expected.size);
      for (const row of result.visualization.table.rows) {
        const key = JSON.stringify([row.viz_x, row.viz_color, ...(xFacet ? [row.viz_facet_x] : []), ...(yFacet ? [row.viz_facet_y] : [])]);
        const value = expected.get(key); assert.ok(value, key);
        assert.equal(row.viz_y, segment ? value.sum / value.count : value.sum);
      }
      report.checks.push(`Full 2500 rows → ${expected.size} groups: horizontal=${xFacet}, vertical=${yFacet}, ${segment ? 'filtered mean' : 'sum'}; all values independently checked.`);
    };
    const runChart = async () => (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1);
    await select('图表类型', '面积图'); await select('X 轴 季度 日期粒度', '季度');
    await editor().getByRole('button', { name: '添加字段 客户类型', exact: true }).dragTo(editor().getByRole('region', { name: '颜色', exact: true }));
    await select('选择水平分面字段', '地区');
    await editor().getByRole('button', { name: '添加字段 渠道', exact: true }).dragTo(editor().getByRole('region', { name: '垂直分面', exact: true }));
    await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await editor().getByRole('textbox', { name: '图表标题' }).fill('季度销售 · 地区与渠道分面（模拟数据）');
    await select('堆叠方式', '堆叠'); await select('配色', '暖橙'); await ready(); await snapshot('14-facets-inline-preview'); await save();
    let result = await runChart(); validate(result); assert.equal(result.visualization.table.rows.length, 96); await ready(chart());
    let svg = await chart().locator('.gw-plot svg').textContent(); for (const text of ['东区', '西区', '直销', '伙伴', '2024 Q1']) assert.ok(svg.includes(text), text);
    assert.match(await chart().locator('.gw-canvas footer').innerText(), /分面 2 列 × 2 行/); await snapshot('15-facets-formal-area');
    const download = page.waitForEvent('download'); await chart().getByRole('button', { name: '导出 PNG', exact: true }).click(); await (await download).saveAs(join(directory, 'facets-export.png'));
    await chart().getByRole('button', { name: '图表数据', exact: true }).click(); assert.match(await chart().locator('.notebook-table-match').innerText(), /96 行/); await snapshot('16-facets-result-table');
    await chart().getByRole('button', { name: '图表', exact: true }).click();
    const original = await persisted(doc => Boolean(doc.cells.find(cell => cell.id === chartId)?.graphicWalker?.channels.facetY));
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await editor().getByRole('button', { name: '移除 水平分面 地区', exact: true }).click();
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); const cancel = page.getByRole('alertdialog'); await snapshot('17-facets-cancel'); await cancel.getByRole('button', { name: '放弃修改并退出', exact: true }).click();
    await editor().waitFor({ state: 'hidden' }); assert.deepEqual(await definition(), original); await ready(chart());
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await select('Y 轴 成交金额 聚合', '平均值');
    await select('筛选字段', '客户类型'); await select('筛选值', '企业客户'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click(); await select('图表类型', '折线图'); await save();
    result = await runChart(); validate(result, true, true, '企业客户'); await ready(chart()); await snapshot('18-facets-filtered-mean');
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await select('筛选字段', '成交金额');
    await editor().getByRole('spinbutton', { name: '筛选下限', exact: true }).fill('99999999'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click(); await save();
    result = await runChart(); assert.equal(result.visualization.table.rows.length, 0); await chart().getByText('没有符合条件的数据，请调整筛选。', { exact: true }).waitFor(); await snapshot('19-facets-empty');
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await editor().getByRole('button', { name: '移除筛选 2', exact: true }).click(); await editor().getByRole('button', { name: '移除筛选 1', exact: true }).click();
    await select('Y 轴 成交金额 聚合', '求和'); await editor().getByRole('button', { name: '移除 垂直分面 渠道', exact: true }).click(); await save();
    result = await runChart(); validate(result, true, false); await ready(chart()); await snapshot('20-horizontal-only');
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await editor().getByRole('button', { name: '移除 水平分面 地区', exact: true }).click(); await select('选择垂直分面字段', '渠道'); await save();
    result = await runChart(); validate(result, false, true); await ready(chart()); await snapshot('21-vertical-only');
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await editor().getByRole('button', { name: '移除 垂直分面 渠道', exact: true }).click(); await select('选择水平分面字段', '客户编号'); await save();
    result = await runChart(); assert.ok(result.visualization.table.rows.length > 0); assert.ok(result.visualization.table.rows.length <= 1000);
    await chart().getByRole('alert').filter({ hasText: '分面网格超过' }).waitFor(); assert.equal(await chart().getByRole('button', { name: '导出 PNG', exact: true }).isDisabled(), true); await snapshot('22-facet-grid-guard');
    await chart().getByRole('button', { name: '图表数据', exact: true }).click(); assert.match(await chart().locator('.notebook-table-match').innerText(), new RegExp(`${result.visualization.table.rows.length} 行`));
    await chart().getByRole('button', { name: '图表', exact: true }).click();
    await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await editor().getByRole('button', { name: '移除 水平分面 客户编号', exact: true }).click(); await select('选择水平分面字段', '地区'); await select('选择垂直分面字段', '渠道'); await select('图表类型', '面积图'); await save();
    const saved = await persisted(doc => doc.cells.find(cell => cell.id === chartId)?.graphicWalker?.channels.facetX?.field === 'field_4' && doc.cells.find(cell => cell.id === chartId)?.graphicWalker?.mark === 'area');
    await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); assert.deepEqual(await definition(), saved);
    result = await runChart(); validate(result); await ready(chart()); await snapshot('23-facets-restored');
    await page.setViewportSize({ width: 1024, height: 1080 }); await ready(chart()); await snapshot('24-facets-1024');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await chart().locator('.gw-plot').evaluate(element => { element.scrollLeft = element.scrollWidth; element.scrollTop = element.scrollHeight; }); await snapshot('25-facets-1024-scrolled');
    report.checks.push('Native GW raw-only workflow rendered horizontal/vertical/both facets, Chinese labels, sum/unequal-weight filtered means, empty result, 50-panel rendering guard with accessible computed table, save/reload, cancel, responsive internal scroll and full PNG export.');
  } else {
  await select('图表类型', '面积图');
  // Real HTML drag from field library; click selection remains available separately.
  await editor().getByRole('button', { name: '添加字段 客户类型', exact: true }).dragTo(editor().getByRole('region', { name: '颜色', exact: true }));
  await editor().getByRole('button', { name: '移除 颜色 客户类型', exact: true }).waitFor();
  await select('X 轴 季度 日期粒度', '季度');
  await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await editor().getByRole('textbox', { name: '图表标题' }).fill(title); await select('堆叠方式', '堆叠');
  await editor().getByRole('tab', { name: 'Data · 数据' }).click(); await ready();
  assert.match(await editor().locator('.gw-canvas footer').innerText(), /100 行.*非全量/s); await snapshot('01-inline-preview-limited');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '放弃未保存的图表修改？' }); await confirmation.waitFor(); await snapshot('02-cancel-keeps-edit');
  await confirmation.getByRole('button', { name: '继续编辑' }).click();
  await editor().getByRole('button', { name: '移除 Y 轴 成交金额', exact: true }).click(); await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().getByRole('alert').filter({ hasText: 'Y 轴' }).waitFor(); await snapshot('03-invalid-axis');
  await editor().getByRole('button', { name: '撤销', exact: true }).click(); await ready(); await save();
  await persisted(doc => doc.cells.find(cell => cell.id === chartId)?.graphicWalker?.channels.color?.field === 'field_3');
  let result = (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1);
  assert.equal(result.visualization.visualResult.inputRowCount, 1250); assert.equal(result.visualization.table.rows.length, 24);
  for (const row of result.visualization.table.rows) assert.equal(row.viz_y, totals.get(row.viz_x + '|' + row.viz_color));
  assert.equal(result.table.rows.length, 1000); assert.equal(result.resultRef.rowCount, 1250);
  await ready(chart()); assert.match(await chart().locator('.gw-canvas footer').innerText(), /1,250 行.*24 行/s);
  assert.ok((await chart().locator('.gw-plot svg').textContent()).includes('2024 Q1')); await snapshot('04-full-upstream-area');
  await chart().getByRole('button', { name: '图表数据', exact: true }).click();
  await chart().locator('.notebook-table-scroll tbody tr').first().waitFor();
  assert.match(await chart().locator('.notebook-table-match').innerText(), /24 行/);
  assert.equal(await chart().locator('.notebook-table-scroll tbody tr').count(), 20); await snapshot('05-materialized-table');
  await chart().getByRole('button', { name: '图表', exact: true }).click();
  report.checks.push('Product CSV 1250 → bounded preview 100 → saved area definition → server 24 quarterly groups; every amount independently verified; input receipt remains 1000/1250. Real field drag, cancel-continue, invalid axis, exact Chinese labels and quarter labels.');
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready();
  await select('Y 轴 成交金额 聚合', '平均值'); await select('筛选字段', '客户类型'); await select('筛选值', '企业客户'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click();
  await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await select('配色', '湖蓝'); await select('堆叠方式', '不堆叠');
  await editor().getByRole('tab', { name: 'Data · 数据' }).click(); await select('图表类型', '折线图'); await save();
  result = (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1);
  assert.equal(result.visualization.table.rows.length, 8);
  for (const row of result.visualization.table.rows) { const matched = rows.filter(r => r.quarter === row.viz_x && r.segment === '企业客户'); assert.equal(row.viz_y, matched.reduce((sum, r) => sum + r.amount, 0) / matched.length); }
  await ready(chart()); await snapshot('06-filtered-mean-line');
  const downloadPromise = page.waitForEvent('download'); await chart().getByRole('button', { name: '导出 PNG', exact: true }).click(); await (await downloadPromise).saveAs(join(directory, 'chart-export.png')); assert.ok((await readFile(join(directory, 'chart-export.png'))).length > 1000);
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready();
  await select('选择水平分面字段', '客户类型'); await ready(); await save();
  result = (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1);
  assert.equal(result.visualization, undefined); assert.match(result.visualizationNotice, /分面/); await ready(chart()); await snapshot('07-facet-explicit-compatibility');
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await ready(); await editor().getByRole('button', { name: '移除 水平分面 客户类型', exact: true }).click();
  await select('筛选字段', '成交金额'); await editor().getByRole('spinbutton', { name: '筛选下限', exact: true }).fill('99999999'); await editor().getByRole('button', { name: '添加筛选', exact: true }).click(); await save();
  result = (await run(chart().getByRole('button', { name: '▶ 运行', exact: true }))).cells.at(-1); assert.equal(result.visualization.table.rows.length, 0);
  await chart().getByText('没有符合条件的数据，请调整筛选。', { exact: true }).waitFor(); await snapshot('08-empty-result');
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await editor().getByRole('button', { name: '移除筛选 2', exact: true }).click(); await editor().getByRole('button', { name: '移除筛选 1', exact: true }).click();
  await select('Y 轴 成交金额 聚合', '求和'); await select('图表类型', '面积图'); await editor().getByRole('tab', { name: 'Style · 样式' }).click(); await select('堆叠方式', '堆叠'); await save();
  const saved = await persisted(doc => doc.cells.find(cell => cell.id === chartId)?.graphicWalker?.mark === 'area' && doc.cells.find(cell => cell.id === chartId)?.graphicWalker.filters.length === 0);
  await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); assert.deepEqual(await definition(), saved);
  await chart().getByRole('button', { name: '编辑图表', exact: true }).click(); await editor().getByText(/等待上游数据/).first().waitFor();
  await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().getByRole('alert').filter({ hasText: '先运行上游' }).waitFor(); await snapshot('09-reload-no-stale-evidence');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  await run(chart().getByRole('button', { name: '▶ 运行', exact: true })); await ready(chart()); await snapshot('10-restored-formal-chart');
  await page.setViewportSize({ width: 1024, height: 1080 }); await ready(chart()); await snapshot('11-notebook-1024');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  report.checks.push('Mean + filter + line + palette apply to formal server results; PNG exported. Facet explicitly stays compatible. Empty result is explicit; save/reload retains exact config, refuses stale input; rerun restores full chart; 1024px no document overflow.');
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
