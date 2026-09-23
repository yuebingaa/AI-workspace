// Managed 3001 only: a new owned CSV project, real local Notebook execution, no AI.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const red = process.argv.includes('--red');
const directory = resolve('.runtime/recipe-numeric-input-2026-09-23', `${red ? 'red' : 'green'}-${Date.now()}`);
const projectPath = join(directory, 'project');
const projectHeader = 'x-agentcanvas-project';
const fileName = 'recipe-numeric-fixture.csv';
const csv = 'item,amount\nnegative,-5\nzero,0\ndecimal,2.5\nhigh,12.75\n';
await mkdir(directory, { recursive: true });
const report = { passed: false, mode: red ? 'red-reproduction' : 'green-acceptance', base, projectPath,
  checks: [], screenshots: [], runs: [], pageErrors: [], routeErrors: [], aiRequests: 0, runRequests: 0,
  boundaries: ['New isolated browser and owned synthetic project only.', 'Real local project persistence, CSV import and Notebook runs.', 'No AI, external database, service operations or publishing.'], visualReview: 'pending actual screenshot inspection' };
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
let handle, created = 0;
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
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
        const response = await route.fetch(); assert.equal(response.status(), 200);
        handle = (await response.json()).handle;
        return await route.fulfill({ response });
      }
      assert.equal(body.action, 'save'); assert.equal(request.headers()[projectHeader], handle);
    } else if (['/api/datasets', '/api/projects/files'].includes(url.pathname)) {
      assert.equal(request.headers()[projectHeader], handle);
      assert.equal(decodeURIComponent(request.headers()['x-file-name']), fileName);
      assert.equal(request.postData(), csv);
    } else if (url.pathname === '/api/notebook/run') {
      report.runRequests++; assert.equal(request.headers()[projectHeader], handle);
      const body = request.postDataJSON(); assert.equal(body.action, 'run');
      assert.ok(body.document.cells.every(cell => ['data', 'transform'].includes(cell.kind)));
    } else throw new Error(`Unexpected mutation: ${url.pathname}`);
    return await route.continue();
  } catch (error) { report.routeErrors.push(error.message); return await route.abort('blockedbyclient'); }
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const notebook = page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const editor = page.locator('.notebook-editor');
const cell = page.getByRole('article', { name: 'DataRecipe单元 数字规则验收', exact: true });
const steps = () => editor.locator('.notebook-recipe-step');
const step = index => steps().nth(index);
async function shot(name, scenario, locator = editor) {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
  if (await locator.isVisible()) await locator.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No document overflow');
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
async function saved() {
  await page.waitForFunction(() => /已保存到本地项目|已打开本地项目/.test(document.querySelector('.top-actions')?.textContent ?? ''));
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(resolve(value.path), projectPath);
  return value.manifest.state?.dataProduct?.notebooks ?? [];
}
function transform(notebooks) { return Object.values(notebooks).flatMap(book => book.cells).find(item => item.kind === 'transform'); }
async function run(expectedRows) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 45000 }),
    notebook.getByRole('button', { name: /全部运行/ }).click(),
  ]);
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.run.status, 'success', JSON.stringify(body));
  await notebook.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(body.run.cells.at(-1).table.rows, expectedRows);
  report.runs.push({ status: body.run.status, cells: body.run.cells.map(result => ({ status: result.status, rows: result.table?.rows })) });
}
async function edit() { await cell.getByRole('button', { name: '编辑', exact: true }).click(); }
async function rejectInvalid(input, baseline) {
  const runsBefore = report.runRequests;
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  await editor.getByRole('button', { name: '保存单元', exact: true }).click();
  assert.ok(await editor.isVisible());
  await editor.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.ok(await editor.isVisible());
  await editor.getByRole('button', { name: '规则代码', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: '表单', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).count(), 0);
  assert.deepEqual(await saved(), baseline);
  assert.equal(report.runRequests, runsBefore);
}
async function addStep(type) {
  await editor.getByRole('button', { name: '＋ 添加处理步骤', exact: true }).click();
  const index = await steps().count() - 1;
  await step(index).getByRole('combobox', { name: `步骤 ${index + 1} 类型`, exact: true }).selectOption(type);
  return index;
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
  await dialog.getByLabel('项目名称', { exact: true }).fill('配方数字输入验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await saved();
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await notebook.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
  await upload.waitFor({ state: 'hidden' });
  await notebook.getByRole('button', { name: '＋ Data', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('合成数字数据');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('numeric_source');
  await saveEditor();
  await notebook.getByRole('button', { name: '＋ DataRecipe', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('数字规则验收');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('numeric_result');
  await step(0).getByRole('combobox', { name: '步骤 1 类型', exact: true }).selectOption('filter');
  await step(0).getByLabel('字段', { exact: true }).fill('amount');
  await step(0).locator('label').filter({ hasText: /^条件/ }).locator('select').selectOption('greaterThanOrEqual');
  await step(0).locator('label').filter({ hasText: /^值类型/ }).locator('select').selectOption('number');
  await step(0).getByRole('spinbutton').fill('2.5');
  await saveEditor(); await saved();
  await run([{ item: 'decimal', amount: 2.5 }, { item: 'high', amount: 12.75 }]);
  await edit();
  await step(0).getByRole('spinbutton').fill('');
  if (red) {
    assert.equal(await step(0).getByRole('spinbutton').inputValue(), '0');
    await shot('01-cleared-filter-became-zero-1440', 'Before fix: clearing the saved 2.5 numeric filter immediately displays 0.');
    await saveEditor();
    assert.equal(transform(await saved()).steps[0].value, 0);
    await run([{ item: 'zero', amount: 0 }, { item: 'decimal', amount: 2.5 }, { item: 'high', amount: 12.75 }]);
    await shot('02-unintended-zero-saved-and-run-1440', 'Before fix: the unintended 0 was saved and includes the zero row in the real local output.', cell);
    report.checks.push('RED reproduced: clearing 2.5 becomes 0, persists and changes the real filter output from two rows to three.');
  } else {
    assert.equal(await step(0).getByRole('spinbutton').inputValue(), '');
    const baseline = await saved();
    await rejectInvalid(step(0).getByRole('spinbutton'), baseline);
    await shot('01-empty-filter-blocked-1440', 'Empty numeric filter remains empty; native save, dispatched submit and rule-code conversion are blocked; persisted 2.5 and two-row result stay unchanged.', editor.locator('footer'));
    await step(0).getByRole('spinbutton').pressSequentially('1e');
    assert.ok(await step(0).getByRole('spinbutton').evaluate(input => input.validity.badInput));
    await rejectInvalid(step(0).getByRole('spinbutton'), baseline);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await shot('02-incomplete-exponent-blocked-1024', 'Native incomplete exponent 1e is marked invalid and cannot replace the saved numeric filter.', editor.locator('footer'));
    await step(0).getByRole('spinbutton').fill('');
    await step(0).getByRole('spinbutton').pressSequentially('-');
    assert.ok(await step(0).getByRole('spinbutton').evaluate(input => input.validity.badInput));
    await rejectInvalid(step(0).getByRole('spinbutton'), baseline);
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await saved(), baseline);
    await edit(); assert.equal(await step(0).getByRole('spinbutton').inputValue(), '2.5');
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    await shot('03-cancel-preserves-saved-result-1024', 'Cancel discards the invalid draft; reopening restores 2.5 and keeps the saved two-row result.', cell);
    report.checks.push('Empty, incomplete exponent 1e and isolated minus drafts block native submit, direct submit and rule-code conversion without persistence or execution; cancel restores 2.5.');

    await page.setViewportSize({ width: 1440, height: 1000 });
    const rows = [{ item: 'negative', amount: -5 }, { item: 'zero', amount: 0 }, { item: 'decimal', amount: 2.5 }, { item: 'high', amount: 12.75 }];
    for (const value of [0, -5, 10, 2.5]) {
      await edit(); await step(0).getByRole('spinbutton').fill(value === 10 ? '1e1' : String(value));
      if (value === 10) {
        await editor.getByRole('button', { name: '规则代码', exact: true }).click();
        assert.equal(JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue())[0].value, 10);
        await editor.getByRole('button', { name: '表单', exact: true }).click();
      }
      await saveEditor();
      assert.equal(transform(await saved()).steps[0].value, value);
      await run(rows.filter(row => row.amount >= value));
    }
    report.checks.push('Explicit zero, negative, decimal and valid exponent 1e1 numeric filters save as numbers and produce independently expected real local rows; code conversion emits numeric 10.');
    await shot('04-corrected-decimal-real-success-1440', 'Corrected decimal 2.5 saves and runs with exactly decimal 2.5 and high 12.75.', cell);

    await edit();
    await addStep('deriveField');
    await step(1).getByLabel('字段', { exact: true }).fill('adjusted');
    await step(1).getByLabel('显示名称', { exact: true }).fill('调整值');
    const leftKind = () => step(1).locator('label').filter({ hasText: /^左侧/ }).locator('select');
    await leftKind().selectOption('literal');
    await step(1).getByRole('spinbutton', { name: '左侧', exact: true }).fill('');
    await rejectInvalid(step(1).getByRole('spinbutton', { name: '左侧', exact: true }), await saved());
    await step(1).getByRole('spinbutton', { name: '左侧', exact: true }).fill('-2.5');
    await step(1).getByRole('spinbutton', { name: '右侧', exact: true }).fill('');
    await rejectInvalid(step(1).getByRole('spinbutton', { name: '右侧', exact: true }), await saved());
    await shot('05-empty-calculation-constant-blocked-1440', 'Both left and right literal blanks were rejected; the visible right literal is empty while left -2.5 remains a valid draft.', step(1).getByRole('spinbutton', { name: '右侧', exact: true }));
    await step(1).getByRole('spinbutton', { name: '右侧', exact: true }).fill('0');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    let code = JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue());
    assert.deepEqual(code[1].left, { kind: 'literal', value: -2.5 });
    assert.deepEqual(code[1].right, { kind: 'literal', value: 0 });
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    await saveEditor(); await run(rows.filter(row => row.amount >= 2.5).map(row => ({ ...row, adjusted: 0 })));
    report.checks.push('Both literal operands reject empty drafts; explicit -2.5 and 0 survive form/code conversion and execute as numeric constants.');

    await edit();
    await leftKind().selectOption('field');
    await step(1).getByRole('textbox', { name: '左侧', exact: true }).fill('amount');
    await step(1).getByRole('spinbutton', { name: '右侧', exact: true }).fill('-2.5');
    await addStep('limit');
    const count = () => step(2).getByRole('spinbutton');
    const beforeLimit = await saved();
    for (const value of ['', '0', '-1', '1.5', '10001']) {
      await count().fill(value); await rejectInvalid(count(), beforeLimit);
    }
    await page.setViewportSize({ width: 1024, height: 1000 });
    await shot('06-invalid-limit-blocked-1024', 'Limit blanks, zero, negative, fractional and above-maximum counts cannot save or convert to code; current visible value is 10001.', count());
    await count().fill('1');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    code = JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue());
    assert.equal(code[0].value, 2.5); assert.equal(code[1].right.value, -2.5); assert.equal(code[2].count, 1);
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    await saveEditor(); await run([{ item: 'decimal', amount: 2.5, adjusted: -6.25 }]);
    const finalDefinition = await saved();
    report.checks.push('Limit rejects blank/0/-1/1.5/10001; corrected integer 1 and multiplier -2.5 persist and run with adjusted -6.25.');

    // Invalid raw state must follow a stable step and disappear when its control is removed.
    await edit(); await count().fill('');
    await step(2).getByRole('button', { name: '上移步骤', exact: true }).click();
    assert.equal(await step(1).getByRole('spinbutton').inputValue(), '');
    await rejectInvalid(step(1).getByRole('spinbutton'), finalDefinition);
    await step(1).getByRole('button', { name: '删除步骤', exact: true }).click();
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.equal(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).count(), 1);
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    await addStep('limit'); await count().fill('');
    await step(2).getByRole('combobox', { name: '步骤 3 类型', exact: true }).selectOption('selectFields');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.equal(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).count(), 1);
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await saved(), finalDefinition);
    report.checks.push('Invalid limit follows its step during reorder; deleting it or replacing its type clears its blocking control; cancelling retains the complete saved definition.');

    await edit(); await step(0).getByRole('spinbutton').fill('');
    await step(0).locator('label').filter({ hasText: /^值类型/ }).locator('select').selectOption('string');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.equal(JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue())[0].value, '');
    await editor.getByRole('button', { name: '表单', exact: true }).click();
    await step(0).locator('label').filter({ hasText: /^值类型/ }).locator('select').selectOption('boolean');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.equal(JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue())[0].value, true);
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.deepEqual(await saved(), finalDefinition);
    report.checks.push('Changing an invalid numeric filter to text or boolean clears the numeric guard and preserves the existing typed values; cancel leaves the saved numeric definition intact.');

    await page.reload({ waitUntil: 'networkidle' });
    assert.deepEqual(await saved(), finalDefinition);
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await edit();
    assert.equal(await step(0).getByRole('spinbutton').inputValue(), '2.5');
    assert.equal(await step(1).getByRole('textbox', { name: '左侧', exact: true }).inputValue(), 'amount');
    assert.equal(await step(1).getByRole('spinbutton', { name: '右侧', exact: true }).inputValue(), '-2.5');
    assert.equal(await count().inputValue(), '1');
    await editor.getByRole('button', { name: '规则代码', exact: true }).click();
    assert.deepEqual(JSON.parse(await editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }).inputValue()), transform(finalDefinition).steps);
    await shot('07-refresh-reopened-rule-code-1024', 'Refresh and reopen restore the complete three-step definition; numeric filter 2.5, multiplier -2.5 and integer limit 1 remain unchanged.', editor.getByRole('textbox', { name: 'DataRecipe 规则代码', exact: true }));
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    await run([{ item: 'decimal', amount: 2.5, adjusted: -6.25 }]);
    report.checks.push('Saved definition and numeric fields survive reload/reopening with exact code equality; a fresh real run still produces -6.25.');
  }
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
