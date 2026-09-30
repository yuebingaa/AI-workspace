// Real CSV import and application entry, owned temporary project only. No model or SQL/database calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/graphic-walker-20260929', `workspace-${Date.now()}`), projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, checks: [], screenshots: [], blocked: [], errors: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage(); let handle;
page.on('pageerror', error => report.errors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    if (url.href === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css') return route.abort();
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
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets')) {
      assert.ok(handle && scope === handle); return route.continue();
    }
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
async function menu(label) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox').fill(label); await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function snapshot(name) { await page.waitForTimeout(200); await page.screenshot({ path: join(directory, `${name}.png`) }); report.screenshots.push({ name, viewed: false }); }
try {
  await page.goto(base); await menu('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('Graphic Walker 隔离验收');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await menu('导入表格'); const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type=file]').setInputFiles({ name: 'chart-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('季度,成交金额,客户类型\n2024-01-01,100,企业客户\n2024-01-01,50,企业客户\n2024-01-01,80,个人客户\n2024-04-01,120,企业客户\n2024-04-01,60,个人客户\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page.getByRole('button', { name: '图表分析', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '交互图表分析', exact: true });
  await editor.locator('.gw-canvas[data-state="ready"]').waitFor({ timeout: 45000 });
  assert.match(await editor.locator('.gw-toolbar').innerText(), /chart-synthetic/);
  assert.match(await editor.locator('.gw-canvas footer').innerText(), /5 行.*全量.*4 个/s);
  await editor.locator('.gw-results summary').click();
  assert.ok((await editor.locator('.gw-results tbody').textContent()).includes('150'));
  await editor.locator('.gw-results summary').click();
  await editor.getByRole('button', { name: '保存配置', exact: true }).click(); await snapshot('13-real-csv-workspace');
  await editor.getByRole('button', { name: '关闭图表编辑器', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '图表分析', exact: true }).evaluate(e => e === document.activeElement), true);
  await page.getByRole('button', { name: '图表分析', exact: true }).click(); await editor.locator('.gw-canvas[data-state="ready"]').waitFor();
  assert.match(await editor.locator('.gw-toolbar').innerText(), /已保存/); await page.keyboard.press('Escape'); await editor.waitFor({ state: 'hidden' });
  await snapshot('14-close-restores-workspace');
  report.checks.push('Real Chinese CSV import; current dataset flows through workspace adapter; 5 rows → 4 aggregates, enterprise Q1=150; saved config restores on reopen; close/Escape and focus return.');
  await page.getByRole('button', { name: '图表分析', exact: true }).click(); await editor.locator('.gw-canvas[data-state="ready"]').waitFor();
  await editor.getByRole('tab', { name: 'Style · 样式' }).click(); await editor.getByRole('textbox', { name: '图表标题' }).fill('未保存的合成标题');
  await editor.locator('.gw-canvas[data-state="ready"]').waitFor(); await page.waitForTimeout(350); await editor.locator('.gw-plot').getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: '放弃未保存的图表修改？' });
  await confirm.waitFor(); await snapshot('15-dialog-unsaved');
  await confirm.getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await editor.getByRole('textbox', { name: '图表标题' }).inputValue(), '未保存的合成标题');
  await editor.getByRole('button', { name: '关闭图表编辑器' }).click(); await confirm.waitFor();
  await confirm.getByRole('button', { name: '放弃修改并退出' }).click(); await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '图表分析', exact: true }).click(); await editor.locator('.gw-canvas[data-state="ready"]').waitFor();
  assert.equal(await editor.locator('.gw-canvas h2').innerText(), 'chart-synthetic · 图表');
  await editor.getByRole('button', { name: '关闭图表编辑器' }).click(); await editor.waitFor({ state: 'hidden' });
  report.checks.push('Unsaved dialog Escape/close is guarded; cancel preserves changes; discard then reopen restores last saved chart.');
  await menu('数据浏览器'); await data.getByRole('button', { name: '预览数据 / 字段', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'chart-synthetic 数据源详情', exact: true }); await details.waitFor();
  await details.getByRole('button', { name: '图表分析', exact: true }).click(); await editor.locator('.gw-canvas[data-state="ready"]').waitFor();
  await page.waitForTimeout(350); await editor.locator('.gw-plot').getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' });
  assert.match(await editor.locator('.gw-canvas footer').innerText(), /5 行.*4 个/s); await snapshot('16-source-details-entry');
  await page.keyboard.press('Escape'); await editor.waitFor({ state: 'hidden' });
  await details.waitFor(); assert.equal(await details.getByRole('button', { name: '图表分析', exact: true }).evaluate(e => e === document.activeElement), true);
  await details.getByRole('button', { name: '关闭数据源详情' }).click(); await details.waitFor({ state: 'hidden' }); await snapshot('17-nested-close');
  report.checks.push('Data-source details entry renders real current CSV; nested Escape closes only editor and restores source-details focus.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await snapshot('failure'); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
