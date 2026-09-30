// Real managed 3001, isolated project, synthetic scalar data, no model/DB/user project access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const directory = resolve('.runtime/visualization-unification-20260929', `notebook-${Date.now()}`), projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, checks: [], screenshots: [], errors: [], blocked: [], runs: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(25000); let handle, noteId;
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
const editor = () => page.locator('.notebook-editor');
const note = () => page.locator(`article[data-cell-id="${noteId}"]`);
async function menu(label) {
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox').fill(label); await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function save() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('.notebook-output-rename-confirmation'));
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true }); if (await rename.isVisible()) await rename.click();
  await editor().waitFor({ state: 'hidden' });
}
async function snapshot(name) {
  await note().evaluate(element => element.scrollIntoView({ block: 'center' })); await page.waitForTimeout(200);
  await page.screenshot({ path: join(directory, `${name}.png`) }); report.screenshots.push({ name, viewed: false });
}
async function definition() {
  const response = await context.request.get(base + '/api/projects', { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  return Object.values((await response.json()).manifest.state.dataProduct.notebooks)[0];
}
async function settled(predicate) {
  for (let i = 0; i < 70; i++) { const doc = await definition(); if (doc && predicate(doc)) return doc; await page.waitForTimeout(150); } throw Error('Save not settled');
}
async function run(status = 'success') {
  const pending = page.waitForResponse(response => response.url() === base + '/api/notebook/run');
  await note().getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await pending, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, status);
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  report.runs.push(body.run.cells.map(cell => ({ cellId: cell.cellId, status: cell.status, text: cell.text, textParts: cell.textParts })));
  return body.run.cells.find(cell => cell.cellId === noteId);
}
const literal = '**不是强调** [不是链接](https://invalid.example) <img src=x onerror=alert(1)>\n\n# 不是标题 | 不新增列';
const markdown = '## 季度销售分析（模拟）\n\n**阅读摘要**：下列值来自本次参数运行。\n\n- 支持标题、列表和表格\n- 数据内容不会变成链接或 HTML\n\n| 项目 | 值 |\n| --- | --- |\n| 原始字段 | {{value_1}} |\n\n> 数据为合成验收值，不代表业务结论。';
try {
  await page.goto(base); await menu('数据浏览器'); const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath); await data.getByLabel('项目名称', { exact: true }).fill('Markdown 隔离验收（模拟）');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const notice = page.getByRole('button', { name: '知道了', exact: true }); if (await notice.isVisible()) await notice.click();
  await page.getByRole('button', { name: '＋ 参数', exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill('模拟原始值');
  await editor().getByRole('combobox', { name: '参数类型', exact: true }).click(); await page.getByRole('option', { name: '文本', exact: true }).click();
  await editor().getByLabel('参数值', { exact: true }).fill(literal); await save();
  await page.getByRole('button', { name: '＋ 说明', exact: true }).click();
  noteId = await page.locator('article[data-cell-kind="text"]').last().getAttribute('data-cell-id');
  await editor().getByLabel('单元名称', { exact: true }).fill('Markdown 阅读与引用');
  await editor().getByLabel('分析说明', { exact: true }).fill(markdown);
  await editor().getByRole('button', { name: '添加数据引用', exact: true }).click(); await save();
  await note().getByText(/引用结果待运行/).waitFor(); await snapshot('01-awaiting-run');
  const receipt = await run(); assert.ok(receipt.textParts.some(part => part.kind === 'literal' && part.value === literal));
  const rich = note().locator('.notebook-rich-text'); await rich.getByRole('heading', { name: '季度销售分析（模拟）' }).waitFor();
  assert.equal(await rich.locator('tbody td').nth(1).textContent(), literal);
  assert.equal(await rich.locator('a,img,iframe,script').count(), 0); assert.equal(await rich.locator('h1,h2,h3').count(), 1); assert.equal(await rich.locator('li').count(), 2);
  assert.equal(await rich.locator('ul').evaluate(element => getComputedStyle(element).listStyleType), 'disc');
  assert.equal(await rich.locator('tbody td').first().evaluate(element => getComputedStyle(element).fontSize), '13px');
  await snapshot('02-rich-success');
  await settled(doc => doc.cells.some(cell => cell.id === noteId && cell.markdown === markdown)); const before = await definition();
  await note().getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('分析说明', { exact: true }).fill('将被取消');
  await editor().getByRole('button', { name: '取消编辑', exact: true }).click(); assert.deepEqual(await definition(), before); await snapshot('03-cancel-preserves-result');
  await note().getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('引用字段 1', { exact: true }).fill('missing'); await save();
  await note().getByText(/引用结果已失效/).waitFor(); assert.equal(await rich.count(), 0); await snapshot('04-stale-hidden');
  await run('failure'); await note().getByText(/引用说明计算失败/).waitFor(); assert.equal(await rich.count(), 0); await snapshot('05-failed-reference');
  await note().getByRole('button', { name: '编辑', exact: true }).click(); await editor().getByLabel('引用字段 1', { exact: true }).fill('value'); await save();
  await settled(doc => doc.cells.find(cell => cell.id === noteId)?.references?.[0]?.field === 'value');
  await page.reload(); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  assert.equal((await definition()).cells.find(cell => cell.id === noteId).markdown, markdown);
  await run(); await rich.getByRole('heading', { name: '季度销售分析（模拟）' }).waitFor(); await snapshot('06-reopened-success');
  await page.setViewportSize({ width: 1024, height: 1080 }); await snapshot('07-narrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole('button', { name: '＋ 说明', exact: true }).click(); noteId = await page.locator('article[data-cell-kind="text"]').last().getAttribute('data-cell-id');
  await editor().getByLabel('单元名称', { exact: true }).fill('静态说明'); await editor().getByLabel('分析说明', { exact: true }).fill('## 无引用说明\n\n**无需运行**即可阅读，原大括号保留：{{未知值}}。\n\n| 客户类型 | 金额 |\n| --- | ---: |\n| 企业 | 150 |\n| 个人 | 80 |'); await save();
  await note().getByRole('heading', { name: '无引用说明', exact: true }).waitFor(); await snapshot('08-static-markdown');
  report.checks.push('Real project + parameter execution → typed rich receipt; malicious data remains one table cell, no network/markup.', 'Pending/stale/failure never displays valid-looking old result; cancel unchanged; reopen and rerun restores Markdown.', 'Static old brace text stays literal; headings/lists/GFM tables; 1440/1024 no page overflow.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) { report.failure = error.stack; await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
