// Managed 3001 only; new synthetic projects, real persistence and local SQL.
// AI UI receives explicit SSE replay from a fixed-model, real cellSearch Harness.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createNotebookContextSelectionReceipt } from './fixtures/context-selection.mjs';

const base = 'http://127.0.0.1:3001';
const directory = resolve('.runtime/hex-context-selection-2026-09-17', `browser-${Date.now()}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const cells = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`p${index}`, {
  label: '参数', title: `上下文参数 ${index + 1}`, output: `context_parameter_${index + 1}`,
}]));
cells.sql = { label: 'SQL', title: '读取参数的 SQL 定义', output: 'context_summary' };
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const ids = {}, checks = [], screenshots = [], actions = [], runs = [], replays = [], clearedConversations = [];
const pageErrors = [], forbiddenRequests = [], httpErrors = [], responseTasks = [], allowedHandles = new Set();
const resourceFailures = [];
let scenario = 'setup', handle, pageId, firstPage, firstPageTitle, firstProject, firstSession, replayTask, expectedSelectedIds;
let directoryReads = 0, passed = false, failure;
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => resourceFailures.push({ url: request.url(), failure: request.failure()?.errorText }));
await page.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === base && url.pathname === '/api/ai/harness/stream' && replayTask) {
    const input = request.postDataJSON();
    assert.equal(input.pageId, firstPage);
    assert.equal(input.instruction, '帮我看看这些');
    assert.ok(allowedHandles.has(request.headers()['x-agentcanvas-project']));
    assert.deepEqual(input.notebookContext.selectedCellIds, expectedSelectedIds);
    assert.ok(input.notebookContext.document.cells.some((item) => item.id === ids.sql));
    assert.deepEqual(Object.keys(input.notebookContext).sort(), ['document', 'selectedCellIds', 'sourceIds']);
    assert.equal(JSON.stringify(input.notebookContext).includes('"rows"'), false, 'No cached rows are sent as selected context');
    assert.equal(JSON.stringify(input.notebookContext).includes('"runId"'), false, 'No old browser run is supplied as evidence');
    const task = JSON.parse(JSON.stringify(replayTask).replaceAll(replayTask.id, `harness_${input.idempotencyKey}`));
    Object.assign(task, { idempotencyKey: input.idempotencyKey, pageId: input.pageId, instruction: input.instruction });
    assert.equal(task.trace.at(-1).type, 'completed');
    const body = task.trace.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ event,
      ...(index === task.trace.length - 1 ? { task } : {}) })}\n\n`).join('');
    replays.push({ mode: await page.getByRole('tab', { name: 'Notebook', exact: true }).getAttribute('aria-selected') === 'true' ? 'notebook' : 'agent',
      selectedCellIds: input.notebookContext.selectedCellIds, notebookContextKeys: Object.keys(input.notebookContext),
      documentRevision: input.notebookContext.document.revision, bodyHasCachedRows: false, taskState: task.state,
      events: task.trace.length, conversationId: input.conversation_id, source: 'actual offline cellSearch Harness task; explicit SSE replay' });
    replayTask = undefined;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  }
  if (url.origin === base && url.pathname === '/api/ai/harness/conversation' && request.method() === 'DELETE') {
    const body = request.postDataJSON();
    assert.ok(allowedHandles.has(request.headers()['x-agentcanvas-project']));
    assert.equal(body.pageId, firstPage);
    assert.ok(replays.some((item) => item.conversationId === body.conversation_id), 'Clear only this fixture\'s own session context');
    clearedConversations.push(body); return route.continue();
  }
  if (url.origin !== base || url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/connections/')) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return route.abort('blockedbyclient');
  }
  if (url.pathname === '/api/connections') {
    if (request.method() !== 'GET') { forbiddenRequests.push('Connection write prohibited'); return route.abort('blockedbyclient'); }
    directoryReads++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [] }) });
  }
  if (url.pathname === '/api/notebook/run' && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.ok(allowedHandles.has(request.headers()['x-agentcanvas-project']));
    assert.equal(body.action, 'run');
    assert.ok(body.document.cells.every((item) => ['parameter', 'sql'].includes(item.kind)));
    actions.push({ scenario, action: body.action, targetCellId: body.targetCellId, revision: body.document.revision });
  }
  return route.continue();
});
page.on('response', (response) => {
  if (response.url() !== `${base}/api/notebook/run` || response.request().method() !== 'POST') return;
  responseTasks.push((async () => {
    const body = await response.json(); assert.equal(response.status(), 200); assert.ok(body.run); runs.push(body.run);
  })().catch((error) => httpErrors.push(String(error))));
});

const editor = () => page.locator('.notebook-editor');
const cell = (key) => page.getByRole('article', { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const chips = () => page.getByRole('region', { name: '已选择的 Notebook 上下文', exact: true });
const trigger = () => page.getByRole('button', { name: '添加附件或上下文', exact: true });
const submenu = () => page.getByRole('menu', { name: 'Notebook 参数与单元', exact: true });
const search = () => submenu().getByRole('textbox', { name: '搜索Notebook 参数与单元', exact: true });
const option = (key) => submenu().getByRole('menuitemcheckbox').filter({ has: page.getByText(cells[key].title, { exact: true }) });
const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });

async function poll(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { assert.deepEqual(httpErrors, []); if (await predicate()) return; await pause(50); }
  throw new Error(message);
}
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page-wide overflow');
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario, assertions });
}
async function dismissNotice() {
  const notice = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true });
  if (await notice.isVisible()) await notice.click();
}
async function manifest(predicate = (value) => Boolean(value.state)) {
  assert.ok(allowedHandles.has(handle)); let result;
  await poll(async () => {
    const response = await context.request.get(`${base}/api/projects`, { headers: { 'x-agentcanvas-project': handle } });
    assert.equal(response.status(), 200); result = (await response.json()).manifest;
    return predicate(result) && /已保存到本地项目|已打开本地项目/.test(await page.locator('.top-actions').textContent());
  }, 'Synthetic project was not saved'); return result;
}
async function savedDocument(predicate = () => true) {
  const project = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId]; return Boolean(book && predicate(book));
  }); return project.state.dataProduct.notebooks[pageId];
}
async function selectProject(path, create = false) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
  await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await menu.getByRole('button', { name: '数据浏览器', exact: true }).click(); await dataBrowser().waitFor();
  await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/ }).click();
  await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(path);
  if (create) await dataBrowser().getByLabel('项目名称', { exact: true }).fill('Notebook 上下文选择独立验收');
  await dataBrowser().getByRole('button', { name: create ? '新建本地项目' : '打开已有项目', exact: true }).click();
  await dataBrowser().waitFor({ state: 'hidden' });
  handle = await page.evaluate(() => localStorage.getItem('agentcanvas:last-local-project:v1')); assert.ok(handle); allowedHandles.add(handle);
  const project = await manifest(); pageId = project.state.appSpec.pages[0].id;
  await mode('Notebook'); await dismissNotice();
}
async function mode(name) {
  await page.getByRole('tab', { name, exact: true }).click();
  if (name === 'Notebook' && !await trigger().isVisible()) await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await trigger().waitFor();
}
async function openMenu() {
  if (await submenu().isVisible()) return;
  await trigger().click();
  await page.getByRole('menuitem', { name: '选择 Notebook 参数与单元', exact: true }).click(); await search().waitFor();
}
async function closeMenu() {
  if (!await submenu().isVisible()) return;
  await search().press('Escape');
  await page.getByRole('menuitem', { name: '选择 Notebook 参数与单元', exact: true }).press('Escape');
  await poll(() => trigger().evaluate((element) => element === document.activeElement), 'Escape did not restore original trigger focus');
}
async function choose(key) {
  await openMenu(); await search().fill(cells[key].output ?? cells[key].title); await option(key).click(); await search().fill('');
}
async function assertSelection(keys) {
  if (!keys.length) { await poll(async () => await chips().count() === 0, 'Selection should be empty'); return; }
  const names = await chips().locator('.composer-context-chip b').allTextContents();
  assert.deepEqual(names, keys.map((key) => cells[key].title));
}
async function clearSelection() {
  while (await chips().count()) await chips().getByRole('button').first().click();
}
async function save({ rename = false } = {}) {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  if (rename) {
    await page.waitForFunction(() => !document.querySelector('.notebook-editor') || document.querySelector('[aria-label="确认输出变量改名"]'));
    const review = page.getByRole('region', { name: '确认输出变量改名', exact: true });
    if (await review.isVisible()) await review.getByRole('button', { name: '确认改名并保存', exact: true }).click();
  }
  await editor().waitFor({ state: 'hidden' });
}
async function createCell(key) {
  await dismissNotice();
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${cells[key].label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(cells[key].title);
  await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(cells[key].output);
  if (key === 'sql') {
    const options = editor().locator('.notebook-input-list label');
    for (let index = 0; index < await options.count(); index++) {
      const item = options.nth(index); await item.getByRole('checkbox').setChecked(await item.locator('code').textContent() === cells.p0.output);
    }
    await editor().getByLabel('SQL', { exact: true }).fill(`SELECT value * 2 AS total FROM ${cells.p0.output}`);
  } else {
    await editor().getByLabel('参数类型', { exact: true }).selectOption('number');
    await editor().getByLabel('参数值', { exact: true }).fill(String(Number(key.slice(1)) + 7));
  }
  await save({ rename: true }); await cell(key).waitFor();
  const book = await savedDocument((value) => value.cells.some((item) => item.title === cells[key].title));
  ids[key] = book.cells.find((item) => item.title === cells[key].title).id;
}
async function sendReplay(keys, name) {
  const book = await savedDocument(), project = await manifest();
  expectedSelectedIds = keys.map((key) => ids[key]);
  replayTask = await createNotebookContextSelectionReceipt({ directory: resolve(directory, name), document: book,
    appSpec: project.state.appSpec, pageId, selectedCellIds: expectedSelectedIds });
  assert.equal(replayTask.state, 'completed'); assert.equal(replayTask.notebookArtifact, undefined);
  const count = replays.length, actionCount = actions.length;
  await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill('帮我看看这些');
  await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
  await poll(() => replays.length === count + 1, 'No selected-context request received');
  await poll(async () => await page.getByRole('button', { name: '发送 AI 指令', exact: true }).isVisible(), 'SSE replay did not complete');
  await poll(async () => /尚未运行|未运行/.test(await page.locator('.conversation-turn').last().textContent()), 'Read-only answer must not imply execution');
  assert.equal(actions.length, actionCount, 'Selecting and inspecting definitions must not execute Notebook');
  await assertSelection(keys);
}

try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await step('Empty scope, keyboard search, Escape focus and saved definitions only', async () => {
    firstProject = resolve(directory, 'project'); await selectProject(firstProject, true); firstPage = pageId;
    const project = await manifest(); firstPageTitle = project.state.appSpec.pages[0].title;
    firstSession = project.state.assistantSessions.activeId;
    await mode('AI 工作台'); await openMenu();
    assert.match(await submenu().innerText(), /当前工作界面暂无 Notebook 单元/);
    await shot('01-empty-context-1440', submenu(), 'Empty Notebook, no execution and no misleading available values'); await closeMenu();
    await mode('Notebook'); await createCell('p0'); await createCell('sql');
    await trigger().click(); const entry = page.getByRole('menuitem', { name: '选择 Notebook 参数与单元', exact: true });
    await entry.focus(); await entry.press('ArrowRight'); assert.equal(await search().evaluate((element) => document.activeElement === element), true);
    await search().fill(cells.p0.output); assert.equal(await submenu().getByRole('menuitemcheckbox').count(), 1);
    await search().press('ArrowDown'); await page.keyboard.press('Enter'); await assertSelection(['p0']);
    await search().fill('not-a-real-cell'); assert.match(await submenu().innerText(), /没有匹配/);
    await shot('02-keyboard-no-match-1440', submenu(), 'Search by output variable, keyboard selection and explicit empty filter');
    await closeMenu(); await assertSelection(['p0']); assert.equal(actions.length, 0);
  });
  await step('Stable IDs survive rename/reorder, unsaved edits and deletion cancellation; deleted IDs are removed', async () => {
    await choose('sql'); await closeMenu();
    await cell('p0').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('尚未保存的上下文名称');
    await openMenu(); assert.equal(await option('p0').isDisabled(), true);
    assert.equal(await submenu().getByText('尚未保存的上下文名称', { exact: true }).count(), 0);
    await shot('03-edit-disabled-1440', submenu(), 'Unsaved title excluded; selection disabled while Notebook editor is open');
    await closeMenu(); await editor().getByRole('button', { name: '取消编辑', exact: true }).click();
    await assertSelection(['p0', 'sql']);
    await cell('p0').getByRole('button', { name: '编辑', exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill('已重命名的上下文参数'); await save(); cells.p0.title = '已重命名的上下文参数';
    await assertSelection(['p0', 'sql']);
    await cell('sql').getByRole('button', { name: `上移 ${cells.sql.title}`, exact: true }).click();
    const book = await savedDocument((value) => value.cells[0].id === ids.sql); assert.ok(book.cells.some((item) => item.id === ids.p0 && item.title === cells.p0.title));
    await assertSelection(['p0', 'sql']);
    await createCell('p1'); await choose('p1'); await closeMenu();
    await cell('p1').getByRole('button', { name: '删除', exact: true }).click();
    await cell('p1').getByRole('button', { name: '保留', exact: true }).click(); await assertSelection(['p0', 'sql', 'p1']);
    await cell('p1').getByRole('button', { name: '删除', exact: true }).click();
    await cell('p1').getByRole('button', { name: '确认删除 1 个单元', exact: true }).click();
    await assertSelection(['p0', 'sql']); await savedDocument((value) => !value.cells.some((item) => item.id === ids.p1));
    await createCell('p1'); await assertSelection(['p0', 'sql']);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await shot('04-stable-rename-delete-1024', chips(), 'Renamed title reflects latest definition; deleted ID never reselected by same name');
  });
  await step('Ten-item cap, removal recovery and both composer modes share the same current selection', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let index = 2; index < 10; index++) await createCell(`p${index}`);
    await clearSelection();
    for (let index = 0; index < 10; index++) await choose(`p${index}`);
    assert.equal(await option('sql').isDisabled(), true); assert.match(await submenu().innerText(), /已选择 10 项/);
    await option('sql').scrollIntoViewIfNeeded();
    await shot('05-selection-limit-1440', submenu(), 'Ten selected IDs; eleventh disabled, selected entries removable');
    await choose('p9'); assert.equal(await option('sql').isEnabled(), true); await choose('sql'); await closeMenu();
    const selected = [...Array.from({ length: 9 }, (_, index) => `p${index}`), 'sql']; await assertSelection(selected);
    await mode('AI 工作台'); await assertSelection(selected);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await shot('06-ai-ten-chips-1024', chips(), 'Same ten IDs in AI workspace; wrapping chips and focus-not-execution explanation');
    await mode('Notebook'); await assertSelection(selected); await clearSelection();
    await choose('p0'); await choose('sql'); await closeMenu(); assert.equal(actions.length, 0);
  });
  await step('Real local SQL result is not sent as cached context; both modes use genuine cellSearch replay', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await cell('sql').getByRole('button', { name: '▶ 运行', exact: true }).click();
    await poll(() => runs.length === 1, 'Real local SQL did not return', 45000);
    await poll(async () => !await page.locator('.notebook-heading').getByRole('button', { name: '停止运行', exact: true }).isVisible(), 'Notebook stayed busy');
    assert.equal(runs[0].status, 'success'); assert.deepEqual(runs[0].cells.find((item) => item.cellId === ids.sql).table.rows, [{ total: 14 }]);
    await sendReplay(['p0', 'sql'], 'notebook-read');
    await page.locator('.conversation-turn').last().locator('.harness-trace > summary').click();
    await shot('07-notebook-cell-search-1440', page.locator('.conversation-turn').last().locator('.harness-trace-body'), 'Actual Harness read-only tool evidence; browser SQL output not promoted to current task result');
    await mode('AI 工作台'); await sendReplay(['p0', 'sql'], 'agent-read');
    await page.setViewportSize({ width: 1024, height: 1000 });
    await shot('08-agent-cell-search-1024', page.locator('.conversation-turn').last(), 'Selected Notebook document persists into AI mode; fixed-model actual tools replay only');
    assert.deepEqual(replays.map((item) => item.mode), ['notebook', 'agent']); assert.equal(actions.length, 1);
    const project = await manifest(); assert.equal(project.tables.length, 0); assert.equal(project.files.length, 0);
    assert.ok(project.state.appSpec.pages.every((item) => item.root.children.length === 0));
  });
  await step('Clearing session context and switching sessions reset ephemeral IDs without replaying old selections', async () => {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill('清除上下文');
    await menu.getByRole('button', { name: '清除上下文', exact: true }).click();
    await assertSelection([]); assert.equal(clearedConversations.length, 1);
    await choose('p0'); await closeMenu();
    // The existing session UI deliberately does not create duplicate empty threads.
    await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill('仅保存的合成会话草稿，不发送');
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); await assertSelection([]);
    await choose('sql'); await closeMenu();
    await page.getByRole('button', { name: '切换会话', exact: true }).click();
    await page.getByRole('menu', { name: '当前项目的会话', exact: true }).getByRole('menuitemradio', { checked: false }).click();
    await assertSelection([]); await manifest((value) => value.state.assistantSessions.activeId === firstSession);
    await shot('09-session-reset-1024', trigger(), 'New/switch/clear context resets selection; old session history cannot restore stale chips');
    assert.equal(actions.length, 1); assert.equal(replays.length, 2);
  });
  await step('Page/project/reload boundaries clear focus and retain only saved Notebook definitions', async () => {
    await mode('Notebook'); await choose('p0'); await closeMenu();
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单' });
    await menu.getByRole('button', { name: '新建界面', exact: true }).click();
    await menu.getByLabel('工作界面名称', { exact: true }).fill('另一个上下文范围');
    await menu.getByRole('button', { name: '创建', exact: true }).click();
    await assertSelection([]); await openMenu(); assert.match(await submenu().innerText(), /暂无 Notebook 单元/); await closeMenu();
    await page.getByLabel('切换工作界面', { exact: true }).click();
    await page.getByRole('menu', { name: '工作界面列表', exact: true }).getByRole('menuitem').filter({ has: page.getByText(firstPageTitle, { exact: true }) }).click();
    pageId = firstPage; await assertSelection([]); await choose('sql'); await closeMenu();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot('10-page-scope-1440', chips(), 'Returning to page does not restore IDs; explicit new selection remains available');
    await selectProject(resolve(directory, 'other-project'), true); await assertSelection([]);
    await selectProject(firstProject); pageId = firstPage; await assertSelection([]);
    await choose('p0'); await choose('sql'); await closeMenu(); await manifest();
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 }); await mode('Notebook'); await dismissNotice(); await assertSelection([]);
    await cell('sql').waitFor(); assert.equal(await cell('sql').getByRole('table').count(), 0, 'Reopen does not restore previous execution as fresh results');
    await openMenu(); assert.equal(await submenu().getByRole('menuitemcheckbox').count(), 11);
    await shot('11-project-reopen-1440', submenu(), 'Saved definitions available after project/reload; no persisted selection or result evidence');
    await closeMenu(); assert.equal(actions.length, 1);
  });
  await Promise.all(responseTasks); assert.deepEqual(httpErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads > 0); passed = true;
} catch (error) {
  failure = { scenario, message: String(error), stack: error.stack }; process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify({ passed, failure, checks, screenshots, actions, runs, replays, clearedConversations,
    ids, pageErrors, forbiddenRequests, httpErrors, resourceFailures, directoryReads, realModelCalls: 0, realWarehouseQueries: 0,
    boundaries: ['Only new synthetic projects and isolated browser; real UI, local SQL and project persistence.',
      'Connection directory GET uses explicit empty fixture; all live models and external/warehouse requests prohibited.',
      'Two SSE replays use real offline Harness cellSearch tools with fixed model decisions, no Notebook execution and no fabricated successful output.',
      'Actual own-session context DELETE is allowed after verifying synthetic project and previously submitted context ID.',
      'Selection represents current focus, not result evidence; no new Dataset or Dashboard is created.',
      'Evidence retained; no service operations, production publication, mobile support or real model quality claims.'] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, replays: replays.length, directory, failure }, null, 2));
}
