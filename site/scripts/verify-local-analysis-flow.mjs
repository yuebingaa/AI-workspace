// M7 managed 3001 acceptance: real UI import/edit/run/snapshot/save/reopen; no model or warehouse.
// One fixed, independently verified synthetic project; no cleanup or limit changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001", runId = Date.now();
const directory = resolve(".runtime/hex-local-analysis-flow-2026-09-21", `browser-${runId}`);
const target = resolve(".runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project");
const baselinePath = resolve(".runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/manifest-backup/agentcanvas.project.json");
const baselineSha = "8fe87a99659a2c876aebbe7787e4cf167bfe24c33180198482c665c45c037b51";
const projectId = "c5613c9c-1509-4542-a272-fe5aac668d52", header = "x-agentcanvas-project";
const manifestName = "agentcanvas.project.json", workspaceName = "M7 本地分析完整链路", notebookName = "M7 手工 CSV 参数分析";
const fileName = "m7-local-analysis-sales.csv";
const sql = "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data WHERE amount >= (SELECT value FROM minimum) GROUP BY region ORDER BY region";
const badSql = "SELECT missing_amount FROM sales_data";
const highExpected = [{ region: "East", revenue: 100 }];
const sourceExpected = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const cells = {
  data: { kind: "data", label: "Data", title: "M7 三行销售数据", output: "sales_data" },
  parameter: { kind: "parameter", label: "参数", title: "M7 金额下限", output: "minimum" },
  sql: { kind: "sql", label: "SQL", title: "M7 按参数汇总地区", output: "regional_revenue" },
  table: { kind: "table", label: "表格", title: "M7 地区金额表格" },
  chart: { kind: "chart", label: "图表", title: "M7 地区金额图表" },
};
assert.equal(process.argv.length, 2, "No target override: only this fixed approved synthetic project is in scope");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rel = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [], screenshots = [], skipped = [], runs = [], snapshots = [], requests = [], saves = [], createdCells = [];
const pageErrors = [], consoleErrors = [], routeErrors = [], forbiddenRequests = [], oldFileHashes = [];
const ids = {};
let browser, context, page, handle, pageId, datasetId, baseline, startManifest, startBytes, finalManifest;
let indexPath, initialIndex, scenario = "preflight", failure, passed = false;
let importedNow = false, createdPageNow = false, snapshotRequests = 0, startingSnapshotCount = 0;
let fixtureConnections = 0, fixtureRecent = 0, fixtureFonts = 0, lifecycleCompleted = false;
let preservationVerified = false, preservationError, recoveredOriginalByApi = false;

function ownPage(value) { return value.state.appSpec.pages.find((item) => item.title === workspaceName); }
function book(value) { return value.state.dataProduct.notebooks?.[pageId]; }
function ownSources(value) { return value.tables.filter((entry) => entry.descriptor.originalFileName === fileName); }
function ownSnapshots(value) {
  const old = new Set(baseline.tables.map((entry) => entry.descriptor.datasetId));
  return value.tables.filter((entry) => !old.has(entry.descriptor.datasetId) && entry.kind === "result");
}
function preserveState(state) {
  for (const specKey of ["appSpec", "productAppSpec"]) {
    const old = specKey === "appSpec" ? baseline.state.appSpec : baseline.state.dataProduct.appSpec;
    const current = specKey === "appSpec" ? state.appSpec : state.dataProduct.appSpec;
    for (const entry of old.pages) assert.deepEqual(current.pages.find((item) => item.id === entry.id), entry, "Old dashboard page changed");
    for (const entry of old.navigation) assert.deepEqual(current.navigation.find((item) => item.id === entry.id), entry, "Old navigation changed");
    const newPages = current.pages.filter((entry) => !old.pages.some((item) => item.id === entry.id));
    assert.ok(newPages.length <= 1, "At most one M7 workspace may be added");
    if (newPages.length) {
      assert.equal(newPages[0].title, workspaceName);
      assert.ok(newPages[0].root.children.length <= 1, "Only the M7 chart may be added to this page");
      for (const node of newPages[0].root.children) { assert.equal(node.type, "BarChart"); assert.equal(node.props.title, cells.chart.title); }
    }
    const newNavigation = current.navigation.filter((entry) => !old.navigation.some((item) => item.id === entry.id));
    assert.ok(newNavigation.length <= 1);
    for (const entry of newNavigation) { assert.equal(entry.title, workspaceName); assert.equal(entry.pageId, newPages[0]?.id); }
    for (const key of ["id", "siteId", "schemaVersion"]) assert.deepEqual(current[key], old[key]);
    for (const entry of old.dataSources) assert.deepEqual(current.dataSources.find((item) => item.id === entry.id), entry);
  }
  for (const [id, definition] of Object.entries(baseline.state.dataProduct.notebooks)) {
    assert.deepEqual(state.dataProduct.notebooks[id], definition, "Old Notebook definition changed");
  }
  const newBooks = Object.entries(state.dataProduct.notebooks ?? {}).filter(([id]) => !(id in baseline.state.dataProduct.notebooks));
  assert.ok(newBooks.length <= 1);
  for (const [id, definition] of newBooks) {
    assert.equal(id, state.appSpec.pages.find((entry) => entry.title === workspaceName)?.id);
    assert.ok(definition.cells.length <= 5);
    assert.equal(new Set(definition.cells.map((entry) => entry.kind)).size, definition.cells.length);
    for (const item of definition.cells) assert.ok(item.kind in cells, "No extra cell kind is in scope");
  }
  assert.deepEqual(state.dataProduct.semanticLayer, baseline.state.dataProduct.semanticLayer);
  for (const entry of baseline.state.dataProduct.datasets) assert.deepEqual(state.dataProduct.datasets.find((item) => item.id === entry.id), entry);
  for (const entry of baseline.state.dataProduct.recipes) assert.deepEqual(state.dataProduct.recipes.find((item) => item.id === entry.id), entry);
  for (const key of ["harnessTasks", "assistantConversation", "assistantConversationInitialized", "assistantSessions", "edsWorkspace"]) assert.deepEqual(state[key], baseline.state[key]);
}
async function resourcesUnchanged(value) {
  assert.equal(value.id, projectId); assert.equal(value.name, baseline.name); preserveState(value.state);
  for (const entry of baseline.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of baseline.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  assert.ok(value.tables.length <= baseline.tables.length + 3 && value.files.length <= baseline.files.length + 1);
  const sources = ownSources(value); assert.ok(sources.length <= 1);
  const results = ownSnapshots(value); assert.ok(results.length <= 2, "The entire M7 batch, including retries, is limited to two snapshots");
  const newTables = value.tables.filter((entry) => !baseline.tables.some((old) => old.descriptor.datasetId === entry.descriptor.datasetId));
  assert.equal(newTables.length, sources.length + results.length);
  for (const entry of results) {
    assert.equal(entry.descriptor.provenance?.kind, "notebook");
    assert.ok([cells.table.title, cells.chart.title].includes(entry.descriptor.provenance.lineage.steps.at(-1)?.title));
    assert.deepEqual(entry.descriptor.provenance.lineage.sourceDatasetIds, [sources[0]?.descriptor.datasetId]);
  }
  for (const folder of ["tables", "files"]) {
    assert.equal(await realpath(join(target, folder)), join(target, folder));
    assert.deepEqual((await readdir(join(target, folder))).sort(), value[folder].map((entry) => entry.file).sort());
    for (const entry of value[folder]) {
      const path = join(target, folder, entry.file), stat = await lstat(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await readFile(path); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
      if (folder === "files") assert.equal(bytes.toString("utf8"), CELL_MODULES_CSV);
      if (sources.includes(entry)) assert.deepEqual(JSON.parse(bytes.toString("utf8")).rows, sourceExpected);
      if (results.includes(entry)) assert.deepEqual(JSON.parse(bytes.toString("utf8")).rows, SQL_EXPECTED);
    }
  }
  if (indexPath) {
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    const ordered = (value) => [...value.entries].sort((a, b) => a.handle.localeCompare(b.handle));
    assert.deepEqual(ordered(current), ordered(initialIndex), "Opening the existing project may only reorder the recent index");
  }
}
async function preflight() {
  const canonical = await readFile(baselinePath); assert.equal(hash(canonical), baselineSha); baseline = JSON.parse(canonical);
  assert.equal(baseline.id, projectId); assert.equal(baseline.stateRevision, 127);
  assert.equal(baseline.tables.length, 37); assert.equal(baseline.files.length, 15); assert.equal(baseline.state.appSpec.pages.length, 16);
  assert.equal(await realpath(target), target); assert.equal((await lstat(target)).isSymbolicLink(), false);
  const ownership = JSON.parse(await readFile(join(dirname(target), "report.json"), "utf8"));
  assert.equal(ownership.passed, false); assert.equal(resolve(ownership.projectPath), target);
  startBytes = await readFile(join(target, manifestName)); startManifest = JSON.parse(startBytes);
  const location = JSON.parse(await readFile(resolve(".runtime/runtime-location.json"), "utf8"));
  const config = JSON.parse(await readFile(join(location.root, "config.json"), "utf8"));
  indexPath = join(config.devState, "local-projects.json"); initialIndex = JSON.parse(await readFile(indexPath, "utf8"));
  assert.equal(initialIndex.entries.filter((entry) => resolve(entry.path) === target).length, 1);
  handle = initialIndex.entries.find((entry) => resolve(entry.path) === target).handle;
  await resourcesUnchanged(startManifest);
  pageId = ownPage(startManifest)?.id; datasetId = ownSources(startManifest)[0]?.descriptor.datasetId;
  for (const item of book(startManifest)?.cells ?? []) ids[item.kind] = item.id;
  startingSnapshotCount = ownSnapshots(startManifest).length;
  for (const folder of ["tables", "files"]) for (const entry of baseline[folder]) oldFileHashes.push({ folder, file: entry.file, sha256: entry.sha256, bytes: entry.bytes });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "prior-manifest.json"), startBytes, { flag: "wx" });
}
function observe(targetPage) {
  targetPage.setDefaultTimeout(20_000);
  targetPage.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  targetPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url }); });
}
const dialog = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const editor = () => page.locator(".notebook-editor");
const cell = (key) => page.getByRole("article", { name: `${cells[key].label}单元 ${cells[key].title}`, exact: true });
const receipt = () => page.getByLabel("Notebook 快照审阅", { exact: true });
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, focus, assertions) {
  if (focus) await focus.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, viewport: page.viewportSize(), assertions });
}
async function dismissNotice() {
  const button = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true });
  if (await button.isVisible()) await button.click();
}
async function openBrowser() {
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click(); await dialog().waitFor();
}
async function openExistingProject() {
  await openBrowser(); await dialog().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/u }).click();
  await dialog().getByLabel("项目文件夹绝对路径", { exact: true }).fill(target);
  const opened = page.waitForResponse((response) => response.url() === `${base}/api/projects` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "open");
  await dialog().getByRole("button", { name: "打开已有项目", exact: true }).click(); const response = await opened; assert.equal(response.status(), 200);
  // Same-project open may navigate/rebuild the workbench before CDP exposes the POST body.
  // The browser's installed handle and an independent real scoped GET verify the session.
  await dialog().waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), handle);
  await manifest(); await saved(); await dismissNotice();
}
async function manifest() {
  assert.ok(handle); const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
  assert.equal(response.status(), 200); const session = await response.json();
  assert.equal(session.handle, handle); assert.equal(resolve(session.path), target); assert.equal(session.manifest.id, projectId);
  return session.manifest;
}
async function saved(predicate = () => true) {
  const deadline = Date.now() + 20_000; let revision, stable = 0;
  while (Date.now() < deadline) {
    const current = await manifest();
    if (predicate(current) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(await page.locator(".top-actions").textContent())) {
      if (revision !== current.stateRevision) { revision = current.stateRevision; stable = Date.now(); }
      if (Date.now() - stable >= 650) { await resourcesUnchanged(current); return current; }
    } else { stable = 0; revision = undefined; }
    await sleep(100);
  }
  throw new Error("The scoped synthetic project did not reach its expected saved state");
}
async function notebookMode() { await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); }
async function dashboardMode() { await page.getByRole("tab", { name: "看板", exact: true }).click(); await dismissNotice(); }
async function selectWorkspace() {
  await page.getByLabel("切换工作界面", { exact: true }).click();
  await page.getByRole("menu", { name: "工作界面列表", exact: true }).getByRole("menuitem").filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
}
async function finishEdit() {
  await editor().getByRole("button", { name: "保存单元", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".notebook-editor") || document.querySelector('[aria-label="确认输出变量改名"]'));
  const rename = page.getByRole("region", { name: "确认输出变量改名", exact: true });
  if (await rename.isVisible()) await rename.getByRole("button", { name: "确认改名并保存", exact: true }).click();
  await editor().waitFor({ state: "hidden" });
}
async function createCell(key) {
  const current = await manifest(), existing = book(current)?.cells.find((item) => item.kind === key);
  if (existing) {
    ids[key] = existing.id; skipped.push({ operation: `create-${key}`, reason: "Reuse this batch's existing cell; not new UI creation evidence" });
    await page.getByRole("article", { name: `${cells[key].label}单元 ${existing.title}`, exact: true }).getByRole("button", { name: "编辑", exact: true }).click();
  } else {
    await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: `＋ ${cells[key].label}`, exact: true }).click();
  }
  await editor().waitFor(); await editor().getByLabel("单元名称", { exact: true }).fill(cells[key].title);
  if (cells[key].output) await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill(cells[key].output);
  if (key === "data") await editor().getByLabel("数据源", { exact: true }).selectOption(datasetId);
  if (key === "parameter") { await editor().getByLabel("参数类型", { exact: true }).selectOption("number"); await editor().getByLabel("参数值", { exact: true }).fill("0"); }
  if (key === "sql") {
    const options = editor().locator(".notebook-input-list label");
    for (let index = 0; index < await options.count(); index++) {
      const option = options.nth(index); await option.getByRole("checkbox").setChecked(["sales_data", "minimum"].includes(await option.locator("code").innerText()));
    }
    assert.equal(await editor().locator(".notebook-input-list input:checked").count(), 2);
    await editor().getByLabel("SQL", { exact: true }).fill(sql);
  }
  if (["table", "chart"].includes(key)) await editor().getByLabel("上游输出", { exact: true }).selectOption(ids.sql);
  if (key === "table") await editor().getByLabel("展示字段（逗号分隔，使用结果中的字段名）", { exact: true }).fill("region, revenue");
  if (key === "chart") {
    await editor().getByLabel("图表类型", { exact: true }).selectOption("bar");
    await editor().getByLabel("分类字段", { exact: true }).fill("region");
    await editor().getByLabel("数值字段（逗号分隔，最多 4 个）", { exact: true }).fill("revenue");
  }
  await finishEdit(); const result = await saved((value) => book(value)?.cells.some((item) => item.title === cells[key].title));
  ids[key] = book(result).cells.find((item) => item.title === cells[key].title).id;
  if (!existing) createdCells.push(key);
}
async function setParameter(value) {
  await notebookMode(); await cell("parameter").getByRole("button", { name: "编辑", exact: true }).click();
  await editor().getByLabel("参数值", { exact: true }).fill(String(value)); await finishEdit();
  return saved((manifest) => book(manifest).cells.find((item) => item.id === ids.parameter).parameter.value === value);
}
async function editSql(value) {
  await notebookMode(); await cell("sql").getByRole("button", { name: "编辑", exact: true }).click();
  await editor().getByLabel("SQL", { exact: true }).fill(value); await finishEdit();
  return saved((manifest) => book(manifest).cells.find((item) => item.id === ids.sql).sql === value);
}
async function run(key, { snapshot = false, expected = SQL_EXPECTED, success = true } = {}) {
  await dismissNotice(); const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  await (key ? cell(key).getByRole("button", { name: snapshot ? "生成看板预览 ↗" : "▶ 运行", exact: true }) : page.getByRole("button", { name: "▶ 全部运行", exact: true })).click();
  const response = await pending, result = await response.json(); assert.equal(response.status(), 200, JSON.stringify(result.error));
  assert.equal(result.run.status, success ? "success" : "failure", JSON.stringify(result.run.cells.map((item) => item.error)));
  assert.equal(runs.some((entry) => entry.run.runId === result.run.runId), false, "Every explicit action uses a distinct real run");
  const requestedDocument = response.request().postDataJSON().document;
  assert.equal(result.run.revision, requestedDocument.revision);
  const expectedIds = key ? [ids.data, ids.parameter, ids.sql, ids[key]] : Object.values(ids);
  assert.deepEqual(result.run.cells.map((item) => item.cellId).sort(), [...new Set(expectedIds)].sort());
  assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.data)?.table?.rows, sourceExpected);
  assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.parameter)?.table?.rows, [{ value: requestedDocument.cells.find((item) => item.id === ids.parameter).parameter.value }]);
  if (success) for (const output of result.run.cells.filter((item) => [ids.sql, ids.table, ids.chart].includes(item.cellId))) assert.deepEqual(output.table.rows, expected);
  else {
    assert.equal(result.snapshot, undefined);
    assert.equal(result.run.cells.find((item) => item.cellId === ids.sql).status, "failure");
    for (const id of [ids.table, ids.chart]) assert.equal(result.run.cells.find((item) => item.cellId === id)?.status, "blocked");
  }
  if (snapshot) {
    assert.deepEqual(result.snapshot.rows, expected); assert.deepEqual(result.snapshot.dataset.provenance.lineage.sourceDatasetIds, [datasetId]);
    assert.equal(result.snapshot.dataset.provenance.cellId, ids[key]); assert.equal(result.snapshot.dataset.provenance.runId, result.run.runId);
    snapshots.push(result.snapshot);
  }
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  runs.push({ scenario, action: snapshot ? "snapshot" : "run", run: result.run }); return result;
}

try {
  await preflight();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage(); observe(page);
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.href === "https://rsms.me/inter/inter.css") { fixtureFonts++; return await route.fulfill({ status: 200, contentType: "text/css", body: "" }); }
      if (url.origin !== base || url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/connections/")) {
        forbiddenRequests.push(`${method} ${url.origin === base ? url.pathname : url.origin}`); return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/connections") { assert.equal(method, "GET"); fixtureConnections++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"connections":[]}' }); }
      if (url.pathname === "/api/projects" && method === "GET" && !request.headers()[header]) { fixtureRecent++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' }); }
      if (request.headers()[header]) { assert.ok(handle); assert.equal(request.headers()[header], handle); }
      if (url.pathname === "/api/projects" && method === "POST") {
        const body = request.postDataJSON(); assert.ok(["open", "save"].includes(body.action));
        if (body.action === "open") assert.equal(body.path, target);
        else { assert.equal(request.headers()[header], handle); preserveState(body.state); saves.push({ scenario, stateRevision: body.stateRevision }); }
      } else if (url.pathname === "/api/datasets" && method === "POST") {
        assert.equal(datasetId, undefined, "Only one import across all attempts"); assert.equal(request.headers()[header], handle);
        assert.equal(decodeURIComponent(request.headers()["x-file-name"]), fileName); assert.equal(request.postData(), CELL_MODULES_CSV);
      } else if (url.pathname === "/api/projects/files" && method === "POST") {
        assert.equal(request.headers()[header], handle);
        // The original-file POST can follow the upload response before this test's
        // awaiting continuation assigns datasetId. Verify its already-persisted owner.
        const current = JSON.parse(await readFile(join(target, manifestName), "utf8")), owners = ownSources(current);
        assert.equal(owners.length, 1);
        assert.equal(request.headers()["x-dataset-id"], owners[0].descriptor.datasetId);
        if (datasetId) assert.equal(owners[0].descriptor.datasetId, datasetId);
        assert.equal(decodeURIComponent(request.headers()["x-file-name"]), fileName); assert.equal(request.postData(), CELL_MODULES_CSV);
      } else if (url.pathname === "/api/notebook/run") {
        assert.equal(method, "POST"); assert.equal(request.headers()[header], handle); const body = request.postDataJSON();
        assert.ok(["run", "snapshot"].includes(body.action));
        assert.ok(body.document.cells.every((item) => Object.values(ids).includes(item.id) && item.kind in cells));
        assert.equal(body.document.cells.find((item) => item.kind === "data")?.sourceDataSourceId, datasetId);
        assert.ok([sql, badSql].includes(body.document.cells.find((item) => item.kind === "sql")?.sql));
        if (body.action === "snapshot") { assert.ok(startingSnapshotCount + snapshotRequests < 2, "No third snapshot may be created"); snapshotRequests++; }
        requests.push({ scenario, action: body.action, targetCellId: body.targetCellId, revision: body.document.revision });
      } else if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(method)) {
        forbiddenRequests.push(`${method} ${url.pathname}`); return await route.abort("blockedbyclient");
      }
      return await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); return await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Open only the existing verified synthetic project and create at most one dedicated blank page", async () => {
    await openExistingProject();
    if (!pageId) {
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
      const menu = page.getByRole("navigation", { name: "工作区功能菜单" }); await menu.getByRole("button", { name: "新建界面", exact: true }).click();
      await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName); await menu.getByRole("button", { name: "创建", exact: true }).click();
      pageId = ownPage(await saved((value) => Boolean(ownPage(value))))?.id; createdPageNow = true;
    } else { skipped.push({ operation: "create-page", reason: "Fixed M7 page reused; no extra page created" }); await selectWorkspace(); }
    await notebookMode();
  });
  await step("Import the synthetic CSV through the actual upload dialog once", async () => {
    if (datasetId) {
      skipped.push({ operation: "import-csv", reason: "Existing identical batch CSV reused; this run does not repeat UI import proof" });
      const current = await manifest();
      if (!current.files.some((entry) => entry.name === fileName)) {
        assert.deepEqual(ownSources(current).map((entry) => entry.descriptor.datasetId), [datasetId]);
        const response = await context.request.post(`${base}/api/projects/files`, { headers: { [header]: handle, origin: base,
          "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(fileName), "x-dataset-id": datasetId }, data: CELL_MODULES_CSV });
        assert.equal(response.status(), 201); const original = (await response.json()).file;
        assert.equal(original.name, fileName); assert.deepEqual(original.datasetIds, [datasetId]); assert.equal(original.sha256, hash(CELL_MODULES_CSV));
        recoveredOriginalByApi = true;
        skipped.push({ operation: "original-upload-recovery", reason: "First attempt's verifier blocked only original-file POST after Dataset creation. Retried the same 40-byte synthetic original against its existing Dataset ID using the actual scoped API; no second Dataset or UI import claimed." });
        await openExistingProject(); await selectWorkspace(); await notebookMode();
      }
      return;
    }
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    await shot("01-csv-import-ready-1440", upload, ["Actual local CSV selected: three synthetic records", "No saved Dataset or Notebook definitions are seeded by the verifier"]);
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click(); const response = await uploaded; assert.equal(response.status(), 201);
    datasetId = (await response.json()).dataset.datasetId; importedNow = true; await upload.waitFor({ state: "hidden" });
    await saved((value) => value.files.some((entry) => entry.name === fileName && entry.datasetIds.includes(datasetId)));
  });
  await step("Manually create and save Data, number parameter, SQL, Table and Chart through their real editors", async () => {
    for (const key of Object.keys(cells)) {
      await createCell(key);
      if (key === "sql") await run("sql"); // Real creation requires current output fields before Table/Chart can be added.
    }
    const title = page.locator(".notebook-title"); await title.click();
    await page.getByLabel("分析文档名称", { exact: true }).fill(notebookName); await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await saved((value) => book(value).name === notebookName); await run();
    await cell("chart").getByRole("img", { name: /图表下方提供对应数据表/u }).waitFor();
    await shot("02-five-cells-real-results-1440", cell("chart"), ["Five definitions were saved using actual cell editors", "Local SQL/table/chart produce East=150 and South=80 from the uploaded CSV"]);
  });
  await step("Changing the number parameter invalidates dependants without auto-run; explicit run produces East=100", async () => {
    const count = requests.length; await setParameter(100); assert.equal(requests.length, count);
    for (const key of ["parameter", "sql", "table", "chart"]) assert.equal(await cell(key).locator(".notebook-cell-status").innerText(), "已失效 · 需重算");
    assert.equal(await cell("chart").locator(".notebook-plot").count(), 0); await run("chart", { expected: highExpected });
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot("03-parameter-explicit-rerun-1024", cell("chart"), ["Threshold 100 retains only East=100; South is absent rather than fabricated as zero", "Saved parameter change did not itself execute a query"]);
    await setParameter(0); await run(); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  if (startingSnapshotCount === 0) {
    await step("A real table snapshot preview can be cancelled without changing the formal dashboard", async () => {
      const before = await saved(); assert.deepEqual(ownPage(before).root.children, []);
      const result = await run("table", { snapshot: true }); await receipt().waitFor();
      await receipt().getByText("查看快照来源", { exact: true }).click(); assert.match(await receipt().innerText(), new RegExp(result.run.runId));
      await shot("04-table-preview-unconfirmed-1440", receipt(), ["Real snapshot provenance is visible before confirmation", "Formal dashboard remains empty until the user confirms"]);
      await page.getByRole("button", { name: "取消预览", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
      const after = await saved((value) => value.state.auditRecords.some((entry) => entry.status === "cancelled" && !before.state.auditRecords.some((old) => old.id === entry.id)));
      assert.deepEqual(after.state.appSpec.pages, before.state.appSpec.pages); assert.equal(after.tables.length, before.tables.length + 1);
      await shot("05-cancel-keeps-blank-dashboard-1440", page.locator(".canvas-toolbar"), ["Cancellation leaves the formal dashboard empty", "The first result snapshot remains stored and auditable"]);
    });
  } else skipped.push({ operation: "snapshot-table-cancel", reason: "The existing first snapshot is retained; no duplicate table snapshot is generated" });
  if (startingSnapshotCount < 2) {
    if (startingSnapshotCount === 1) assert.equal(ownSnapshots(startManifest)[0].descriptor.provenance.lineage.steps.at(-1).title, cells.table.title);
    await step("Explicitly confirming the second snapshot saves a chart bound to its independent result table", async () => {
      await notebookMode(); await run(); const result = await run("chart", { snapshot: true }); await receipt().waitFor();
      await page.getByRole("button", { name: "确认加入看板", exact: true }).click(); await receipt().waitFor({ state: "hidden" });
      const after = await saved((value) => ownPage(value).root.children.length === 1), node = ownPage(after).root.children[0];
      assert.equal(node.type, "BarChart"); assert.equal(node.props.binding.dataSourceId, result.snapshot.dataset.datasetId);
      assert.match(await page.locator(".canvas-area .chart-card").innerText(), /150/u); assert.match(await page.locator(".canvas-area .chart-card").innerText(), /80/u);
      await shot("06-confirmed-persistent-chart-1440", page.locator(".canvas-area .chart-card"), ["Confirmation saved the actual 150/80 chart and its Dataset binding", "Only two snapshots have been created in the whole batch"]);
    });
  } else {
    skipped.push({ operation: "snapshot-chart-confirm", reason: "Snapshot budget is shared across retries; existing results are reused, not regenerated" });
  }
  await step("A real SQL error blocks outputs and never changes an already saved dashboard or result bytes", async () => {
    const before = await saved(); await editSql(badSql); await run(undefined, { success: false });
    const failed = await saved(); assert.deepEqual(failed.state.appSpec.pages, before.state.appSpec.pages); assert.deepEqual(failed.tables, before.tables);
    await shot("07-real-sql-failure-1440", cell("sql"), ["Actual local SQL rejects an unknown field and blocks downstream outputs", "Saved dashboard pages and both independent snapshot tables are unchanged"]);
    await editSql(sql); await saved();
  });
  await step("Refresh and a new tab retain exact definitions and the saved chart without automatic execution", async () => {
    const before = await saved(), count = requests.length;
    await page.reload({ waitUntil: "networkidle" }); await selectWorkspace(); await notebookMode();
    assert.equal(requests.length, count); assert.equal(await page.locator(".notebook-result").count(), 0);
    assert.deepEqual(book(await saved()), book(before));
    await page.setViewportSize({ width: 1024, height: 900 });
    await shot("08-refresh-no-automatic-execution-1024", cell("data"), ["Saved five-cell Notebook reopens with no transient result cache", "No automatic SQL, Python or Agent request after refresh"]);
    await page.close(); page = await context.newPage(); observe(page); await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(base, { waitUntil: "networkidle" }); assert.equal(requests.length, count);
    await openExistingProject(); assert.equal(requests.length, count); await selectWorkspace(); await dashboardMode();
    const reopened = await saved(); assert.deepEqual(reopened.state.appSpec.pages, before.state.appSpec.pages); assert.deepEqual(book(reopened), book(before)); assert.equal(requests.length, count);
    if (ownPage(before).root.children.length) {
      assert.match(await page.locator(".canvas-area .chart-card").innerText(), /150/u); assert.match(await page.locator(".canvas-area .chart-card").innerText(), /80/u);
      await shot("09-new-tab-reopens-saved-chart-1024", page.locator(".canvas-area .chart-card"), ["New tab renders saved 150/80 snapshot without running Notebook", "Source CSV, result data, binding and definitions are preserved"]);
    } else skipped.push({ operation: "reopen-saved-chart", reason: "A previous attempt already undid the snapshot; no new result is generated for this retry" });
  });
  await step("Finally undo only the own chart change; keep both snapshots, source CSV and five definitions", async () => {
    const before = await saved();
    if (!ownPage(before).root.children.length) { skipped.push({ operation: "undo", reason: "This batch's chart is already absent; never undo an older unrelated change" }); return; }
    const changeId = before.state.appliedChangeSetIds.at(-1); assert.ok(changeId);
    const historyTail = before.state.changeHistory.at(-1); assert.deepEqual(historyTail.appSpec.pages.find((item) => item.id === pageId).root.children, []);
    for (const oldPage of baseline.state.appSpec.pages) assert.deepEqual(historyTail.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
    await page.locator(".canvas-toolbar").getByRole("button", { name: "↶", exact: true }).click();
    const after = await saved((value) => ownPage(value).root.children.length === 0);
    assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.files, before.files); assert.deepEqual(book(after), book(before));
    assert.equal(after.state.changeHistory.length, before.state.changeHistory.length - 1);
    assert.ok(after.state.auditRecords.some((entry) => entry.changeSetId === changeId && entry.status === "undone"));
    await shot("10-final-undo-retains-data-1024", page.locator(".canvas-toolbar"), ["Final explicit undo removes only the M7 dashboard chart", "CSV, two immutable results and all five Notebook definitions remain saved"]);
    lifecycleCompleted = startingSnapshotCount === 0;
  });
  finalManifest = await saved(); await resourcesUnchanged(finalManifest);
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(routeErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.ok(lifecycleCompleted, "This attempt did not complete the snapshot lifecycle; preserved results cannot substitute for fresh confirmation/undo evidence");
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error).replaceAll(process.cwd(), "<workspace>") }; process.exitCode = 1;
  console.error(failure);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (startManifest) {
    try { finalManifest = JSON.parse(await readFile(join(target, manifestName), "utf8")); await resourcesUnchanged(finalManifest); preservationVerified = true; }
    catch (error) { preservationVerified = false; preservationError = String(error); passed = false; process.exitCode = 1; failure ??= { scenario: "final preservation", message: preservationError }; }
  }
  await mkdir(directory, { recursive: true });
  const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const path = join(dirname(directory), entry.name, "report.json");
    try {
      const prior = JSON.parse(await readFile(path, "utf8"));
      attemptHistory.push({ report: rel(path), passed: prior.passed, checks: prior.checks, setup: prior.setup,
        preserved: prior.preservation?.oldResourcesPreserved, failure: prior.failure });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const report = { passed, base, directory: rel(directory), project: rel(target), pageId, datasetId, cells: ids,
    checks, screenshots, skipped, runs, snapshots, requests, saves, failure, attemptHistory,
    setup: { importedNow, createdPageNow, createdCells, startingSnapshotCount, snapshotRequests, lifecycleCompleted, recoveredOriginalByApi },
    preservation: { baseline: rel(baselinePath), baselineSha, runStartSha: startBytes ? hash(startBytes) : undefined, backup: "prior-manifest.json", oldFileHashes,
      prior: startManifest && { revision: startManifest.stateRevision, tables: startManifest.tables.length, files: startManifest.files.length, pages: startManifest.state.appSpec.pages.length },
      final: finalManifest && { revision: finalManifest.stateRevision, tables: finalManifest.tables.length, files: finalManifest.files.length, pages: finalManifest.state.appSpec.pages.length },
      indexEntryCount: initialIndex?.entries.length, oldResourcesPreserved: preservationVerified, preservationError },
    fixtures: { connections: fixtureConnections, recentProjectList: fixtureRecent, fontCss: fixtureFonts,
      note: "Only empty connection/recent directories and exact external font CSS are fixtures. Every actual upload, cell edit, run, snapshot and project write uses managed 3001; skipped operations are not fresh UI evidence.",
      importEvidence: importedNow ? "This attempt created the Dataset through the upload UI; completed original storage must also be verified in the manifest."
        : "Dataset comes from the retained first attempt's real UI upload. Its original-file POST was blocked by a missing verifier allowlist; the retained second attempt repaired only the original via the actual scoped API. This attempt reuses those resources, not a new complete UI import. See attemptHistory and recoveredOriginalByApi." },
    consoleErrors, pageErrors, routeErrors, forbiddenRequests,
    boundaries: ["One fixed synthetic page and CSV; two snapshots maximum across attempts; no registration, deletion, cleanup or limit changes.",
      "Final page is intentionally blank after the explicit undo. The saved chart was verified after SQL failure and new-tab reopen before undo.",
      "No models, external databases, Python execution, service lifecycle or stable publication. Existing tables/files/definitions remain intact.",
      "A reused setup or exhausted snapshot budget is explicitly skipped, never counted as repeated first-import or full lifecycle evidence."],
    visualReview: { completed: false, note: "Individually inspect screenshots after this run." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, skipped: skipped.length, report: rel(join(directory, "report.json")), failure }));
}
