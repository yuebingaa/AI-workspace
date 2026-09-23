// Visual acceptance on the managed 3001 service, with an owned synthetic project.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/ui-refinement-2026-09-22', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
const projectHeader = 'x-agentcanvas-project';
const fileName = 'ui-layout-sales.csv';
const csv = 'region,revenue\n华东,150\n华南,80\n';
await mkdir(directory, { recursive: true });
const report = { passed: false, base, projectPath, checks: [], screenshots: [], runs: [], pageErrors: [], routeErrors: [], aiRequests: 0,
  boundaries: ['Isolated browser and new synthetic project; no user projects or data.', 'Project and SQL requests are real; unscoped catalogs and external fonts are isolated.', 'No model calls, service operations or stable-site publishing.'], visualReview: 'pending actual screenshot inspection' };
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
let handle, created = 0;
await context.route('https://fonts.googleapis.com/**', route => route.abort());
await context.route('https://fonts.gstatic.com/**', route => route.abort());
await context.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url());
  try {
    if (url.pathname.startsWith('/api/ai/')) { report.aiRequests++; return await route.abort(); }
    if (request.method() === 'GET') {
      if (url.pathname === '/api/connections') return await route.fulfill({ json: { connections: [] } });
      if (url.pathname === '/api/projects' && !request.headers()[projectHeader]) return await route.fulfill({ json: { projects: [] } });
      if (url.pathname === '/api/datasets' && !request.headers()[projectHeader]) return await route.fulfill({ json: { datasets: [] } });
      if (request.headers()[projectHeader]) assert.equal(request.headers()[projectHeader], handle);
      return await route.continue();
    }
    if (url.pathname === '/api/projects') {
      const body = request.postDataJSON();
      if (body.action === 'create') {
        assert.equal(++created, 1); assert.equal(body.path, projectPath);
        const response = await route.fetch();
        assert.equal(response.status(), 200); handle = (await response.json()).handle;
        return await route.fulfill({ response });
      }
      assert.equal(body.action, 'save'); assert.equal(request.headers()[projectHeader], handle);
      assert.equal(body.state.appSpec.pages.length, 1);
    } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
      assert.equal(request.headers()[projectHeader], handle);
      assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName);
      assert.equal(request.postData(), csv);
    } else if (url.pathname === '/api/notebook/run') {
      assert.equal(request.headers()[projectHeader], handle);
      const body = request.postDataJSON(); assert.equal(body.action, 'run');
      assert.equal(body.document.cells.length, 2);
      assert.deepEqual(body.document.cells.map(cell => cell.kind), ['data', 'sql']);
    } else throw new Error(`Unexpected mutation: ${url.pathname}`);
    return await route.continue();
  } catch (error) { report.routeErrors.push(error.message); return await route.abort('blockedbyclient'); }
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const notebook = page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const prompt = page.getByRole('textbox', { name: 'AI 指令', exact: true });
const editor = page.locator('.notebook-editor');
const sql = 'SELECT region, revenue FROM ui_source';
const cell = page.getByRole('article', { name: 'SQL单元 地区销售概览', exact: true });
async function shot(name, scenario, locator) {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  if (locator) await locator.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no document overflow`);
  const file = `${name}.png`;
  await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), actualImageReviewed: false });
}
async function saveEditor() {
  await editor.getByRole('button', { name: '保存单元', exact: true }).click();
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true });
  if (await rename.isVisible()) await rename.click();
  await editor.waitFor({ state: 'hidden' });
}
async function run(expected) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 45000 }),
    notebook.getByRole('button', { name: /全部运行/ }).click(),
  ]);
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, expected, JSON.stringify(body));
  await notebook.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  if (expected === 'success') assert.deepEqual(body.run.cells.at(-1).table.rows, [{ region: '华东', revenue: 150 }, { region: '华南', revenue: 80 }]);
  report.runs.push({ id: body.run.runId, status: body.run.status, cells: body.run.cells.map(result => ({ status: result.status, rows: result.table?.rows })) });
}
async function saved() {
  await page.waitForFunction(() => /已保存到本地项目|已打开本地项目/.test(document.querySelector('.top-actions')?.textContent ?? ''));
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(resolve(value.path), projectPath);
  return value.manifest;
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('UI 体验验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await saved();
  report.checks.push('Created an isolated local project through the existing UI.');

  for (const [width, height] of [[1440, 1000], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    const promptBox = await page.locator('.prompt-box').boundingBox();
    assert.ok(promptBox.y >= 56 && promptBox.y + promptBox.height <= height, 'Composer fits the initial viewport');
    assert.equal(await page.locator('.assistant-resize-handle').isVisible(), false);
    await shot(`home-${width}`, 'Empty workspace with readable suggestions and adjacent composer.');
  }
  for (const name of ['了解数据', '生成可视化', '整理表格']) {
    await page.getByRole('button', { name, exact: true }).click(); assert.ok((await prompt.inputValue()).length > 15);
  }
  const draft = await prompt.inputValue();
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Notebook', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await prompt.inputValue(), draft);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '看板', exact: true }).getAttribute('aria-selected'), 'true');
  await shot('canvas-1024', 'Keyboard navigation reaches the existing empty dashboard.');
  await page.keyboard.press('Home'); assert.equal(await prompt.inputValue(), draft);
  await prompt.fill('');
  assert.equal(report.aiRequests, 0);
  report.checks.push('All suggestion cards fill the shared draft only; keyboard tabs preserve the draft and issue zero AI requests.');

  await page.locator('.agent-context-bar-menu .context-add-trigger').click();
  await shot('context-1024', 'Context picker stays within the viewport near the centered composer.');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.agent-context-bar-menu .context-add-trigger').getAttribute('aria-expanded'), 'false');
  report.checks.push('Context menu opens and Escape cancels it.');

  for (const [width, height] of [[1440, 1000], [1024, 900]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await notebook.evaluate(el => { el.scrollTop = 0; });
    const tools = notebook.getByRole('group', { name: '添加分析单元', exact: true });
    assert.equal(await tools.getByRole('button').count(), 10);
    await shot(`notebook-empty-${width}`, 'Empty Notebook with data entry cards and the available cell toolbar.');
    await tools.scrollIntoViewIfNeeded();
    assert.ok(await tools.getByRole('button', { name: '＋ SQL', exact: true }).isVisible());
  }
  await page.getByRole('textbox', { name: 'Notebook 分析问题', exact: true }).fill('对比各地区销售额');
  await page.getByRole('button', { name: '在 AI 助手中继续', exact: true }).click();
  assert.equal(await prompt.inputValue(), '对比各地区销售额');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  assert.equal(await prompt.isVisible(), false);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  assert.equal(await prompt.inputValue(), '对比各地区销售额'); await prompt.fill('');
  report.checks.push('Notebook question, sidebar collapse and restore preserve the draft; ten insert tools remain reachable.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await notebook.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
  await upload.waitFor({ state: 'hidden' });
  await notebook.getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('合成销售数据');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('ui_source');
  await saveEditor();
  await notebook.getByRole('button', { name: '＋ SQL', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('地区销售概览');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('ui_sales');
  await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill(sql);
  await saveEditor(); await run('success');
  for (const number of ['150', '80']) await cell.getByRole('cell', { name: number, exact: true }).waitFor();
  await shot('notebook-success-1440', 'Real synthetic SQL returns 华东 150 and 华南 80.', cell);
  const beforeCancel = (await saved()).state.dataProduct.notebooks;
  await page.setViewportSize({ width: 1024, height: 900 });
  await cell.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill('SELECT 999 AS revenue');
  await shot('notebook-edit-1024', 'Editor remains readable beside the AI sidebar.', editor);
  await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
  assert.deepEqual((await saved()).state.dataProduct.notebooks, beforeCancel);
  await shot('notebook-cancel-1024', 'Cancel preserves the saved SQL and its 150 / 80 result.', cell);

  await cell.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill('SELECT missing_column FROM (SELECT 1 AS amount)');
  await saveEditor(); await run('failure');
  await shot('notebook-failure-1024', 'Real SQL binding failure is visible; old results are not presented as successful.', cell);
  await cell.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByRole('textbox', { name: 'SQL', exact: true }).fill(sql);
  await saveEditor(); await run('success');
  report.checks.push('Real SQL success, cancelled editing, real execution failure and repaired success all retain usable layouts.');

  const beforeReload = (await saved()).state.dataProduct.notebooks;
  await page.reload({ waitUntil: 'networkidle' }); await saved();
  assert.deepEqual((await saved()).state.dataProduct.notebooks, beforeReload);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '原始文件', exact: true }).click();
  await shot('files-notebook-1280', 'Files, saved Notebook and AI sidebar remain usable together.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.equal(report.aiRequests, 0);
  report.checks.push('Saved definition survives reload; parallel file and assistant panels fit the desktop viewport.');
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error?.message }, null, 2));
}
