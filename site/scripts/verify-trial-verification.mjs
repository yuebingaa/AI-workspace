// Existing managed 3001 only. New synthetic project. Real manual local execution
// and explicit SSE replay of actual Harness tasks; no real model or warehouse.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createTrialReceipts, PYTHON_TITLE, SQL_TITLE, PYTHON_CODE, SQL_CODE, EXPECTED, NOTICE_CANARY, SOURCE_MARKER } from './fixtures/trial-verification.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-trial-verification-2026-09-16', `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], screenshots = [], pageErrors = [], forbiddenRequests = [], manualRuns = [], replays = [];
let scenario = 'setup', passed = false, failure, handle, pageId, formalDocument, receipts, replayKind;
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) { forbiddenRequests.push(url.origin); return route.abort('blockedbyclient'); }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection mutation prohibited'); return route.abort('blockedbyclient'); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run') {
    const input = request.postDataJSON();
    assert.ok(input.document.cells.every((cell) => ['python', 'sql'].includes(cell.kind)), 'Only this manual local chain may execute through HTTP');
  }
  if (!url.pathname.startsWith('/api/ai/')) return route.continue();
  if (url.pathname !== '/api/ai/harness/stream' || !receipts?.[replayKind]) {
    forbiddenRequests.push(url.pathname); return route.abort('blockedbyclient');
  }
  const input = request.postDataJSON(), original = receipts[replayKind];
  const task = JSON.parse(JSON.stringify(original).replaceAll(original.id, `harness_${input.idempotencyKey}`));
  Object.assign(task, { idempotencyKey: input.idempotencyKey, pageId: input.pageId, instruction: input.instruction });
  assert.equal(task.trace.at(-1).type, 'completed');
  const body = task.trace.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ event,
    ...(index === task.trace.length - 1 ? { task } : {}) })}\n\n`).join('');
  assert.ok(!body.includes(NOTICE_CANARY));
  replays.push({ kind: replayKind, source: `harness-${replayKind}-task.json`, events: task.trace.length,
    finalState: task.state, realModel: false, transport: 'explicit captured SSE replay' });
  return route.fulfill({ contentType: 'text/event-stream', status: 200, body });
});
const editor = () => page.locator('.notebook-editor');
const python = () => page.getByRole('article', { name: `Python单元 ${PYTHON_TITLE}`, exact: true });
const sql = () => page.getByRole('article', { name: `SQL单元 ${SQL_TITLE}`, exact: true });
const latest = () => page.locator('.conversation-turn').last();
const draft = () => page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page-wide desktop overflow');
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario, assertions });
}
async function saveCell() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  await editor().waitFor({ state: 'hidden' });
}
async function projectState() {
  await page.waitForFunction(() => /已保存到本地项目|已打开本地项目/.test(document.querySelector('.top-actions')?.textContent ?? ''));
  const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
  assert.equal(response.status(), 200); return (await response.json()).manifest.state;
}
async function assertFormalUnchanged() {
  const state = await projectState();
  assert.deepEqual(state.dataProduct.notebooks[pageId], formalDocument);
  assert.ok(!JSON.stringify(state).includes('notebookDiagnostics'));
  assert.ok(!JSON.stringify(state).includes(NOTICE_CANARY));
}
async function replay(kind) {
  replayKind = kind;
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(`整稿回执验收（脚本模型与真实本地执行，SSE 回放：${kind}）`);
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await latest().locator(`.harness-trace.${kind === 'rejected' ? 'failed' : 'waiting'}`).waitFor();
}
async function inspectAndDismissDraft(kind, name) {
  await replay(kind);
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  await draft().waitFor();
  assert.match(await draft().innerText(), /已通过数据试运行/);
  assert.equal(await draft().getByRole('button', { name: '采用草稿', exact: true }).isEnabled(), true);
  await draft().getByText(/查看变更和步骤/).click();
  assert.equal(await draft().getByRole('article').count(), 2);
  await shot(name, draft(), ['real whole-draft tool validated the receipt', 'two proposed additions only', 'manual adoption still required', 'explicit scripted SSE replay']);
  await draft().getByRole('button', { name: '暂不采用', exact: true }).click();
  await draft().waitFor({ state: 'hidden' });
  await assertFormalUnchanged();
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Create a new isolated synthetic local project', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
    await menu.getByRole('button', { name: '数据浏览器', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
    await dialog.getByRole('button', { name: /项目文件夹/ }).first().click();
    await dialog.getByLabel('项目名称', { exact: true }).fill('整稿执行回执合成验收');
    await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(resolve(directory, 'project'));
    await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')); assert.ok(handle);
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  });
  await step('Real manual Python and SQL HTTP execution remains successful', async () => {
    await page.getByRole('button', { name: '＋ Python', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill(PYTHON_TITLE);
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('cleaned');
    await editor().getByLabel('Python', { exact: true }).fill(PYTHON_CODE); await saveCell();
    await page.getByRole('button', { name: '＋ SQL', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill(SQL_TITLE);
    await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('totals');
    await editor().getByRole('checkbox').first().check();
    await editor().getByLabel('SQL', { exact: true }).fill(SQL_CODE); await saveCell();
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
    await sql().getByRole('button', { name: '▶ 运行', exact: true }).click();
    const response = await pending, result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result.error));
    assert.equal(result.run.status, 'success'); assert.deepEqual(result.run.cells[1].table.rows, EXPECTED);
    manualRuns.push({ status: result.run.status, runId: result.run.runId, values: EXPECTED });
    await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
    await shot('01-real-manual-success-1440', sql(), ['real HTTP Python→DuckDB', 'Alpha=3 / Beta=0.5, independently fixed expectation']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('02-real-manual-success-1024', sql(), ['same real results remain readable at minimum desktop width']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const state = await projectState(); pageId = state.appSpec.pages[0].id;
    formalDocument = state.dataProduct.notebooks[pageId];
    assert.equal(formalDocument.cells.length, 2);
    receipts = await createTrialReceipts({ directory, document: formalDocument, appSpec: state.appSpec, pageId });
  });
  await step('Valid whole draft waits for adoption; dismiss leaves formal Notebook unchanged', async () => {
    await inspectAndDismissDraft('valid', '03-valid-whole-draft-1440');
    await shot('04-dismiss-keeps-formal-document', sql(), ['dismiss is not adoption', 'two original cells and results retained']);
  });
  await step('Invalid internal success receipt becomes unavailable read-only diagnosis, never adoption', async () => {
    await replay('rejected');
    await latest().locator('.harness-trace > summary').click();
    const disclosure = latest().locator('details.notebook-failure-diagnostics');
    await disclosure.getByText('查看失败草稿（只读）', { exact: true }).click();
    const region = disclosure.getByRole('region', { name: '失败 Notebook 草稿诊断', exact: true });
    const note = region.getByRole('article', { name: '失败草稿单元 仅待采用的合成说明', exact: true });
    await note.getByText('单元定义 · JSON', { exact: true }).click();
    assert.ok((await note.locator('code').innerText()).includes(SOURCE_MARKER.replaceAll('"', '\\"')));
    assert.match(await region.innerText(), /未取得执行回执，阶段与耗时未知/);
    assert.equal(await region.getByRole('button').count(), 0);
    assert.equal(await region.locator('img,script,textarea,input,[contenteditable=true]').count(), 0);
    assert.equal(await region.getByRole('group', { name: 'Notebook 单元耗时' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '采用草稿', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__trialXss), undefined);
    assert.ok(!(await page.locator('body').innerText()).includes(NOTICE_CANARY));
    await shot('05-rejected-untrusted-receipt-1440', note, ['actual Harness rejected an injected wrong-run resultRef', 'unknown is not claimed execution failure', 'escaped read-only JSON; no timing or adoption']);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('06-rejected-untrusted-receipt-1024', note, ['unknown diagnostic readable at 1024', 'no runner notice canary']);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await assertFormalUnchanged();
  });
  await step('A fresh legal retry remains usable; cancellation and refresh preserve original definition', async () => {
    await inspectAndDismissDraft('retry', '07-valid-retry-after-rejection');
    await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
    await projectState(); await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('details.notebook-failure-diagnostics').count(), 0);
    assert.ok(!(await page.locator('body').innerText()).includes('__trialXss'));
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await python().waitFor(); await sql().waitFor(); await assertFormalUnchanged();
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot('08-refreshed-original-notebook-1024', python(), ['diagnostics are ephemeral', 'formal two-cell definition unchanged', 'no generated draft adopted']);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []); assert.equal(replays.length, 3);
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, pageErrors,
    forbiddenRequests, manualRuns, replays, realModelCalls: 0, externalDatabaseCalls: 0,
    boundaries: ['Manual Notebook execution uses real 3001 HTTP, local Python and DuckDB with synthetic values.',
      'Agent tasks use actual offline Harness and tools with a scripted model; rejected runner return is explicit identity/notice fault injection.',
      'Browser Agent transport replays captured SSE tasks, not live model generation or a real public Harness API call.',
      'Cancellation here means dismissing a pending draft, not in-flight execution cancellation.',
      'Empty connection directory is an explicit GET test double; no database queries, service changes, user files or product debug API.',
      'New synthetic project and all failure evidence remain on disk.'] }, null, 2), { flag: 'wx' });
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, directory, failure }, null, 2));
}
