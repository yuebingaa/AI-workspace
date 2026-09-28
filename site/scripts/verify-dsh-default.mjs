// Default official DSH surface acceptance. No paid mode exists in this script.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

assert.ok(process.argv.length <= 3 && [undefined, '--offline'].includes(process.argv[2]), 'Only --offline is supported.');
const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project', endpoint = '/api/ai/dsh/conversation/stream';
const directory = resolve('.runtime/dsh-default-20260926', `browser-${Date.now()}`), projectPath = join(directory, 'project');
const instructions = ['默认 DSH 合成验收：记住代号晨星42，不分析数据。', '请回复刚才的合成代号，不分析数据。',
  '隔离失败演示，不调用真实模型。', '隔离取消演示，不调用真实模型。', '隔离 HTTP 预检拒绝演示，不调用真实模型。'];
const responses = ['合成成功回执：已记住 **晨星42**，未读取数据或修改 Notebook。', '晨星42',
  '合成失败回执：任务未完成，没有读取数据或修改正式文档。'];
const report = { passed: false, base, offline: true, paidTasks: 0, checks: [], screenshots: [], fixtures: [],
  pageErrors: [], routeErrors: [], resourceFailures: [], oldHarnessRequests: [], settingsRequests: [], clearRequests: [], fixtureSeeds: 0,
  boundaries: ['Fresh browser context and newly created synthetic local project only; no user data, database, real model or Notebook execution.',
    'Actual official Web resources and presentation bridge; success, failure, cancellation and HTTP preflight rejection are explicit browser transport fixtures.',
    'HTTP 400 demonstrates server-admission error handling, not a frontend-before-onAccepted rejection or a real provider outage.',
    'One synthetic classic conversation is seeded into the owned project through the normal save API and must remain unchanged.',
    'Screenshots require separate actual visual review; capturing a PNG does not mark it reviewed.'] };
await mkdir(directory, { recursive: true });
let browser, context, page, handle, pageId, baselineAppSpec, baselineNotebooks, classicSeed, sessionId, expectedClearContext;
let created = 0;
const activeOf = state => state.assistantSessions.items.find(item => item.id === state.assistantSessions.activeId);
const frame = () => page.frameLocator('iframe[title="官方 DSH 聊天"]');
const composer = () => frame().locator('[data-composer-input="true"]');
const normalized = value => value.replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/\s+/gu, ' ').trim();
const pause = ms => new Promise(done => setTimeout(done, ms));
const redacted = value => value.replaceAll(pathToFileURL(process.cwd()).href, '<workspace>')
  .replaceAll(process.cwd(), '<workspace>').replaceAll(process.cwd().replaceAll('\\', '/'), '<workspace>');
async function poll(predicate, message, timeout = 40_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(120); }
  throw new Error(message);
}
function preserve(state) {
  if (baselineAppSpec) assert.deepEqual(state.appSpec, baselineAppSpec, 'Template/dashboard definition changed.');
  if (baselineNotebooks) assert.deepEqual(state.dataProduct.notebooks, baselineNotebooks, 'Notebook definition changed.');
  if (classicSeed) assert.deepEqual(state.assistantSessions.items.find(item => item.id === classicSeed.id), classicSeed, 'Old classic conversation was overwritten.');
}
async function ownedProject() {
  assert.ok(handle);
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
  assert.equal(response.status(), 200);
  const value = await response.json(); assert.equal(resolve(value.path), projectPath); assert.equal(value.handle, handle);
  assert.deepEqual(value.manifest.tables, []); assert.deepEqual(value.manifest.files, []);
  return value;
}
async function snapshot(predicate = () => true) {
  let state;
  await poll(async () => {
    state = (await ownedProject()).manifest.state;
    return state && predicate(state) && /已保存到本地项目|已打开本地项目/u.test(await page.locator('.top-actions').textContent());
  }, 'Owned project save did not settle.');
  preserve(state); return state;
}
async function menu(label) {
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  await navigation.getByRole('textbox', { name: '查找功能或工作界面', exact: true }).fill(label);
  await navigation.getByRole('button', { name: label, exact: true }).click();
}
async function readyComposer() {
  await frame().locator('[data-agentcanvas-dsh-native-web="true"]').waitFor(); await composer().waitFor();
  await poll(async () => await composer().getAttribute('contenteditable') === 'true', 'Official composer did not become editable.');
}
async function workspace() {
  await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click(); await readyComposer();
}
async function officialText(expected) {
  await poll(async () => {
    const text = normalized(await frame().locator('body').innerText());
    return expected.every(item => text.includes(normalized(item)));
  }, 'Expected official response is not rendered.');
}
async function assertSimplified() {
  const panel = page.locator('.official-dsh-panel');
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.locator('.agent-context-bar, .safe-note, .harness-trace, .context-pill').count(), 0,
    'Legacy footer, redundant context strip or independent trace remains in official surface.');
  assert.equal(await page.getByRole('button', { name: /返回过渡入口|试用官方对话界面|返回原工作台/u }).count(), 0);
  assert.equal(await page.locator('.dsh-conversation-notice').count(), 0, 'Preview-entry notice remains on the default website.');
  assert.equal(await page.locator('.top-actions .publish, .publish-readiness-dialog').count(), 0,
    'Removed publish control or readiness dialog remains in the workspace.');
  assert.equal(await page.getByRole('button', { name: '选择分析数据与上下文', exact: true }).count(), 1);
}
async function visibleElement(locator, name) {
  assert.equal(await locator.count(), 1, `Expected one visible target: ${name}`);
  const geometry = await locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let shown = true;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) shown = false;
      if (node === element) continue;
      const box = node.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/u.test(style.overflowX)) {
        clip.left = Math.max(clip.left, box.left + node.clientLeft);
        clip.right = Math.min(clip.right, box.left + node.clientLeft + node.clientWidth);
      }
      if (/auto|scroll|hidden|clip/u.test(style.overflowY)) {
        clip.top = Math.max(clip.top, box.top + node.clientTop);
        clip.bottom = Math.min(clip.bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return { shown, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, clip,
      fullyVisible: bounds.width > 0 && bounds.height > 0 && bounds.left >= clip.left - 1 && bounds.right <= clip.right + 1
        && bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1,
      unobscured: Boolean(hit && (element.contains(hit) || hit.contains(element))) };
  });
  assert.equal(geometry.shown, true, `${name} is hidden.`);
  assert.equal(geometry.fullyVisible, true, `${name} is clipped or outside the rendered viewport: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.unobscured, true, `${name} is covered by another element.`);
  return geometry;
}
async function shot(file, scenario, { modal = false, expectedVisible = [], running = false, emptyDock = false, welcome = false } = {}) {
  await page.mouse.move(1, 1); await assertSimplified();
  await poll(async () => page.locator('iframe[title="官方 DSH 聊天"]').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= -1 && bounds.right <= innerWidth + 1
      && bounds.top >= -1 && bounds.bottom <= innerHeight + 1;
  }), 'Official iframe did not settle inside the resized viewport.', 5_000);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const outer = await page.locator('iframe[title="官方 DSH 聊天"]').evaluate(element => {
    const frameBounds = element.getBoundingClientRect(), surface = element.closest('.dsh-web-frame-surface');
    const conversation = element.closest('.conversation'), surfaceBounds = surface.getBoundingClientRect();
    const panelBounds = element.closest('.official-dsh-panel').getBoundingClientRect();
    const style = getComputedStyle(conversation), availableWidth = conversation.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { frame: { x: frameBounds.x, y: frameBounds.y, width: frameBounds.width, height: frameBounds.height },
      surfaceHeight: surfaceBounds.height, availableWidth, panelHeight: panelBounds.height,
      withinViewport: frameBounds.left >= -1 && frameBounds.right <= innerWidth + 1 && frameBounds.top >= -1 && frameBounds.bottom <= innerHeight + 1 };
  });
  assert.ok(outer.frame.height >= 300 && outer.surfaceHeight >= 300, `Official frame fell back to browser default height: ${JSON.stringify(outer)}`);
  assert.ok(outer.frame.height >= outer.panelHeight * 0.6, `Official frame collapsed to the old small empty-page composer: ${JSON.stringify(outer)}`);
  assert.ok(Math.abs(outer.frame.width - outer.availableWidth) <= Math.max(4, outer.availableWidth * 0.04), `Official iframe does not fill the conversation width: ${JSON.stringify(outer)}`);
  assert.equal(outer.withinViewport, true, `Official iframe is clipped by the outer viewport: ${JSON.stringify(outer)}`);
  const layout = await frame().locator('body').evaluate(() => {
    const bounds = document.querySelector('[data-composer-input]')?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      composerFits: Boolean(bounds && bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1) };
  });
  assert.equal(layout.overflow, false); assert.equal(layout.composerFits, true);
  layout.outer = outer;
  const seat = frame().locator('.wSkVaW_composerSeat[data-composer-seat]');
  assert.equal(await seat.count(), 1, 'Official conversation has no unique composer seat.');
  layout.composerDock = await seat.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const scroll = element.closest('[data-conversation-scroll]')?.getBoundingClientRect();
    return {
      frameHeight: innerHeight,
      seat: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, bottom: bounds.bottom },
      scroll: scroll ? { y: scroll.y, height: scroll.height, bottom: scroll.bottom } : null,
      bottomGap: innerHeight - bounds.bottom,
    };
  });
  const { frameHeight, seat: seatBounds, bottomGap } = layout.composerDock;
  assert.ok(bottomGap >= -2 && bottomGap <= Math.max(64, Math.min(112, frameHeight * 0.13)),
    `DSH composer is floating above the conversation bottom: ${JSON.stringify(layout.composerDock)}`);
  if (emptyDock) {
    assert.ok(seatBounds.y >= frameHeight * 0.45,
      `Empty DSH composer starts too high: ${JSON.stringify(layout.composerDock)}`);
  }
  const welcomeLayer = page.locator('[data-agentcanvas-dsh-empty-welcome]');
  await poll(async () => await welcomeLayer.count() === Number(welcome),
    `Empty-conversation welcome visibility did not settle to ${welcome}.`, 5_000);
  layout.welcome = null;
  if (welcome) {
    assert.equal(await welcomeLayer.isVisible(), true, 'Empty-conversation welcome is not visible.');
    const visual = await welcomeLayer.evaluate(element => {
      const nodes = [...element.querySelectorAll('svg, h2, p')];
      const boxes = nodes.map(node => node.getBoundingClientRect());
      return { pointerEvents: getComputedStyle(element).pointerEvents, nodes: nodes.length,
        heading: element.querySelector('h2')?.textContent?.trim() ?? '',
        bounds: { x: Math.min(...boxes.map(box => box.left)), y: Math.min(...boxes.map(box => box.top)),
          width: Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left)),
          height: Math.max(...boxes.map(box => box.bottom)) - Math.min(...boxes.map(box => box.top)) } };
    });
    const { bounds } = visual;
    const { frame: frameBounds } = outer;
    const composerTop = frameBounds.y + seatBounds.y;
    const centerRatio = (bounds.y + bounds.height / 2 - frameBounds.y) / (composerTop - frameBounds.y);
    layout.welcome = { ...visual, composerTop, centerRatio };
    assert.equal(visual.pointerEvents, 'none', 'Welcome must not intercept the official composer.');
    assert.equal(visual.nodes, 3, 'Welcome needs its illustration, heading and description.');
    assert.ok(visual.heading.length > 0, 'Welcome heading is empty.');
    assert.ok(bounds.width >= 160 && bounds.height >= 60,
      `Empty-conversation welcome collapsed: ${JSON.stringify(layout.welcome)}`);
    assert.ok(bounds.x >= frameBounds.x - 2 && bounds.x + bounds.width <= frameBounds.x + frameBounds.width + 2
      && bounds.y >= frameBounds.y - 2 && bounds.y + bounds.height <= composerTop - 12,
    `Empty-conversation welcome overlaps the composer or leaves the DSH frame: ${JSON.stringify(layout.welcome)}`);
    assert.ok(centerRatio >= 0.15 && centerRatio <= 0.85,
      `Empty-conversation welcome is not placed in the conversation body: ${JSON.stringify(layout.welcome)}`);
  }
  layout.visibleMessages = [];
  for (const text of expectedVisible) layout.visibleMessages.push(await visibleElement(frame().getByText(normalized(text), { exact: true }).last(), `Message ${normalized(text).slice(0, 50)}`));
  if (running) layout.runningStatus = await visibleElement(frame().locator('[data-agentcanvas-dsh-running-status="true"]'), 'Running status');
  await page.screenshot({ path: join(directory, `${file}.png`), animations: 'disabled' });
  report.screenshots.push({ file: `${file}.png`, page: new URL(page.url()).pathname, scenario, viewport: page.viewportSize(), modal, layout, actualImageReviewed: false });
}
async function send(text, kind = 'success') {
  await page.evaluate(kind => { window.__dshDefaultFixtureKind = kind; }, kind);
  await composer().fill(text); await composer().press('Enter');
}
async function openPath(path) {
  await snapshot(); await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, path, 'Route must not redirect away from its established browser storage URL.');
  await workspace(); await assertSimplified();
  assert.equal(activeOf(await snapshot()).id, sessionId);
}
function completedFixture(body, state, message) {
  const now = new Date().toISOString(), task = { id: `harness_${body.idempotencyKey}`, idempotencyKey: body.idempotencyKey,
    instruction: body.instruction, pageId: body.pageId, role: 'editor', state, createdAt: now, updatedAt: now,
    counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, events: [], resultMessage: message,
    ...(state === 'failed' ? { error: '合成失败回执', terminationCode: 'verificationFailed' } : {}) };
  const event = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: now, type: 'completed', taskState: state, message };
  return { status: 200, contentType: 'text/event-stream', body: `event: completed\ndata: ${JSON.stringify({ event, task })}\n\n` };
}

try {
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      if (url.pathname.startsWith('/api/ai/harness')) {
        report.oldHarnessRequests.push({ method: request.method(), path: url.pathname });
        throw new Error('Default DSH must not call the old Harness route.');
      }
      const project = request.headers()[header]; if (project) assert.equal(project, handle);
      if (url.pathname.startsWith('/api/settings/')) report.settingsRequests.push({ path: url.pathname, method: request.method() });
      if (request.method() === 'GET') {
        if (url.pathname === '/api/connections') return route.fulfill({ json: { connections: [] } });
        if (['/api/projects', '/api/datasets'].includes(url.pathname)) {
          if (!project) return route.fulfill({ json: url.pathname === '/api/projects' ? { projects: [] } : { datasets: [] } });
          assert.ok(handle); return route.continue();
        }
        if (url.pathname.startsWith('/api/ai/dsh/web/') || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/notebook/python') return route.continue();
        throw new Error(`Unexpected read: ${url.pathname}`);
      }
      if (url.pathname === '/api/projects') {
        const body = request.postDataJSON(); assert.equal(request.method(), 'POST');
        if (body.action === 'create') {
          assert.equal(++created, 1); assert.equal(body.path, projectPath);
          const response = await route.fetch(); assert.equal(response.status(), 200);
          handle = (await response.json()).handle; assert.ok(handle); return route.fulfill({ response });
        }
        assert.equal(body.action, 'save'); assert.ok(handle); assert.equal(project, handle); preserve(body.state);
        return route.continue();
      }
      if (url.pathname === '/api/ai/dsh/conversation/clear') {
        assert.equal(request.method(), 'DELETE'); assert.ok(handle); assert.equal(project, handle); assert.equal(report.clearRequests.length, 0);
        const body = request.postDataJSON(); assert.deepEqual(body, { conversation_id: expectedClearContext, pageId });
        report.clearRequests.push(body); return route.continue();
      }
      throw new Error(`Prohibited network mutation: ${request.method()} ${url.pathname}; all AI transport must remain synthetic.`);
    } catch (error) { report.routeErrors.push(error.message); return route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.exposeBinding('__acceptDshDefaultFixture', async ({ frame: source }, value) => {
    try {
      assert.equal(source, page.mainFrame(), 'Official iframe must not bypass the parent website.');
      assert.equal(value.path, endpoint); assert.equal(value.project, handle); assert.ok(handle);
      const index = report.fixtures.length, body = value.body;
      assert.ok(index < 5, 'No fixture retry is permitted.');
      assert.equal(value.kind, ['success', 'success', 'failure', 'cancel', 'preflight'][index]);
      assert.equal(body.instruction, instructions[index]); assert.equal(body.pageId, pageId);
      assert.match(body.conversation_id, /^dshconversation_/u); assert.deepEqual(body.appSpec.dataSources, []); assert.deepEqual(body.recipes, []);
      assert.ok(!body.dataSourceId && !body.rawWorkbookManifest && !body.imageAttachmentManifest && !body.mcpTools);
      assert.equal(body.notebookContext?.document.cells.length ?? 0, 0);
      if (index === 1) assert.equal(body.conversationContext?.recentMessages?.[0]?.instruction, instructions[0]);
      report.fixtures.push({ kind: value.kind, endpoint: value.path, instruction: body.instruction, pageId: body.pageId, conversationId: body.conversation_id });
      if (value.kind === 'cancel') return { kind: 'cancel' };
      if (value.kind === 'preflight') return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: '隔离 HTTP 预检拒绝：测试输入未获接收；未启动模型或工具。' }) };
      return completedFixture(body, value.kind === 'failure' ? 'failed' : 'completed', responses[index]);
    } catch (error) { report.routeErrors.push(error.message); throw error; }
  });
  await context.addInitScript(({ endpoint }) => {
    if (window !== window.top) return;
    const original = window.fetch.bind(window); window.__dshDefaultFixtureKind = 'success';
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== endpoint) return original(input, init);
      const result = await window.__acceptDshDefaultFixture({ path: url.pathname, kind: window.__dshDefaultFixtureKind,
        body: JSON.parse(init.body), project: new Headers(init.headers).get('x-agentcanvas-project') });
      if (result.kind === 'cancel') return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled synthetic transport', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      return new Response(result.body, { status: result.status, headers: { 'content-type': result.contentType } });
    };
  }, { endpoint });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).origin === base) report.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  const engineBefore = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineBefore.activeTasks, 0);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' }); assert.equal(new URL(page.url()).pathname, '/');
  await workspace(); await assertSimplified();
  await menu('数据浏览器');
  const dialog = page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  await dialog.getByRole('button', { name: /项目文件夹/u }).first().click();
  await dialog.getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  await dialog.getByLabel('项目名称', { exact: true }).fill('DSH 默认界面 · 隔离验收');
  await dialog.getByRole('button', { name: '新建本地项目', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const initial = await snapshot(); pageId = activeOf(initial).pageId;
  assert.deepEqual(initial.appSpec.dataSources, []);
  baselineAppSpec = structuredClone(initial.appSpec); baselineNotebooks = structuredClone(initial.dataProduct.notebooks);
  // Stop this fresh browser from autosaving while seeding a single owned classic row.
  await page.goto('about:blank');
  const project = await ownedProject(), seeded = structuredClone(project.manifest.state), now = new Date().toISOString();
  classicSeed = { id: 'conversation_default_classic_fixture', contextId: 'conversation_default_classic_fixture', title: '保留的经典聊天（合成）',
    createdAt: now, updatedAt: now, draft: '保留的旧草稿', pageId, pageIds: [pageId], turns: [{ id: 'classic_preserved_fixture',
      instruction: '原入口的合成消息必须保留。', response: '旧聊天合成回复保持原样。', createdAt: now, state: 'success', pageId }] };
  seeded.assistantSessions.items.push(classicSeed); preserve(seeded);
  const seedResult = await context.request.post(`${base}/api/projects`, { headers: { [header]: handle, origin: base },
    data: { action: 'save', stateRevision: project.manifest.stateRevision, state: seeded } });
  assert.equal(seedResult.status(), 200); report.fixtureSeeds++;
  await page.goto(`${base}/`, { waitUntil: 'networkidle' }); await workspace(); await assertSimplified();
  const prepared = await snapshot(); sessionId = activeOf(prepared).id; assert.match(sessionId, /^dshconversation_/u);
  assert.equal(activeOf(prepared).turns.length, 0);
  report.project = { path: relative(process.cwd(), projectPath).replaceAll('\\', '/'), handle, pageId, sessionId, classicId: classicSeed.id };
  assert.ok(!(await frame().locator('body').innerText()).includes(classicSeed.turns[0].response));
  await shot('01-default-home-1440', 'Root homepage uses official DSH with a centered empty-conversation welcome above the bottom composer; synthetic classic chat remains stored.', { emptyDock: true, welcome: true });
  await page.setViewportSize({ width: 2048, height: 1150 });
  await shot('01b-empty-home-2048', 'At the reported desktop viewport, the empty root conversation shows its welcome without covering the bottom composer.', { emptyDock: true, welcome: true });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const emptySidebarToggle = page.getByRole('button', { name: 'AI 助手', exact: true });
  if (await emptySidebarToggle.getAttribute('aria-expanded') === 'false') await emptySidebarToggle.click();
  await readyComposer(); assert.equal(activeOf(await snapshot()).turns.length, 0);
  await shot('01c-empty-notebook-sidebar-2048', 'At the reported desktop viewport, an empty Notebook sidebar keeps its composer at the bottom.', { emptyDock: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await shot('01a-empty-notebook-sidebar-1440', 'Empty Notebook sidebar keeps the official DSH composer at the bottom without running Notebook cells.', { emptyDock: true });
  await workspace();
  await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
  assert.equal(await navigation.getByRole('link', { name: /可视化测试/ }).count(), 0, 'Retired visualization-lab page must not appear in navigation.');
  await navigation.locator('.studio-navigation-settings > summary').click();
  assert.equal(await navigation.getByLabel('界面演示角色，不影响服务端授权', { exact: true }).count(), 0);
  assert.equal(await navigation.locator('.studio-navigation-settings select').count(), 0, 'Removed demo role selection remains in settings.');
  await shot('01d-settings-without-role-1440', 'Workspace settings keep tools and backup actions without the demo role selector or publish control.', { modal: true, welcome: true });
  await navigation.locator('.studio-navigation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await shot('01e-settings-bottom-without-role-1440', 'The end of settings shows backup and undo actions with no demo role selector.', { modal: true, welcome: true });
  await navigation.getByRole('button', { name: '收起工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '选择分析数据与上下文', exact: true }).click();
  const contextMenu = page.getByRole('menu', { name: '添加上下文菜单', exact: true });
  await contextMenu.waitFor();
  const menuBounds = await contextMenu.boundingBox(), triggerBounds = await page.getByRole('button', { name: '选择分析数据与上下文', exact: true }).boundingBox();
  assert.ok(menuBounds && triggerBounds && menuBounds.y >= triggerBounds.y + triggerBounds.height,
    'Header context menu must open below its trigger, not use the old bottom-composer anchor.');
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= page.viewportSize().width + 1
    && menuBounds.y + menuBounds.height <= page.viewportSize().height + 1, 'Header context menu extends outside the viewport.');
  report.contextMenuPlacement = { menu: menuBounds, trigger: triggerBounds, below: true };
  await shot('02-header-context-menu-1440', 'Lightweight header context button opens the existing context menu while the empty root welcome stays in place.', { modal: true, welcome: true });
  await page.keyboard.press('Escape');
  await frame().locator('body').evaluate(() => {
    window.__dshDefaultKeyboardTrace = [];
    for (const name of ['keydown', 'beforeinput', 'input', 'keyup']) document.addEventListener(name, event => {
      if (!event.target.closest?.('[data-composer-input]')) return;
      const selection = window.getSelection();
      window.__dshDefaultKeyboardTrace.push({ name, key: event.key ?? null, inputType: event.inputType ?? null, data: event.data ?? null,
        text: event.target.closest('[data-composer-input]').innerText, selection: selection?.toString() ?? '',
        anchorOffset: selection?.anchorOffset, focusOffset: selection?.focusOffset,
        parentDraft: window.__AGENTCANVAS_DSH_WEB__?.current()?.draft ?? null });
    }, true);
  });
  await composer().fill('第一行'); await composer().press('End'); await composer().press('Shift+Enter'); await composer().press('b');
  report.keyboardTrace = await frame().locator('body').evaluate(() => window.__dshDefaultKeyboardTrace);
  assert.equal(await composer().innerText(), '第一行\nb'); assert.equal(report.fixtures.length, 0);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await shot('03-shift-enter-workspace-1024', 'Official Shift+Enter inserts a real newline and sends no request; the welcome is hidden while a draft exists.');
  await composer().fill(''); await page.setViewportSize({ width: 1440, height: 1100 });
  await poll(async () => await page.locator('[data-agentcanvas-dsh-empty-welcome]').count() === 1,
    'Welcome did not return after clearing the unsent draft.', 5_000);
  for (let index = 0; index < 2; index++) {
    await send(instructions[index]);
    const state = await snapshot(value => activeOf(value)?.turns.length === index + 1);
    assert.equal(activeOf(state).turns[index].response, responses[index]); assert.equal(activeOf(state).turns[index].state, 'success');
    await readyComposer(); await officialText([instructions[index], responses[index]]);
    assert.equal(report.fixtures.length, index + 1); await assertSimplified();
  }
  const successState = await snapshot(), savedTurns = structuredClone(activeOf(successState).turns);
  await shot('04-success-home-1440', 'Two Enter sends use only the dedicated DSH transport; original Markdown is stored exactly and the latest reply is fully visible.', { expectedVisible: [responses[1]] });
  await page.reload({ waitUntil: 'networkidle' }); await workspace(); await officialText(responses.slice(0, 2));
  assert.deepEqual(activeOf(await snapshot()).turns, savedTurns);
  for (const [index, path] of ['/dsh', '/dsh/web'].entries()) {
    await page.setViewportSize({ width: 1024, height: 1000 }); await openPath(path); await officialText(responses.slice(0, 2));
    assert.deepEqual(activeOf(await snapshot()).turns, savedTurns);
    await shot(`05-alias-${index + 1}-1024`, `${path} uses the same default official UI and saved DSH session without redirect or extra requests.`, { expectedVisible: [responses[1]] });
  }
  await openPath('/');
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const assistantToggle = page.getByRole('button', { name: 'AI 助手', exact: true });
  if (await assistantToggle.getAttribute('aria-expanded') === 'false') await assistantToggle.click();
  await readyComposer(); await officialText(responses.slice(0, 2));
  await shot('06-notebook-sidebar-1024', 'Notebook sidebar keeps official composer and visible latest reply at 1024 px; no Notebook execution.', { expectedVisible: [responses[1]] });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await shot('07-notebook-sidebar-1440', 'Full-width Notebook sidebar has no old safe note, bottom context card or independent Harness step strip.', { expectedVisible: [responses[1]] });
  await workspace(); await page.setViewportSize({ width: 1024, height: 1000 });
  await send(instructions[2], 'failure'); await snapshot(value => activeOf(value)?.turns.at(-1)?.state === 'failed');
  await officialText([responses[2]]); await readyComposer();
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  await shot('08-failure-retry-1024', 'Failed synthetic receipt remains visible with a conditional retry control; no independent old step strip.', { expectedVisible: [responses[2]] });
  await send(instructions[3], 'cancel');
  const runningStatus = frame().locator('[data-agentcanvas-dsh-running-status="true"]');
  await runningStatus.waitFor({ state: 'visible' });
  assert.equal(await runningStatus.count(), 1);
  assert.ok((await runningStatus.innerText()).trim());
  assert.equal(await runningStatus.evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
  await shot('09a-running-inline-status-1024', 'A single website-owned status line appears beside the official composer while a synthetic request is held; no separate step strip.', { expectedVisible: [instructions[3]], running: true });
  await frame().getByRole('button', { name: /^(停止生成|Stop generating)$/u }).first().click();
  const cancelled = await snapshot(value => activeOf(value)?.turns.at(-1)?.state === 'cancelled');
  await readyComposer(); await officialText([activeOf(cancelled).turns.at(-1).response]);
  await runningStatus.waitFor({ state: 'hidden' }); assert.equal(await runningStatus.count(), 0);
  await shot('09-cancel-1024', 'Official stop cancels an explicitly held browser transport and leaves a visible cancelled response.', { expectedVisible: [activeOf(cancelled).turns.at(-1).response] });
  await send(instructions[4], 'preflight');
  const rejected = await snapshot(value => activeOf(value)?.turns.length === 5 && activeOf(value).turns.at(-1).state === 'failed');
  await readyComposer(); await officialText([activeOf(rejected).turns.at(-1).response]);
  await page.getByRole('button', { name: '重试这次任务', exact: true }).waitFor();
  await shot('10-http-preflight-rejected-1024', 'Explicit HTTP 400 admission refusal is visible and retryable; not a frontend pre-onAccepted test or a provider failure.', { expectedVisible: [activeOf(rejected).turns.at(-1).response] });
  await menu('DSH 执行与插件');
  const settings = page.getByRole('dialog', { name: 'Agent 执行与插件', exact: true }); await settings.waitFor();
  await settings.getByText('当前对话引擎：', { exact: false }).waitFor();
  assert.match(await settings.innerText(), /当前对话固定使用 DSH/u);
  assert.equal(await settings.getByRole('radio').count(), 0); assert.equal(await settings.getByRole('button', { name: '应用执行引擎', exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await shot('11-dsh-settings-readonly-1440', 'DSH execution/plugins dialog is read-only: no classic engine option and no apply button.', { modal: true });
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  expectedClearContext = activeOf(await snapshot()).contextId; await menu('清除上下文');
  const finalState = await snapshot(value => activeOf(value)?.turns.length === 0);
  assert.equal(activeOf(finalState).id, sessionId); assert.notEqual(activeOf(finalState).contextId, expectedClearContext);
  await readyComposer(); await shot('12-cleared-classic-preserved-1440', 'Dedicated clear empties only the DSH context, restores the welcome above the bottom composer, and preserves classic history and definitions.', { emptyDock: true, welcome: true });
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  const toolbar = page.locator('.canvas-toolbar'); await toolbar.waitFor();
  assert.equal(await toolbar.getByRole('button', { name: '↶', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '编辑', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '预览', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '↷', exact: true }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: '分享', exact: true }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: '•••', exact: true }).count(), 0);
  assert.equal((await toolbar.innerText()).includes('100%'), false);
  await shot('13-dashboard-toolbar-clean-1440', 'Dashboard keeps undo and edit/preview while unavailable redo, fake zoom, share and more controls are removed.', { emptyDock: true });
  assert.equal(report.fixtures.length, 5); assert.equal(report.fixtureSeeds, 1); assert.equal(report.clearRequests.length, 1);
  assert.deepEqual(report.oldHarnessRequests, []); assert.ok(report.settingsRequests.every(item => item.method === 'GET'));
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.resourceFailures, []);
  const engineAfter = await (await context.request.get(`${base}/api/settings/agent-engine`)).json();
  assert.equal(engineAfter.engine, engineBefore.engine); assert.equal(engineAfter.revision, engineBefore.revision); assert.equal(engineAfter.activeTasks, 0);
  report.checks.push('Root and both old paths stay at their URLs and share one official DSH session.',
    'Header context menu remains usable; demo role selector, publish control, redundant context strip, old footer cards/independent trace and transition navigation are absent.',
    'Dashboard toolbar keeps working undo/edit/preview controls and omits unavailable redo/zoom/share/more placeholders.',
    'Enter sends once; Shift+Enter does not send. Success, failure, cancellation and HTTP admission errors stay observable.',
    'One inline running-status line appears only during the held request and disappears after cancellation.',
    '2048/1440/1024 DSH layouts keep the composer at the bottom in empty, populated and cleared conversations; Notebook has no horizontal overflow or cell execution.',
    'The centered empty-workspace welcome is visible only on the empty root or after clearing, never in the Notebook sidebar, with an unsent draft, or during populated and running states; it never overlaps the composer.',
    'Owned template/dashboard and Notebook definitions plus the seeded classic conversation remain byte-for-byte equivalent.',
    'DSH settings use GET only, offer no engine switching, and preserve server configuration.');
  await writeFile(join(directory, 'final-synthetic-state.json'), JSON.stringify(finalState, null, 2));
  report.passed = true;
} catch (error) {
  report.failure = { message: redacted(error.message), stack: error.stack ? redacted(error.stack) : undefined };
  await page?.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }).catch(() => {});
  if (page) await writeFile(join(directory, 'failure-dom.json'), JSON.stringify(await Promise.all(page.frames().map(async item => ({
    url: item.url(), text: await item.locator('body').innerText().catch(() => ''),
  }))), null, 2)).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? redacted(value) : value, 2)); await browser?.close();
  console.log(JSON.stringify({ passed: report.passed, paidTasks: 0, screenshots: report.screenshots.length,
    report: relative(process.cwd(), join(directory, 'report.json')).replaceAll('\\', '/'), failure: report.failure?.message }));
}
