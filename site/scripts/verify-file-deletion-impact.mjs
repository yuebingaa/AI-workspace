// Existing managed 3001 only. All writes are limited to this run's synthetic resources.
// Python reads a real project original through JSON requests, never multipart fixtures.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001", runId = Date.now();
const directory = resolve(".runtime/hex-file-deletion-impact-2026-09-21", `browser-${runId}`);
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--reuse-failed-project", "Pass the explicitly approved failed synthetic project; never clear or expand the recent-project registry");
const projectPath = resolve(args[1]), projectHeader = "x-agentcanvas-project", manifestName = "agentcanvas.project.json";
const workspaceName = `M6 原件删除 ${runId}`, bookName = `原件风险 Notebook ${runId}`, fileName = `file-deletion-impact-${runId}.csv`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = { python: `file_python_${suffix}`, fileSql: `file_query_${suffix}`, data: `file_data_${suffix}`, dataSql: `data_query_${suffix}` };
const titles = { python: "按原件名称读取销售", fileSql: "原件 Python 下游汇总", data: "独立项目销售表", dataSql: "独立数据表 SQL 汇总" };
const fileSql = "SELECT region, SUM(amount)::DOUBLE AS revenue FROM raw_sales GROUP BY region ORDER BY region";
const pythonCode = (name) => `raw_sales = pd.read_csv(files['${name}'])`;
const syntheticRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [], screenshots = [], consoleErrors = [], pageErrors = [], routeErrors = [], forbiddenRequests = [], apiChecks = [], runs = [], notebookRequests = [], mutations = [];
const priorFileHashes = [], cleanupErrors = [];
const coverage = { realProjectPython: false, sidebarReviewAndCancel: false, dataBrowserReviewAndArchive: false, missingOriginalAndIndependentData: false, restoredSameFile: false };
let scenario = "preflight", passed = false, failure, browser, context, page, handle, projectId, pageId, datasetId;
let priorManifest, reuseEvidence, tableEntry, originalEntry, baseline, directoryReads = 0, recentProjectReads = 0, cleanupRestored = false;
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
      || /^file-deletion-impact-\d+\.csv$/u.test(entry.descriptor.originalFileName));
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
      assert.ok(["data", "sql", "semanticQuery", "table", "python"].includes(item.kind));
      if (item.kind === "sql") assert.ok([CELL_MODULES_SQL, fileSql].includes(item.sql));
      if (item.kind === "data") assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === item.sourceDataSourceId));
      if (item.kind === "semanticQuery") assert.ok(priorManifest.state.dataProduct.semanticLayer?.models.some((model) => model.id === item.modelId));
      if (item.kind === "table") assert.deepEqual(item.columns, ["region", "revenue"]);
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
const deleteDialog = () => page.getByRole("alertdialog", { name: "删除文件", exact: true });
const filePanel = () => page.getByRole("complementary", { name: "原始文件面板", exact: true });
const cell = (kind) => page.getByRole("article", { name: `${{ python: "Python", fileSql: "SQL", data: "Data", dataSql: "SQL" }[kind]}单元 ${titles[kind]}`, exact: true });
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
async function closeDataBrowser() { await dataBrowser().getByRole("button", { name: "关闭数据浏览器", exact: true }).click(); await dataBrowser().waitFor({ state: "hidden" }); }
async function category(name) { await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name }).click(); }
async function readManifest() {
  assert.ok(handle); const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text()); const session = await response.json();
  assert.equal(session.handle, handle); assert.equal(resolve(session.path), projectPath); if (projectId) assert.equal(session.manifest.id, projectId); return session.manifest;
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
  await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); await cell("python").waitFor();
}
async function run(kind, success) {
  await dismissNotice(); const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  await cell(kind).getByRole("button", { name: "▶ 运行", exact: true }).click(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result.error));
  assert.equal(result.run.status, success ? "success" : "failure", JSON.stringify(result.run.cells));
  if (success) assert.deepEqual(result.run.cells.find((item) => item.cellId === ids[kind]).table.rows, SQL_EXPECTED);
  else {
    assert.equal(kind, "fileSql"); const failed = result.run.cells.find((item) => item.cellId === ids.python);
    assert.equal(failed.status, "failure"); assert.ok(failed.error.includes(fileName)); assert.match(failed.error, /当前不可用|缺失/u);
    assert.equal(result.run.cells.find((item) => item.cellId === ids.fileSql).status, "blocked");
  }
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  runs.push({ scenario, httpStatus: response.status(), run: result.run }); return result.run;
}
async function assertRiskReview() {
  await deleteDialog().waitFor(); await deleteDialog().getByText(bookName, { exact: false }).waitFor();
  await deleteDialog().getByText(titles.python, { exact: false }).waitFor(); await deleteDialog().getByText(ids.python, { exact: false }).waitFor();
  const checkbox = deleteDialog().getByRole("checkbox", { name: /已了解/u }); assert.equal(await checkbox.isChecked(), false);
  assert.equal(await deleteDialog().getByRole("button", { name: "删除", exact: true }).isDisabled(), true);
  assert.match(await deleteDialog().innerText(), /下游/u); return checkbox;
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
    assert.deepEqual(value.tables, baseline.tables); assert.deepEqual(book(value), book(baseline));
    assert.deepEqual(value.state.appSpec, baseline.state.appSpec); assert.deepEqual(value.state.changeHistory, baseline.state.changeHistory);
    assert.deepEqual(value.state.dataProduct, baseline.state.dataProduct);
    const live = { ...value.files.find((entry) => entry.id === originalEntry.id) }; delete live.deletedAt;
    assert.deepEqual(live, originalEntry);
    assert.equal(hash(await readFile(join(projectPath, "tables", tableEntry.file))), tableEntry.sha256);
    assert.equal(hash(await readFile(join(projectPath, "files", originalEntry.file))), originalEntry.sha256);
    const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { [projectHeader]: handle } });
    assert.equal(response.status(), 200); assert.deepEqual((await response.json()).rows, syntheticRows);
  }
  reuseEvidence.preserved = true;
}
function mutationResponse(action) {
  return (response) => response.url() === `${base}/api/projects` && response.request().method() === "POST"
    && response.request().postDataJSON()?.action === action && response.request().postDataJSON()?.fileId === originalEntry.id;
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
        const body = request.postDataJSON(); assert.notEqual(body.action, "create");
        if (body.action === "open") assert.equal(body.path, projectPath);
        if (["archiveFile", "restoreFile"].includes(body.action)) {
          assert.equal(body.fileId, originalEntry.id); assert.equal(priorManifest.files.some((entry) => entry.id === body.fileId), false);
          mutations.push({ scenario, action: body.action, fileId: body.fileId });
        }
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.headers()[projectHeader], handle); assert.match(request.headers()["content-type"], /^application\/json/u);
        const body = request.postDataJSON(); assert.ok(body.document.cells.every((item) => ["data", "python", "sql"].includes(item.kind)));
        const python = body.document.cells.find((item) => item.kind === "python"); assert.equal(python.code, pythonCode(fileName)); assert.deepEqual(python.fileNames, [fileName]);
        notebookRequests.push({ scenario, contentType: request.headers()["content-type"], targetCellId: body.targetCellId, action: body.action });
      }
      await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real JSON Notebook reads this run's project original and computes matching totals", async () => {
    await openDataBrowser(); await category(/项目文件夹/u); await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
    await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click(); assert.equal((await pending).status(), 200); await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")); projectId = (await savedManifest()).id; assert.equal(projectId, priorManifest.id);
    await dismissNotice(); await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    const menu = page.getByRole("navigation", { name: "工作区功能菜单" }); await menu.getByRole("button", { name: "新建界面", exact: true }).click();
    await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName); await menu.getByRole("button", { name: "创建", exact: true }).click();
    const created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName)); pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
    assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false); Object.assign(reuseEvidence, { addedWorkspaceId: pageId, addedWorkspaceName: workspaceName });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true }); await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploading = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click(); const uploaded = await uploading; assert.equal(uploaded.status(), 201); datasetId = (await uploaded.json()).dataset.datasetId;
    await upload.waitFor({ state: "hidden" }); const imported = await savedManifest((value) => value.files.some((entry) => entry.datasetIds.includes(datasetId)));
    assert.equal(priorManifest.tables.some((entry) => entry.descriptor.datasetId === datasetId), false);
    tableEntry = imported.tables.find((entry) => entry.descriptor.datasetId === datasetId); originalEntry = imported.files.find((entry) => entry.datasetIds.includes(datasetId));
    assert.equal(originalEntry.name, fileName); assert.equal(priorManifest.files.some((entry) => entry.id === originalEntry.id), false);
    const state = structuredClone(imported.state); state.dataProduct.notebooks = { ...state.dataProduct.notebooks, [pageId]: { name: bookName, revision: 1, cells: [
      { id: ids.python, kind: "python", title: titles.python, inputCellIds: [], fileNames: [fileName], outputName: "raw_sales", code: pythonCode(fileName) },
      { id: ids.fileSql, kind: "sql", title: titles.fileSql, inputCellIds: [ids.python], outputName: "file_totals", sql: fileSql },
      { id: ids.data, kind: "data", title: titles.data, sourceDataSourceId: datasetId, outputName: "sales_data" },
      { id: ids.dataSql, kind: "sql", title: titles.dataSql, inputCellIds: [ids.data], outputName: "sales_totals", sql: CELL_MODULES_SQL },
    ] } };
    const installed = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base }, data: { action: "save", state, stateRevision: imported.stateRevision } });
    assert.equal(installed.status(), 200, await installed.text()); apiChecks.push({ type: "synthetic-notebook-fixture", source: "real-API-save", beforeRevision: imported.stateRevision, afterRevision: (await installed.json()).stateRevision });
    await reopen(); const result = await run("fileSql", true);
    assert.deepEqual(result.cells.find((item) => item.cellId === ids.fileSql).resultRef.sourceFiles, [{ name: fileName, sha256: originalEntry.sha256 }]);
    baseline = await savedManifest(); await assertPreserved();
    await shot("01-project-original-python-success-1440", cell("fileSql"), ["Real JSON request resolves the project CSV; no multipart or model request", "Python→SQL totals are East=150 / South=80, with the original file SHA in the receipt"]); coverage.realProjectPython = true;
  });
  await step("File sidebar requires explicit risk acknowledgement and cancellation changes nothing", async () => {
    const before = await savedManifest(), count = mutations.length;
    await page.getByRole("button", { name: "原始文件", exact: true }).click(); await filePanel().waitFor();
    await filePanel().getByLabel("搜索原始文件", { exact: true }).fill(fileName);
    await filePanel().getByRole("button", { name: `删除文件 ${fileName}`, exact: true }).click(); const checkbox = await assertRiskReview();
    await shot("02-sidebar-risk-unacknowledged-1440", deleteDialog(), ["Sidebar review names the referencing Notebook/Python cell and downstream impact", "Deletion is disabled until the explicit acknowledgement is checked"]);
    await checkbox.check(); assert.equal(await deleteDialog().getByRole("button", { name: "删除", exact: true }).isEnabled(), true);
    await deleteDialog().getByRole("button", { name: "取消", exact: true }).click(); await deleteDialog().waitFor({ state: "hidden" });
    assert.equal(mutations.length, count); assert.deepEqual(await readManifest(), before);
    await shot("03-sidebar-deletion-cancelled-1440", filePanel(), ["Cancel after acknowledgement leaves the original listed", "No archive request, manifest revision, definition or byte changed"]);
    await filePanel().getByRole("button", { name: "收起原始文件面板", exact: true }).click(); coverage.sidebarReviewAndCancel = true;
  });
  await step("Data Browser repeats the risk review and archives only after acknowledgement", async () => {
    await page.setViewportSize({ width: 1024, height: 900 }); await openDataBrowser(); await category(/原始文件/u);
    await dataBrowser().getByRole("button", { name: `删除文件 ${fileName}`, exact: true }).click(); const checkbox = await assertRiskReview();
    await shot("04-data-browser-risk-unacknowledged-1024", deleteDialog(), ["The second deletion entry shows the same explicit filename-reference impact", "Previous cancelled acknowledgement is not reused"]);
    const before = await savedManifest(); await checkbox.check(); const pending = page.waitForResponse(mutationResponse("archiveFile"));
    await deleteDialog().getByRole("button", { name: "删除", exact: true }).click(); assert.equal((await pending).status(), 200); await deleteDialog().waitFor({ state: "hidden" });
    const archived = await readManifest(); assert.ok(archived.files.find((entry) => entry.id === originalEntry.id).deletedAt);
    assert.deepEqual(archived.state, before.state); assert.equal(archived.stateRevision, before.stateRevision); assert.deepEqual(archived.tables, before.tables);
    await assertPreserved(); assert.equal(await dataBrowser().getByRole("article", { name: `原始文件 ${fileName}`, exact: true }).count(), 0);
    apiChecks.push({ type: "archive", fileId: originalEntry.id, beforeRevision: before.stateRevision, afterRevision: archived.stateRevision, definitionsUnchanged: true, bytesUnchanged: true });
    await shot("05-file-archived-definitions-retained-1024", dataBrowser(), ["Real archive changes only this run's original metadata", "Notebook, table, original bytes and save revision remain unchanged; cached results are not claimed to auto-invalidate"]);
    await closeDataBrowser(); coverage.dataBrowserReviewAndArchive = true;
  });
  await step("Archived original causes a real Python failure while the independent Dataset still runs", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await run("fileSql", false); await assertPreserved();
    await shot("06-python-missing-original-downstream-blocked-1440", cell("python"), ["Real HTTP 200 contains run.failure, explicit missing filename and blocked downstream SQL", "No fake HTTP error or stale successful Python result is used"]);
    await page.setViewportSize({ width: 1024, height: 900 }); const result = await run("dataSql", true);
    assert.deepEqual(result.cells.map((item) => item.cellId), [ids.data, ids.dataSql]);
    assert.ok((await readManifest()).files.find((entry) => entry.id === originalEntry.id).deletedAt); await assertPreserved();
    await shot("07-independent-data-sql-still-runs-1024", cell("dataSql"), ["The original remains archived", "The separate Data→SQL branch still computes East=150 / South=80 from the persisted table"]); coverage.missingOriginalAndIndependentData = true;
  });
  await step("Restore preserves the original ID and hash and explicit Python rerun succeeds", async () => {
    const runCount = notebookRequests.length; await openDataBrowser(); await category(/回收站/u);
    const pending = page.waitForResponse(mutationResponse("restoreFile"));
    await dataBrowser().getByRole("button", { name: `恢复文件 ${fileName}`, exact: true }).click(); assert.equal((await pending).status(), 200);
    const restored = await readManifest(); assert.deepEqual(restored.files.find((entry) => entry.id === originalEntry.id), originalEntry);
    assert.equal(notebookRequests.length, runCount, "Restoration must not automatically rerun the Notebook"); await assertPreserved();
    await category(/原始文件/u); await dataBrowser().getByRole("article", { name: `原始文件 ${fileName}`, exact: true }).waitFor();
    await shot("08-same-original-restored-no-auto-run-1024", dataBrowser(), ["Real restore returns the same original ID, associations and SHA", "No Notebook request was triggered by restoring the file"]);
    await closeDataBrowser(); await page.setViewportSize({ width: 1440, height: 1000 }); const result = await run("fileSql", true);
    assert.deepEqual(result.cells.find((item) => item.cellId === ids.fileSql).resultRef.sourceFiles, [{ name: fileName, sha256: originalEntry.sha256 }]);
    await savedManifest(); await assertPreserved(); apiChecks.push({ type: "restore", fileId: originalEntry.id, sha256: originalEntry.sha256, sameIdAndBytes: true, automaticNotebookRequests: 0 });
    await shot("09-explicit-python-rerun-restored-1440", cell("fileSql"), ["Explicit real project-original Python→SQL rerun succeeds again", "Totals and source-file SHA match the baseline; all old resources remain unchanged"]); coverage.restoredSameFile = true;
  });
  assert.equal(mutations.length, 2); assert.equal(notebookRequests.length, 4);
  assert.equal(consoleErrors.length, 0); assert.equal(pageErrors.length, 0); assert.equal(routeErrors.length, 0); assert.equal(forbiddenRequests.length, 0);
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).then(() => {
    screenshots.push({ file: "failure.png", scenario, viewport: page.viewportSize(), assertions: ["Actual failure evidence, not a passed acceptance screenshot"] });
  }).catch(() => {});
} finally {
  if (handle && originalEntry) {
    try {
      assert.equal(priorManifest.files.some((entry) => entry.id === originalEntry.id), false); assert.equal(originalEntry.name, fileName);
      assert.equal(hash(await readFile(join(projectPath, "files", originalEntry.file))), originalEntry.sha256);
      const value = await readManifest();
      if (value.files.find((entry) => entry.id === originalEntry.id)?.deletedAt) {
        const response = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base }, data: { action: "restoreFile", fileId: originalEntry.id } });
        assert.equal(response.status(), 200, await response.text()); cleanupRestored = true;
        assert.deepEqual((await readManifest()).files.find((entry) => entry.id === originalEntry.id), originalEntry);
      }
    } catch (error) { cleanupErrors.push(String(error)); passed = false; }
  }
  if (handle && priorManifest) {
    try { await assertPreserved(); } catch (error) { passed = false; failure ??= { scenario: "final-preservation-check", message: String(error) }; }
  }
  await browser?.close(); const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(dirname(directory), entry.name, "report.json");
    try { const old = JSON.parse(await readFile(path, "utf8")); attemptHistory.push({ report: siteRelative(path), passed: old.passed, failure: old.failure, cleanupErrors: old.cleanupErrors, preserved: old.reuseEvidence?.preserved }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: siteRelative(directory), projectPath: siteRelative(projectPath), handle, projectId, pageId, datasetId, ids, workspaceName, bookName, fileName,
    coverage, checks, screenshots, failure, attemptHistory, reuseEvidence, apiChecks, runs, notebookRequests, mutations, cleanupRestored, cleanupErrors,
    fixtures: { directoryReads, recentProjectReads, description: "Only connection and unscoped recent-project listings are empty fixtures. Upload, scoped save, archive/restore and all JSON Notebook runs are real. Notebook definitions are an explicitly declared synthetic real-API setup, not a cell-editor UI acceptance." },
    consoleErrors, pageErrors, routeErrors, forbiddenRequests,
    scope: { sameNameResolution: "Single unique project filename only; multipart precedence and multiple-name ambiguity are not browser-tested here.",
      cache: "Project-original archive/restore does not promise automatic cache invalidation or recomputation. This script explicitly reruns and checks the real receipts.",
      other: "No historical AI draft, cross-page reference screenshot, external database, real model call or service reconfiguration." },
    visualReview: { completed: false, note: "Actually inspect every screenshot with view_image after execution." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(directory, "report.json")), checks: checks.length, screenshots: screenshots.length, cleanupErrors: cleanupErrors.length }));
}
if (!passed) process.exitCode = 1;
