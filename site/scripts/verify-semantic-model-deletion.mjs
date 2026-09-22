// Existing managed 3001 only. Adds isolated synthetic resources; preserves every old resource.
// The rejected save is a real API request, not an injected browser error.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001", runId = Date.now();
const directory = resolve(".runtime/hex-semantic-model-deletion-2026-09-21", `browser-${runId}`);
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--reuse-failed-project", "Pass the explicitly approved failed synthetic project; do not create another registry entry");
const projectPath = resolve(args[1]), projectHeader = "x-agentcanvas-project", manifestName = "agentcanvas.project.json";
const workspaceName = `M6 模型删除 ${runId}`, modelName = `M6 删除保护模型 ${runId}`, bookName = `删除保护 Notebook ${runId}`;
const fileName = `semantic-model-deletion-${runId}.csv`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = { model: `semantic_delete_${suffix}`, data: `delete_data_${suffix}`, semantic: `delete_semantic_${suffix}`, table: `delete_table_${suffix}`, metric: `delete_metric_${suffix}` };
const titles = { data: "删除保护合成销售源", semantic: "地区销售语义汇总", table: "语义汇总下游表格" };
const syntheticRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [], screenshots = [], consoleErrors = [], pageErrors = [], routeErrors = [], forbiddenRequests = [], apiChecks = [], runs = [], dialogs = [];
const priorFileHashes = [], browserSaves = [];
const coverage = { realQueryAndUiProtection: false, realServerProtection: false, explicitRemovalAndCancellation: false, reopen: false };
let scenario = "preflight", passed = false, failure, browser, context, page, handle, projectId, pageId, datasetId;
let priorManifest, reuseEvidence, tableEntry, originalEntry, ownModel, baseline, directoryReads = 0, recentProjectReads = 0;

await mkdir(directory, { recursive: true });
async function verifyReuse() {
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actual = await realpath(projectPath), parts = relative(approvedRoot, actual).split(sep);
  assert.ok(parts.length === 2 && /^browser-\d+$/u.test(parts[0]) && parts[1] === "project", "Only the approved failed synthetic subtree may be reused");
  assert.equal((await lstat(projectPath)).isSymbolicLink(), false);
  for (const folder of ["tables", "files"]) assert.equal(await realpath(join(projectPath, folder)), join(actual, folder));
  const previousReport = join(dirname(actual), "report.json"), previous = JSON.parse(await readFile(previousReport, "utf8"));
  assert.equal(previous.passed, false); assert.equal(resolve(previous.projectPath), actual);
  const bytes = await readFile(join(actual, manifestName)); priorManifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(priorManifest.name, "Python 能力关闭与恢复验收");
  for (const entry of priorManifest.tables) {
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    assert.ok(["capability-toggle-sales.csv", "project-save-recovery-sales.csv"].includes(entry.descriptor.originalFileName)
      || /^project-save-recovery-\d+\.csv$/u.test(entry.descriptor.originalFileName)
      || /^project-file-diagnostics-\d+(?:-trash)?\.csv$/u.test(entry.descriptor.originalFileName)
      || /^semantic-model-deletion-\d+\.csv$/u.test(entry.descriptor.originalFileName));
    const path = join(actual, "tables", entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const payload = await readFile(path); assert.equal(hash(payload), entry.sha256);
    assert.deepEqual(JSON.parse(payload.toString("utf8")).rows, syntheticRows);
    priorFileHashes.push({ folder: "tables", file: entry.file, sha256: entry.sha256 });
  }
  for (const entry of priorManifest.files) {
    assert.match(entry.file, /^file-[a-f0-9-]{36}\.csv$/u);
    const path = join(actual, "files", entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const payload = await readFile(path); assert.equal(payload.toString("utf8"), CELL_MODULES_CSV); assert.equal(hash(payload), entry.sha256);
    priorFileHashes.push({ folder: "files", file: entry.file, sha256: entry.sha256 });
  }
  for (const model of priorManifest.state?.dataProduct.semanticLayer?.models ?? []) {
    assert.match(model.name, /^M6 删除保护模型 \d+$/u);
    assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === model.sourceDatasetId));
    assert.deepEqual(model.dimensions, [{ key: "region", label: "地区", field: "region", description: "合成地区" }]);
    assert.deepEqual(model.measures, [{ key: "revenue", label: "销售额", field: "amount", aggregation: "sum", description: "合成金额求和" }]);
  }
  for (const book of Object.values(priorManifest.state?.dataProduct.notebooks ?? {})) {
    for (const cell of book.cells) {
      assert.ok(["data", "sql", "semanticQuery", "table"].includes(cell.kind), "Only proven synthetic notebook kinds may be reused");
      if (cell.kind === "sql") assert.equal(cell.sql, CELL_MODULES_SQL);
      if (cell.kind === "data") assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === cell.sourceDataSourceId));
      if (cell.kind === "semanticQuery") assert.ok(priorManifest.state.dataProduct.semanticLayer?.models.some((model) => model.id === cell.modelId));
      if (cell.kind === "table") assert.deepEqual(cell.columns, ["region", "revenue"]);
    }
  }
  await writeFile(join(directory, "prior-manifest.json"), bytes, { flag: "wx" });
  reuseEvidence = { mode: "approved-failed-synthetic-project", path: siteRelative(actual), previousReport: siteRelative(previousReport), previousPassed: false,
    reason: "The existing recent-project index reached 100 entries. No entries, limits or old resources are changed; one new workspace and synthetic resources are added.",
    backup: "prior-manifest.json", backupSha256: hash(bytes), priorFileHashes,
    priorTableIds: priorManifest.tables.map((entry) => entry.descriptor.datasetId), priorFileIds: priorManifest.files.map((entry) => entry.id),
    priorNotebookPageIds: Object.keys(priorManifest.state?.dataProduct.notebooks ?? {}), priorModelIds: (priorManifest.state?.dataProduct.semanticLayer?.models ?? []).map((model) => model.id), preserved: false };
}
function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url }); });
}
const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const manager = () => page.getByRole("dialog", { name: "语义模型管理", exact: true });
const cell = (kind) => page.getByRole("article", { name: `${{ data: "Data", semantic: "语义查询", table: "表格" }[kind]}单元 ${titles[kind]}`, exact: true });
const book = (manifest) => manifest.state.dataProduct.notebooks[pageId];
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide desktop overflow");
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, viewport: page.viewportSize(), assertions });
}
async function dismissNotice() {
  const button = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true });
  if (await button.isVisible()) await button.click();
}
async function openDataBrowser() {
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click(); await dataBrowser().waitFor();
}
async function openManager() {
  await dismissNotice(); await openDataBrowser();
  await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /语义模型/u }).click();
  await dataBrowser().locator(".project-model-grid").getByRole("button").filter({ hasText: modelName }).click();
  await manager().waitFor();
}
async function readManifest() {
  assert.ok(handle);
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text());
  const session = await response.json(); assert.equal(session.handle, handle); assert.equal(resolve(session.path), projectPath);
  if (projectId) assert.equal(session.manifest.id, projectId); return session.manifest;
}
async function savedManifest(predicate = (value) => Boolean(value.state)) {
  const deadline = Date.now() + 20_000; let lastRevision, stableSince = 0;
  while (Date.now() < deadline) {
    const value = await readManifest(), label = await page.locator(".top-actions").textContent();
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(label ?? "")) {
      if (lastRevision !== value.stateRevision) { lastRevision = value.stateRevision; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 650) return value;
    } else { stableSince = 0; lastRevision = undefined; }
    await sleep(100);
  }
  throw new Error("Synthetic project did not reach a stable saved state");
}
async function reopen() {
  await page.close(); page = await context.newPage(); observe(page);
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByLabel("切换工作界面", { exact: true }).click();
  await page.getByRole("menu", { name: "工作界面列表", exact: true }).getByRole("menuitem").filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
  await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); await cell("data").waitFor();
}
async function confirmModelDeletion(accept) {
  const pending = page.waitForEvent("dialog");
  const click = manager().getByRole("button", { name: "删除模型", exact: true }).click();
  const dialog = await pending; assert.equal(dialog.type(), "confirm"); assert.ok(dialog.message().includes(modelName));
  dialogs.push({ scenario, action: accept ? "accept" : "dismiss", message: dialog.message() });
  if (accept) await dialog.accept(); else await dialog.dismiss(); await click;
}
async function assertPreserved() {
  const value = await readManifest();
  for (const entry of priorManifest.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of priorManifest.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  for (const [id, definition] of Object.entries(priorManifest.state.dataProduct.notebooks ?? {})) assert.deepEqual(value.state.dataProduct.notebooks[id], definition);
  for (const model of priorManifest.state.dataProduct.semanticLayer?.models ?? []) assert.deepEqual(value.state.dataProduct.semanticLayer.models.find((item) => item.id === model.id), model);
  for (const [id, modelId] of Object.entries(priorManifest.state.dataProduct.semanticLayer?.selectedByWorkspace ?? {})) assert.equal(value.state.dataProduct.semanticLayer.selectedByWorkspace[id], modelId);
  for (const oldPage of priorManifest.state.appSpec.pages) assert.deepEqual(value.state.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
  for (const entry of priorFileHashes) assert.equal(hash(await readFile(join(projectPath, entry.folder, entry.file))), entry.sha256);
  if (baseline) {
    assert.deepEqual(value.tables, baseline.tables); assert.deepEqual(value.files, baseline.files);
    assert.deepEqual(value.state.appSpec, baseline.state.appSpec); assert.deepEqual(value.state.changeHistory, baseline.state.changeHistory);
    assert.deepEqual(value.state.dataProduct.datasets, baseline.state.dataProduct.datasets); assert.deepEqual(value.state.dataProduct.recipes, baseline.state.dataProduct.recipes);
    assert.equal(hash(await readFile(join(projectPath, "tables", tableEntry.file))), tableEntry.sha256);
    assert.equal(hash(await readFile(join(projectPath, "files", originalEntry.file))), originalEntry.sha256);
    const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { [projectHeader]: handle } });
    assert.equal(response.status(), 200); assert.deepEqual((await response.json()).rows, syntheticRows);
  }
  reuseEvidence.preserved = true;
}

try {
  await verifyReuse();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage(); observe(page);
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base || url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/connections/")) {
        forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/connections") {
        assert.equal(request.method(), "GET"); directoryReads++;
        return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connections: [] }) });
      }
      if (url.pathname === "/api/projects" && request.method() === "GET" && !request.headers()[projectHeader]) {
        recentProjectReads++;
        return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (handle && request.headers()[projectHeader]) assert.equal(request.headers()[projectHeader], handle);
      if (url.pathname === "/api/projects" && request.method() === "POST") {
        const body = request.postDataJSON(); assert.notEqual(body.action, "create", "No new project registry entries");
        if (body.action === "open") assert.equal(body.path, projectPath);
        if (body.action === "save") browserSaves.push({ scenario, stateRevision: body.stateRevision });
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.headers()[projectHeader], handle);
        assert.ok(request.postDataJSON().document.cells.every((item) => ["data", "semanticQuery", "table"].includes(item.kind)));
      }
      await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real semantic query and referenced-model deletion protection", async () => {
    await openDataBrowser();
    await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/u }).click();
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const opening = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
    await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click();
    // Opening replaces the workspace; Chromium may discard a successful response body.
    // The subsequent scoped GET verifies the complete session and manifest.
    const opened = await opening; assert.equal(opened.status(), 200); await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1"));
    projectId = (await savedManifest()).id; assert.equal(projectId, priorManifest.id); await dismissNotice();
    await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
    await menu.getByRole("button", { name: "新建界面", exact: true }).click(); await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName);
    await menu.getByRole("button", { name: "创建", exact: true }).click();
    const created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName));
    pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
    assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false);
    Object.assign(reuseEvidence, { addedWorkspaceId: pageId, addedWorkspaceName: workspaceName });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploading = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click();
    const uploaded = await uploading; assert.equal(uploaded.status(), 201); datasetId = (await uploaded.json()).dataset.datasetId;
    await upload.waitFor({ state: "hidden" });
    const imported = await savedManifest((value) => value.files.some((entry) => entry.datasetIds.includes(datasetId)));
    assert.equal(priorManifest.tables.some((entry) => entry.descriptor.datasetId === datasetId), false);
    tableEntry = imported.tables.find((entry) => entry.descriptor.datasetId === datasetId);
    originalEntry = imported.files.find((entry) => entry.datasetIds.includes(datasetId));
    ownModel = { id: ids.model, version: 1, name: modelName, description: "本轮独立合成模型", sourceDatasetId: datasetId,
      dimensions: [{ key: "region", label: "地区", field: "region", description: "合成地区" }],
      measures: [{ key: "revenue", label: "销售额", field: "amount", aggregation: "sum", description: "合成金额求和" }] };
    const state = structuredClone(imported.state);
    state.dataProduct.semanticLayer = { models: [...(state.dataProduct.semanticLayer?.models ?? []), ownModel],
      selectedByWorkspace: { ...state.dataProduct.semanticLayer?.selectedByWorkspace, [pageId]: ids.model } };
    state.dataProduct.notebooks = { ...state.dataProduct.notebooks, [pageId]: { name: bookName, revision: 1, cells: [
      { id: ids.data, kind: "data", title: titles.data, sourceDataSourceId: datasetId, outputName: "sales_data" },
      { id: ids.semantic, kind: "semanticQuery", title: titles.semantic, inputCellId: ids.data, modelId: ids.model, modelVersion: 1,
        dimensions: ["region"], measures: ["revenue"], limit: 100, outputName: "sales_totals" },
      { id: ids.table, kind: "table", title: titles.table, inputCellId: ids.semantic, columns: ["region", "revenue"] },
    ] } };
    const ownPage = state.appSpec.pages.find((item) => item.id === pageId);
    ownPage.root.children = [...(ownPage.root.children ?? []), { id: ids.metric, type: "MetricCard", props: { label: "合成销售总额", trend: "",
      binding: { dataSourceId: datasetId, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" } } } }];
    state.dataProduct.appSpec = state.appSpec;
    const installed = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base },
      data: { action: "save", state, stateRevision: imported.stateRevision } });
    assert.equal(installed.status(), 200, await installed.text());
    apiChecks.push({ type: "synthetic-definition-fixture", source: "real-API-save", beforeRevision: imported.stateRevision, afterRevision: (await installed.json()).stateRevision });
    await reopen(); baseline = await savedManifest();
    assert.deepEqual(baseline.state.dataProduct.semanticLayer.models.find((item) => item.id === ids.model), ownModel);
    const running = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45_000 });
    await cell("table").getByRole("button", { name: "▶ 运行", exact: true }).click();
    const response = await running, result = await response.json(); assert.equal(response.status(), 200, JSON.stringify(result.error));
    assert.equal(result.run.status, "success", JSON.stringify(result.run.cells));
    assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.semantic).table.rows, SQL_EXPECTED);
    assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.table).table.rows, SQL_EXPECTED);
    await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" }); runs.push(result.run);
    await shot("01-real-semantic-query-1440", cell("semantic"), ["Real Data→semanticQuery→table execution returns East=150 / South=80", "The model, Notebook and direct-source dashboard were installed using a real scoped API save"]);
    await openManager(); assert.equal(await manager().getByRole("button", { name: "删除模型", exact: true }).isDisabled(), true);
    await manager().getByText(bookName, { exact: false }).waitFor(); await manager().getByText(titles.semantic, { exact: false }).waitFor();
    await manager().getByText(ids.semantic, { exact: false }).waitFor();
    await shot("02-referenced-model-blocked-1440", manager(), ["The impact list identifies the Notebook and semantic-query cell title/ID", "Delete is disabled before confirmation; no model or source is removed"]);
    await assertPreserved(); coverage.realQueryAndUiProtection = true;
  });
  await step("Independent real save cannot remove a model while retaining its Notebook reference", async () => {
    const before = await savedManifest(), bytes = await readFile(join(projectPath, manifestName)), state = structuredClone(before.state);
    state.dataProduct.semanticLayer.models = state.dataProduct.semanticLayer.models.filter((item) => item.id !== ids.model);
    state.dataProduct.semanticLayer.selectedByWorkspace = Object.fromEntries(Object.entries(state.dataProduct.semanticLayer.selectedByWorkspace).filter(([, id]) => id !== ids.model));
    const response = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base }, data: { action: "save", state, stateRevision: before.stateRevision } });
    assert.equal(response.status(), 409); const body = await response.json(); assert.match(body.error.message, /引用|Notebook|语义/u);
    assert.deepEqual(await readManifest(), before); assert.deepEqual(await readFile(join(projectPath, manifestName)), bytes);
    apiChecks.push({ type: "referenced-model-delete-rejected", status: 409, message: body.error.message, source: "real-independent-API-request",
      beforeRevision: before.stateRevision, afterRevision: before.stateRevision, manifestSha256: hash(bytes), exactManifestUnchanged: true });
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await manager().getByRole("button", { name: "删除模型", exact: true }).isDisabled(), true);
    await shot("03-model-retained-after-real-api-409-1024", manager(), ["The independent API returned a real 409 and left exact manifest bytes unchanged", "Screenshot shows the unchanged UI reference blocker, not an API-error UI or injected response"]);
    await assertPreserved(); coverage.realServerProtection = true;
  });
  await step("Explicit Notebook deletion preserves its cancellation; unreferenced model deletion confirms separately", async () => {
    await manager().getByRole("button", { name: "关闭语义模型管理", exact: true }).click(); await manager().waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const beforeCells = await savedManifest(); await cell("semantic").getByRole("button", { name: "删除", exact: true }).click();
    const prompt = cell("semantic").getByRole("alert"); await prompt.getByText(/1 个依赖它的下游单元/u).waitFor();
    await shot("04-notebook-dependency-delete-confirmation-1440", prompt, ["Existing Notebook confirmation explicitly includes the one downstream table", "The first attempt is cancelled via 保留; the model cannot bypass this dependency flow"]);
    await prompt.getByRole("button", { name: "保留", exact: true }).click(); assert.deepEqual(book(await readManifest()), book(beforeCells));
    await cell("semantic").getByRole("button", { name: "删除", exact: true }).click();
    await cell("semantic").getByRole("button", { name: "确认删除 2 个单元", exact: true }).click();
    const afterCells = await savedManifest((value) => book(value).cells.length === 1);
    assert.deepEqual(book(afterCells).cells, [book(beforeCells).cells.find((item) => item.id === ids.data)]);
    assert.ok(afterCells.state.dataProduct.semanticLayer.models.some((item) => item.id === ids.model)); await assertPreserved();
    await openManager(); assert.equal(await manager().getByRole("button", { name: "删除模型", exact: true }).isEnabled(), true);
    const beforeCancel = await savedManifest(), saveCount = browserSaves.length;
    await confirmModelDeletion(false); assert.equal(await manager().isVisible(), true); assert.equal(browserSaves.length, saveCount);
    assert.deepEqual(await readManifest(), beforeCancel);
    await shot("05-unreferenced-model-delete-cancelled-1440", manager(), ["The actual model-deletion confirmation was dismissed", "Model, selection, remaining Data cell, source table and dashboard remain unchanged"]);
    await confirmModelDeletion(true); await manager().waitFor({ state: "hidden" });
    const removed = await savedManifest((value) => !value.state.dataProduct.semanticLayer.models.some((item) => item.id === ids.model));
    assert.equal(removed.state.dataProduct.semanticLayer.selectedByWorkspace[pageId], undefined);
    assert.deepEqual(book(removed), book(afterCells)); await assertPreserved();
    await page.setViewportSize({ width: 1024, height: 900 }); await cell("data").waitFor();
    await shot("06-model-deleted-source-retained-1024", cell("data"), ["Explicitly confirmed model deletion clears only the model and its selection", "The source Data cell, table/original bytes, dashboard and history remain unchanged"]);
    coverage.explicitRemovalAndCancellation = true;
  });
  await step("Closed-tab reopen keeps the deleted model absent and the original dashboard/data intact", async () => {
    const before = await savedManifest(); await reopen(); await page.setViewportSize({ width: 1024, height: 900 });
    const after = await savedManifest(); assert.deepEqual(after.state, before.state);
    assert.equal(after.state.dataProduct.semanticLayer.models.some((item) => item.id === ids.model), false);
    assert.deepEqual(book(after).cells.map((item) => item.id), [ids.data]); await assertPreserved();
    await page.getByRole("tab", { name: "看板", exact: true }).click();
    await page.getByText("合成销售总额", { exact: true }).waitFor(); await page.getByText("230", { exact: true }).waitFor();
    await shot("07-reopened-dashboard-and-data-retained-1024", page.getByText("合成销售总额", { exact: true }), ["A newly opened tab restores the exact post-deletion project state", "The direct-source dashboard still renders 230; model remains absent and source data/old resources are unchanged"]);
    coverage.reopen = true;
  });
  assert.equal(consoleErrors.length, 0); assert.equal(pageErrors.length, 0); assert.equal(routeErrors.length, 0); assert.equal(forbiddenRequests.length, 0);
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).then(() => {
    screenshots.push({ file: "failure.png", scenario, viewport: page.viewportSize(), assertions: ["Actual failed attempt, not successful acceptance"] });
  }).catch(() => {});
} finally {
  if (handle && priorManifest) {
    try { await assertPreserved(); } catch (error) { passed = false; failure ??= { scenario: "final-preservation-check", message: String(error) }; }
  }
  await browser?.close();
  const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(dirname(directory), entry.name, "report.json");
    try { const old = JSON.parse(await readFile(path, "utf8")); attemptHistory.push({ report: siteRelative(path), passed: old.passed, failure: old.failure, preserved: old.reuseEvidence?.preserved }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: siteRelative(directory), projectPath: siteRelative(projectPath), handle, projectId, pageId, datasetId, ids,
    workspaceName, modelName, bookName, coverage, checks, screenshots, failure, attemptHistory, reuseEvidence, apiChecks, runs, dialogs, browserSaves,
    fixtures: { directoryReads, recentProjectReads, description: "Only connection and unscoped recent-project GET listings are empty fixtures. Scoped save, upload, query and reopen APIs are real. Model/Notebook/dashboard setup uses a real API save of declared synthetic definitions; it does not verify the model-creation UI." },
    consoleErrors, pageErrors, routeErrors, forbiddenRequests,
    unverifiedBrowserBranches: ["Pending AI draft reintroduction after model deletion is not exercised by this browser script; no historical Harness artifact was created or mutated."],
    visualReview: { completed: false, note: "Open every actual screenshot with view_image after execution." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(directory, "report.json")), checks: checks.length, screenshots: screenshots.length }));
}
if (!passed) process.exitCode = 1;
