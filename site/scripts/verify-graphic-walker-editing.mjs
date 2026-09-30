// Managed 3001 only; fresh browser storage and synthetic chart. No models or user projects.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const directory = resolve('.runtime/graphic-walker-20260929', `editing-${Date.now()}`);
await mkdir(directory, { recursive: true });
const report = { passed: false, checks: [], screenshots: [], errors: [], external: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
await context.addInitScript(() => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (window.__failChartSave && key.startsWith('datacanvas:chart-editor:')) throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
    return setItem.call(this, key, value);
  };
});
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== 'http://127.0.0.1:3001') { report.external.push(url.href); return route.abort(); }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 403, json: { error: 'Isolated chart test: API access disabled' } });
  return route.continue();
});
const check = detail => { report.checks.push(detail); console.log(`PASS ${detail}`); };
const snap = async name => { await page.screenshot({ path: join(directory, `${name}.png`) }); report.screenshots.push({ name, viewed: false }); };
const ready = async () => { await page.locator('.gw-canvas[data-state="ready"]').waitFor({ timeout: 45000 }); await page.waitForTimeout(350); await page.locator('.gw-plot').getByText('Loading...', { exact: true }).waitFor({ state: 'hidden' }); await page.locator('.gw-plot svg').first().waitFor(); };
const button = name => page.getByRole('button', { name, exact: true });
const select = async (label, option) => { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
const save = () => button('保存配置').click();
try {
  await page.goto('http://127.0.0.1:3001/charts'); await ready();
  assert.equal(await button('撤销').isDisabled(), true); assert.equal(await button('重做').isDisabled(), true);
  await save();
  await page.getByRole('tab', { name: 'Style · 样式' }).click();
  await page.getByRole('textbox', { name: '图表标题' }).fill('销售图 · 导出验收'); await ready();
  await button('撤销').click(); await ready(); assert.match(await page.locator('.gw-canvas h2').innerText(), /季度成交金额/);
  assert.match(await page.locator('.gw-toolbar').innerText(), /已保存/);
  await button('重做').click(); await ready(); assert.equal(await page.locator('.gw-canvas h2').innerText(), '销售图 · 导出验收');
  await select('配色', '暖橙'); await ready();
  await button('撤销').click(); await ready(); assert.match(await page.locator('.gw-plot svg').first().innerHTML(), /#7d91c8/i);
  await select('配色', '湖蓝'); await ready(); assert.equal(await button('重做').isDisabled(), true);
  check('Undo/redo restores title and actual SVG palette; editing after undo clears redo; undo-to-save clears dirty');
  await button('← 返回工作台').click();
  const confirm = page.getByRole('alertdialog', { name: '放弃未保存的图表修改？' });
  await confirm.waitFor(); await snap('01-unsaved-exit');
  await confirm.getByRole('button', { name: '继续编辑' }).click(); await confirm.waitFor({ state: 'hidden' });
  assert.match(page.url(), /\/charts$/); assert.equal(await page.locator('.gw-canvas h2').innerText(), '销售图 · 导出验收');
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  check('Unsaved exit can be canceled without losing changes; refresh/close guard registered');
  await page.evaluate(() => { window.__failChartSave = true; }); await save();
  await page.getByRole('alert').filter({ hasText: '浏览器存储不可用' }).waitFor(); await ready(); await snap('02-save-failure');
  await button('← 返回工作台').click(); await confirm.waitFor(); await confirm.getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await page.locator('.gw-canvas h2').innerText(), '销售图 · 导出验收');
  await page.evaluate(() => { window.__failChartSave = false; }); await save();
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  check('Injected storage failure preserves edits and dirty guard; successful save removes guard');
  for (const format of ['SVG', 'PNG']) {
    const downloadPromise = page.waitForEvent('download'); await button(`导出 ${format}`).click();
    const download = await downloadPromise; const file = join(directory, `chart.${format.toLowerCase()}`); await download.saveAs(file);
    const content = await readFile(file);
    if (format === 'SVG') { assert.match(content.toString(), /<svg/); assert.match(content.toString(), /企业客户/); assert.match(content.toString(), /#315b8c/i); }
    else { assert.deepEqual([...content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(content.readUInt32BE(16) > 400); assert.ok(content.readUInt32BE(20) > 200); }
    assert.match(download.suggestedFilename(), /销售图 · 导出验收/);
  }
  await page.getByRole('status').filter({ hasText: '已生成 1 个 PNG' }).waitFor(); await snap('03-image-export');
  check('Official renderer exported valid local SVG and PNG with matching series and changed palette; no screenshot scraping');
  await page.evaluate(() => { window.__realBlob = window.Blob; window.Blob = class extends Blob { constructor() { throw Error('模拟下载失败：浏览器拒绝创建文件'); } }; });
  await button('导出 SVG').click(); await page.getByRole('alert').filter({ hasText: '模拟下载失败' }).waitFor(); await snap('04-export-failure');
  await page.evaluate(() => { window.Blob = window.__realBlob; });
  const recovered = page.waitForEvent('download'); await button('导出 SVG').click(); await recovered;
  check('Injected file-creation failure is visible and retry succeeds');
  await page.getByRole('tab', { name: 'Data · 数据' }).click(); await select('选择水平分面字段', '客户类型'); await ready();
  const facetDownloadPromise = page.waitForEvent('download'); await button('导出 SVG').click();
  const facetDownload = await facetDownloadPromise; await facetDownload.saveAs(join(directory, 'faceted.svg'));
  const facetSvg = await readFile(await facetDownload.path(), 'utf8');
  for (const label of ['个人客户', '中小企业', '企业客户']) assert.ok(facetSvg.includes(label));
  await button('移除 水平分面 客户类型').click(); await ready();
  check('Faceted SVG contains every customer panel');
  await page.setViewportSize({ width: 1024, height: 850 }); await ready();
  const before = await page.locator('.gw-plot').boundingBox(); await button('收起字段库').click(); await ready();
  assert.equal(await page.getByRole('complementary', { name: '数据字段库' }).count(), 0);
  const after = await page.locator('.gw-plot').boundingBox(); assert.ok(after.width > before.width + 100);
  await page.getByRole('tab', { name: 'Data · 数据' }).click(); await select('图表类型', '柱状图'); await ready(); await snap('05-collapsed-1024');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await button('展开字段库').click(); await ready(); assert.equal(await page.getByRole('textbox', { name: '搜索字段' }).isVisible(), true);
  check('Collapsed library increases narrow desktop plot width; controls remain usable; expansion restores fields');
  await button('移除 Y 轴 成交金额').click(); await page.locator('.gw-canvas[data-state="empty"]').waitFor();
  assert.equal(await button('导出 SVG').isDisabled(), true); assert.equal(await button('导出 PNG').isDisabled(), true); await snap('06-empty-export-disabled');
  await button('撤销').click(); await ready(); await save(); await page.reload(); await ready();
  assert.equal(await button('撤销').isDisabled(), true); assert.equal(await button('重做').isDisabled(), true);
  assert.equal(await page.locator('.gw-canvas h2').innerText(), '销售图 · 导出验收');
  check('Empty chart cannot export; undo recovers; persisted config restores while temporary undo history does not');
  assert.deepEqual(report.errors, []); assert.ok(report.external.every(url => url === 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'));
  report.passed = true;
} catch (error) { report.failure = error.stack; await snap('failure'); throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(`EVIDENCE ${directory}`); await browser.close(); }
