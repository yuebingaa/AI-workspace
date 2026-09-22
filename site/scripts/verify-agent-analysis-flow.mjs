// Managed 3001 UI continuity acceptance. Only the fixed synthetic project is writable.
// Agent transport is explicitly intercepted: actual requests drive an offline real Harness,
// then buffered production SSE is replayed. Never a live model or public-handler claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { AGENT_CONTINUITY_FILE_NAME as fileName, AGENT_CONTINUITY_CSV as csv, AGENT_CONTINUITY_TITLES as titles, createAgentContinuityRunner } from "./fixtures/agent-continuity.mjs";

assert.equal(process.argv.length, 2, "No arbitrary project target is accepted");
const base = "http://127.0.0.1:3001", runId = Date.now(), header = "x-agentcanvas-project";
const evidenceRoot = resolve(".runtime/hex-agent-analysis-flow-2026-09-21"), directory = join(evidenceRoot, `browser-${runId}`);
const target = resolve(".runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project");
const projectId = "c5613c9c-1509-4542-a272-fe5aac668d52", manifestName = "agentcanvas.project.json";
const baselinePath = join(evidenceRoot, "baseline-manifest.json"), baselineSha = "0e91bd7a44255668d5d5ae415b6e911be97003ba952e837f1a91a4cd312d954f";
const workspaceName = "M7 Agent 连续分析", dataTitle = "M7 Agent 三行销售数据", notebookName = "M7 Agent CSV 分析";
const firstInstruction = "检查现有单元，按地区汇总 CSV，添加 SQL、表格和图表单元，先验证再让我采用。";
const followupInstruction = "保留现有地区汇总和图表单元，再计算其两倍收入并生成新的 SQL、表格和图表单元，先不要采用。";
const sourceRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const expected = [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"), sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rel = (path) => relative(process.cwd(), path).split(sep).join("/");
const checks = [], screenshots = [], skips = [], uiRuns = [], agentRuns = [], agentRequests = [], requests = [], saves = [], pageErrors = [], consoleErrors = [], routeErrors = [], forbiddenRequests = [];
let browser, context, page, runner, baseline, startManifest, finalManifest, startBytes, handle, pageId, datasetId, dataId, sessionId, indexPath, initialIndex;
let phase, firstDocument, adoptedDocument, scenario = "preflight", failure, passed = false, preservationVerified = false, preservationError;
let importedNow = false, originalUploadedNow = false, createdPageNow = false, createdDataNow = false, adoptedNow = false, dismissedNow = false;
let fixtureConnections = 0, fixtureRecent = 0, fixtureFonts = 0;
const ownPage = (value) => value.state.appSpec.pages.find((entry) => entry.title === workspaceName);
const book = (value) => value.state.dataProduct.notebooks?.[pageId];
const ownSources = (value) => value.tables.filter((entry) => entry.descriptor.originalFileName === fileName);
const ownSessions = (state) => state.assistantSessions.items.filter((entry) => entry.id === sessionId);
function preserveState(state) {
  for (const [current, old] of [[state.appSpec, baseline.state.appSpec], [state.dataProduct.appSpec, baseline.state.dataProduct.appSpec]]) {
    for (const entry of old.pages) assert.deepEqual(current.pages.find((item) => item.id === entry.id), entry, "Original dashboard changed");
    for (const entry of old.navigation) assert.deepEqual(current.navigation.find((item) => item.id === entry.id), entry);
    for (const entry of old.dataSources) assert.deepEqual(current.dataSources.find((item) => item.id === entry.id), entry);
    const pages = current.pages.filter((entry) => !old.pages.some((item) => item.id === entry.id));
    assert.ok(pages.length <= 1); for (const entry of pages) { assert.equal(entry.title, workspaceName); assert.deepEqual(entry.root.children, [], "No dashboard snapshot is in scope"); }
    const navigation = current.navigation.filter((entry) => !old.navigation.some((item) => item.id === entry.id));
    assert.ok(navigation.length <= 1); for (const entry of navigation) { assert.equal(entry.title, workspaceName); assert.equal(entry.pageId, pages[0]?.id); }
    assert.ok(current.dataSources.length <= old.dataSources.length + 1);
    for (const key of ["id", "siteId", "schemaVersion"]) assert.deepEqual(current[key], old[key]);
  }
  for (const [id, definition] of Object.entries(baseline.state.dataProduct.notebooks)) assert.deepEqual(state.dataProduct.notebooks[id], definition);
  const newBooks = Object.entries(state.dataProduct.notebooks).filter(([id]) => !(id in baseline.state.dataProduct.notebooks));
  assert.ok(newBooks.length <= 1);
  for (const [id, definition] of newBooks) {
    assert.equal(id, state.appSpec.pages.find((entry) => entry.title === workspaceName)?.id);
    assert.ok(definition.cells.length <= 4, "The follow-up draft must never be adopted");
    for (const item of definition.cells) {
      assert.ok(["data", "sql", "table", "chart"].includes(item.kind));
      if (item.kind !== "data") assert.equal(item.id, `m7_agent_first_${item.kind}`);
      else assert.ok(state.appSpec.dataSources.some((source) => source.id === item.sourceDataSourceId), "Data editor may temporarily use its existing default source; execution is separately restricted");
    }
  }
  assert.deepEqual(state.dataProduct.semanticLayer, baseline.state.dataProduct.semanticLayer);
  for (const key of ["datasets", "recipes"]) for (const entry of baseline.state.dataProduct[key]) assert.deepEqual(state.dataProduct[key].find((item) => item.id === entry.id), entry);
  assert.equal(state.changeHistory.length, baseline.state.changeHistory.length);
  for (const entry of baseline.state.changeHistory) {
    const current = state.changeHistory.find((item) => item.changeSetId === entry.changeSetId); assert.ok(current);
    // Normal CSV synchronization adds this one source to every historical AppSpec.
    // No historical component, binding, old source or other field may change.
    const sources = current.appSpec.dataSources.filter((source) => source.id !== datasetId);
    assert.deepEqual({ ...current, appSpec: { ...current.appSpec, dataSources: sources } }, entry);
    const additions = current.appSpec.dataSources.filter((source) => source.id === datasetId); assert.ok(additions.length <= 1);
    for (const source of additions) assert.deepEqual(source, state.appSpec.dataSources.find((item) => item.id === datasetId));
  }
  for (const key of ["auditRecords", "queryRecords"]) for (const entry of baseline.state[key]) assert.ok(state[key].some((item) => JSON.stringify(item) === JSON.stringify(entry)), `Original ${key} entry changed`);
  assert.deepEqual(state.appliedChangeSetIds, baseline.state.appliedChangeSetIds);
  assert.deepEqual(state.edsWorkspace, baseline.state.edsWorkspace);
  for (const entry of baseline.state.harnessTasks) assert.deepEqual(state.harnessTasks.find((item) => item.id === entry.id), entry);
  const newTasks = state.harnessTasks.filter((entry) => !baseline.state.harnessTasks.some((item) => item.id === entry.id));
  assert.ok(newTasks.length <= 2, "Only two Agent tasks are authorized across attempts");
  for (const entry of newTasks) assert.equal(entry.pageId, pageId);
  assert.equal(state.assistantSessions.items.length, baseline.state.assistantSessions.items.length, "No conversation is added");
  for (const entry of baseline.state.assistantSessions.items) {
    const current = state.assistantSessions.items.find((item) => item.id === entry.id);
    if (entry.id !== sessionId) { assert.deepEqual(current, entry, "Original populated conversation changed"); continue; }
    for (const key of ["id", "contextId", "createdAt"]) assert.deepEqual(current[key], entry[key]);
    assert.ok([entry.title, firstInstruction.replace(/\s+/gu, " ").slice(0, 48)].includes(current.title));
    assert.ok(["", firstInstruction, followupInstruction].includes(current.draft));
    assert.ok(current.turns.length <= 2); for (const turn of current.turns) { assert.equal(turn.pageId, pageId); assert.ok([firstInstruction, followupInstruction].includes(turn.instruction)); }
    assert.ok(current.pageIds.every((id) => id === pageId));
  }
}
async function resourcesUnchanged(value) {
  assert.equal(value.id, projectId); assert.equal(value.name, baseline.name); preserveState(value.state);
  for (const entry of baseline.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of baseline.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  const addedTables = value.tables.filter((entry) => !baseline.tables.some((old) => old.descriptor.datasetId === entry.descriptor.datasetId));
  assert.ok(addedTables.length <= 1); assert.deepEqual(addedTables, ownSources(value));
  const addedFiles = value.files.filter((entry) => !baseline.files.some((old) => old.id === entry.id));
  assert.ok(addedFiles.length <= 1); for (const entry of addedFiles) { assert.equal(entry.name, fileName); assert.deepEqual(entry.datasetIds, addedTables.map((table) => table.descriptor.datasetId)); }
  for (const folder of ["tables", "files"]) {
    assert.equal(await realpath(join(target, folder)), join(target, folder));
    assert.deepEqual((await readdir(join(target, folder))).sort(), value[folder].map((entry) => entry.file).sort());
    for (const entry of value[folder]) {
      const path = join(target, folder, entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await readFile(path); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
      if (addedTables.includes(entry)) assert.deepEqual(JSON.parse(bytes).rows, sourceRows);
      if (addedFiles.includes(entry)) assert.equal(bytes.toString("utf8"), csv);
    }
  }
  if (indexPath) {
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const sorted = (value) => [...value.entries].sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(sorted(current), sorted(initialIndex), "No project registration or removal");
  }
}
async function preflight() {
  assert.equal(await realpath(target), target); assert.equal((await lstat(target)).isSymbolicLink(), false);
  const ownership = JSON.parse(await readFile(join(dirname(target), "report.json"), "utf8")); assert.equal(resolve(ownership.projectPath), target); assert.equal(ownership.passed, false);
  startBytes = await readFile(join(target, manifestName)); startManifest = JSON.parse(startBytes);
  await mkdir(directory, { recursive: true });
  let bytes; try { bytes = await readFile(baselinePath); } catch (error) {
    if (error.code !== "ENOENT") throw error; assert.equal(hash(startBytes), baselineSha); await writeFile(baselinePath, startBytes, { flag: "wx" }); bytes = startBytes;
  }
  assert.equal(hash(bytes), baselineSha); baseline = JSON.parse(bytes);
  assert.equal(baseline.stateRevision, 155); assert.equal(baseline.tables.length, 40); assert.equal(baseline.files.length, 16); assert.equal(baseline.state.appSpec.pages.length, 17);
  const location = JSON.parse(await readFile(resolve(".runtime/runtime-location.json"), "utf8")); const config = JSON.parse(await readFile(join(location.root, "config.json"), "utf8"));
  indexPath = join(config.devState, "local-projects.json"); initialIndex = JSON.parse(await readFile(indexPath, "utf8"));
  const entries = initialIndex.entries.filter((entry) => resolve(entry.path) === target); assert.equal(entries.length, 1); handle = entries[0].handle;
  pageId = ownPage(startManifest)?.id; datasetId = ownSources(startManifest)[0]?.descriptor.datasetId;
  dataId = book(startManifest)?.cells.find((entry) => entry.kind === "data")?.id;
  assert.equal(baseline.state.assistantSessions.items.length, 1);
  const originalSession = baseline.state.assistantSessions.items[0];
  assert.deepEqual(originalSession.turns, []); assert.equal(originalSession.draft, ""); assert.deepEqual(originalSession.pageIds, []); assert.equal(originalSession.pendingTaskId, undefined);
  assert.deepEqual(baseline.state.harnessTasks, []); sessionId = originalSession.id;
  await resourcesUnchanged(startManifest); await writeFile(join(directory, "prior-manifest.json"), startBytes, { flag: "wx" });
  assert.equal(startManifest.state.harnessTasks.length, baseline.state.harnessTasks.length, "Prior Agent attempt exists: fail-safe; do not generate duplicate tasks or discard evidence");
  assert.ok(!book(startManifest)?.lastDraftId, "An adopted prior attempt cannot silently be replayed as new proof");
}
function observe(targetPage) {
  targetPage.setDefaultTimeout(20_000);
  targetPage.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  targetPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ scenario, text: message.text() }); });
}
const browserDialog = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const editor = () => page.locator(".notebook-editor");
const draft = () => page.getByRole("region", { name: "AI Notebook 草稿", exact: true });
const chart = () => page.getByRole("article", { name: `图表单元 ${titles.firstChart}`, exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, focus, assertions) {
  if (focus) await focus.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), scenario, assertions });
}
async function dismissNotice() { const button = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true }); if (await button.isVisible()) await button.click(); }
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } }); assert.equal(response.status(), 200);
  const session = await response.json(); assert.equal(session.handle, handle); assert.equal(resolve(session.path), target); assert.equal(session.manifest.id, projectId); return session.manifest;
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 25_000; let revision, stable = 0;
  while (Date.now() < deadline) {
    const value = await manifest();
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(await page.locator(".top-actions").textContent())) {
      if (revision !== value.stateRevision) { revision = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable >= 650) { await resourcesUnchanged(value); return value; }
    } else { stable = 0; revision = undefined; } await sleep(100);
  }
  throw new Error("Expected scoped state was not stably saved");
}
async function openDataBrowser() {
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser"); await menu.getByRole("button", { name: "数据浏览器", exact: true }).click();
}
async function openExistingProject() {
  await openDataBrowser();
  await browserDialog().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/u }).click();
  await browserDialog().getByLabel("项目文件夹绝对路径", { exact: true }).fill(target);
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
  await browserDialog().getByRole("button", { name: "打开已有项目", exact: true }).click(); assert.equal((await pending).status(), 200);
  await browserDialog().waitFor({ state: "hidden" }); assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), handle);
  await manifest(); await saved(); await dismissNotice();
}
async function selectWorkspace() {
  await page.getByLabel("切换工作界面", { exact: true }).click();
  await page.getByRole("menu", { name: "工作界面列表", exact: true }).getByRole("menuitem").filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
}
async function mode(name) { await page.getByRole("tab", { name, exact: true }).click(); await dismissNotice(); }
async function sendAgent(nextPhase, instruction) {
  phase = nextPhase; await mode("AI 工作台");
  await page.getByRole("textbox", { name: "AI 指令", exact: true }).fill(instruction);
  await page.getByRole("button", { name: "发送 AI 指令", exact: true }).click();
  await page.locator(".conversation-turn").last().locator(".harness-trace.waiting").waitFor({ timeout: 70_000 });
  await page.getByRole("button", { name: "取消 AI 请求", exact: true }).waitFor({ state: "hidden" });
  assert.equal(agentRuns.length, nextPhase === "first" ? 1 : 2);
  const receipt = agentRuns.at(-1); assert.equal(receipt.task.state, "awaitingConfirmation");
  await saved((value) => value.state.harnessTasks.some((task) => task.id === receipt.task.id && task.state === "awaitingConfirmation")); return receipt;
}
async function realRun() {
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  await page.getByRole("button", { name: "▶ 全部运行", exact: true }).click(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200); assert.equal(result.run.status, "success"); assert.equal(result.run.revision, adoptedDocument.revision);
  assert.deepEqual(result.run.cells.map((cell) => cell.cellId).sort(), adoptedDocument.cells.map((cell) => cell.id).sort());
  assert.deepEqual(result.run.cells.find((cell) => cell.cellId === dataId).table.rows, sourceRows);
  for (const kind of ["sql", "table", "chart"]) assert.deepEqual(result.run.cells.find((cell) => cell.cellId === `m7_agent_first_${kind}`).table.rows, expected);
  assert.equal(uiRuns.some((entry) => entry.runId === result.run.runId), false); uiRuns.push(result.run);
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  await chart().getByRole("img", { name: /图表下方提供对应数据表/u }).waitFor(); return result.run;
}

try {
  await preflight(); browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage(); observe(page);
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.href === "https://rsms.me/inter/inter.css") { fixtureFonts++; return await route.fulfill({ status: 200, contentType: "text/css", body: "" }); }
      if (url.origin !== base || url.pathname.startsWith("/api/connections/")) { forbiddenRequests.push(`${method} ${url.origin === base ? url.pathname : url.origin}`); return await route.abort("blockedbyclient"); }
      if (url.pathname === "/api/connections") { assert.equal(method, "GET"); fixtureConnections++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"connections":[]}' }); }
      if (url.pathname === "/api/projects" && method === "GET" && !request.headers()[header]) { fixtureRecent++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' }); }
      if (request.headers()[header]) assert.equal(request.headers()[header], handle);
      if (url.pathname.startsWith("/api/ai/")) {
        assert.equal(url.pathname, "/api/ai/harness/stream"); assert.equal(method, "POST"); assert.equal(request.headers()[header], handle);
        assert.ok(runner && ["first", "followup"].includes(phase)); assert.equal(agentRuns.length, phase === "first" ? 0 : 1, "No extra task permitted");
        const payload = request.postDataJSON(); assert.equal(payload.instruction, phase === "first" ? firstInstruction : followupInstruction);
        agentRequests.push({ phase, idempotencyKey: payload.idempotencyKey, conversationId: payload.conversation_id, pageId: payload.pageId, recipeCount: payload.recipes?.length });
        const result = await runner.run({ payload, projectHandle: handle, phase }); agentRuns.push(result);
        return await route.fulfill({ status: 200, headers: result.headers, body: result.body });
      }
      if (url.pathname === "/api/projects" && method === "POST") {
        const body = request.postDataJSON(); assert.ok(["open", "save"].includes(body.action));
        if (body.action === "open") assert.equal(body.path, target);
        else { assert.equal(request.headers()[header], handle); preserveState(body.state); saves.push({ scenario, revision: body.stateRevision }); }
      } else if (url.pathname === "/api/datasets" && method === "POST") {
        assert.equal(datasetId, undefined); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()["x-file-name"]), fileName); assert.equal(request.postData(), csv);
      } else if (url.pathname === "/api/projects/files" && method === "POST") {
        assert.equal(request.headers()[header], handle); assert.equal(decodeURIComponent(request.headers()["x-file-name"]), fileName); assert.equal(request.postData(), csv);
        const owners = ownSources(JSON.parse(await readFile(join(target, manifestName), "utf8"))); assert.equal(owners.length, 1);
        assert.equal(request.headers()["x-dataset-id"], owners[0].descriptor.datasetId); if (datasetId) assert.equal(owners[0].descriptor.datasetId, datasetId);
      } else if (url.pathname === "/api/notebook/run") {
        assert.equal(method, "POST"); assert.equal(request.headers()[header], handle); const body = request.postDataJSON();
        assert.equal(body.action, "run", "No snapshot or Dataset save in this batch"); assert.deepEqual(body.document, adoptedDocument);
        requests.push({ scenario, action: body.action, revision: body.document.revision });
      } else if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(method)) { forbiddenRequests.push(`${method} ${url.pathname}`); return await route.abort("blockedbyclient"); }
      return await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); return await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Open verified synthetic project and at most one dedicated blank page", async () => {
    await openExistingProject();
    if (!pageId) {
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click(); const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
      await menu.getByRole("button", { name: "新建界面", exact: true }).click(); await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName);
      await menu.getByRole("button", { name: "创建", exact: true }).click(); pageId = ownPage(await saved((value) => Boolean(ownPage(value)))).id; createdPageNow = true;
    } else { skips.push({ operation: "create-page", reason: "Reuse fixed page from a pre-Agent attempt" }); await selectWorkspace(); }
    await mode("Notebook");
  });
  await step("Complete actual UI CSV and original-file upload", async () => {
    if (datasetId) {
      assert.ok((await manifest()).files.some((entry) => entry.name === fileName && entry.datasetIds.includes(datasetId)), "Incomplete prior import: no API repair or duplicate upload authorized");
      skips.push({ operation: "ui-upload", reason: "Existing complete CSV reused, not fresh complete upload proof" });
      if (!(await manifest()).state.appSpec.dataSources.some((source) => source.id === datasetId)) {
        await openDataBrowser(); await browserDialog().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /数据表/u }).click();
        await browserDialog().getByRole("textbox", { name: "搜索数据表", exact: true }).fill(fileName);
        assert.equal(await browserDialog().locator(".data-browser-table-list button").count(), 1);
        await browserDialog().getByRole("button", { name: "用于 Notebook", exact: true }).click(); await browserDialog().waitFor({ state: "hidden" });
        await saved((value) => value.state.appSpec.dataSources.some((source) => source.id === datasetId));
        skips.push({ operation: "recover-source-binding", reason: "The first attempt's upload was complete but workspace save was blocked by the verifier. Used the actual Data Browser '用于 Notebook' action on the existing table to finish source synchronization; no mutation API seeding or new import." });
      }
      return;
    }
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click(); const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(csv) });
    await shot("01-csv-ready-1440", upload, ["New three-row synthetic CSV selected through real upload UI"]);
    const parsed = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    const original = page.waitForResponse((response) => response.url() === `${base}/api/projects/files` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click(); const response = await parsed; assert.equal(response.status(), 201);
    datasetId = (await response.json()).dataset.datasetId; importedNow = true; assert.equal((await original).status(), 201); originalUploadedNow = true;
    await upload.waitFor({ state: "hidden" }); await saved((value) => value.files.some((entry) => entry.name === fileName && entry.datasetIds.includes(datasetId)));
  });
  await step("Manually create one Data cell and reuse only the verified empty synthetic conversation", async () => {
    if (!dataId) {
      await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: "＋ Data", exact: true }).click();
      await editor().getByLabel("单元名称", { exact: true }).fill(dataTitle); await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill("sales_data");
      await editor().getByLabel("数据源", { exact: true }).selectOption(datasetId); await editor().getByRole("button", { name: "保存单元", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".notebook-editor") || document.querySelector('[aria-label="确认输出变量改名"]'));
      const rename = page.getByRole("region", { name: "确认输出变量改名", exact: true }); if (await rename.isVisible()) await rename.getByRole("button", { name: "确认改名并保存", exact: true }).click();
      await editor().waitFor({ state: "hidden" }); dataId = book(await saved((value) => book(value)?.cells.some((cell) => cell.title === dataTitle))).cells[0].id; createdDataNow = true;
      await page.locator(".notebook-title").click(); await page.getByLabel("分析文档名称", { exact: true }).fill(notebookName); await page.getByRole("button", { name: "保存名称", exact: true }).click();
      await saved((value) => book(value)?.name === notebookName);
    } else skips.push({ operation: "create-data", reason: "Reuse exact prior manually created Data cell" });
    firstDocument = book(await saved()); assert.equal(firstDocument.cells.length, 1); assert.equal(firstDocument.cells[0].sourceDataSourceId, datasetId);
    await shot("02-upload-complete-data-1440", page.getByRole("article", { name: `Data单元 ${dataTitle}`, exact: true }), [importedNow && originalUploadedNow ? "This attempt's upload dialog closed after both Dataset and original-file 201" : "Reused the first attempt's UI-uploaded Dataset/original; source recovery, if needed, uses actual Data Browser", "Persisted original bytes and Dataset rows are checked", "One manually saved Data cell; no injected Notebook definition"]);
    await mode("AI 工作台");
    assert.equal((await manifest()).state.assistantSessions.activeId, sessionId);
    skips.push({ operation: "create-conversation", reason: "Reuse the baseline's sole verified empty synthetic conversation: the real New conversation action intentionally does nothing when the current thread and input are empty. No historical messages are replaced." });
    runner = await createAgentContinuityRunner({ directory: join(directory, "harness"), scope: { projectHandle: handle, pageId, datasetId },
      loadSyntheticDataset: async (scope) => {
        assert.deepEqual(scope, { projectHandle: handle, pageId, datasetId }); const current = JSON.parse(await readFile(join(target, manifestName), "utf8"));
        await resourcesUnchanged(current); const entry = ownSources(current)[0]; assert.equal(entry.descriptor.datasetId, datasetId);
        const content = JSON.parse(await readFile(join(target, "tables", entry.file), "utf8")); assert.deepEqual(content.rows, sourceRows);
        return { descriptor: entry.descriptor, rows: content.rows };
      } });
  });
  await step("Actual browser request drives first offline Harness trial and leaves a draft unadopted", async () => {
    const first = await sendAgent("first", firstInstruction); assert.deepEqual(book(await saved()), firstDocument);
    await shot("03-agent-first-trace-1440", page.locator(".conversation-turn").last(), ["Actual request drove real search/edit/run/submit tools", "Scripted model and buffered SSE, not public-handler or paid-model verification"]);
    await mode("Notebook"); await draft().waitFor(); assert.match(await draft().innerText(), /已通过数据试运行/u);
    await draft().getByText(/查看变更和步骤/u).click(); assert.equal(await draft().getByRole("article").count(), 3);
    assert.equal(first.task.notebookArtifact.cells.length, 4); assert.equal(first.task.notebookArtifact.baseRevision, firstDocument.revision);
    await shot("04-first-draft-unadopted-1440", draft(), ["Three new cells shown for review; formal document remains one Data cell", "Actual trial evidence; explicit adoption required"]);
  });
  await step("Adopt first draft explicitly then run real HTTP SQL/table/chart to 150 and 80", async () => {
    const task = agentRuns[0].task; await draft().getByRole("button", { name: "采用草稿", exact: true }).click(); await draft().waitFor({ state: "hidden" });
    const value = await saved((current) => book(current)?.lastDraftId === task.notebookArtifact.id && current.state.harnessTasks.find((entry) => entry.id === task.id)?.state === "completed");
    adoptedDocument = book(value); adoptedNow = true; assert.equal(adoptedDocument.revision, firstDocument.revision + 1); assert.deepEqual(adoptedDocument.cells, task.notebookArtifact.cells);
    assert.equal(requests.length, 0); assert.equal(await chart().locator(".notebook-plot").count(), 0);
    await shot("05-adopted-not-autorun-1440", chart(), ["Four definitions persisted and task settled completed", "Adoption alone did not execute or reuse AI trial as human result"]);
    await realRun(); await shot("06-real-http-chart-1440", chart(), ["All four exact cell IDs succeeded via managed 3001", "East=150, South=80; result revision and rows verified", "Dashboard remains empty; zero snapshots"]);
  });
  await step("Reload and new-tab explicit project open retain adopted definition and same conversation without autorun", async () => {
    const runCount = requests.length, agentCount = agentRuns.length; await saved(); await page.reload({ waitUntil: "networkidle" }); await selectWorkspace(); await mode("Notebook");
    assert.deepEqual(book(await saved()), adoptedDocument); assert.equal(requests.length, runCount); assert.equal(agentRuns.length, agentCount); assert.equal(await chart().locator(".notebook-plot").count(), 0);
    await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 }); await openExistingProject(); await selectWorkspace(); await mode("AI 工作台");
    const reopened = await saved(); assert.deepEqual(book(reopened), adoptedDocument); assert.equal(reopened.state.assistantSessions.activeId, sessionId);
    const session = ownSessions(reopened.state)[0]; assert.equal(session.turns.length, 1); assert.equal(session.turns[0].taskId, agentRuns[0].task.id);
    assert.equal(reopened.state.harnessTasks.find((entry) => entry.id === agentRuns[0].task.id).state, "completed");
    assert.equal(requests.length, runCount); assert.equal(agentRuns.length, agentCount); assert.match(await page.locator(".conversation").innerText(), /检查现有单元/u);
    await shot("07-project-reopened-conversation-1024", page.locator(".conversation-turn").last(), ["Explicit Data Browser open in new tab, exact project handle/path/id checked", "Same conversation and completed adoption retained; no automatic execution"]);
    await mode("Notebook"); assert.equal(await chart().locator(".notebook-plot").count(), 0); await realRun();
  });
  await step("Follow-up uses same conversation and new real trial; second draft not adopted", async () => {
    const second = await sendAgent("followup", followupInstruction);
    assert.equal(second.request.conversation_id, agentRuns[0].request.conversation_id); assert.notEqual(second.task.id, agentRuns[0].task.id);
    assert.deepEqual(book(await saved()), adoptedDocument); await mode("Notebook"); await draft().waitFor(); assert.match(await draft().innerText(), /已通过数据试运行/u);
    await draft().getByText(/查看变更和步骤/u).click(); assert.equal(await draft().getByRole("article").count(), 3);
    assert.equal(second.task.notebookArtifact.cells.length, 7); assert.equal(second.task.notebookArtifact.baseRevision, adoptedDocument.revision);
    await shot("08-followup-draft-1024", draft(), ["Same-conversation follow-up trial computes doubled 300/160", "Only three proposed additions; adopted four-cell document remains unchanged"]);
    await draft().getByRole("button", { name: "暂不采用", exact: true }).click(); await draft().waitFor({ state: "hidden" }); dismissedNow = true;
    const after = await saved(); assert.deepEqual(book(after), adoptedDocument); assert.deepEqual(ownPage(after).root.children, []);
    assert.equal(after.state.harnessTasks.find((task) => task.id === second.task.id).state, "awaitingConfirmation");
    assert.equal(ownSessions(after.state)[0].turns.length, 2); assert.equal(requests.length, 2);
    await chart().getByRole("img", { name: /图表下方提供对应数据表/u }).waitFor();
    await shot("09-dismiss-keeps-original-chart-1024", chart(), ["Temporarily dismisses this window's draft only, not a durable rejection", "Formal four-cell Notebook and existing 150/80 chart remain; dashboard never changed"]);
  });
  finalManifest = await saved(); await resourcesUnchanged(finalManifest);
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(routeErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.equal(agentRuns.length, 2); assert.equal(uiRuns.length, 2); assert.ok(adoptedNow && dismissedNow);
  assert.deepEqual(runner.getStats(), { executions: 2, trials: 2, modelActions: 8, networkAttempts: 0 });
  assert.deepEqual(ownSessions(finalManifest.state)[0].turns.map(({ taskId, instruction }) => ({ taskId, instruction })), agentRuns.map(({ task, request }) => ({ taskId: task.id, instruction: request.instruction })));
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error).replaceAll(process.cwd(), "<workspace>") }; console.error(failure); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  await browser?.close().catch(() => {}); const runnerStats = runner?.getStats(); await runner?.close().catch(() => {});
  if (baseline) try { finalManifest = JSON.parse(await readFile(join(target, manifestName), "utf8")); await resourcesUnchanged(finalManifest); preservationVerified = true; }
  catch (error) { preservationError = String(error); passed = false; process.exitCode = 1; failure ??= { scenario: "final preservation", message: preservationError }; }
  await mkdir(directory, { recursive: true });
  const attemptHistory = [];
  for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(evidenceRoot, entry.name, "report.json");
    try { const prior = JSON.parse(await readFile(path, "utf8")); attemptHistory.push({ report: rel(path), passed: prior.passed, setup: prior.setup, failure: prior.failure, preservation: prior.preservation?.oldResourcesPreserved }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: rel(directory), project: rel(target), pageId, datasetId, dataId, sessionId, checks, screenshots, skips, attemptHistory,
    setup: { importedNow, originalUploadedNow, createdPageNow, createdDataNow, adoptedNow, dismissedNow }, failure,
    requests, uiRuns, agentRequests, agentRuns: agentRuns.map(({ phase, task, trials, request, transport, realModel }) => ({ phase, task, trials, request, transport, realModel })), runnerStats, saves,
    preservation: { baseline: rel(baselinePath), baselineSha, startSha: startBytes && hash(startBytes), oldResourcesPreserved: preservationVerified, preservationError, indexCount: initialIndex?.entries.length,
      prior: startManifest && { revision: startManifest.stateRevision, tables: startManifest.tables.length, files: startManifest.files.length, pages: startManifest.state.appSpec.pages.length },
      final: finalManifest && { revision: finalManifest.stateRevision, tables: finalManifest.tables.length, files: finalManifest.files.length, pages: finalManifest.state.appSpec.pages.length } },
    fixtures: { connections: fixtureConnections, recentProjectList: fixtureRecent, fontCss: fixtureFonts,
      uploadEvidence: importedNow && originalUploadedNow ? "This attempt completed both actual UI upload POSTs; project workspace save is separately verified."
        : "The retained first attempt completed Dataset and original-file UI POSTs (both 201). Its later workspace save was blocked by an overly strict verifier history-source guard. This attempt reuses those exact resources; no API repair or repeated import is claimed.",
      note: `${agentRequests.length} actual Agent browser requests intercepted; ${agentRuns.length} completed fixture receipts. The planned adapter drives an offline scripted Harness with real local SQL/tools and buffered production SSE; counters and completed checks, not this description, determine what ran. Upload, adoption, manual run and project save/open use managed 3001 when reached. Not paid-model quality, public-handler, realtime streaming or process-restart proof.` },
    pageErrors, consoleErrors, routeErrors, forbiddenRequests,
    boundaries: ["One fixed page, one CSV table/original, reuse of the original empty synthetic conversation, two Agent tasks; zero snapshots, new conversations or project registrations.", "Second draft dismissal is current-window UI state, not persistent refusal; task remains awaitingConfirmation.", "Pre-Agent setup reuse is explicitly skipped. Any existing task blocks rerun rather than duplicating tasks or silently claiming a fresh chain."],
    visualReview: { completed: false, note: "Requires actual individual screenshot inspection after execution" } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, report: rel(join(directory, "report.json")), failure }));
}
