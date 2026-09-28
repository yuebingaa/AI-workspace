// 3001-only restore acceptance. All project files and CSV rows are synthetic and
// created in this run's evidence directory. No model, database or Notebook run.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001';
const projectHeader = 'x-agentcanvas-project';
const directory = resolve('.runtime/workspace-restore-scope-20260926', `browser-${Date.now()}`);
const projectPath = join(directory, 'project');
const report = { passed: false, base, projectPath: relative(process.cwd(), projectPath).replaceAll('\\', '/'),
  checks: [], screenshots: [], pageErrors: [], blocked: [], routes: [], dialogs: [], modelRequests: 0, notebookRuns: 0 };
await mkdir(directory, { recursive: true });

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
  reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
let handle = null, datasetId = null, holdNextDatasetRead = false;
let heldReadStarted, releaseHeldRead;
let heldReadPromise = Promise.resolve();
let nextDialog = null;

page.on('dialog', async dialog => {
  const action = nextDialog;
  nextDialog = null;
  report.dialogs.push({ type: dialog.type(), action: action ?? 'unexpected',
    isRestorePrompt: /确定从.*恢复工作区/u.test(dialog.message()) });
  await (action === 'accept' ? dialog.accept() : dialog.dismiss());
});

await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) { report.blocked.push(`external ${url.origin}`); return route.abort('blockedbyclient'); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const method = request.method(), scoped = request.headers()[projectHeader];
  try {
    if (url.pathname.startsWith('/api/ai/') && !url.pathname.startsWith('/api/ai/dsh/web/')) {
      report.modelRequests++; throw new Error(`Model transport prohibited: ${method} ${url.pathname}`);
    }
    if (url.pathname === '/api/notebook/run') { report.notebookRuns++; throw new Error('Notebook execution prohibited'); }
    if (method === 'GET' && url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
    if (method === 'GET' && url.pathname === '/api/projects' && !scoped) return route.fulfill({ json: { projects: [] } });
    if (method === 'GET' && url.pathname === '/api/datasets' && !scoped) return route.fulfill({ json: { datasets: [] } });
    if (url.pathname === '/api/projects' && method === 'POST' && request.postDataJSON()?.action === 'create') {
      assert.equal(request.postDataJSON()?.path, projectPath, 'Project creation escaped its run-owned folder.');
      const response = await route.fetch();
      assert.equal(response.status(), 200, await response.text());
      handle = (await response.json()).handle;
      assert.ok(handle);
      report.routes.push(`create ${url.pathname}`);
      return route.fulfill({ response });
    }
    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/datasets') || url.pathname.startsWith('/api/projects/files')) {
      assert.ok(handle && scoped === handle, `Unscoped project data request: ${method} ${url.pathname}`);
      if (method === 'GET' && datasetId && url.pathname === `/api/datasets/${encodeURIComponent(datasetId)}` && holdNextDatasetRead) {
        holdNextDatasetRead = false;
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        heldReadStarted();
        await heldReadPromise;
        report.routes.push(`released delayed GET ${url.pathname}`);
        return route.fulfill({ response });
      }
      report.routes.push(`${method} ${url.pathname}`);
      return route.continue();
    }
    if (method === 'GET' && (url.pathname.startsWith('/api/ai/dsh/web/')
      || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python')) return route.continue();
    throw new Error(`Unexpected API: ${method} ${url.pathname}`);
  } catch (error) {
    report.blocked.push(error.message);
    return route.abort('blockedbyclient').catch(() => {});
  }
});

async function step(name, run) {
  await run(); report.checks.push(name); console.log(`PASS ${name}`);
}
async function shot(name, scenario) {
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow.');
  const file = `${name}.png`;
  await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push({ file, scenario, viewport: page.viewportSize(), visuallyReviewed: false });
}
async function dismissNotice() {
  const buttons = page.getByRole('button', { name: '知道了', exact: true });
  while (await buttons.count()) await buttons.first().click();
}
async function menu(label) {
  await dismissNotice();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill(label);
  await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function openDataContext(expectCsv) {
  await dismissNotice();
  await page.getByRole('button', { name: '选择分析数据与上下文', exact: true }).click();
  await page.getByRole('menuitem', { name: '选择工作界面与数据表', exact: true }).click();
  const submenu = page.getByRole('menu', { name: '工作界面与数据表', exact: true });
  await submenu.waitFor();
  const source = submenu.getByRole('menuitemradio').filter({ hasText: 'restore-scope-synthetic' });
  assert.equal(await source.count(), expectCsv ? 1 : 0,
    `The visible data menu ${expectCsv ? 'lost' : 'retained'} the synthetic CSV source.`);
}
async function closeDataContext() {
  await page.getByRole('button', { name: '选择分析数据与上下文', exact: true }).click();
  await page.getByRole('menu', { name: '工作界面与数据表', exact: true }).waitFor({ state: 'hidden' });
}
async function manifest() {
  assert.ok(handle);
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200);
  const value = await response.json();
  assert.equal(resolve(value.path), projectPath);
  return value.manifest;
}
async function waitForManifest(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await manifest();
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 120));
  }
  throw new Error(`Timed out waiting for project state: ${label}`);
}
async function downloadBackup() {
  const pending = page.waitForEvent('download');
  await menu('下载工作区备份');
  const download = await pending;
  const bytes = await readFile(await download.path());
  assert.ok(bytes.byteLength > 0 && bytes.byteLength < 5 * 1024 * 1024);
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(value.format, 'datacanvas-ai-studio-backup-v1');
  return { bytes, value };
}
async function restore(bytes, name, decision) {
  const dialogsBefore = report.dialogs.length;
  nextDialog = decision;
  await page.getByLabel('选择工作区备份文件', { exact: true }).setInputFiles({
    name, mimeType: 'application/json', buffer: bytes,
  });
  if (decision) {
    const deadline = Date.now() + 5_000;
    while (report.dialogs.length === dialogsBefore && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.equal(report.dialogs.length, dialogsBefore + 1, 'Restore confirmation did not open.');
    assert.equal(nextDialog, null, 'Restore confirmation did not open.');
    if (decision === 'accept') await page.waitForFunction(name => [...document.querySelectorAll('.persistence-notice')]
      .some(item => item.textContent?.includes(name)), name);
  } else assert.equal(report.dialogs.length, dialogsBefore, 'Malformed backup unexpectedly opened confirmation.');
}
function noDataset(value) {
  return !value.state.appSpec.dataSources.some(source => source.id === datasetId)
    && !value.state.dataProduct.datasets.some(item => item.id === datasetId)
    && !value.state.dataProduct.recipes.some(item => item.sourceDataSourceId === datasetId);
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
  await menu('数据浏览器');
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('恢复作用域隔离验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await waitForManifest(value => Boolean(value.state), 'project creation');
  const clean = await downloadBackup();
  assert.equal(clean.value.state.appSpec.dataSources.filter(item => item.sourceType === 'csv').length, 0);

  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await dismissNotice();
  await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
  const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: 'restore-scope-synthetic.csv',
    mimeType: 'text/csv', buffer: Buffer.from('group,value\nnorth,10\nsouth,20\n') });
  const uploaded = page.waitForResponse(item => item.url() === `${base}/api/datasets`
    && item.request().method() === 'POST');
  await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
  const uploadResponse = await uploaded;
  assert.equal(uploadResponse.status(), 201, await uploadResponse.text());
  datasetId = (await uploadResponse.json()).dataset.datasetId;
  await upload.waitFor({ state: 'hidden' });
  await waitForManifest(value => value.state.appSpec.dataSources.some(source => source.id === datasetId), 'CSV import');
  const withDataset = await downloadBackup();
  assert.ok(withDataset.value.state.appSpec.dataSources.some(source => source.id === datasetId));
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();

  await step('Cancelled restore leaves the uploaded source and project state unchanged', async () => {
    const before = (await manifest()).state;
    await restore(clean.bytes, 'scope-cancel.json', 'dismiss');
    assert.deepEqual((await manifest()).state, before);
    await openDataContext(true);
    await shot('01-cancelled-restore-1440', 'The confirmation was dismissed; the synthetic CSV is still offered in the data menu.');
    await closeDataContext();
    assert.ok((await downloadBackup()).value.state.appSpec.dataSources.some(source => source.id === datasetId));
  });
  await step('Malformed backup is rejected without changing the current project', async () => {
    const before = (await manifest()).state;
    await restore(Buffer.from('{"format":"broken"'), 'scope-invalid.json', null);
    await page.getByRole('alert').filter({ hasText: '工作区备份恢复失败，当前页面未被覆盖' }).waitFor();
    assert.deepEqual((await manifest()).state, before);
    await shot('02-invalid-restore-1440', 'Invalid JSON gives a visible failure notice and preserves the workspace.');
  });
  await step('Confirmed backup restore removes the synthetic CSV source', async () => {
    await restore(clean.bytes, 'scope-clean.json', 'accept');
    await waitForManifest(value => !value.state.appSpec.dataSources.some(source => source.id === datasetId), 'clean backup restore');
    await openDataContext(false);
    await shot('03-confirmed-clean-restore-1440', 'Confirmed clean backup replaced the CSV workspace; no automatic analysis ran.');
    await closeDataContext();
    assert.ok(noDataset((await downloadBackup()).value));
  });

  await step('A delayed response from the old backup cannot contaminate the newer restore', async () => {
    let observed;
    const started = new Promise(done => { observed = done; });
    heldReadStarted = observed;
    heldReadPromise = new Promise(done => { releaseHeldRead = done; });
    holdNextDatasetRead = true;
    await restore(withDataset.bytes, 'scope-with-csv.json', 'accept');
    await Promise.race([started, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('CSV read was not started by restore.')), 8_000))]);
    await openDataContext(true);
    await shot('04-old-csv-read-held-1440', 'The prior backup is visible while its scoped CSV read is deliberately held.');
    await closeDataContext();
    await restore(clean.bytes, 'scope-newer-clean.json', 'accept');
    await waitForManifest(value => !value.state.appSpec.dataSources.some(source => source.id === datasetId), 'newer clean restore');
    await openDataContext(false);
    await shot('05-newer-restore-before-release-1440', 'The newer clean backup is active before the old CSV response arrives.');
    await closeDataContext();
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname
      === `/api/datasets/${encodeURIComponent(datasetId)}` && response.request().method() === 'GET');
    releaseHeldRead();
    assert.equal((await delivered).status(), 200, 'The delayed response was not actually delivered.');
    await page.waitForTimeout(350);
    await openDataContext(false);
    await shot('06-late-csv-ignored-1440', 'After the delayed old CSV response, current project and backup still match the newer clean restore.');
    await closeDataContext();
    const after = (await downloadBackup()).value;
    assert.ok(noDataset(after), 'Late CSV response reintroduced a removed source or recipe.');
    assert.ok(noDataset({ state: (await manifest()).state }), 'Late CSV response contaminated saved project state.');
  });

  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.modelRequests, 0);
  assert.equal(report.notebookRuns, 0);
  assert.equal(report.dialogs.filter(item => item.action === 'unexpected').length, 0);
  report.datasetId = datasetId;
  report.passed = true;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ passed: true, directory: relative(process.cwd(), directory).replaceAll('\\', '/'),
    checks: report.checks.length, screenshots: report.screenshots.length, modelRequests: 0, notebookRuns: 0 }));
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  releaseHeldRead?.();
  await page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.error(JSON.stringify({ passed: false, directory: relative(process.cwd(), directory).replaceAll('\\', '/'), failure: report.failure }));
  process.exitCode = 1;
} finally {
  await context.close(); await browser.close();
}
