import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Isolated browser storage, synthetic drafts, mocked settings. No model/account mutations.
const evidence = resolve(process.env.STUDIO_NAV_EVIDENCE_DIR || '.runtime/hex-layout-2026-09-14');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [], checks = [], captures = [];
let modelRequests = 0, settingsWrites = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/ai/**', route => { modelRequests++; return route.abort(); });
await context.route('**/api/settings/**', route => {
  if (route.request().method() !== 'GET') { settingsWrites++; return route.abort(); }
  const body = route.request().url().endsWith('/wecom')
    ? { available: true, connected: false, pending: false, qrReady: false, failed: false, message: '尚未连接', tools: [] }
    : { configured: true, source: 'environment', model: 'test-model', modelSource: 'environment', availableModels: [], modelsDiscovered: false, persistence: 'process-memory' };
  return route.fulfill({ status: 200, json: body });
});
await context.route('**/api/projects', route => route.request().method() === 'GET'
  ? route.fulfill({ status: 200, json: { projects: [] } }) : route.abort());
const trigger = page.locator('.studio-navigation-toggle');
const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
const prompt = page.getByRole('textbox', { name: 'AI 指令' });
async function mode(value) {
  await page.locator(`#workspace-tab-${value}`).click();
  await page.locator(`#workspace-tab-${value}[aria-selected="true"]`).waitFor();
}
async function openMenu() {
  if (!await menu.isVisible()) await trigger.click();
  await menu.waitFor();
}
async function action(label) {
  await openMenu();
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill(label);
  await menu.getByRole('button', { name: label, exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
}
async function capture(name) {
  await page.mouse.move(0, 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal page overflow`);
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: 'disabled' });
  captures.push(name);
}
async function assertFocusOnTrigger() {
  assert(await trigger.evaluate(el => el === document.activeElement), 'Closing a menu/dialog restores a connected navigation trigger');
}
try {
  await page.goto('http://127.0.0.1:3001', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#workspace-tab-agent').getAttribute('aria-selected'), 'true');
  assert.equal(Math.round((await page.locator('.topbar').boundingBox()).height), 56);
  assert.equal(await page.locator('.workspace-sidebar-rail').isVisible(), false);
  await capture('after-agent');
  await openMenu();
  assert(await menu.getByRole('textbox').evaluate(el => document.activeElement === el));
  await capture('after-menu');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '数据浏览器');
  await page.keyboard.press('Escape');
  await assertFocusOnTrigger();
  await openMenu();
  await menu.getByRole('textbox').fill('没有这项功能');
  await menu.getByText('没有找到相关功能，试试“数据”或“历史”。').waitFor();
  await page.locator('#agent-welcome-title').click();
  assert.equal(await menu.isVisible(), false);
  checks.push('首次进入 AI；单行导航；菜单自动聚焦、搜索、方向键、Escape、外部点击关闭');

  await page.getByRole('button', { name: '生成可视化', exact: true }).click();
  const draft = await prompt.inputValue();
  assert(draft.includes('可视化预览'));
  await page.locator('.right-panel input[accept="image/jpeg,image/png,image/webp"]').setInputFiles({
    name: 'navigation-test.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGAAAAAASUVORK5CYII=', 'base64'),
  });
  for (const value of ['notebook', 'canvas', 'agent']) {
    await mode(value);
    assert.equal(await prompt.inputValue(), draft);
    assert.equal(await page.getByRole('button', { name: '移除图片 navigation-test.png' }).count(), 1);
  }
  await page.getByRole('button', { name: '移除图片 navigation-test.png' }).click();
  await mode('notebook');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  assert.equal(await prompt.isVisible(), false);
  await capture('notebook-assistant-collapsed');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  assert.equal(await prompt.inputValue(), draft);
  await prompt.fill('');
  await capture('after-notebook');
  await mode('canvas'); await capture('after-canvas');
  await page.locator('#workspace-tab-canvas').focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#workspace-tab-agent').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#workspace-tab-notebook').getAttribute('aria-selected'), 'true');
  checks.push('同一个输入区保留草稿与附件；侧栏收放保留草稿；模式方向键与 Home 正常');

  for (const label of ['数据浏览器', '数据库连接', '原始文件', '语义模型', '工作界面与数据', '任务与变更历史']) {
    const button = page.locator(`.workspace-sidebar-rail button[data-tooltip="${label}"]`);
    await button.hover();
    assert.equal(await button.evaluate(el => getComputedStyle(el, '::after').opacity), '1');
  }
  await capture('notebook-tools');
  await action('数据库连接');
  assert.equal(await page.locator('.notebook-connections').getAttribute('open'), '');
  await action('数据浏览器');
  await page.getByRole('dialog', { name: 'Data Browser 数据浏览器' }).waitFor();
  await capture('data-browser');
  await page.getByRole('button', { name: '关闭数据浏览器' }).click();
  await assertFocusOnTrigger();
  await action('语义模型');
  await page.getByRole('dialog', { name: '语义模型管理' }).waitFor();
  await capture('semantic-models');
  await page.getByRole('button', { name: '关闭语义模型管理' }).click();
  await action('原始文件');
  await page.getByRole('complementary', { name: '原始文件面板' }).waitFor();
  await capture('original-files-panel');
  await page.getByRole('button', { name: '收起原始文件面板', exact: true }).click();
  await action('任务与变更历史');
  await page.getByRole('button', { name: '关闭任务历史' }).waitFor();
  await capture('history');
  await page.getByRole('button', { name: '关闭任务历史' }).click();
  await assertFocusOnTrigger();
  await action('工作界面与数据');
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  assert.equal(await page.locator('.workspace-sidebar-rail').isVisible(), true);
  checks.push('六个工具提示可见；连接、数据、语义模型、文件导入、历史、页面结构均可达');

  for (const [label, dialogName] of [['AI 接口配置', 'AI 接口配置'], ['企业微信连接', '连接企业微信']]) {
    await action(label);
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await dialog.waitFor();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'Settings keyboard focus stays inside its modal');
    }
    await capture(label === 'AI 接口配置' ? 'api-settings' : 'wecom-settings');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await assertFocusOnTrigger();
  }
  await openMenu();
  await menu.locator('.studio-navigation-settings > summary').click();
  await menu.getByRole('combobox').selectOption('viewer');
  assert.equal(await menu.getByRole('button', { name: '新建界面', exact: true }).isDisabled(), true);
  await menu.getByRole('combobox').selectOption('editor');
  await page.keyboard.press('Escape');
  await openMenu();
  await menu.getByRole('button', { name: '新建界面', exact: true }).click();
  await menu.getByRole('textbox', { name: '工作界面名称' }).fill('布局验收工作界面');
  await menu.getByRole('button', { name: '创建', exact: true }).click();
  await openMenu();
  await menu.getByRole('button', { name: '布局验收工作界面 当前', exact: true }).waitFor();
  await capture('menu-new-interface');
  await page.keyboard.press('Escape');
  const downloadPending = page.waitForEvent('download');
  await action('下载工作区备份');
  const download = await downloadPending;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert(JSON.stringify(backup).includes('布局验收工作界面'));
  if (await page.getByRole('button', { name: '知道了', exact: true }).isVisible()) await page.getByRole('button', { name: '知道了', exact: true }).click();
  const chooserPending = page.waitForEvent('filechooser');
  await action('从备份文件恢复');
  const chooser = await chooserPending;
  assert(chooser.element());
  checks.push('设置弹窗焦点与 Escape；角色约束；新建/最近界面；备份包含新界面；恢复文件选择器可达');

  await mode('agent');
  for (const [width, height] of [[1440, 1000], [1280, 720], [820, 900], [390, 844], [360, 740], [375, 667]]) {
    await page.setViewportSize({ width, height });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const suggestions = await page.locator('.agent-suggestions').boundingBox();
    const composer = await page.locator('.prompt-box').boundingBox();
    assert(suggestions.y + suggestions.height < composer.y, `${width}: suggestions fit above composer`);
    assert(await prompt.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    }), `${width}: composer unobstructed`);
    await openMenu();
    const bounds = await menu.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 56 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, `${width}x${height}: ${JSON.stringify(bounds)}`);
    await capture(`menu-${width}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '添加附件或上下文', exact: true }).click();
    await page.getByRole('menuitem', { name: '选择工作界面与数据表', exact: true }).click();
    const submenu = await page.getByRole('menu', { name: '工作界面与数据表', exact: true }).boundingBox();
    assert(submenu.x >= 0 && submenu.y >= 0 && submenu.x + submenu.width <= width && submenu.y + submenu.height <= height);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('after-mobile-agent');
  await action('工作界面与数据');
  await page.getByRole('button', { name: '关闭页面与结构面板' }).waitFor();
  await capture('mobile-pages');
  await page.getByRole('button', { name: '关闭页面与结构面板' }).click();
  await assertFocusOnTrigger();
  await mode('notebook');
  const assistantEntry = page.getByRole('button', { name: 'AI 助手', exact: true });
  assert.equal(await assistantEntry.getAttribute('aria-expanded'), 'false');
  await assistantEntry.click();
  assert.equal(await assistantEntry.getAttribute('aria-expanded'), 'true');
  await prompt.fill('手机端草稿保留');
  await capture('mobile-notebook-assistant');
  await page.keyboard.press('Escape');
  assert.equal(await assistantEntry.getAttribute('aria-expanded'), 'false');
  await assistantEntry.click();
  assert.equal(await prompt.inputValue(), '手机端草稿保留');
  await page.getByRole('button', { name: '关闭 AI 助手面板' }).click();
  await action('AI 接口配置'); await capture('mobile-api-settings'); await page.keyboard.press('Escape');
  await mode('canvas'); await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#workspace-tab-canvas').getAttribute('aria-selected'), 'true');
  checks.push('六种尺寸菜单与上下文菜单不越界、输入区无遮挡；手机页面/AI 侧栏；刷新保留看板模式');
  assert.deepEqual(errors, []); assert.equal(modelRequests, 0); assert.equal(settingsWrites, 0);
  await writeFile(resolve(evidence, 'navigation-checks.json'), JSON.stringify({ checks, captures, errors, modelRequests, settingsWrites }, null, 2));
  console.log(JSON.stringify({ checks, screenshots: captures.length, errors, modelRequests, settingsWrites }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidence, 'failure.png'), animations: 'disabled' });
  throw error;
} finally { await browser.close(); }
