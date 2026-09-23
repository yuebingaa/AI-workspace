// Real 3001 UI acceptance; mutations are restricted to one newly created synthetic project.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/interface-selection-2026-09-22', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
const projectHeader = 'x-agentcanvas-project';
const fileName = 'interface-selection.csv', csv = 'region,revenue\nEast,150\nSouth,80\n';
const names = ['空白工作界面', 'DES', 'EDS 月度异常分析与业务经营汇总工作界面'];
const report = { passed: false, base, projectPath, checks: [], screenshots: [], pageErrors: [], routeErrors: [], aiRequests: 0,
  boundaries: ['New isolated browser and synthetic project only.', 'Real project creation, CSV upload and saves; unscoped resource catalogs and external fonts isolated.', 'No model calls, user project access, service operations or stable publishing.'] };
await mkdir(directory, { recursive: true });
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
      assert.ok(body.state.appSpec.pages.length <= 3);
    } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
      assert.equal(request.headers()[projectHeader], handle);
      assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName);
      assert.equal(request.postData(), csv);
    } else throw new Error(`Unexpected mutation: ${url.pathname}`);
    return await route.continue();
  } catch (error) { report.routeErrors.push(error.message); return await route.abort('blockedbyclient'); }
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const panel = page.getByRole('complementary', { name: '工作界面选择', exact: true });
const notebook = page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
async function saved(predicate = () => true) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
    assert.equal(response.status(), 200);
    const value = await response.json(); assert.equal(resolve(value.path), projectPath);
    if (value.manifest.state && predicate(value.manifest.state)) return value.manifest.state;
    await page.waitForTimeout(150);
  }
  throw new Error('Synthetic project did not reach the expected saved state');
}
async function shot(name, scenario) {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal overflow`);
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${name}.png`, scenario, viewport: page.viewportSize(), actualImageReviewed: false });
}
async function select(name, keyboard = false) {
  const button = panel.getByRole('button', { name, exact: true });
  if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); } else await button.click();
  await page.waitForFunction(title => document.querySelector('.interface-selection-list [aria-current="page"]')?.getAttribute('title') === title, name);
  assert.equal(await panel.locator('[aria-current="page"]').count(), 1);
  assert.ok((await notebook.locator('.notebook-document-title').textContent()).includes(name));
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  await dialog.getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('界面选择验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await saved();
  for (const name of names.slice(1)) {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    await menu.getByRole('button', { name: '新建界面', exact: true }).click();
    await menu.getByLabel('工作界面名称', { exact: true }).fill(name);
    await menu.getByRole('button', { name: '创建', exact: true }).click();
  }
  await saved(state => state.appSpec.pages.length === 3);
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const assistant = page.getByRole('button', { name: 'AI 助手', exact: true });
  if (await assistant.getAttribute('aria-expanded') === 'true') await assistant.click();
  await notebook.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
  await upload.waitFor({ state: 'hidden' });
  await notebook.getByRole('button', { name: '＋ Data', exact: true }).click();
  const editor = page.locator('.notebook-editor');
  await editor.getByLabel('单元名称', { exact: true }).fill('界面选择验收数据');
  await editor.getByRole('button', { name: '保存单元', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await saved(state => Object.values(state.dataProduct.notebooks ?? {}).some(document => document.cells?.length === 1));

  await page.getByRole('button', { name: '选择工作界面', exact: true }).click();
  assert.equal(await panel.getByRole('button').count(), names.length);
  for (const text of ['Data Browser', '数据管理', '语义模型', '原始资料', '导入表格', '新建', '重命名', '删除']) assert.equal((await panel.textContent()).includes(text), false);
  await shot('selector-1440', 'Only interface choices and selection state; Notebook keeps the imported synthetic data cell.');
  await select(names[1]); await select(names[0], true); await select(names[2], true);
  await notebook.getByRole('article', { name: 'Data单元 界面选择验收数据', exact: true }).waitFor();
  report.checks.push('Three real interfaces switch by mouse and Enter; selection and Notebook match, and the imported cell survives.');

  const baseline = await saved();
  await page.setViewportSize({ width: 1024, height: 768 });
  const label = panel.getByRole('button', { name: names[2], exact: true }).locator('.interface-selection-name');
  assert.ok(await label.evaluate(element => element.scrollWidth > element.clientWidth), 'Long name truncates without widening the panel');
  await shot('selector-1024', 'Narrow desktop keeps the full accessible name while visually truncating the long selected interface.');
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '选择工作界面');
  await page.getByRole('button', { name: '选择工作界面', exact: true }).click();
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  assert.deepEqual((await saved()).dataProduct, baseline.dataProduct);
  await shot('collapsed-cancel-1024', 'Closing the selector without choosing preserves the interface and all saved resources; focus returns to its entry.');
  report.checks.push('1024 px long-name layout, collapse focus, and open/close cancellation preserve saved data.');

  await page.getByRole('button', { name: '打开 Data Browser 数据浏览器', exact: true }).click();
  await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '原始文件', exact: true }).click();
  await page.locator('#studio-files-panel').waitFor();
  await page.locator('#studio-files-panel').getByText(fileName, { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('independent-files-1440', 'The existing independent file panel still shows the synthetic CSV; resources were not deleted.');
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  await menu.getByRole('button', { name: '工作界面', exact: true }).click();
  await panel.waitFor(); assert.equal(await page.locator('#studio-files-panel').count(), 0);
  assert.equal(await panel.getByRole('button').count(), names.length);
  assert.deepEqual((await saved()).dataProduct, baseline.dataProduct);
  await shot('menu-selector-1440', 'The renamed menu entry returns to the same selection-only panel.');
  report.checks.push('Independent Data Browser opens and cancels; original files remain; the main menu opens the same pure selector.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.equal(report.aiRequests, 0);
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
