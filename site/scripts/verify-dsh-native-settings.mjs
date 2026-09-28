import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { chromium } from 'playwright-core';
assert.equal(process.argv.length, 2);
const base = 'http://127.0.0.1:3001';
const output = resolve('.runtime/dsh-native-settings-20260927', 'browser-' + Date.now());
await mkdir(output, { recursive: true });
const read = async path => { const r = await fetch(base + path, { headers: { origin: base } }); assert.equal(r.status, 200); return r.json(); };
const original = await read('/api/settings/dsh-plugins'), inventory = await read('/api/settings/dsh-plugins/inventory');
let settings = structuredClone(original), failure = false, inventoryFailure = false;
const report = { passed: false, screenshots: [], errors: [], console: [], forbidden: [], writes: [], actualCount: inventory.packages.length };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.href === 'https://rsms.me/inter/inter.css') return route.fulfill({ contentType: 'text/css', body: '' });
    if (u.origin !== base) { report.forbidden.push('external'); return route.abort(); }
    if (u.pathname === '/api/settings/dsh-plugins') {
      if (req.method() === 'PATCH') {
        const value = req.postDataJSON(); report.writes.push(value);
        if (failure) return route.fulfill({ status: 409, json: { error: { message: '合成版本冲突，请刷新' } } });
        assert.equal(value.revision, settings.document.revision);
        settings.document = { ...settings.document, revision: value.revision + 1, config: value.config };
        settings.plugins = settings.plugins.map(row => row.id === 'dsh-tool-skill' ? { ...row, state: value.config.skills ? 'configured' : 'disabled' } : row);
      }
      return route.fulfill({ json: settings });
    }
    if (req.method() !== 'GET') { report.forbidden.push(u.pathname); return route.abort(); }
    if (u.pathname === '/api/settings/dsh-plugins/inventory' && inventoryFailure) return route.fulfill({ status: 503, json: { error: { message: 'synthetic failure' } } });
    if (!u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/ai/dsh/web/') || ['/api/settings/dsh-plugins/inventory', '/api/settings/agent-engine', '/api/notebook/python'].includes(u.pathname)) return route.continue();
    if (u.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
    if (u.pathname === '/api/datasets') return route.fulfill({ json: { datasets: [] } });
    if (u.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (u.pathname === '/api/settings/ai') return route.fulfill({ json: { configured: false, source: 'none', model: 'deepseek-chat', modelSource: 'default', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' } });
    report.forbidden.push(u.pathname); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 500)));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push(message.text().slice(0, 700)); });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  const group = menu.locator('details').filter({ hasText: '设置与备份' });
  if (!await group.evaluate(el => el.open)) await group.locator('summary').click();
  await menu.getByRole('button', { name: 'DSH 执行与插件', exact: true }).click();
  const ui = page.frameLocator('iframe[title="官方 DSH 设置"]');
  const button = name => ui.getByRole('button', { name, exact: true });
  const shot = async (name, scenario, source = 'actual metadata, isolated config fixture') => {
    await page.screenshot({ path: resolve(output, name), animations: 'disabled' });
    report.screenshots.push({ file: name, scenario, source, actualImageReviewed: false });
  };
  await button('内置插件').click();
  await ui.getByRole('searchbox').waitFor();
  await shot('01-official-shell.png', 'Unmodified official shell, navigation and plugin groups.');
  await ui.getByRole('searchbox').fill('ui-settings');
  await ui.getByText('client-ui-settings-plugins', { exact: true }).first().waitFor();
  await shot('02-official-plugin-cards.png', 'Official cards and search; install state is not live enablement.');
  await ui.getByRole('searchbox').fill('nonexistent-synthetic-query');
  await ui.getByText('没有匹配的插件。', { exact: true }).waitFor();
  await shot('03-no-results.png', 'Official no-match state.');
  await button('通用设置').click();
  await shot('10-general.png', 'Official general settings; Host config is read-only.');
  await button('Agent 预设').click();
  await ui.getByText('基础分析', { exact: true }).waitFor();
  await ui.getByText(original.document.config.skills ? '基础分析' : '分析 + Skill', { exact: true }).click();
  await shot('11-preset.png', 'Official segmented control bound to website capability config, not an unconnected Host editor.');
  await button('网站能力').click();
  const toggle = ui.getByRole('switch', { name: '启用内置 Skill', exact: true });
  assert.equal(await toggle.isChecked(), !original.document.config.skills);
  await toggle.click(); // Return to the original fixture before testing save.
  await toggle.click();
  failure = true; await button('保存配置').click();
  await ui.getByRole('alert').filter({ hasText: '合成版本冲突' }).waitFor();
  assert.equal(await button('保存配置').isDisabled(), true);
  await shot('04-save-conflict.png', 'Explicit PATCH 409 fixture, draft retained and save disabled.');
  await button('刷新状态').click(); failure = false;
  await page.waitForTimeout(150);
  await button('保存配置').click();
  await ui.getByRole('status').filter({ hasText: '下一轮任务生效' }).waitFor();
  await shot('05-save-success.png', 'Explicit in-memory PATCH fixture, next-task setting saved.');
  await toggle.click();
  await button('关闭').click();
  await ui.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).waitFor();
  await shot('06-discard-confirmation.png', 'Official Modal with existing draft confirmation.');
  await button('继续编辑').last().click();
  await button('内置插件').click();
  // Reopen the settings document to force a fresh lazy official list request.
  await button('关闭').click(); await button('放弃并关闭').click();
  inventoryFailure = true;
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const reopenedGroup = page.getByRole('navigation', { name: '工作区功能菜单' }).locator('details').filter({ hasText: '设置与备份' });
  if (!await reopenedGroup.evaluate(el => el.open)) await reopenedGroup.locator('summary').click();
  await reopenedGroup.getByRole('button', { name: 'DSH 执行与插件', exact: true }).click();
  await button('内置插件').click();
  await ui.getByText('暂时无法读取插件。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('07-inventory-failure.png', 'Explicit GET 503 fixture in official failure/retry component.');
  inventoryFailure = false; await button('重试').click();
  await ui.getByRole('searchbox').waitFor();
  await shot('08-recovered-1024.png', 'Real metadata recovered inside official 1024px dialog.');
  await ui.getByRole('searchbox').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('title')), '官方 DSH 设置');
  await page.keyboard.press('Escape');
  await page.locator('iframe[title="官方 DSH 设置"]').waitFor({ state: 'detached' });
  await shot('09-closed.png', 'Closed without changing real deployment or project.');
  assert.deepEqual(await read('/api/settings/dsh-plugins'), original);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, []);
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(0, 1500) };
  const page = browser.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png') }); report.dom = (await page.locator('body').innerText()).slice(-1200);
    const settingsFrame = page.frames().find(frame => frame.url().includes('surface=settings'));
    if (settingsFrame) report.settingsText = (await settingsFrame.locator('body').innerText()).slice(0, 3000); }
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close();
  console.log(JSON.stringify({ passed: report.passed, output: relative(process.cwd(), output), failure: report.failure, errors: report.errors }));
}
