// Managed 3001 only. Reuse an explicitly verified synthetic project; never clean old resources.
// Notebook definitions are declared real scoped-API setup; snapshots and dashboard changes use UI.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001", runId = Date.now();
const directory = resolve(".runtime/hex-notebook-dashboard-snapshot-2026-09-21", `browser-${runId}`);
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--reuse-failed-project", "Explicit verified synthetic reuse only");
const projectPath = resolve(args[1]), projectHeader = "x-agentcanvas-project", manifestName = "agentcanvas.project.json";
const workspaceName = `M6 看板快照 ${runId}`, bookName = `快照闭环 Notebook ${runId}`, fileName = `notebook-dashboard-snapshot-${runId}.csv`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = Object.fromEntries(["data", "sql", "table", "chart"].map((kind) => [kind, `snapshot_${kind}_${suffix}`]));
const titles = { data: "快照合成销售源", sql: "快照地区汇总", table: "快照地区表格", chart: "快照地区图表" };
const labels = { data: "Data", sql: "SQL", table: "表格", chart: "图表" };
const doubledSql = "SELECT region, SUM(amount)::DOUBLE * 2 AS revenue FROM sales_data GROUP BY region ORDER BY region";
const duplicateSql = "SELECT region, amount::DOUBLE AS revenue FROM sales_data ORDER BY region, revenue";
const deletionSql = "SELECT 'All' AS region, SUM(amount)::DOUBLE AS revenue FROM sales_data";
const fileSql = "SELECT region, SUM(amount)::DOUBLE AS revenue FROM raw_sales GROUP BY region ORDER BY region";
const syntheticRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const doubledRows = SQL_EXPECTED.map((row) => ({ ...row, revenue: row.revenue * 2 }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [], screenshots = [], consoleErrors = [], pageErrors = [], routeErrors = [], forbiddenRequests = [], apiChecks = [], runs = [], snapshots = [], notebookRequests = [], browserSaves = [], priorFileHashes = [];
const coverage = { baseline: false, tableCancel: false, historicalApply: false, independentSnapshot: false, undo: false, regeneratedApply: false, reopen: false, duplicateFailure: false, editorDraft: false };
let scenario = "preflight", passed = false, failure, browser, context, page, handle, projectId, pageId, datasetId;
let priorManifest, reuseEvidence, baselinePages, tableEntry, originalEntry, expectedBook, directoryReads = 0, recentProjectReads = 0, externalFontFixtures = 0;
let expectedConsoleErrors = [], knownConsoleWarnings = [], unexpectedConsoleErrors = [];
await mkdir(directory, { recursive: true });

async function verifyReuse() {
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actual = await realpath(projectPath), parts = relative(approvedRoot, actual).split(sep);
  assert.ok(parts.length === 2 && /^browser-\d+$/u.test(parts[0]) && parts[1] === "project");
  assert.equal((await lstat(projectPath)).isSymbolicLink(), false);
  for (const folder of ["tables", "files"]) assert.equal(await realpath(join(projectPath, folder)), join(actual, folder));
  const previousReport = join(dirname(actual), "report.json"), previous = JSON.parse(await readFile(previousReport, "utf8"));
  assert.equal(previous.passed, false); assert.equal(resolve(previous.projectPath), actual);
  const bytes = await readFile(join(actual, manifestName)); priorManifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(priorManifest.name, "Python 能力关闭与恢复验收");
  for (const entry of priorManifest.tables) {
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    const name = entry.descriptor.originalFileName;
    const result = entry.kind === "result" && name === "notebook-result.csv";
    assert.ok(result || ["capability-toggle-sales.csv", "project-save-recovery-sales.csv"].includes(name)
      || /^project-save-recovery-\d+\.csv$/u.test(name) || /^project-file-diagnostics-\d+(?:-trash)?\.csv$/u.test(name)
      || /^semantic-model-deletion-\d+\.csv$/u.test(name) || /^(?:file|cell)-deletion-impact-\d+\.csv$/u.test(name)
      || /^notebook-dashboard-snapshot-\d+\.csv$/u.test(name));
    const path = join(actual, "tables", entry.file), stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const payload = await readFile(path); assert.equal(hash(payload), entry.sha256);
    const rows = JSON.parse(payload.toString("utf8")).rows;
    if (result) {
      assert.ok([JSON.stringify(SQL_EXPECTED), JSON.stringify(doubledRows)].includes(JSON.stringify(rows)));
      const provenance = entry.descriptor.provenance; assert.equal(provenance.kind, "notebook");
      assert.match(provenance.cellId, /^snapshot_(?:chart|table)_[a-f0-9]{12}$/u);
      assert.ok(provenance.lineage.steps.every((step) => Object.values(titles).includes(step.title)));
    } else assert.deepEqual(rows, syntheticRows);
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
  for (const notebook of Object.values(priorManifest.state?.dataProduct.notebooks ?? {})) for (const item of notebook.cells) {
    assert.ok(["data", "sql", "semanticQuery", "table", "python", "chart", "text"].includes(item.kind));
    if (item.kind === "sql") assert.ok([CELL_MODULES_SQL, fileSql, deletionSql, doubledSql, duplicateSql].includes(item.sql));
    if (item.kind === "data") assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === item.sourceDataSourceId));
    if (item.kind === "semanticQuery") assert.ok(priorManifest.state.dataProduct.semanticLayer?.models.some((model) => model.id === item.modelId));
    if (item.kind === "table") assert.deepEqual(item.columns, ["region", "revenue"]);
    if (item.kind === "chart") { assert.equal(item.chartType, "bar"); assert.equal(item.categoryField, "region"); assert.deepEqual(item.valueFields, ["revenue"]); }
    if (item.kind === "text") {
      assert.equal(item.markdown, "汇总金额：{{total}}"); assert.equal(item.references.length, 1);
      assert.deepEqual(item.references[0], { key: "total", cellId: item.references[0].cellId, field: "revenue" });
      assert.equal(notebook.cells.find((source) => source.id === item.references[0].cellId)?.sql, deletionSql);
    }
    if (item.kind === "python") {
      assert.equal(item.fileNames.length, 1); assert.match(item.fileNames[0], /^file-deletion-impact-\d+\.csv$/u);
      assert.ok(priorManifest.files.some((entry) => entry.name === item.fileNames[0]));
      assert.equal(item.code, `raw_sales = pd.read_csv(files['${item.fileNames[0]}'])`); assert.equal(item.outputName, "raw_sales"); assert.deepEqual(item.inputCellIds, []);
    }
  }
  assert.ok(priorManifest.tables.length + 6 <= 50, "Do not raise the project table limit or remove old resources");
  await writeFile(join(directory, "prior-manifest.json"), bytes, { flag: "wx" });
  reuseEvidence = { mode: "approved-failed-synthetic-project", path: siteRelative(actual), previousReport: siteRelative(previousReport), previousPassed: false,
    reason: "Registry already contains 100 projects. No registry or old resource changes; only this run's isolated workspace, CSV and snapshots are added.",
    backup: "prior-manifest.json", backupSha256: hash(bytes), priorFileHashes, priorTables: priorManifest.tables.length, priorFiles: priorManifest.files.length,
    priorNotebookPageIds: Object.keys(priorManifest.state.dataProduct.notebooks ?? {}), preserved: false };
}
function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url }); });
}
const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const cell = (kind) => page.getByRole("article", { name: `${labels[kind]}单元 ${titles[kind]}`, exact: true });
const receipt = () => page.getByLabel("Notebook 快照审阅", { exact: true });
const book = (value) => value.state.dataProduct.notebooks[pageId];
const ownPage = (value) => value.state.appSpec.pages.find((item) => item.id === pageId);
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
async function notebookMode() { await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); }
async function dashboardMode() { await page.getByRole("tab", { name: "看板", exact: true }).click(); await dismissNotice(); }
async function run(kind, snapshot = false, expected = SQL_EXPECTED, status = 200) {
  await dismissNotice(); const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  await (kind ? cell(kind).getByRole("button", { name: snapshot ? "生成看板预览 ↗" : "▶ 运行", exact: true }) : page.getByRole("button", { name: "▶ 全部运行", exact: true })).click();
  const response = await pending, result = await response.json(); assert.equal(response.status(), status, JSON.stringify(result.error));
  if (status === 200) {
    assert.equal(result.run.status, "success", JSON.stringify(result.run.cells));
    for (const item of result.run.cells.filter((item) => item.cellId !== ids.data)) assert.deepEqual(item.table.rows, expected);
    runs.push({ scenario, httpStatus: response.status(), run: result.run });
    if (snapshot) {
      assert.deepEqual(result.snapshot.rows, expected); assert.equal(result.snapshot.dataset.provenance.cellId, ids[kind]);
      assert.equal(result.snapshot.dataset.provenance.runId, result.run.runId); assert.equal(result.snapshot.dataset.provenance.revision, expectedBook.revision);
      assert.deepEqual(result.snapshot.dataset.provenance.lineage.sourceDatasetIds, [datasetId]);
      snapshots.push({ scenario, dataset: result.snapshot.dataset, rows: result.snapshot.rows });
    }
  } else { assert.match(result.error.message, /唯一分类/u); assert.equal(result.snapshot, undefined); apiChecks.push({ type: "real-duplicate-category-rejection", status, message: result.error.message }); }
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" }); return result;
}
async function verifyReceipt(result, kind) {
  await receipt().waitFor();
  if (await receipt().locator("details").evaluate((element) => !element.open)) await receipt().getByText("查看快照来源", { exact: true }).click();
  const text = await receipt().innerText();
  assert.ok(text.includes(titles[kind])); assert.ok(text.includes(result.run.runId)); assert.match(text, /2\s*行/u); assert.match(text, /2\s*列/u);
  assert.match(text, /快照/u); await page.getByRole("button", { name: "确认加入看板", exact: true }).waitFor();
}
async function editSql(sql) {
  await notebookMode(); await cell("sql").getByRole("button", { name: "编辑", exact: true }).click();
  await cell("sql").getByLabel("SQL", { exact: true }).fill(sql); await cell("sql").getByRole("button", { name: "保存单元", exact: true }).click();
  expectedBook = { ...expectedBook, revision: expectedBook.revision + 1, cells: expectedBook.cells.map((item) => item.id === ids.sql ? { ...item, sql } : item) };
  const value = await savedManifest((value) => book(value).cells.find((item) => item.id === ids.sql).sql === sql); assert.deepEqual(book(value), expectedBook);
}
async function assertPreserved() {
  const value = await readManifest();
  for (const entry of priorManifest.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of priorManifest.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  for (const [id, definition] of Object.entries(priorManifest.state.dataProduct.notebooks ?? {})) assert.deepEqual(value.state.dataProduct.notebooks[id], definition);
  assert.deepEqual(value.state.dataProduct.semanticLayer, priorManifest.state.dataProduct.semanticLayer);
  for (const oldPage of priorManifest.state.appSpec.pages) assert.deepEqual(value.state.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
  for (const entry of priorFileHashes) assert.equal(hash(await readFile(join(projectPath, entry.folder, entry.file))), entry.sha256);
  if (expectedBook) assert.deepEqual(book(value), expectedBook);
  for (const entry of [tableEntry, originalEntry].filter(Boolean)) {
    const folder = entry === tableEntry ? "tables" : "files"; assert.equal(hash(await readFile(join(projectPath, folder, entry.file))), entry.sha256);
  }
  for (const snapshot of snapshots) {
    const entry = value.tables.find((item) => item.descriptor.datasetId === snapshot.dataset.datasetId); assert.ok(entry && !entry.deletedAt); assert.equal(entry.kind, "result");
    assert.deepEqual(entry.descriptor.provenance, snapshot.dataset.provenance);
    const bytes = await readFile(join(projectPath, "tables", entry.file)); assert.equal(hash(bytes), entry.sha256); assert.deepEqual(JSON.parse(bytes.toString("utf8")).rows, snapshot.rows);
  }
  reuseEvidence.preserved = true; return value;
}
function snapshotNode(value, dataset) { return ownPage(value).root.children.find((node) => node.props?.binding?.dataSourceId === dataset.datasetId); }
function historyWithSnapshot(history, snapshot) {
  return history.map((entry) => ({ ...entry, appSpec: { ...entry.appSpec, dataSources: [...entry.appSpec.dataSources, snapshot.dataset.source] } }));
}

try {
  await verifyReuse(); browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage(); observe(page);
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (url.href === "https://rsms.me/inter/inter.css") {
        assert.equal(request.method(), "GET"); externalFontFixtures++;
        return await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      }
      if (url.origin !== base || url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/connections/")) {
        forbiddenRequests.push(url.origin === base ? url.pathname : url.origin); return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/connections") { assert.equal(request.method(), "GET"); directoryReads++; return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connections: [] }) }); }
      if (url.pathname === "/api/projects" && request.method() === "GET" && !request.headers()[projectHeader]) {
        recentProjectReads++; return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (handle && request.headers()[projectHeader]) assert.equal(request.headers()[projectHeader], handle);
      if (url.pathname === "/api/projects" && request.method() === "POST") {
        const body = request.postDataJSON(); assert.ok(["open", "save"].includes(body.action), "No archive, purge, restore or project creation");
        if (body.action === "open") assert.equal(body.path, projectPath);
        if (body.action === "save") browserSaves.push({ scenario, stateRevision: body.stateRevision, notebookRevision: body.state.dataProduct.notebooks?.[pageId]?.revision });
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.headers()[projectHeader], handle); const body = request.postDataJSON();
        assert.ok(body.document.cells.every((item) => Object.values(ids).includes(item.id) && ["data", "sql", "table", "chart"].includes(item.kind)));
        notebookRequests.push({ scenario, action: body.action, targetCellId: body.targetCellId, revision: body.document.revision });
      }
      await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real synthetic Data to SQL to Table/Chart establishes a blank-dashboard baseline", async () => {
    await openDataBrowser(); await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/u }).click();
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const opening = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
    await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click(); assert.equal((await opening).status(), 200); await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")); projectId = (await savedManifest()).id; assert.equal(projectId, priorManifest.id);
    await dismissNotice(); await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    const menu = page.getByRole("navigation", { name: "工作区功能菜单" }); await menu.getByRole("button", { name: "新建界面", exact: true }).click();
    await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName); await menu.getByRole("button", { name: "创建", exact: true }).click();
    const created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName)); pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
    assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false); reuseEvidence.addedWorkspaceId = pageId;
    await notebookMode(); await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true }); await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploading = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click(); const uploaded = await uploading; assert.equal(uploaded.status(), 201); datasetId = (await uploaded.json()).dataset.datasetId; await upload.waitFor({ state: "hidden" });
    const imported = await savedManifest((value) => value.files.some((entry) => entry.datasetIds.includes(datasetId)));
    tableEntry = imported.tables.find((entry) => entry.descriptor.datasetId === datasetId); originalEntry = imported.files.find((entry) => entry.datasetIds.includes(datasetId)); assert.equal(originalEntry.name, fileName);
    const state = structuredClone(imported.state); state.dataProduct.notebooks = { ...state.dataProduct.notebooks, [pageId]: { name: bookName, revision: 1, cells: [
      { id: ids.data, kind: "data", title: titles.data, sourceDataSourceId: datasetId, outputName: "sales_data" },
      { id: ids.sql, kind: "sql", title: titles.sql, inputCellIds: [ids.data], outputName: "snapshot_totals", sql: CELL_MODULES_SQL },
      { id: ids.table, kind: "table", title: titles.table, inputCellId: ids.sql, columns: ["region", "revenue"] },
      { id: ids.chart, kind: "chart", title: titles.chart, inputCellId: ids.sql, chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    ] } };
    const installed = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base }, data: { action: "save", state, stateRevision: imported.stateRevision } });
    assert.equal(installed.status(), 200, await installed.text()); apiChecks.push({ type: "declared-four-cell-fixture", beforeRevision: imported.stateRevision, afterRevision: (await installed.json()).stateRevision });
    expectedBook = state.dataProduct.notebooks[pageId]; await reopen(); await run(); const baseline = await savedManifest(); baselinePages = structuredClone(baseline.state.appSpec.pages);
    assert.deepEqual(ownPage(baseline).root.children, []); await assertPreserved();
    await shot("01-real-notebook-results-1440", cell("chart"), ["Real SQL/table/chart East=150 South=80", "Formal dashboard is empty; no pre-seeded dashboard node"]); coverage.baseline = true;
  });
  await step("Table snapshot receipt is real but cancellation leaves formal dashboard untouched", async () => {
    const before = await savedManifest(), result = await run("table", true); await verifyReceipt(result, "table");
    const preview = await savedManifest((value) => value.tables.length === before.tables.length + 1); assert.deepEqual(preview.state.appSpec.pages, baselinePages);
    assert.deepEqual(preview.state.changeHistory, historyWithSnapshot(before.state.changeHistory, result.snapshot));
    await shot("02-table-preview-unconfirmed-1440", receipt(), ["Receipt shows actual cell, run ID, revision and 2 by 2 result", "Preview renders table but formal nodes and undo history remain unchanged"]);
    await editSql(doubledSql); await dashboardMode(); await verifyReceipt(result, "table");
    assert.match(await receipt().innerText(), /历史版本/u);
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot("02b-historical-preview-before-cancel-1024", receipt(), ["Pending table preview remains fixed after an actual Notebook SQL edit", "Historical-version warning advises cancelling and regenerating"]);
    await page.getByRole("button", { name: "取消预览", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
    const cancelled = await savedManifest((value) => value.state.auditRecords.some((record) => record.status === "cancelled" && !before.state.auditRecords.some((old) => old.id === record.id)));
    assert.deepEqual(cancelled.state.appSpec.pages, baselinePages); assert.deepEqual(cancelled.state.changeHistory, preview.state.changeHistory); assert.equal(cancelled.tables.length, preview.tables.length); await assertPreserved();
    apiChecks.push({ type: "cancelled-historical-preview", stateRevision: cancelled.stateRevision, resultId: result.snapshot.dataset.datasetId, formalPagesUnchanged: true,
      audit: cancelled.state.auditRecords.filter((record) => record.status === "cancelled" && !before.state.auditRecords.some((old) => old.id === record.id)) });
    await shot("03-cancelled-preview-keeps-snapshot-1024", page.locator(".canvas-toolbar"), ["Cancelled historical preview disappears; dashboard stays empty", "Stored result remains intact with provenance and no history entry"]);
    await editSql(CELL_MODULES_SQL); coverage.tableCancel = true;
  });
  await step("Changing Notebook preserves an explicit historical preview and confirmation uses its fixed source", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await notebookMode(); await run(); const result = await run("chart", true); await verifyReceipt(result, "chart");
    await editSql(doubledSql); await dashboardMode(); await verifyReceipt(result, "chart"); assert.match(await receipt().innerText(), /历史|已变化|不同/u);
    const before = await savedManifest(); assert.deepEqual(before.state.appSpec.pages, baselinePages);
    await shot("04-historical-snapshot-review-1440", receipt(), ["Notebook is revision 4; receipt remains revision 3 and explains the historical snapshot", "Source rows are still East=150 South=80, not the changed computation"]);
    await page.getByRole("button", { name: "确认加入看板", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
    const applied = await savedManifest((value) => Boolean(snapshotNode(value, result.snapshot.dataset))); const node = snapshotNode(applied, result.snapshot.dataset);
    assert.equal(node.type, "BarChart"); assert.equal(node.props.binding.dataSourceId, result.snapshot.dataset.datasetId); assert.equal(applied.state.changeHistory.length, before.state.changeHistory.length + 1);
    assert.ok(applied.state.auditRecords.some((record) => record.status === "applied" && record.changeSetId === applied.state.appliedChangeSetIds.at(-1)));
    apiChecks.push({ type: "confirmed-historical-preview", beforeRevision: before.stateRevision, afterRevision: applied.stateRevision,
      sourceRevision: result.run.revision, currentNotebookRevision: book(applied).revision, changeSetId: applied.state.appliedChangeSetIds.at(-1), node });
    await assertPreserved(); await shot("05-confirmed-historical-chart-1440", page.locator(".canvas-area .chart-card"), ["Explicit confirmation adds a chart bound to the selected historical snapshot", "Notebook revision 4 remains saved unchanged"]); coverage.historicalApply = true;
  });
  await step("New Notebook execution does not mutate the saved snapshot chart", async () => {
    const before = await savedManifest(); await notebookMode(); await run(undefined, false, doubledRows); await dashboardMode();
    const after = await savedManifest(); assert.deepEqual(after.state.appSpec.pages, before.state.appSpec.pages); await assertPreserved();
    assert.match(await page.locator(".canvas-area .chart-card").innerText(), /150/u); assert.match(await page.locator(".canvas-area .chart-card").innerText(), /80/u);
    await page.setViewportSize({ width: 1024, height: 900 }); await shot("06-new-run-old-snapshot-1024", page.locator(".canvas-area .chart-card"), ["Notebook latest SQL returns 300/160, while the saved chart still displays 150/80", "Chart binding and snapshot bytes did not change"]); coverage.independentSnapshot = true;
  });
  await step("Undo removes only the applied dashboard change and retains Notebook and snapshot data", async () => {
    const before = await savedManifest(); await page.locator(".canvas-toolbar").getByRole("button", { name: "↶", exact: true }).click();
    const after = await savedManifest((value) => JSON.stringify(value.state.appSpec.pages) === JSON.stringify(baselinePages));
    assert.equal(after.state.changeHistory.length, before.state.changeHistory.length - 1); assert.deepEqual(after.tables, before.tables); assert.deepEqual(book(after), book(before));
    assert.ok(after.state.auditRecords.some((record) => record.status === "undone" && record.changeSetId === before.state.appliedChangeSetIds.at(-1))); await assertPreserved();
    apiChecks.push({ type: "undo-preserves-result-data-and-notebook", beforeRevision: before.stateRevision, afterRevision: after.stateRevision,
      changeSetId: before.state.appliedChangeSetIds.at(-1), snapshotsRetained: snapshots.map((snapshot) => snapshot.dataset.datasetId), notebookRevision: book(after).revision });
    await shot("07-undo-keeps-source-and-definitions-1024", page.locator(".canvas-toolbar"), ["Undo restores the empty dashboard only", "The revised Notebook, both result tables and their provenance remain saved"]); coverage.undo = true;
  });
  await step("Regenerated chart and table snapshots can both be explicitly confirmed", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await notebookMode(); await run(undefined, false, doubledRows);
    const chart = await run("chart", true, doubledRows); await verifyReceipt(chart, "chart"); assert.doesNotMatch(await receipt().innerText(), /历史定义/u);
    await page.getByRole("button", { name: "确认加入看板", exact: true }).click(); await receipt().waitFor({ state: "hidden" }); await savedManifest((value) => Boolean(snapshotNode(value, chart.snapshot.dataset)));
    await notebookMode(); await run(undefined, false, doubledRows); const table = await run("table", true, doubledRows); await verifyReceipt(table, "table");
    await shot("08-current-table-snapshot-review-1440", receipt(), ["New table snapshot provenance records revision 4", "The already-confirmed new chart remains visible alongside the not-yet-applied table preview"]);
    await page.getByRole("button", { name: "确认加入看板", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
    const applied = await savedManifest((value) => Boolean(snapshotNode(value, table.snapshot.dataset))); assert.equal(ownPage(applied).root.children.length, 2);
    assert.equal(snapshotNode(applied, chart.snapshot.dataset).type, "BarChart"); assert.equal(snapshotNode(applied, table.snapshot.dataset).type, "DataTable");
    assert.deepEqual(snapshotNode(applied, table.snapshot.dataset).props.binding.columns.map((column) => column.field), table.snapshot.dataset.source.fields.map((field) => field.name));
    apiChecks.push({ type: "confirmed-current-chart-and-table", stateRevision: applied.stateRevision, notebookRevision: book(applied).revision,
      nodes: ownPage(applied).root.children, changeHistoryCount: applied.state.changeHistory.length });
    await assertPreserved(); await shot("09-confirmed-chart-and-table-1440", page.locator(".canvas-toolbar"), ["Actual latest results now have separate confirmed chart/table snapshot bindings", "All two table fields are preserved"]); coverage.regeneratedApply = true;
  });
  await step("A new tab reopens definitions, snapshot provenance and dashboard without automatic execution", async () => {
    const before = await savedManifest(), requestCount = notebookRequests.length; await reopen(); await page.setViewportSize({ width: 1024, height: 900 });
    const after = await savedManifest(); assert.deepEqual(after.state, before.state); assert.equal(notebookRequests.length, requestCount);
    assert.equal(await page.locator(".notebook-result").count(), 0); await assertPreserved();
    await shot("10-reopened-notebook-no-run-cache-1024", cell("data"), ["Four exact saved definitions remain; transient run results were not persisted", "Reopen does not send any Notebook execution request"]);
    await dashboardMode(); assert.equal(await page.locator(".canvas-area .chart-card").count(), 1); assert.match(await page.locator(".canvas-area").innerText(), /300/u); assert.match(await page.locator(".canvas-area").innerText(), /160/u);
    assert.equal(notebookRequests.length, requestCount); apiChecks.push({ type: "new-tab-reopen", stateRevision: after.stateRevision, exactStatePreserved: true, notebookRequestsBefore: requestCount, notebookRequestsAfter: notebookRequests.length });
    await shot("11-reopened-persistent-dashboard-1024", page.locator(".canvas-toolbar"), ["Saved chart/table render 300/160 from local snapshot data", "No model or external database required"]); coverage.reopen = true;
  });
  await step("Real duplicate categories reject preview without creating a partial result or changing the dashboard", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await editSql(duplicateSql);
    await run(undefined, false, [{ region: "East", revenue: 50 }, { region: "East", revenue: 100 }, { region: "South", revenue: 80 }]);
    const before = await savedManifest(); await run("chart", true, undefined, 400); await cell("chart").waitFor();
    await page.getByText(/看板图表需要唯一分类/u).waitFor(); assert.equal(await receipt().count(), 0);
    const after = await savedManifest(); assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.state.appSpec, before.state.appSpec); assert.deepEqual(after.state.changeHistory, before.state.changeHistory);
    apiChecks.push({ type: "rejected-snapshot-did-not-persist", beforeRevision: before.stateRevision, afterRevision: after.stateRevision, beforeTables: before.tables.length, afterTables: after.tables.length, dashboardAndHistoryUnchanged: true });
    await assertPreserved(); await shot("12-real-duplicate-category-refusal-1440", page.getByText(/看板图表需要唯一分类/u), ["Actual snapshot API returns 400 for duplicate East categories", "No new result table, preview, formal node or undo entry was created"]);
    await editSql(doubledSql); await dashboardMode(); await savedManifest(); await assertPreserved(); coverage.duplicateFailure = true;
  });
  await step("An unapplied Puck draft survives Notebook snapshot preview and cancellation", async () => {
    const before = await savedManifest(), draftTitle = `未应用的快照图表标题 ${runId}`;
    await page.locator(".canvas-mode-switch").getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator(".puck-editor-shell iframe").waitFor();
    await page.frame({ name: "preview-frame" }).getByText(titles.chart, { exact: true }).click();
    const titleField = () => page.locator('.puck-editor-shell input[id$="_text_title"]:visible');
    await titleField().fill(draftTitle); await titleField().blur();
    await page.frame({ name: "preview-frame" }).getByText(draftTitle, { exact: true }).waitFor();
    assert.deepEqual((await savedManifest()).state.appSpec.pages, before.state.appSpec.pages);
    await shot("13-puck-title-is-unapplied-draft-1440", titleField(), ["Actual Puck chart-title field and preview show the edited title", "Formal dashboard still contains the original title"]);
    await notebookMode(); await run(undefined, false, doubledRows); const result = await run("chart", true, doubledRows); await verifyReceipt(result, "chart");
    assert.equal(await page.getByRole("button", { name: "取消预览", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "继续编辑", exact: true }).count(), 0);
    const preview = await savedManifest((value) => value.tables.length === before.tables.length + 1); assert.deepEqual(preview.state.appSpec.pages, before.state.appSpec.pages);
    await shot("14-snapshot-cancel-label-with-existing-draft-1440", receipt(), ["Notebook snapshot clearly offers Cancel preview even when an unrelated editor draft exists", "No existing draft or formal node is silently applied"]);
    await page.getByRole("button", { name: "取消预览", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
    await page.locator(".puck-editor-shell iframe").waitFor(); await page.frame({ name: "preview-frame" }).getByText(draftTitle, { exact: true }).waitFor();
    await page.frame({ name: "preview-frame" }).getByText(draftTitle, { exact: true }).click(); assert.equal(await titleField().inputValue(), draftTitle);
    const after = await savedManifest(); assert.deepEqual(after.state.appSpec.pages, before.state.appSpec.pages); assert.deepEqual(after.state.changeHistory, preview.state.changeHistory);
    await assertPreserved(); apiChecks.push({ type: "puck-draft-retained-on-notebook-preview-cancel", draftTitle, formalTitle: titles.chart,
      beforeRevision: before.stateRevision, afterRevision: after.stateRevision, sourceDatasetId: result.snapshot.dataset.datasetId, formalPagesUnchanged: true });
    await shot("15-cancel-restores-existing-editor-draft-1440", titleField(), ["Cancellation returns to the actual editor with its unsaved title still present", "Original saved dashboard and Notebook definitions remain unchanged; result data is retained"]); coverage.editorDraft = true;
  });
  expectedConsoleErrors = consoleErrors.filter((item) => /Real duplicate categories/u.test(item.scenario) && item.url === `${base}/api/notebook/run` && /400/u.test(item.text));
  knownConsoleWarnings = consoleErrors.filter((item) => item.scenario === "An unapplied Puck draft survives Notebook snapshot preview and cancellation"
    && item.text === "`NaN` is an invalid value for the `%s` css style property. top"
    && item.url.startsWith(`${base}/node_modules/.vite/deps/react-dom_client.js`));
  unexpectedConsoleErrors = consoleErrors.filter((item) => !expectedConsoleErrors.includes(item) && !knownConsoleWarnings.includes(item));
  assert.equal(expectedConsoleErrors.length, 1); assert.ok(knownConsoleWarnings.length <= 1); assert.deepEqual(unexpectedConsoleErrors, []);
  assert.equal(pageErrors.length, 0); assert.equal(routeErrors.length, 0); assert.equal(forbiddenRequests.length, 0);
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).then(() => screenshots.push({ file: "failure.png", scenario, viewport: page.viewportSize(), assertions: ["Failure evidence, not passed acceptance"] })).catch(() => {});
} finally {
  if (handle && priorManifest) { try { await assertPreserved(); } catch (error) { passed = false; failure ??= { scenario: "final-preservation-check", message: String(error) }; } }
  await browser?.close(); const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(dirname(directory), entry.name, "report.json");
    try { const old = JSON.parse(await readFile(path, "utf8")); attemptHistory.push({ report: siteRelative(path), passed: old.passed, failure: old.failure, preserved: old.reuseEvidence?.preserved }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: siteRelative(directory), projectPath: siteRelative(projectPath), handle, projectId, pageId, datasetId, ids, workspaceName, bookName, fileName,
    coverage, checks, screenshots, failure, attemptHistory, reuseEvidence, apiChecks, runs, snapshots, notebookRequests, browserSaves, expectedFinalNotebook: expectedBook,
    fixtures: { directoryReads, recentProjectReads, externalFontFixtures, description: "Connection and unscoped recent-project GET directories use empty fixtures. Exact Puck external font CSS URL uses empty CSS to prevent network access. Workspace/import/edit/snapshot/cancel/confirm/undo use UI. Four cell definitions use a declared real scoped API save. No run/save/read result is replaced." },
    consoleErrors, expectedConsoleErrors, knownConsoleWarnings, unexpectedConsoleErrors, pageErrors, routeErrors, forbiddenRequests,
    knownIssueEvidence: "Puck CSS top NaN warning independently reproduced by editing and switching to Notebook without any snapshot/run request: .runtime/hex-notebook-dashboard-snapshot-2026-09-21/puck-baseline-warning.json. This is retained, not reported as zero console errors.",
    scope: { data: "Old synthetic resources are preserved. Added only own workspace, CSV source and five persistent result snapshots. Cancel/undo never deletes snapshot data. Puck title edit remains an unapplied, in-memory draft.",
      external: "No model or external database; no service change or new registry entry. Reopen means new tab in the same isolated browser context.",
      limits: "This flow does not browser-test over-30-column rejection, cross-window conflicts, viewer permissions or physical Python uninstall." },
    visualReview: { completed: false, note: "Inspect every screenshot with view_image after running." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(directory, "report.json")), checks: checks.length, screenshots: screenshots.length }));
}
if (!passed) process.exitCode = 1;
