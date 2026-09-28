// Fresh 3001 browser, run-owned synthetic project. Configuration responses are fixtures; no real keys or model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chooseUiOption } from './fixtures/ui-controls.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/radix-themes-20260928', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
await mkdir(directory, { recursive: true });
const report = { passed: false, base, projectPath, checks: [], screenshots: [], errors: [], blocked: [], motion: {} };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'no-preference', serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on('pageerror', error => report.errors.push(error.message));
let handle, releaseKeyFailure;
let status = { configured: true, source: 'runtime', model: 'fixture-model-a', modelSource: 'runtime',
  availableModels: [{ id: 'fixture-model-a', ownedBy: 'fixture' }, { id: 'fixture-model-b', ownedBy: 'fixture' }],
  modelsDiscovered: true, persistence: 'process-memory' };
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  try {
    assert.equal(url.origin, base);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const scope = request.headers()['x-agentcanvas-project'];
    if (method === 'GET' && ['/api/projects', '/api/datasets'].includes(url.pathname) && !scope) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (url.pathname === '/api/settings/ai') {
      if (method === 'GET') return route.fulfill({ json: status });
      if (method === 'PATCH') {
        assert.equal(request.postDataJSON().model, 'fixture-model-b');
        status = { ...status, model: 'fixture-model-b' }; return route.fulfill({ json: status });
      }
      if (method === 'POST') {
        assert.equal(request.postDataJSON().apiKey, 'synthetic-not-a-real-key');
        await new Promise(done => { releaseKeyFailure = done; });
        return route.fulfill({ status: 400, json: { error: { message: '合成验收：无法验证该密钥，请检查后重试。' } } });
      }
    }
    if (method === 'POST' && url.pathname === '/api/projects' && request.postDataJSON()?.action === 'create') {
      assert.equal(request.postDataJSON().path, projectPath);
      const response = await route.fetch(); assert.equal(response.status(), 200);
      handle = (await response.json()).handle; return route.fulfill({ response });
    }
    if (url.pathname.startsWith('/api/projects') || url.pathname.startsWith('/api/datasets')) {
      assert.ok(handle && scope === handle, 'Outside run-owned project'); return route.continue();
    }
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname === '/api/notebook/python')) return route.continue();
    throw Error(`Unexpected API ${method} ${url.pathname}`);
  } catch (error) { report.blocked.push(error.message); return route.abort('blockedbyclient'); }
});
const trigger = page.locator('.studio-navigation-toggle');
const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
async function openMenu() {
  const notice = page.getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  await trigger.click(); await menu.waitFor();
}
async function action(label) {
  await openMenu(); await menu.getByRole('textbox').fill(label);
  await menu.getByRole('button', { name: label, exact: true }).click();
}
async function focusAt(locator) {
  await page.waitForFunction(element => document.activeElement === element, await locator.elementHandle());
}
async function shot(file, scenario) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth - innerWidth,
    dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(el => el.getBoundingClientRect().width > 0).map(el => el.getBoundingClientRect().toJSON()) }));
  assert.ok(layout.overflow <= 1, JSON.stringify(layout));
  for (const rect of layout.dialogs) assert.ok(rect.x >= -1 && rect.y >= -1 && rect.right <= layout.width + 1 && rect.bottom <= layout.height + 1, JSON.stringify(rect));
  await page.screenshot({ path: join(directory, file + '.png'), animations: 'disabled' });
  report.screenshots.push({ file: file + '.png', scenario, layout, visuallyReviewed: false });
}
const computed = locator => locator.evaluate(el => { const style = getComputedStyle(el); return { transition: style.transitionDuration, animation: style.animationName, animationDuration: style.animationDuration, transform: style.transform }; });
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await openMenu();
  await focusAt(menu.getByRole('textbox'));
  report.motion.normalButton = await computed(trigger);
  report.motion.normalPopover = await computed(page.locator('.studio-navigation-popover'));
  assert.match(report.motion.normalButton.transition, /0\.14s/u);
  assert.notEqual(report.motion.normalPopover.animation, 'none');
  const imported = menu.getByRole('button', { name: '导入表格', exact: true });
  await imported.hover();
  await page.mouse.down();
  await page.waitForTimeout(160); // Measure the short active-state transition after its duration.
  report.motion.pressedButton = await computed(imported);
  assert.equal(report.motion.pressedButton.transform, 'matrix(1, 0, 0, 1, 0, 1)');
  await page.mouse.move(800, 100); await page.mouse.up();
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  await openMenu();
  await shot('01-menu', 'Radix menu, search autofocus and hover/press feedback with normal motion.');
  await menu.getByRole('textbox').fill('不存在xyz');
  await menu.getByText('没有找到相关功能，试试“数据”或“历史”。', { exact: true }).waitFor();
  await shot('02-search-empty', 'Search empty state remains readable.');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); await focusAt(trigger);
  report.checks.push('Normal-motion popover animation, 140 ms button feedback, 1 px pressed state, search empty state and Escape focus return.');

  await action('AI 接口配置');
  const api = page.getByRole('dialog', { name: 'AI 接口配置', exact: true }); await api.waitFor();
  await api.getByText('DeepSeek API 已配置', { exact: true }).waitFor();
  const model = api.getByRole('combobox');
  await model.click(); await page.getByRole('option', { name: 'fixture-model-b', exact: true }).waitFor();
  await shot('03-select-in-dialog', 'Portaled model select remains usable inside the modal; all configuration data are fixtures.');
  await page.keyboard.press('Escape'); await focusAt(model);
  await chooseUiOption(page, model, 'fixture-model-b');
  await api.getByRole('button', { name: '应用模型', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ai-api-configured-card')?.textContent.includes('当前模型：fixture-model-b'));
  assert.equal(await api.getByRole('button', { name: '应用模型', exact: true }).isDisabled(), true);
  await shot('04-settings-success', 'Synthetic model selection success; unchanged model cannot be applied again.');
  await api.getByRole('button', { name: '更换密钥', exact: true }).click();
  await api.getByLabel('DeepSeek API Key', { exact: true }).fill('synthetic-not-a-real-key');
  await api.getByRole('button', { name: '验证密钥并识别模型', exact: true }).click();
  const busyButton = api.locator('button[aria-busy="true"]'); await busyButton.waitFor();
  report.loadingAccessibility = await busyButton.ariaSnapshot();
  assert.match(report.loadingAccessibility, /正在识别/u);
  assert.equal(await busyButton.getAttribute('aria-busy'), 'true');
  assert.equal(await busyButton.locator('.rt-Spinner').count(), 1);
  await page.keyboard.press('Escape'); assert.equal(await api.isVisible(), true);
  await shot('05-settings-loading', 'Real pending UI with Radix spinner; Escape does not dismiss a pending submission. Request is held by fixture.');
  releaseKeyFailure(); releaseKeyFailure = undefined;
  await api.getByRole('alert').getByText('合成验收：无法验证该密钥，请检查后重试。', { exact: true }).waitFor();
  await shot('06-settings-failure', 'Synthetic verification failure leaves the form usable and explains the failure.');
  await api.getByRole('button', { name: '取消更换', exact: true }).click();
  assert.equal(await api.getByLabel('DeepSeek API Key', { exact: true }).count(), 0);
  await page.keyboard.press('Tab'); assert.equal(await api.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape'); await api.waitFor({ state: 'hidden' }); await focusAt(trigger);
  report.checks.push('Modal select Escape only closes select; synthetic setting success, pending spinner and close lock, failure, cancel; modal focus remains inside and returns to menu trigger.');

  await action('数据浏览器');
  const data = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await data.getByRole('button', { name: /项目文件夹/u }).first().click();
  await data.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await data.getByLabel('项目名称', { exact: true }).fill('Radix 交互隔离验收');
  await data.getByRole('button', { name: '新建本地项目', exact: true }).click(); await data.waitFor({ state: 'hidden' });
  await action('导入表格');
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type=file]').setInputFiles({ name: 'synthetic-ui.csv', mimeType: 'text/csv', buffer: Buffer.from('region,amount\nEast,100\nWest,80\n') });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' });
  await action('数据浏览器');
  await data.getByRole('button', { name: /原始文件/u }).first().click();
  const remove = data.getByRole('button', { name: '删除文件 synthetic-ui.csv', exact: true }); await remove.click();
  const deletion = page.getByRole('alertdialog'); await deletion.waitFor();
  const deletionBounds = await deletion.boundingBox();
  assert.ok(Math.abs(deletionBounds.x + deletionBounds.width / 2 - 720) < 2, 'File confirmation should be centered');
  await focusAt(deletion.getByRole('button', { name: '取消', exact: true }));
  await shot('07-delete-confirmation', 'Nested original-file confirmation focuses cancel; only synthetic run-owned data.');
  await page.keyboard.press('Escape'); await deletion.waitFor({ state: 'hidden' });
  assert.equal(await data.isVisible(), true); await focusAt(remove);
  await shot('08-delete-cancelled', 'Escape cancels nested deletion, keeps the outer browser open and restores the same file action.');
  await page.keyboard.press('Escape'); await data.waitFor({ state: 'hidden' });
  report.checks.push('Real synthetic CSV import; nested file deletion cancel and focus restoration; no file deleted.');

  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 1024, height: 800 });
  await openMenu();
  report.motion.reducedButton = await computed(trigger);
  report.motion.reducedPopover = await computed(page.locator('.studio-navigation-popover'));
  assert.equal(report.motion.reducedButton.transition, '0s');
  assert.equal(report.motion.reducedPopover.animation, 'none');
  await shot('09-reduced-motion-1024', 'Reduced motion disables transitions and popup animation; menu fits 1024 desktop.');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const mode = page.getByRole('tab', { name: 'Notebook', exact: true }); await mode.focus();
  await page.keyboard.press('ArrowRight');
  const canvas = page.getByRole('tab', { name: '看板', exact: true }); await focusAt(canvas);
  assert.equal(await canvas.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft'); await focusAt(mode);
  assert.equal(await mode.getAttribute('aria-selected'), 'true');
  await shot('10-notebook-1024', 'Keyboard mode switching selects and focuses tabs; fixed header stays visible at 1024.');
  const header = await page.locator('header.topbar').boundingBox(); assert.ok(header && header.y >= 0);
  report.checks.push('Reduced-motion button/popup animations disabled; 1024 layout; Radix tab arrow-key navigation, automatic selection and stable header.');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.passed = true;
} catch (error) {
  report.failure = String(error); await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {}); throw error;
} finally {
  releaseKeyFailure?.(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks }));
}
