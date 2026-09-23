// Real managed 3001 UI, owned synthetic CSV project, and real Python only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

assert.ok(process.argv.slice(2).every(value => value === '--red'));
const base = 'http://127.0.0.1:3001';
const red = process.argv.includes('--red');
const directory = resolve('.runtime/python-files-editor-browser-20260923', `${red ? 'red' : 'green'}-${Date.now()}`);
const projectPath = join(directory, 'project');
const localPath = path => relative(process.cwd(), path).split(sep).join('/');
const projectHeader = 'x-agentcanvas-project';
const fixtures = { 'first.csv': 'source,amount\nfirst,10\nfirst,20\n', 'second.csv': 'source,amount\nsecond,7\n' };
const code = "first = pd.read_csv(files['first.csv'])\nsecond = pd.read_csv(files['second.csv'])\ncombined = pd.concat([first, second], ignore_index=True)\nprint('Two synthetic CSV files: 3 rows, total 37')";
const expectedRows = [{ source: 'first', amount: 10 }, { source: 'first', amount: 20 }, { source: 'second', amount: 7 }];
await mkdir(directory, { recursive: true });
const report = { passed: false, mode: red ? 'red-reproduction' : 'green-acceptance', base, projectPath: localPath(projectPath),
  checks: [], screenshots: [], runs: [], pageErrors: [], routeErrors: [], aiRequests: 0, runRequests: 0,
  boundaries: ['New isolated browser and owned synthetic project only.', 'Real local project persistence, CSV import and Python execution.', 'Unscoped project, dataset and connection catalogs are replaced with empty lists; AI and external HTTP are blocked.', 'No dependency installation, service operations or publishing.'],
  visualReview: 'pending actual image inspection' };
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
      if (['/api/notebook/python', '/api/health', '/api/config'].includes(url.pathname)) return await route.continue();
      assert.ok(handle && request.headers()[projectHeader] === handle, `Scoped GET required: ${url.pathname}`);
      assert.ok(/^\/api\/(?:projects|datasets)(?:\/|$)/u.test(url.pathname), `Unexpected GET: ${url.pathname}`);
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
      assert.ok(handle && request.headers()[projectHeader] === handle);
      const fileName = decodeURIComponent(request.headers()['x-file-name']);
      assert.ok(Object.hasOwn(fixtures, fileName)); assert.equal(request.postData(), fixtures[fileName]);
    } else if (url.pathname === '/api/notebook/run') {
      report.runRequests++; assert.ok(handle && request.headers()[projectHeader] === handle);
      const body = request.postDataJSON(); assert.equal(body.action, 'run');
      assert.ok(body.document.cells.every(cell => cell.kind === 'python'));
      assert.equal(body.document.cells.length, 1); assert.equal(body.document.cells[0].code, code);
      assert.deepEqual(body.document.cells[0].fileNames, ['first.csv', 'second.csv']);
    } else throw new Error(`Unexpected mutation: ${url.pathname}`);
    return await route.continue();
  } catch (error) { report.routeErrors.push(error.message); return await route.abort('blockedbyclient'); }
});
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on('pageerror', error => report.pageErrors.push(error.message));
const notebook = page.getByRole('region', { name: 'Notebook 分析文档', exact: true });
const editor = page.locator('.notebook-editor');
const cell = page.getByRole('article', { name: 'Python单元 双文件输入验收', exact: true });
const files = () => editor.getByRole('textbox', { name: 'Python 原始文件', exact: true });
async function shot(name, scenario, locator = files()) {
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
  assert.ok(handle);
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(resolve(value.path), projectPath);
  return value.manifest.state?.dataProduct?.notebooks ?? [];
}
function python(notebooks) { return Object.values(notebooks).flatMap(book => book.cells).find(item => item.kind === 'python'); }
async function edit() { await cell.getByRole('button', { name: '编辑', exact: true }).click(); }
async function cancel() { await editor.getByRole('button', { name: '取消编辑', exact: true }).click(); }
async function run() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${base}/api/notebook/run`, { timeout: 45000 }),
    cell.getByRole('button', { name: '▶ 运行', exact: true }).click(),
  ]);
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, 'success', JSON.stringify(body));
  await notebook.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(body.run.cells.at(-1).table.rows, expectedRows);
  report.runs.push({ status: body.run.status, cells: body.run.cells.map(result => ({ status: result.status, rows: result.table?.rows })) });
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const statusResponse = await context.request.get(`${base}/api/notebook/python`);
  const status = await statusResponse.json();
  report.pythonCapability = { enabled: status.enabled, available: status.available, reason: status.reason };
  assert.equal(status.available, true, 'Python unavailable; no switches or services changed.');
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('Python 文件名输入验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' }); await saved();
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  if (!red) {
    await notebook.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type="file"]').setInputFiles(Object.entries(fixtures).map(([name, csv]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) })));
    await upload.getByRole('button', { name: '导入 2 份文件', exact: true }).click();
    await upload.waitFor({ state: 'hidden' });
  }
  await notebook.getByRole('button', { name: '＋ Python', exact: true }).click();
  await editor.getByLabel('单元名称', { exact: true }).fill('双文件输入验收');
  await editor.getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('combined');
  await editor.getByRole('textbox', { name: 'Python', exact: true }).fill(code);
  await files().pressSequentially('first.csv'); await files().press('Enter');
  if (red) {
    assert.equal(await files().inputValue(), 'first.csv');
    await shot('01-enter-newline-lost-1440', 'Before fix: actual keyboard Enter after first.csv immediately disappears from the controlled textarea.');
    await files().pressSequentially('second.csv'); assert.equal(await files().inputValue(), 'first.csvsecond.csv');
    report.checks.push('Actual keyboard reproduces Enter removal and second filename concatenation. No erroneous definition was saved or run.');
    await cancel();
  } else {
    assert.equal(await files().inputValue(), 'first.csv\n');
    await files().pressSequentially('second.csv'); assert.equal(await files().inputValue(), 'first.csv\nsecond.csv');
    await shot('01-keyboard-two-lines-1440', 'Actual keyboard first.csv, Enter, second.csv preserves two separate file names.');
    await saveEditor(); assert.deepEqual(python(await saved()).fileNames, ['first.csv', 'second.csv']);
    await run();
    await shot('02-real-two-csv-success-1440', 'Real pd.read_csv of both current-project originals combines exactly first 10, first 20, second 7.', cell);
    report.checks.push('Keyboard Enter, two filenames, persisted array and real two-CSV Python output all match.');

    await edit();
    await files().fill('\r\nfirst.csv\r\n\r\nsecond.csv\r\n');
    assert.equal(await files().inputValue(), '\nfirst.csv\n\nsecond.csv\n');
    await editor.getByLabel('单元名称', { exact: true }).fill('双文件输入验收');
    assert.equal(await files().inputValue(), '\nfirst.csv\n\nsecond.csv\n');
    await saveEditor(); assert.deepEqual(python(await saved()).fileNames, ['first.csv', 'second.csv']);
    await edit(); assert.equal(await files().inputValue(), 'first.csv\nsecond.csv'); await cancel();
    report.checks.push('Textarea browser-normalized CRLF and leading/intermediate/trailing empty lines persist while editing; save ignores only truly empty lines and reopening shows two canonical names.');

    const baseline = await saved();
    await edit(); await page.setViewportSize({ width: 1024, height: 1000 });
    for (const [name, value] of [
      ['forward path', '../first.csv\nsecond.csv'], ['backslash path', 'folder\\first.csv\nsecond.csv'],
      ['duplicate', 'first.csv\nfirst.csv'], ['four files', 'first.csv\nsecond.csv\nthird.csv\nfourth.csv'],
      ['unsupported extension', 'first.txt\nsecond.csv'], ['whitespace-only line', 'first.csv\n \nsecond.csv'],
    ]) {
      await files().fill(value);
      await editor.getByRole('button', { name: '保存单元', exact: true }).click();
      assert.ok(await editor.isVisible()); assert.ok(await editor.getByRole('alert').isVisible());
      assert.equal(await files().inputValue(), value); assert.deepEqual(await saved(), baseline); assert.equal(report.runRequests, 1);
      report.checks.push(`Schema rejects ${name}; exact raw draft remains, prior saved definition and run remain unchanged.`);
      if (name === 'duplicate') await shot('03-duplicate-save-rejected-1024', 'Duplicate file names are rejected by the existing Schema; raw draft remains editable and prior two-file definition is unchanged.', editor.getByRole('alert'));
    }
    await cancel(); assert.deepEqual(await saved(), baseline);
    await edit(); assert.equal(await files().inputValue(), 'first.csv\nsecond.csv');
    await shot('04-cancel-restores-file-names-1024', 'After cancelling the invalid draft, reopening restores exactly first.csv and second.csv.');
    await files().fill(''); await saveEditor(); assert.deepEqual(python(await saved()).fileNames, []);
    await edit(); await files().fill('first.csv\nsecond.csv'); await saveEditor();
    report.checks.push('Cancel restores saved filenames; optional empty list saves as [], then two-file definition is restored without execution.');

    const finalDefinition = await saved();
    await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual(await saved(), finalDefinition);
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click(); await edit();
    assert.equal(await files().inputValue(), 'first.csv\nsecond.csv');
    assert.equal(await editor.getByRole('textbox', { name: 'Python', exact: true }).inputValue(), code);
    await shot('05-refresh-reopened-two-files-1024', 'Refresh and reopen recover exactly both filenames and the saved Python code.');
    await cancel(); await run();
    report.checks.push('Reload and reopen preserve exact filenames and code; a second real Python run reproduces the same three rows.');
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.equal(report.aiRequests, 0);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message.replaceAll(projectPath, '[owned-project]'), stack: error.stack?.replaceAll(process.cwd(), '[site]') };
  await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ directory: localPath(directory), passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error?.message }, null, 2));
}
