// Only the existing managed 3001. Never clear registry entries or touch old synthetic resources.
// Cell definitions and a direct-source dashboard are declared real-API setup fixtures.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001", runId = Date.now();
const directory = resolve(".runtime/hex-cell-deletion-impact-2026-09-21", `browser-${runId}`);
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--reuse-failed-project", "Explicit approved synthetic reuse only; no new registry entry");
const projectPath = resolve(args[1]), projectHeader = "x-agentcanvas-project", manifestName = "agentcanvas.project.json";
const workspaceName = `M6 步骤删除 ${runId}`, bookName = `步骤删除 Notebook ${runId}`, fileName = `cell-deletion-impact-${runId}.csv`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = Object.fromEntries(["data", "sql", "table", "chart", "text", "independent", "metric"].map((kind) => [kind, `cell_delete_${kind}_${suffix}`]));
const titles = { data: "保留的项目销售源", sql: "待删销售总额", table: "下游总额表格", chart: "下游总额图表", text: "下游总额说明", independent: "独立地区汇总" };
const labels = { data: "Data", sql: "SQL", table: "表格", chart: "图表", text: "说明", independent: "SQL" };
const editedDataTitle = "保留的项目销售源（已核对）";
const deletionSql = "SELECT 'All' AS region, SUM(amount)::DOUBLE AS revenue FROM sales_data";
const fileSql = "SELECT region, SUM(amount)::DOUBLE AS revenue FROM raw_sales GROUP BY region ORDER BY region";
const pythonCode = (name) => `raw_sales = pd.read_csv(files['${name}'])`;
const syntheticRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const totalRows = [{ region: "All", revenue: 230 }];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [], screenshots = [], consoleErrors = [], pageErrors = [], routeErrors = [], forbiddenRequests = [], apiChecks = [], runs = [], notebookRequests = [], browserSaves = [], priorFileHashes = [];
const coverage = { baseline: false, reviewAndCancel: false, staleReview: false, explicitDeletion: false, independentBranch: false, reopen: false };
let scenario = "preflight", passed = false, failure, browser, context, page, handle, projectId, pageId, datasetId;
let priorManifest, reuseEvidence, tableEntry, originalEntry, baseline, expectedBook, directoryReads = 0, recentProjectReads = 0, currentDataTitle = titles.data;
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
      || /^semantic-model-deletion-\d+\.csv$/u.test(entry.descriptor.originalFileName)
      || /^(?:file|cell)-deletion-impact-\d+\.csv$/u.test(entry.descriptor.originalFileName));
    const path = join(actual, "tables", entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const payload = await readFile(path); assert.equal(hash(payload), entry.sha256); assert.deepEqual(JSON.parse(payload.toString("utf8")).rows, syntheticRows);
    priorFileHashes.push({ folder: "tables", file: entry.file, sha256: entry.sha256 });
  }
  for (const entry of priorManifest.files) {
    assert.match(entry.file, /^file-[a-f0-9-]{36}\.csv$/u);
    const path = join(actual, "files", entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const payload = await readFile(path); assert.equal(payload.toString("utf8"), CELL_MODULES_CSV); assert.equal(hash(payload), entry.sha256);
    priorFileHashes.push({ folder: "files", file: entry.file, sha256: entry.sha256 });
  }
  for (const model of priorManifest.state?.dataProduct.semanticLayer?.models ?? []) {
    assert.match(model.name, /^M6 删除保护模型 \d+$/u); assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === model.sourceDatasetId));
    assert.deepEqual(model.dimensions, [{ key: "region", label: "地区", field: "region", description: "合成地区" }]);
    assert.deepEqual(model.measures, [{ key: "revenue", label: "销售额", field: "amount", aggregation: "sum", description: "合成金额求和" }]);
  }
  for (const previousBook of Object.values(priorManifest.state?.dataProduct.notebooks ?? {})) {
    for (const item of previousBook.cells) {
      assert.ok(["data", "sql", "semanticQuery", "table", "python", "chart", "text"].includes(item.kind));
      if (item.kind === "sql") assert.ok([CELL_MODULES_SQL, fileSql, deletionSql].includes(item.sql));
      if (item.kind === "data") assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === item.sourceDataSourceId));
      if (item.kind === "semanticQuery") assert.ok(priorManifest.state.dataProduct.semanticLayer?.models.some((model) => model.id === item.modelId));
      if (item.kind === "table") assert.deepEqual(item.columns, ["region", "revenue"]);
      if (item.kind === "chart") { assert.equal(item.chartType, "bar"); assert.equal(item.categoryField, "region"); assert.deepEqual(item.valueFields, ["revenue"]); }
      if (item.kind === "text") {
        assert.equal(item.markdown, "汇总金额：{{total}}"); assert.equal(item.references.length, 1);
        assert.deepEqual(item.references[0], { key: "total", cellId: item.references[0].cellId, field: "revenue" });
        assert.equal(previousBook.cells.find((source) => source.id === item.references[0].cellId)?.sql, deletionSql);
      }
      if (item.kind === "python") {
        assert.equal(item.fileNames.length, 1); assert.match(item.fileNames[0], /^file-deletion-impact-\d+\.csv$/u);
        assert.ok(priorManifest.files.some((entry) => entry.name === item.fileNames[0]));
        assert.equal(item.code, pythonCode(item.fileNames[0])); assert.equal(item.outputName, "raw_sales"); assert.deepEqual(item.inputCellIds, []);
      }
    }
  }
  await writeFile(join(directory, "prior-manifest.json"), bytes, { flag: "wx" });
  reuseEvidence = { mode: "approved-failed-synthetic-project", path: siteRelative(actual), previousReport: siteRelative(previousReport), previousPassed: false,
    reason: "The recent-project registry reached 100 entries. No entries/limits or old resources are changed; this run adds only its own workspace and CSV-backed definitions.",
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
const cell = (kind) => page.getByRole("article", { name: `${labels[kind]}单元 ${kind === "data" ? currentDataTitle : titles[kind]}`, exact: true });
const review = () => page.getByRole("alert", { name: "确认删除分析步骤", exact: true });
const book = (manifest) => manifest.state.dataProduct.notebooks[pageId];
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide overflow");
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
async function readManifest() {
  assert.ok(handle); const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text()); const session = await response.json();
  assert.equal(session.handle, handle); assert.equal(resolve(session.path), projectPath);
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
  await page.close(); page = await context.newPage(); observe(page); await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByLabel("切换工作界面", { exact: true }).click();
  await page.getByRole("menu", { name: "工作界面列表", exact: true }).getByRole("menuitem").filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
  await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); await cell("data").waitFor();
}
async function run(all = false) {
  await dismissNotice(); const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  if (all) await page.getByRole("button", { name: "▶ 全部运行", exact: true }).click();
  else await cell("independent").getByRole("button", { name: "▶ 运行", exact: true }).click();
  const response = await pending, result = await response.json(); assert.equal(response.status(), 200, JSON.stringify(result.error));
  assert.equal(result.run.status, "success", JSON.stringify(result.run.cells));
  assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.independent).table.rows, SQL_EXPECTED);
  if (all) {
    assert.equal(result.run.cells.length, 6);
    for (const kind of ["sql", "table", "chart"]) assert.deepEqual(result.run.cells.find((item) => item.cellId === ids[kind]).table.rows, totalRows);
    assert.equal(result.run.cells.find((item) => item.cellId === ids.text).text, "汇总金额：230");
  } else assert.deepEqual(result.run.cells.map((item) => item.cellId), [ids.data, ids.independent]);
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  runs.push({ scenario, httpStatus: response.status(), run: result.run }); return result.run;
}
async function assertReview(stale = false) {
  await review().waitFor();
  assert.equal(await review().getByRole("listitem").count(), 4);
  for (const kind of ["sql", "table", "chart", "text"]) {
    await review().getByText(titles[kind], { exact: true }).waitFor();
    await review().getByText(ids[kind], { exact: false }).waitFor();
    await review().getByText(`${labels[kind]} · ${kind === "sql" ? "当前单元" : "直接下游"}`, { exact: true }).waitFor();
  }
  assert.equal((await review().innerText()).includes(ids.data), false);
  assert.equal((await review().innerText()).includes(ids.independent), false);
  await review().getByText("deletion_totals", { exact: false }).waitFor();
  const confirm = review().getByRole("button", { name: "确认删除 4 个单元", exact: true });
  assert.equal(await confirm.isDisabled(), stale);
  if (stale) await review().getByText(/文档已变化/u).waitFor();
}
async function assertPreserved() {
  const value = await readManifest();
  for (const entry of priorManifest.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of priorManifest.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  for (const [id, definition] of Object.entries(priorManifest.state.dataProduct.notebooks ?? {})) assert.deepEqual(value.state.dataProduct.notebooks[id], definition);
  assert.deepEqual(value.state.dataProduct.semanticLayer, priorManifest.state.dataProduct.semanticLayer);
  for (const oldPage of priorManifest.state.appSpec.pages) assert.deepEqual(value.state.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
  for (const entry of priorFileHashes) assert.equal(hash(await readFile(join(projectPath, entry.folder, entry.file))), entry.sha256);
  if (baseline) {
    assert.deepEqual(value.tables, baseline.tables); assert.deepEqual(value.files, baseline.files);
    assert.deepEqual(value.state.appSpec, baseline.state.appSpec); assert.deepEqual(value.state.changeHistory, baseline.state.changeHistory);
    assert.deepEqual(value.state.dataProduct, { ...baseline.state.dataProduct, notebooks: { ...baseline.state.dataProduct.notebooks, [pageId]: expectedBook } });
    assert.equal(hash(await readFile(join(projectPath, "tables", tableEntry.file))), tableEntry.sha256);
    assert.equal(hash(await readFile(join(projectPath, "files", originalEntry.file))), originalEntry.sha256);
    const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { [projectHeader]: handle } });
    assert.equal(response.status(), 200); assert.deepEqual((await response.json()).rows, syntheticRows);
  }
  reuseEvidence.preserved = true;
}

try {
  await verifyReuse(); browser = await chromium.launch({ channel: "msedge", headless: true });
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
        recentProjectReads++; return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (handle && request.headers()[projectHeader]) assert.equal(request.headers()[projectHeader], handle);
      if (url.pathname === "/api/projects" && request.method() === "POST") {
        const body = request.postDataJSON(); assert.ok(["open", "save"].includes(body.action), "No original/table archive, purge or new project is allowed");
        if (body.action === "open") assert.equal(body.path, projectPath);
        if (body.action === "save") browserSaves.push({ scenario, stateRevision: body.stateRevision, notebookRevision: body.state.dataProduct.notebooks?.[pageId]?.revision });
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.headers()[projectHeader], handle); assert.match(request.headers()["content-type"], /^application\/json/u);
        const body = request.postDataJSON(); assert.ok(body.document.cells.every((item) => Object.values(ids).includes(item.id) && ["data", "sql", "table", "chart", "text"].includes(item.kind)));
        notebookRequests.push({ scenario, targetCellId: body.targetCellId, action: body.action });
      }
      await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real six-cell DAG and saved direct-source dashboard form the deletion baseline", async () => {
    await openDataBrowser();
    await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/u }).click();
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
    await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click(); assert.equal((await pending).status(), 200); await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")); projectId = (await savedManifest()).id; assert.equal(projectId, priorManifest.id);
    await dismissNotice(); await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    const menu = page.getByRole("navigation", { name: "工作区功能菜单" }); await menu.getByRole("button", { name: "新建界面", exact: true }).click();
    await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName); await menu.getByRole("button", { name: "创建", exact: true }).click();
    const created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName)); pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
    assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false); Object.assign(reuseEvidence, { addedWorkspaceId: pageId, addedWorkspaceName: workspaceName });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploading = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click(); const uploaded = await uploading;
    assert.equal(uploaded.status(), 201); datasetId = (await uploaded.json()).dataset.datasetId; await upload.waitFor({ state: "hidden" });
    const imported = await savedManifest((value) => value.files.some((entry) => entry.datasetIds.includes(datasetId)));
    assert.equal(priorManifest.tables.some((entry) => entry.descriptor.datasetId === datasetId), false);
    tableEntry = imported.tables.find((entry) => entry.descriptor.datasetId === datasetId); originalEntry = imported.files.find((entry) => entry.datasetIds.includes(datasetId));
    assert.equal(originalEntry.name, fileName); assert.equal(priorManifest.files.some((entry) => entry.id === originalEntry.id), false);
    const state = structuredClone(imported.state); state.dataProduct.notebooks = { ...state.dataProduct.notebooks, [pageId]: { name: bookName, revision: 1, cells: [
      { id: ids.data, kind: "data", title: titles.data, sourceDataSourceId: datasetId, outputName: "sales_data" },
      { id: ids.sql, kind: "sql", title: titles.sql, inputCellIds: [ids.data], outputName: "deletion_totals", sql: deletionSql },
      { id: ids.table, kind: "table", title: titles.table, inputCellId: ids.sql, columns: ["region", "revenue"] },
      { id: ids.chart, kind: "chart", title: titles.chart, inputCellId: ids.sql, chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
      { id: ids.text, kind: "text", title: titles.text, markdown: "汇总金额：{{total}}", references: [{ key: "total", cellId: ids.sql, field: "revenue" }] },
      { id: ids.independent, kind: "sql", title: titles.independent, inputCellIds: [ids.data], outputName: "sales_totals", sql: CELL_MODULES_SQL },
    ] } };
    const ownPage = state.appSpec.pages.find((item) => item.id === pageId);
    ownPage.root.children = [...(ownPage.root.children ?? []), { id: ids.metric, type: "MetricCard", props: { label: "步骤删除后保留的总额", trend: "",
      binding: { dataSourceId: datasetId, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" } } } }];
    state.dataProduct.appSpec = state.appSpec;
    const installed = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base }, data: { action: "save", state, stateRevision: imported.stateRevision } });
    assert.equal(installed.status(), 200, await installed.text());
    apiChecks.push({ type: "synthetic-definitions-fixture", source: "real-scoped-API-save", beforeRevision: imported.stateRevision, afterRevision: (await installed.json()).stateRevision });
    await reopen(); await run(true); baseline = await savedManifest(); expectedBook = book(baseline); await assertPreserved();
    await shot("01-real-table-chart-text-baseline-1440", cell("text"), ["Six real cells succeed: SQL/table/chart All=230, dynamic text 230 and independent regions 150/80", "Definitions and direct-source MetricCard are declared real API setup, not a snapshot workflow"]);
    coverage.baseline = true;
  });
  await step("Deletion review lists exactly four cells and Keep leaves the manifest unchanged", async () => {
    const before = await savedManifest(), saveCount = browserSaves.length;
    await cell("sql").getByRole("button", { name: "删除", exact: true }).click(); await assertReview();
    await shot("02-four-cell-review-1440", review(), ["The selected SQL and exact Table/Chart/Text titles, types and IDs are listed", "Upstream Data and independent SQL are outside the deletion list"]);
    await review().getByRole("button", { name: "保留", exact: true }).click(); await review().waitFor({ state: "hidden" });
    assert.equal(browserSaves.length, saveCount); assert.deepEqual(await readManifest(), before); await assertPreserved();
    await cell("sql").getByRole("button", { name: "删除", exact: true }).click(); await assertReview();
    await cell("data").getByRole("button", { name: "编辑", exact: true }).click();
    assert.equal(await review().getByRole("button", { name: "确认删除 4 个单元", exact: true }).isDisabled(), true);
    for (const button of await page.locator("button[data-delete-cell-id]").all()) assert.equal(await button.isDisabled(), true);
    await review().getByRole("button", { name: "保留", exact: true }).click(); await review().waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.matches(".notebook-cells") === true);
    await cell("data").getByRole("button", { name: "取消编辑", exact: true }).click();
    assert.equal(browserSaves.length, saveCount); assert.deepEqual(await readManifest(), before); await assertPreserved();
    apiChecks.push({ type: "keep-during-edit-focus-fallback", focused: ".notebook-cells", allDeleteButtonsDisabled: true, confirmationDisabled: true, stateRevision: before.stateRevision, manifestUnchanged: true });
    await shot("03-keep-cancels-without-write-1440", cell("sql"), ["Keep closes the review without a save, revision change or deleted cell"]);
    coverage.reviewAndCancel = true;
  });
  await step("A real upstream title edit makes an already-open deletion review stale", async () => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await cell("sql").getByRole("button", { name: "删除", exact: true }).click(); await assertReview();
    const before = await savedManifest(); await cell("data").getByRole("button", { name: "编辑", exact: true }).click();
    await cell("data").getByLabel("单元名称", { exact: true }).fill(editedDataTitle);
    await cell("data").getByRole("button", { name: "保存单元", exact: true }).click(); currentDataTitle = editedDataTitle;
    const expected = { ...book(before), revision: book(before).revision + 1, cells: book(before).cells.map((item) => item.id === ids.data ? { ...item, title: editedDataTitle } : item) };
    const edited = await savedManifest((value) => book(value).cells[0].title === editedDataTitle);
    assert.deepEqual(book(edited), expected); expectedBook = expected; await assertReview(true);
    const saveCount = browserSaves.length; await sleep(500); assert.equal(browserSaves.length, saveCount); assert.deepEqual(await readManifest(), edited);
    await assertPreserved(); apiChecks.push({ type: "stale-review-real-UI-edit", beforeRevision: before.stateRevision, afterRevision: edited.stateRevision, confirmationDisabled: true, deletedCells: 0 });
    await shot("04-stale-review-disabled-1024", review(), ["Saving an actual Data title edit invalidates the open review", "Document changed warning is visible and old confirm is disabled; no deletion/save was triggered"]);
    coverage.staleReview = true;
  });
  await step("Fresh explicit confirmation removes only the four reviewed cells", async () => {
    await review().getByRole("button", { name: "关闭过期审阅", exact: true }).click(); await review().waitFor({ state: "hidden" });
    await cell("sql").getByRole("button", { name: "删除", exact: true }).click(); await assertReview();
    await shot("05-fresh-review-ready-1024", review(), ["Closing the stale review and opening a new one restores explicit confirmation", "The refreshed list still contains exactly four intended cells"]);
    const before = await savedManifest();
    const expected = { ...book(before), revision: book(before).revision + 1, cells: book(before).cells.filter((item) => [ids.data, ids.independent].includes(item.id)) };
    await review().getByRole("button", { name: "确认删除 4 个单元", exact: true }).click(); await review().waitFor({ state: "hidden" });
    const deleted = await savedManifest((value) => book(value).cells.length === 2); assert.deepEqual(book(deleted), expected); expectedBook = expected;
    for (const kind of ["sql", "table", "chart", "text"]) assert.equal(await cell(kind).count(), 0);
    await assertPreserved(); apiChecks.push({ type: "confirmed-cell-deletion", beforeRevision: before.stateRevision, afterRevision: deleted.stateRevision, removedCellIds: [ids.sql, ids.table, ids.chart, ids.text], remainingCellIds: [ids.data, ids.independent] });
    await shot("06-only-independent-branch-remains-1024", cell("data"), ["Only the intended SQL/Table/Chart/Text definitions are gone", "Edited upstream Data and independent SQL remain; table, original and dashboard definitions are unchanged"]);
    coverage.explicitDeletion = true;
  });
  await step("The retained independent Data to SQL branch still runs on original bytes", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await run(); await savedManifest(); await assertPreserved();
    await shot("07-independent-sql-still-succeeds-1440", cell("independent"), ["Real post-deletion Data→SQL returns East=150 / South=80", "No table/original archive or delete API was called"]);
    coverage.independentBranch = true;
  });
  await step("Closed-tab reopen preserves deletion, surviving definitions and saved dashboard", async () => {
    const before = await savedManifest(); await reopen(); await page.setViewportSize({ width: 1024, height: 900 });
    const after = await savedManifest(); assert.deepEqual(after.state, before.state); assert.deepEqual(book(after), expectedBook);
    for (const kind of ["sql", "table", "chart", "text"]) assert.equal(await cell(kind).count(), 0);
    for (const kind of ["data", "independent"]) assert.equal(await cell(kind).locator(".notebook-result").count(), 0);
    await assertPreserved();
    await shot("08-reopened-definitions-retained-1024", cell("data"), ["Fresh tab has the exact saved two-cell Notebook and edited Data title", "Deleted definitions do not reappear and transient result tables are not restored"]);
    await page.getByRole("tab", { name: "看板", exact: true }).click(); await page.getByText("步骤删除后保留的总额", { exact: true }).waitFor(); await page.getByText("230", { exact: true }).waitFor();
    await shot("09-reopened-saved-dashboard-1024", page.getByText("步骤删除后保留的总额", { exact: true }), ["Previously saved direct-source MetricCard still renders 230", "All prior resources plus this run's table/original IDs and bytes remain unchanged"]);
    coverage.reopen = true;
  });
  assert.equal(notebookRequests.length, 2); assert.equal(consoleErrors.length, 0); assert.equal(pageErrors.length, 0); assert.equal(routeErrors.length, 0); assert.equal(forbiddenRequests.length, 0);
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).then(() => {
    screenshots.push({ file: "failure.png", scenario, viewport: page.viewportSize(), assertions: ["Actual failure evidence; not a passed acceptance screenshot"] });
  }).catch(() => {});
} finally {
  if (handle && priorManifest) {
    try { await assertPreserved(); } catch (error) { passed = false; failure ??= { scenario: "final-preservation-check", message: String(error) }; }
  }
  await browser?.close(); const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(dirname(directory), entry.name, "report.json");
    try { const old = JSON.parse(await readFile(path, "utf8")); attemptHistory.push({ report: siteRelative(path), passed: old.passed, failure: old.failure, preserved: old.reuseEvidence?.preserved }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: siteRelative(directory), projectPath: siteRelative(projectPath), handle, projectId, pageId, datasetId, ids, workspaceName, bookName, fileName,
    coverage, checks, screenshots, failure, attemptHistory, reuseEvidence, apiChecks, runs, notebookRequests, browserSaves,
    fixtures: { directoryReads, recentProjectReads, description: "Only connection and unscoped recent-project GET directories use empty fixtures. New workspace/import/edit/delete use UI; six cells and the direct-source MetricCard are explicit real scoped-API setup. Save/read/run responses are never replaced." },
    consoleErrors, pageErrors, routeErrors, forbiddenRequests,
    scope: { confirmation: "Only current explicit ID dependencies; no free-code parsing, cross-page dependencies, custom unknown cells or historical AI artifacts.",
      data: "Only this run's four Cell definitions are explicitly deleted. No table, original, saved dashboard, registry entry or old resource is deleted. No Cell recycle-bin or undo is claimed.",
      external: "No model, external database, service reconfiguration or complete dashboard snapshot workflow." },
    visualReview: { completed: false, note: "Actually inspect all screenshots with view_image after execution." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(directory, "report.json")), checks: checks.length, screenshots: screenshots.length }));
}
if (!passed) process.exitCode = 1;
