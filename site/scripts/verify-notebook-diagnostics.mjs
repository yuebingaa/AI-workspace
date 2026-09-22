// Existing 3001 only. Synthetic project, real Python/Harness execution, explicit
// SSE receipt replay; never a paid model call or existing user's project.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDiagnosticReceipts } from './fixtures/notebook-diagnostics.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/notebook-diagnostics-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], notebookRequests = [], blockedRequests = [], replays = [];
let activeScenario = 'setup', passed = false, failure, handle, receipts, replayKind = 'failed';
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => {
  if (request.url() === `${base}/api/notebook/run`) notebookRequests.push({ outcome: 'aborted-request', message: request.failure()?.errorText });
});
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== base) { blockedRequests.push(url.origin); return route.abort('blockedbyclient'); }
  if (!url.pathname.startsWith('/api/ai/')) return route.continue();
  if (url.pathname !== '/api/ai/harness/stream' || !receipts) {
    blockedRequests.push(url.pathname); return route.abort('blockedbyclient');
  }
  const input = route.request().postDataJSON();
  const original = receipts[replayKind];
  const id = `harness_${input.idempotencyKey}`;
  const task = JSON.parse(JSON.stringify(original).replaceAll(original.id, id));
  Object.assign(task, { idempotencyKey: input.idempotencyKey, pageId: input.pageId, instruction: input.instruction });
  assert.equal(task.trace.at(-1).type, 'completed');
  const body = task.trace.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ event,
    ...(index === task.trace.length - 1 ? { task } : {}) })}\n\n`).join('');
  replays.push({ kind: replayKind, source: `harness-${replayKind}-task.json`, events: task.trace.length, realModel: false });
  return route.fulfill({ contentType: 'text/event-stream', status: 200, body });
});
const editor = () => page.locator('.notebook-editor');
const python = () => page.getByRole('article', { name: 'Python单元 人工计时合成 Python', exact: true });
const sql = () => page.getByRole('article', { name: 'SQL单元 人工计时下游 SQL', exact: true });
const latest = () => page.locator('.conversation-turn').last();
const timing = (cell) => cell.getByRole('group', { name: 'Notebook 单元耗时', exact: true });
async function step(name, action) {
  activeScenario = name;
  await action(); checks.push(name); console.log(`PASS ${name}`);
}
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop page must not overflow');
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario: activeScenario, assertions });
}
async function saveCell() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function runCell(cell, expectedStatus) {
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
  await cell.getByRole('button', { name: '▶ 运行', exact: true }).click();
  const response = await pending;
  const { run, error } = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(error));
  assert.equal(run.status, expectedStatus);
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
  notebookRequests.push({ outcome: 'response', status: response.status(), runId: run.runId,
    cells: run.cells.map(({ cellId, status, timing }) => ({ cellId, status, timing })) });
  return run;
}
async function projectState() {
  await page.waitForFunction(() => /已保存到本地项目|已打开本地项目/.test(document.querySelector('.top-actions')?.textContent ?? ''));
  const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200);
  return (await response.json()).manifest.state;
}
async function sendReplay(kind) {
  replayKind = kind;
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(`执行合成 Notebook 诊断验收（脚本模型回执回放：${kind}）`);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await latest().locator(`.harness-trace.${kind}`).waitFor();
}
const successCode = "raw = pd.DataFrame({'station': ['Alpha', 'Alpha', 'Beta'], 'seconds': [60, 120, 30]})\ncleaned = raw.assign(minutes=raw['seconds'] / 60)\nprint('three synthetic records')";
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a new synthetic local project without opening user files', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
    await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
    await dialog.getByRole('button', { name: /项目文件夹/ }).first().click();
    await dialog.getByLabel('项目名称', { exact: true }).fill('Notebook 失败诊断合成验收');
    await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1'));
    assert.ok(handle);
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const info = await (await context.request.get(`${base}/api/notebook/python`)).json();
    assert.equal(info.available, true);
  });
  await step('Real manual Python success exposes preparation and execution timing at 1440 and 1024', async () => {
    await page.getByRole('button', { name: '＋ Python', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('人工计时合成 Python');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('cleaned');
    await editor().getByLabel('Python', { exact: true }).fill(successCode); await saveCell();
    const run = await runCell(python(), 'success');
    assert.deepEqual(run.cells[0].table.rows.map((row) => row.minutes), [1, 2, 0.5]);
    assert.ok(run.cells[0].timing.preparationMs >= 0 && run.cells[0].timing.executionMs >= 0);
    assert.match(await timing(python()).innerText(), /环境准备/);
    assert.match(await timing(python()).innerText(), /执行计算/);
    await shot('01-manual-success-1440', python(), ['real Python values 1, 2, 0.5', 'actual preparation/execution timing present']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-manual-success-1024', python(), ['timing remains readable at minimum supported desktop width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Real Python failure exposes execution phase and blocks downstream SQL without stale success', async () => {
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('人工计时下游 SQL');
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
    await editor().getByRole('checkbox').first().check();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT station, SUM(minutes) AS minutes FROM cleaned GROUP BY station ORDER BY minutes DESC');
    await saveCell();
    await runCell(sql(), 'success');
    await python().getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill("print('synthetic failure evidence')\nraise ValueError('manual synthetic failure')");
    await saveCell();
    const run = await runCell(sql(), 'failure');
    assert.deepEqual(run.cells.map((cell) => cell.status), ['failure', 'blocked']);
    assert.equal(run.cells[0].timing.failurePhase, 'execution');
    assert.match(await timing(python()).innerText(), /失败阶段.*执行计算/);
    assert.match(await sql().innerText(), /阻断|阻止|上游|未完成/);
    await shot('03-manual-failure-1440', python(), ['real ValueError', 'execution failure timing', 'dependent SQL blocked']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('04-manual-failure-1024', python(), ['failure labels and timing readable at 1024']);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('User cancellation aborts the actual Notebook request and does not fabricate completed results', async () => {
    await python().getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill('while True:\n    pass'); await saveCell();
    const started = page.waitForRequest((request) => request.url() === `${base}/api/notebook/run`);
    await python().getByRole('button', { name: '▶ 运行', exact: true }).click(); await started;
    await page.getByRole('button', { name: '停止运行', exact: true }).click();
    await page.getByText('运行已取消或超过 40 秒。结果未更新，请重新运行。', { exact: true }).waitFor();
    assert.equal(await timing(python()).count(), 0, 'An aborted HTTP request has no completed timing receipt');
    await shot('05-manual-cancelled', python(), ['actual HTTP abort', 'cancellation text', 'no invented timing/result']);
    await python().getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('Python', { exact: true }).fill(successCode); await saveCell();
    await runCell(sql(), 'success');
  });
  const formalState = await projectState();
  const pageId = formalState.appSpec.pages[0].id;
  const formalDocument = formalState.dataProduct.notebooks[pageId];
  assert.equal(formalDocument.cells.length, 2);
  await step('Generate real failed and cancelled Harness receipts using a scripted model only', async () => {
    receipts = await createDiagnosticReceipts({ directory, document: formalDocument, appSpec: formalState.appSpec, pageId });
    assert.deepEqual((await projectState()).dataProduct.notebooks[pageId], formalDocument);
  });
  await step('Replay the real failed receipt through SSE and inspect read-only escaped bounded definitions', async () => {
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    await sendReplay('failed');
    assert.equal(await latest().locator('.harness-trace[open]').count(), 0);
    await latest().locator('.harness-trace > summary').click();
    const disclosure = latest().locator('details.notebook-failure-diagnostics');
    assert.equal(await disclosure.getAttribute('open'), null);
    await disclosure.getByText('查看失败草稿（只读）', { exact: true }).click();
    const region = disclosure.getByRole('region', { name: '失败 Notebook 草稿诊断', exact: true });
    const failedCell = region.getByRole('article', { name: '失败草稿单元 脚本模型的失败 Python', exact: true });
    await failedCell.getByText('单元定义 · JSON', { exact: true }).click();
    assert.match(await failedCell.locator('code').innerText(), /<img src=x onerror=/);
    assert.equal(await region.locator('img, script, textarea, input, [contenteditable=true]').count(), 0);
    assert.equal(await region.getByRole('button').count(), 0, 'Diagnostic definitions must not be adoptable/runnable/saveable');
    assert.equal(await page.evaluate(() => window.__diagnosticXss), undefined);
    assert.match(await region.innerText(), /省略|仅显示前/);
    assert.match(await region.innerText(), /环境准备/);
    await shot('06-failed-diagnostic-1440', failedCell, ['SSE replay labelled as scripted', 'read-only JSON escaped', 'real failure timing', 'bounded source notice']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('07-failed-diagnostic-1024', failedCell, ['read-only diagnostic remains available at 1024']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const truncated = region.locator('.notebook-diagnostic-cell').filter({ hasText: /仅显示前/ }).first();
    if (await truncated.count()) {
      await truncated.getByText('单元定义 · JSON', { exact: true }).click();
      await shot('07b-bounded-source-notice', truncated, ['actual source truncation explicitly warns that the definition is incomplete']);
    } else {
      await shot('07b-bounded-source-notice', region.getByText(/另有.*诊断体积限制省略/), ['actual omitted cell count explicitly displayed']);
    }
    const stored = await projectState();
    assert.deepEqual(stored.dataProduct.notebooks[pageId], formalDocument);
    assert.ok(!JSON.stringify(stored).includes('notebookDiagnostics'), 'Diagnostics must not be persisted to the project');
    assert.ok(!JSON.stringify(stored).includes('window.__diagnosticXss'), 'Generated failure source must not leak into persisted task/context');
  });
  await step('Cancelled receipt has no diagnostics and refresh removes ephemeral code without changing Notebook', async () => {
    await sendReplay('cancelled');
    await latest().locator('.harness-trace > summary').click();
    assert.equal(await latest().locator('details.notebook-failure-diagnostics').count(), 0);
    await shot('08-cancelled-harness', latest(), ['actual cancelled Harness receipt', 'no failed draft diagnostic attached']);
    await projectState();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('details.notebook-failure-diagnostics').count(), 0);
    assert.ok(!(await page.locator('body').innerText()).includes('window.__diagnosticXss'));
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await python().waitFor(); await sql().waitFor();
    assert.deepEqual((await projectState()).dataProduct.notebooks[pageId], formalDocument);
    await shot('09-refreshed-formal-notebook', python(), ['two formal cells unchanged', 'failure code absent after reload']);
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, []);
  assert.equal(replays.length, 2);
  passed = true;
} catch (error) {
  failure = { scenario: activeScenario, message: String(error) };
  process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  const report = { passed, failure, checks, screenshots, pageErrors, blockedRequests, notebookRequests, replays, realModelCalls: 0,
    boundaries: ['Actual HTTP/Python for manual cells; scripted model with real Harness/tools/Python for receipts.',
      'Browser Agent responses replay the captured receipts through the actual SSE parser; not live model requests.',
      'Cancellation after real Harness execution is distinct from the manual in-flight HTTP abort scenario.',
      'No user files, website configuration, service lifecycle, or stable-site changes. Synthetic project and failures are preserved.'] };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, directory, failure }, null, 2));
}
