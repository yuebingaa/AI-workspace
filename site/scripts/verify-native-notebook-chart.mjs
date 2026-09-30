// Real managed 3001 + isolated synthetic project. --paid authorizes exactly one real model task.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const paid = process.argv.includes('--paid'), inspect = process.argv.includes('--inspect');
const exercise = process.argv.includes('--exercise');
const reopenIndex = process.argv.indexOf('--reopen'), reopen = reopenIndex >= 0 ? resolve(process.argv[reopenIndex + 1]) : null;
assert.ok(!reopen || (!paid && reopen.startsWith(resolve('.runtime/native-notebook-chart-20260929') + '\\')));
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/native-notebook-chart-20260929', `browser-${Date.now()}`), projectPath = join(reopen ?? directory, 'project');
if (reopen) assert.equal(JSON.parse(await readFile(join(reopen, 'real-model-task.json'), 'utf8')).state, 'awaitingConfirmation');
await mkdir(directory, { recursive: true });
const report = { passed: false, paid, reopen, projectPath, modelRequests: 0, screenshots: [], errors: [], blocked: [], checks: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
let handle;
await context.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url()), method = req.method();
  try {
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = req.headers()[header];
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || ['/api/settings/ai', '/api/notebook/python', '/api/agent-engine'].includes(url.pathname))) return route.continue();
    if (method === 'POST' && url.pathname === '/api/projects' && ['create', 'open'].includes(req.postDataJSON().action)) {
      assert.equal(req.postDataJSON().path, projectPath); const response = await route.fetch();
      assert.equal(response.status(), 200); handle = (await response.json()).handle; return route.fulfill({ response });
    }
    if (url.pathname === '/api/ai/dsh/conversation/stream') {
      assert.ok(paid); assert.equal(++report.modelRequests, 1); assert.equal(scope, handle);
      assert.equal(req.postDataJSON().rawWorkbookManifest, undefined); assert.equal(req.postDataJSON().imageAttachmentManifest, undefined);
      return route.continue();
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets') || url.pathname === '/api/notebook/run') { assert.equal(scope, handle); return route.continue(); }
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort(); }
});
await context.addInitScript(() => {
  const original = window.fetch.bind(window); window.__nativeChartReceipt = null;
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/ai/dsh/conversation/stream') void response.clone().text().then(body => { window.__nativeChartReceipt = { status: response.status, body }; });
    return response;
  };
});
const page = await context.newPage(); page.setDefaultTimeout(25000);
page.on('pageerror', error => report.errors.push(error.message));
const editor = () => page.locator('.notebook-editor');
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await nav.getByRole('textbox').fill(label); await nav.getByRole('button', { name: label, exact: true }).click();
}
async function state() {
  const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  return (await response.json()).manifest.state;
}
const book = s => Object.values(s.dataProduct.notebooks)[0];
async function settled(predicate) { for (let i = 0; i < 90; i++) { const s = await state(); if (predicate(s)) return s; await page.waitForTimeout(150); } throw Error('Save did not settle'); }
async function shot(name) {
  const target = page.locator('.native-chart-editor'); if (await target.isVisible()) await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400); await page.screenshot({ path: join(directory, name + '.png') }); report.screenshots.push({ name, viewed: false });
}
async function run(button) {
  const promise = page.waitForResponse(response => response.url() === base + '/api/notebook/run', { timeout: 90000 });
  await button.click(); const response = await promise, data = await response.json(); assert.equal(response.status(), 200); assert.equal(data.run.status, 'success', JSON.stringify(data));
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); await page.waitForTimeout(300); return data.run;
}
try {
  await page.goto(base); await menu('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('官方图表编辑器 · 隔离模拟验收');
  await data.getByRole('button', { name: reopen ? '打开已有项目' : '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  if (!reopen) {
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  const csv = 'quarter,amount,segment\n' + Array.from({ length: 48 }, (_, i) => `${2024 + Math.floor(i % 8 / 4)}-${String(i % 4 * 3 + 1).padStart(2, '0')}-01,${1000 + i * 10},${i % 3 ? '企业客户' : '个人客户'}`).join('\n') + '\n';
  await upload.locator('input[type=file]').setInputFiles({ name: 'official-chart-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill('模拟销售明细'); await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('sales');
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.getByRole('button', { name: '确认改名并保存', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
  await run(page.locator('article[data-cell-kind="data"]').getByRole('button', { name: '▶ 运行', exact: true }));
  } else {
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await run(page.getByRole('button', { name: '▶ 全部运行', exact: true }));
  }
  if (paid) {
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    const composer = page.frameLocator('iframe[title="官方 DSH 聊天"]').locator('[data-composer-input="true"]');
    await composer.fill('这是隔离模拟销售数据。请使用已有 Data 的 quarter、amount、segment，创建一张季度成交金额堆叠面积图（amount 求和，segment 颜色分组），无需另建SQL或说明。请用 editNotebookCells 的 charts 配置入口，真实运行并提交草稿。标题写“AI季度销售（模拟）”。保留现有单元，不修改看板。'); await composer.press('Enter');
    await page.waitForFunction(() => window.__nativeChartReceipt !== null, undefined, { timeout: 300000 });
    const receipt = await page.evaluate(() => window.__nativeChartReceipt); assert.equal(receipt.status, 200);
    const frames = receipt.body.split(/\r?\n\r?\n/u).flatMap(frame => { const line = frame.split(/\r?\n/u).find(line => line.startsWith('data:')); return line ? [JSON.parse(line.slice(5))] : []; });
    const task = frames.findLast(frame => frame.event?.type === 'completed')?.task; assert.ok(task);
    await writeFile(join(directory, 'real-model-task.json'), JSON.stringify(task, null, 2));
    assert.equal(task.state, 'awaitingConfirmation', task.error ?? task.resultMessage);
    assert.ok(task.notebookArtifact.cells.some(cell => cell.kind === 'chart' && cell.graphicWalker));
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const adopt = page.getByRole('button', { name: '确认更改', exact: true }); await adopt.waitFor({ timeout: 60000 }); await adopt.click();
    await settled(s => book(s).cells.some(cell => cell.kind === 'chart'));
    await shot('01-ai-created');
    await page.locator('article[data-cell-kind="chart"]').getByRole('button', { name: '编辑图表', exact: true }).click();
  } else if (reopen) {
    await page.locator('article[data-cell-kind="chart"]').getByRole('button', { name: '编辑图表', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '＋ 图表', exact: true }).click(); await page.waitForTimeout(500);
    if (!await editor().isVisible()) await page.locator('article[data-cell-kind="chart"]').getByRole('button', { name: '编辑图表', exact: true }).click();
  }
  await page.getByRole('region', { name: 'Graphic Walker 官方编辑器', exact: true }).waitFor();
  await page.locator('.native-chart-surface').getByText('amount', { exact: false }).first().waitFor();
  await page.waitForTimeout(2000); await shot('02-official-editor');
  await writeFile(join(directory, 'native-dom.txt'), await page.locator('.native-chart-surface').ariaSnapshot());
  if (exercise) {
    const surface = page.locator('.native-chart-surface');
    assert.equal(await surface.getByRole('button', { name: '收起面板', exact: true }).count(), 0);
    // Axis and an explicitly assigned Tooltip metric are independent in GW.
    // Update both, otherwise the old Tooltip SUM is a second metric (compatibility mode).
    const measurePills = await surface.getByRole('button', { name: /^amount (sum|mean)$/u }).count();
    for (const index of Array.from({ length: measurePills }, (_, i) => measurePills - 1 - i)) {
      await surface.getByRole('button', { name: /^amount (sum|mean)$/u }).nth(index).locator('span[data-state]').click();
      await surface.getByRole('menuitem', { name: '最小值', exact: true }).click();
      await page.waitForTimeout(250);
      await surface.getByRole('button', { name: 'amount min', exact: true }).getByText('min', { exact: true }).click();
      await surface.getByRole('menuitem', { name: '平均值', exact: true }).click();
      await page.waitForTimeout(250);
    }
    await editor().getByText('官方编辑器 · 未保存', { exact: true }).waitFor();
    // The first two official toolbar buttons are undo/redo in the pinned 0.5.2 build.
    await surface.getByRole('button').nth(2).click();
    await surface.getByRole('menuitemradio', { name: '散点', exact: true }).click();
    await editor().getByRole('alert').filter({ hasText: '不能无损保存' }).waitFor();
    const unchanged = book(await state());
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    assert.deepEqual(book(await state()), unchanged);
    await shot('03-unsupported-rejected');
    await surface.getByRole('button').first().click();
    await editor().getByRole('alert').waitFor({ state: 'hidden' });
    await surface.getByRole('button').nth(2).click();
    await surface.getByRole('menuitemradio', { name: '折线', exact: true }).click();
    await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await page.getByRole('alertdialog', { name: '放弃未保存的图表修改？', exact: true }).waitFor();
    await shot('04-cancel-guard');
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await editor().getByText('标题与网站样式', { exact: true }).click();
    await editor().getByRole('textbox', { name: '图表标题', exact: true }).fill('手动调整 · 季度销售均值（模拟）');
    await editor().getByRole('combobox', { name: '图表配色', exact: true }).click();
    await page.getByRole('option', { name: '暖橙', exact: true }).click();
    await shot('05-manual-edits');
    report.checks.push(`Official ${measurePills} assigned metric(s) → MEAN; unsupported point rejected without save, undo; mark → line; dirty cancel guard / continue; host title and palette edits.`);
  }
  if (!inspect) {
    const previousRevision = book(await state()).revision;
    await editor().getByRole('button', { name: '保存单元', exact: true }).click(); await editor().waitFor({ state: 'hidden' });
    await page.waitForTimeout(600);
    const saved = book(await settled(s => book(s).revision > previousRevision && book(s).cells.some(cell => cell.graphicWalker)));
    const result = await run(page.locator('article[data-cell-kind="chart"]').getByRole('button', { name: '▶ 运行', exact: true }));
    await writeFile(join(directory, 'notebook-run.json'), JSON.stringify(result, null, 2));
    assert.ok(result.cells.find(cell => cell.visualization));
    if (exercise) {
      const savedChart = saved.cells.find(cell => cell.kind === 'chart'), grouped = new Map();
      for (let i = 0; i < 48; i++) {
        const x = `${2024 + Math.floor(i % 8 / 4)}-${String(i % 4 * 3 + 1).padStart(2, '0')}-01`;
        const color = savedChart.graphicWalker.channels.color ? (i % 3 ? '企业客户' : '个人客户') : null;
        const key = JSON.stringify([x, color]), values = grouped.get(key) ?? []; values.push(1000 + i * 10); grouped.set(key, values);
      }
      const table = result.cells.find(cell => cell.visualization).visualization.table;
      assert.equal(table.rows.length, grouped.size);
      for (const row of table.rows) { const values = grouped.get(JSON.stringify([row.viz_x, row.viz_color ?? null])); assert.ok(values); assert.equal(row.viz_y, values.reduce((a, b) => a + b, 0) / values.length); }
      report.checks.push(`Full 48-row input → ${grouped.size} MEAN groups independently recomputed.`);
    }
    await page.locator('.gw-materialized-canvas[data-state="ready"]').waitFor(); await shot('06-formal-chart');
    await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    assert.deepEqual(book(await state()), saved); report.checks.push('Official component save / real Notebook execution / reload retain canonical chart definition.');
    await page.locator('article[data-cell-kind="chart"]').getByRole('button', { name: '编辑图表', exact: true }).click();
    await page.getByRole('region', { name: 'Graphic Walker 官方编辑器', exact: true }).waitFor();
    await page.setViewportSize({ width: 1024, height: 900 }); await shot('07-reopened-1024');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await writeFile(join(directory, 'failure-dom.txt'), await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
