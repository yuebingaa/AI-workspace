// Isolated browser; synthetic imports only; uses the existing managed dev service.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import writeXlsxFile from 'write-excel-file/node';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/files-panel-2026-09-15', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await mkdir(directory, { recursive: true });
const csv = Buffer.from('region,amount\nEast,100\nEast,50\nSouth,80\n');
const excelPath = resolve(directory, '销售数据-原始工作簿.xlsx');
const excel = await writeXlsxFile([{ data: [[{ value: 'region', type: String }, { value: 'amount', type: String }], [{ value: 'East', type: String }, { value: 150, type: Number }], [{ value: 'South', type: String }, { value: 80, type: Number }]], sheet: 'Sales' }]).toBuffer();
await writeFile(excelPath, excel);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], results = [], screenshots = [], temporaryIds = new Set(); let aiRequests = 0, projectHandle;
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/ai/**', (route) => { aiRequests++; return route.abort(); });
page.on('response', async (response) => {
  if (response.url() === `${base}/api/datasets` && response.request().method() === 'POST' && response.ok() && !response.request().headers()['x-agentcanvas-project']) {
    const body = await response.json().catch(() => null); if (body?.dataset?.datasetId) temporaryIds.add(body.dataset.datasetId);
  }
});
const panel = () => page.getByRole('complementary', { name: '原始文件面板', exact: true });
const railButton = () => page.locator('.workspace-sidebar-rail').getByRole('button', { name: '原始文件', exact: true });
const file = (name) => panel().getByRole('article', { name: `文件 ${name}`, exact: true });
async function step(label, fn) { console.log(label); await fn(); results.push(label); }
async function shot(name) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.mouse.move(1, 1); await page.screenshot({ path: resolve(directory, `${name}.png`) }); screenshots.push(name); }
async function upload(payload, count = 1) {
  await panel().locator('input[type=file]').setInputFiles(payload);
  const dialog = page.getByRole('dialog', { name: '导入本机表格', exact: true }); await dialog.waitFor();
  await dialog.getByRole('button', { name: `导入 ${count} 份文件`, exact: true }).click(); await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
}
async function checkDownload(name, bytes) {
  const pending = page.waitForEvent('download'); await file(name).getByRole('button', { name: `下载原件 ${name}`, exact: true }).click();
  const download = await pending; assert.equal(download.suggestedFilename(), name); assert.deepEqual(await readFile(await download.path()), bytes);
}
async function menuFiles() {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('原始文件');
  await menu.getByRole('button', { name: '原始文件', exact: true }).click(); await panel().waitFor();
  await page.waitForFunction(() => document.querySelector('.pages-panel-slot').getBoundingClientRect().left >= -1);
}
try {
  await step('Files button docks a panel beside the rail and retains Notebook', async () => {
    await page.goto(base, { waitUntil: 'networkidle' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await railButton().click(); await panel().waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await railButton().getAttribute('aria-expanded'), 'true');
    const left = await panel().boundingBox(), notebook = await page.locator('.notebook-panel').boundingBox();
    assert.ok(left.x >= 50 && left.width >= 270 && left.width <= 300); assert.ok(notebook.x >= left.x + left.width - 1);
    await shot('01-empty-desktop');
    await railButton().click(); await panel().waitFor({ state: 'hidden' }); assert.equal(await railButton().getAttribute('aria-expanded'), 'false');
    await railButton().click();
  });
  await step('Upload real CSV and XLSX through the file panel and download exact original bytes', async () => {
    await upload([{ name: '销售记录-CSV.csv', mimeType: 'text/csv', buffer: csv }, { name: '销售数据-原始工作簿.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: excel }], 2);
    assert.equal(await panel().getByRole('article').count(), 2); assert.match(await panel().innerText(), /2 个文件/);
    await checkDownload('销售记录-CSV.csv', csv); await checkDownload('销售数据-原始工作簿.xlsx', excel);
    await shot('02-imported-files');
  });
  await step('Search, sort, original workbook and imported-data preview use existing features', async () => {
    await panel().getByLabel('搜索原始文件').fill('CSV'); assert.equal(await panel().getByRole('article').count(), 1);
    await panel().getByLabel('搜索原始文件').fill('unmatched'); assert.match(await panel().innerText(), /没有找到/);
    await panel().getByLabel('搜索原始文件').fill(''); await panel().getByLabel('文件排序').selectOption('name');
    await file('销售记录-CSV.csv').getByRole('button', { name: '销售记录-CSV.csv', exact: true }).click();
    await file('销售记录-CSV.csv').getByRole('button', { name: /3 行 · 查看数据/ }).click();
    await page.getByRole('button', { name: '关闭数据源详情', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭数据源详情', exact: true }).click();
    const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
    await file('销售数据-原始工作簿.xlsx').getByRole('button', { name: '销售数据-原始工作簿.xlsx', exact: true }).click();
    await file('销售数据-原始工作簿.xlsx').getByRole('button', { name: '查看原始工作簿 ↗', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor(); await shot('03-original-workbook');
    await dialog.getByRole('button', { name: /关闭/ }).first().click();
    await shot('04-file-details');
  });
  await step('Drag/drop queues files in the existing import flow and cancel leaves the list unchanged', async () => {
    const transfer = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['region,amount\nEast,1'], '拖放.csv', { type: 'text/csv' })); return transfer; });
    await panel().locator('.studio-files-drop').dispatchEvent('drop', { dataTransfer: transfer }); await transfer.dispose();
    const dialog = page.getByRole('dialog', { name: '导入本机表格', exact: true }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /拖放.csv/); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await panel().getByRole('article').count(), 2);
  });
  await step('Opening files preserves unsaved SQL and prevents conflicting imports', async () => {
    await panel().getByRole('button', { name: '收起原始文件面板', exact: true }).click();
    await page.getByRole('button', { name: '＋ Data', exact: true }).click();
    let editor = page.locator('.notebook-editor'); await editor.getByRole('button', { name: '保存单元', exact: true }).click();
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click(); editor = page.locator('.notebook-editor');
    await editor.getByLabel('SQL', { exact: true }).fill('SELECT * FROM sales\n-- unsaved draft');
    await railButton().click(); assert.equal(await panel().getByRole('button', { name: /拖放文件到这里/ }).isDisabled(), true);
    assert.equal(await editor.getByLabel('SQL', { exact: true }).inputValue(), 'SELECT * FROM sales\n-- unsaved draft');
    await panel().getByRole('button', { name: '收起原始文件面板', exact: true }).click();
    assert.equal(await editor.getByLabel('SQL', { exact: true }).inputValue(), 'SELECT * FROM sales\n-- unsaved draft');
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click(); await railButton().click();
  });
  await step('Files and real SQL code/results remain visible together', async () => {
    const cell = page.getByRole('article', { name: 'SQL单元 SQL 数据分析', exact: true });
    await cell.getByRole('button', { name: '编辑', exact: true }).click();
    const table = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')).dataProduct.notebooks)[0].cells.find((cell) => cell.kind === 'data').outputName);
    await page.locator('.notebook-editor').getByLabel('SQL', { exact: true }).fill(`SELECT region, SUM(amount) AS revenue\nFROM ${table}\nGROUP BY region\nORDER BY revenue DESC`);
    await page.locator('.notebook-editor').getByRole('button', { name: '保存单元', exact: true }).click();
    const response = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
    await cell.getByRole('button', { name: '▶ 运行', exact: true }).click(); const body = await (await response).json();
    assert.equal(body.run.status, 'success'); assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
    await page.getByRole('group', { name: 'Notebook 显示模式', exact: true }).getByRole('button', { name: '代码', exact: true }).click();
    await cell.scrollIntoViewIfNeeded(); await shot('05-files-with-sql-result');
    const filesBox = await panel().boundingBox(), sqlBox = await cell.boundingBox(); assert.ok(sqlBox.x >= filesBox.x + filesBox.width);
    assert.equal(await cell.locator('table').count(), 1);
  });
  await step('Desktop, tablet and phone layouts keep file actions reachable; Escape returns focus', async () => {
    for (const [width, height] of [[1280, 720], [1024, 768]]) { await page.setViewportSize({ width, height }); await shot(`05-docked-${width}`); }
    for (const [width, height] of [[820, 900], [390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height }); await menuFiles(); await shot(`06-drawer-${width}`);
      const close = panel().getByRole('button', { name: '收起原始文件面板', exact: true }); const box = await close.boundingBox(); assert.ok(box.x + box.width <= width);
      await close.focus(); await page.keyboard.press('Escape'); await panel().waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开工作区菜单');
    }
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.reload({ waitUntil: 'networkidle' }); await railButton().click();
    assert.equal(await panel().getByRole('button', { name: /下载原件/ }).count(), 0);
    assert.match(await panel().innerText(), /已导入数据/); await shot('07-temporary-after-reload');
  });
  await step('Project files persist through reload and download via the real project API', async () => {
    await panel().getByRole('button', { name: '管理项目与数据', exact: false }).click();
    const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true }); await dialog.waitFor();
    await dialog.getByLabel('项目名称', { exact: true }).fill('文件面板合成验收');
    await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'synthetic-project'));
    await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await railButton().click();
    await upload({ name: 'project-sales.csv', mimeType: 'text/csv', buffer: csv });
    await file('project-sales.csv').waitFor(); await checkDownload('project-sales.csv', csv);
    projectHandle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    assert.ok(projectHandle); await page.reload({ waitUntil: 'networkidle' }); await railButton().click();
    await file('project-sales.csv').waitFor(); await checkDownload('project-sales.csv', csv);
    assert.match(await panel().innerText(), /本地项目/); await shot('08-project-files-restored');
    await page.route('**/api/projects', (route) => route.fulfill({ status: 503, json: { error: { message: '合成测试：暂时无法读取目录' } } }));
    await panel().getByRole('button', { name: '刷新文件列表', exact: true }).click();
    await panel().getByRole('alert').waitFor(); assert.equal(await file('project-sales.csv').count(), 1);
    await shot('09-project-refresh-error'); await page.unroute('**/api/projects');
    await panel().getByRole('button', { name: '刷新文件列表', exact: true }).click(); await panel().getByRole('alert').waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click(); await shot('09-files-with-agent');
    assert.deepEqual(errors, []); assert.equal(aiRequests, 0);
  });
  console.log('Passed:', directory);
} catch (error) { await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1; }
finally {
  for (const id of temporaryIds) await context.request.delete(`${base}/api/datasets/${encodeURIComponent(id)}`).catch(() => {});
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed: process.exitCode !== 1, checks: results, screenshots, errors, aiRequests, retainedSyntheticProject: projectHandle ? resolve(directory, 'synthetic-project') : null }, null, 2));
  await browser.close();
}
