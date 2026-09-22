// Managed development site (127.0.0.1:3001) only.
// The missing-resource browser phase replaces only GET /api/notebook/python.
// It never moves vendor/python, restarts a service, or claims a real missing-resource server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import {
  CELL_MODULES_CSV,
  CELL_MODULES_PYTHON,
  CELL_MODULES_SQL,
  SQL_EXPECTED,
  WEIGHTED_EXPECTED,
} from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001";
const runId = Date.now();
const evidenceDirectory = resolve(".runtime/hex-python-optional-runtime-2026-09-21", `browser-${runId}`);
const projectPath = resolve(".runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project");
const priorReportPath = join(dirname(projectPath), "report.json");
const canonicalManifestPath = resolve(".runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/manifest-backup/agentcanvas.project.json");
const manifestName = "agentcanvas.project.json";
const manifestPath = join(projectPath, manifestName);
const projectHeader = "x-agentcanvas-project";
const canonicalSha256 = "49c05388a1db85a6e46abdb146f8dbd06a8ac4286084a9abfb01016bbcb804e9";
const expectedProjectId = "c5613c9c-1509-4542-a272-fe5aac668d52";
const expectedProjectName = "Python 能力关闭与恢复验收";
const workspaceName = "M6 Python 可选资源验收";
const notebookName = "M6 Python 可选资源 Notebook";
const missingReason = "当前安装未包含 Python 资源，Python 能力暂不可用；请安装 Python 资源或使用包含 Python 的完整产物。原 Python 定义已保留。";
const missingStatus = {
  engine: "pyodide",
  enabled: false,
  available: false,
  reason: missingReason,
};
const ids = {
  data: "python_optional_data",
  sql: "python_optional_sql",
  table: "python_optional_table",
  chart: "python_optional_chart",
  python: "python_optional_python",
};
const titles = {
  data: "可选资源合成销售源",
  sql: "可选资源地区汇总",
  table: "缺件时仍可用的地区表格",
  chart: "缺件时仍可用的地区图表",
  python: "资源恢复后的 Python 加权",
};
const labels = { data: "Data", sql: "SQL", table: "表格", chart: "图表", python: "Python" };
const cancelledSql = "SELECT 'cancelled draft must not persist' AS marker";
const expectedSourceRows = [
  { region: "East", amount: 100 },
  { region: "East", amount: 50 },
  { region: "South", amount: 80 },
];

assert.equal(process.argv.length, 2, "This verifier accepts no arguments and has one fixed approved synthetic target");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");

await mkdir(join(evidenceDirectory, "manifest-backup"), { recursive: true });

const checks = [];
const screenshots = [];
const apiChecks = [];
const projectRequests = [];
const capabilityRequests = [];
const notebookRequests = [];
const runs = [];
const pageErrors = [];
const consoleErrors = [];
const routeErrors = [];
const forbiddenRequests = [];
const originalResourceHashes = [];
const coverage = {
  syntheticOwnership: false,
  setupOnlyAddsNotebookPage: false,
  missingStatusFixture: false,
  oldPythonReadOnly: false,
  independentTable: false,
  independentChart: false,
  cancelPreservesDefinition: false,
  refreshPreservesDefinition: false,
  liveStatusRestored: false,
  livePythonRun: false,
  oldResourcesPreserved: false,
};

let scenario = "preflight";
let phase = "live-3001";
let passed = false;
let failure;
let browser;
let context;
let page;
let handle;
let pageId;
let sourceDatasetId;
let expectedBook;
let canonicalBytes;
let canonicalManifest;
let startBytes;
let startManifest;
let setupManifest;
let finalManifest;
let liveStatus;
let directoryReads = 0;
let recentProjectReads = 0;
let externalFontFixtures = 0;

function expectedNotebook(datasetId) {
  return {
    name: notebookName,
    revision: 1,
    cells: [
      { id: ids.data, kind: "data", title: titles.data, sourceDataSourceId: datasetId, outputName: "sales_data" },
      { id: ids.sql, kind: "sql", title: titles.sql, inputCellIds: [ids.data], outputName: "sales_totals", sql: CELL_MODULES_SQL },
      { id: ids.table, kind: "table", title: titles.table, inputCellId: ids.sql, columns: ["region", "revenue"] },
      { id: ids.chart, kind: "chart", title: titles.chart, inputCellId: ids.sql, chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
      { id: ids.python, kind: "python", title: titles.python, inputCellIds: [ids.sql], fileNames: [], outputName: "weighted_data", code: CELL_MODULES_PYTHON },
    ],
  };
}

async function step(name, action) {
  scenario = name;
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

function validSyntheticName(name, result) {
  return result && name === "notebook-result.csv"
    || ["capability-toggle-sales.csv", "project-save-recovery-sales.csv"].includes(name)
    || /^project-save-recovery-\d+\.csv$/u.test(name)
    || /^project-file-diagnostics-\d+(?:-trash)?\.csv$/u.test(name)
    || /^semantic-model-deletion-\d+\.csv$/u.test(name)
    || /^(?:file|cell)-deletion-impact-\d+\.csv$/u.test(name)
    || /^notebook-dashboard-snapshot-\d+\.csv$/u.test(name);
}

async function verifyRegularFile(path, expected) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${path} must be a regular non-link file`);
  const bytes = await readFile(path);
  assert.equal(bytes.length, expected.bytes);
  assert.equal(sha256(bytes), expected.sha256);
  return bytes;
}

function assertOldDefinitionsPreserved(value) {
  assert.equal(value.id, canonicalManifest.id);
  assert.equal(value.name, canonicalManifest.name);
  assert.equal(value.format, canonicalManifest.format);
  assert.deepEqual(value.tables, canonicalManifest.tables);
  assert.deepEqual(value.files, canonicalManifest.files);

  const oldPageIds = new Set(canonicalManifest.state.appSpec.pages.map((item) => item.id));
  const oldNavIds = new Set(canonicalManifest.state.appSpec.navigation.map((item) => item.id));
  for (const oldPage of canonicalManifest.state.appSpec.pages) {
    assert.deepEqual(value.state.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
  }
  for (const oldNav of canonicalManifest.state.appSpec.navigation) {
    assert.deepEqual(value.state.appSpec.navigation.find((item) => item.id === oldNav.id), oldNav);
  }
  for (const oldPage of canonicalManifest.state.dataProduct.appSpec.pages) {
    assert.deepEqual(value.state.dataProduct.appSpec.pages.find((item) => item.id === oldPage.id), oldPage);
  }
  for (const oldNav of canonicalManifest.state.dataProduct.appSpec.navigation) {
    assert.deepEqual(value.state.dataProduct.appSpec.navigation.find((item) => item.id === oldNav.id), oldNav);
  }
  for (const [id, notebook] of Object.entries(canonicalManifest.state.dataProduct.notebooks)) {
    assert.deepEqual(value.state.dataProduct.notebooks[id], notebook);
  }
  const extraPages = value.state.appSpec.pages.filter((item) => !oldPageIds.has(item.id));
  const extraNavigation = value.state.appSpec.navigation.filter((item) => !oldNavIds.has(item.id));
  assert.ok(extraPages.length <= 1, "Only one optional-Python workspace may be appended");
  assert.ok(extraNavigation.length <= 1, "Only one optional-Python navigation item may be appended");
  if (extraPages.length) {
    assert.equal(extraPages[0].title, workspaceName);
    assert.deepEqual(extraPages[0].root.children, []);
    assert.equal(extraNavigation[0]?.title, workspaceName);
    assert.equal(extraNavigation[0]?.pageId, extraPages[0].id);
    const extraNotebookIds = Object.keys(value.state.dataProduct.notebooks).filter((id) => !(id in canonicalManifest.state.dataProduct.notebooks));
    assert.ok(extraNotebookIds.length <= 1, "Only the optional-Python Notebook may be appended");
    if (extraNotebookIds.length) {
      assert.deepEqual(extraNotebookIds, [extraPages[0].id]);
      assert.deepEqual(value.state.dataProduct.notebooks[extraPages[0].id], expectedNotebook(sourceDatasetId));
    }
    const productExtraPages = value.state.dataProduct.appSpec.pages.filter((item) => !oldPageIds.has(item.id));
    const productExtraNavigation = value.state.dataProduct.appSpec.navigation.filter((item) => !oldNavIds.has(item.id));
    assert.deepEqual(productExtraPages, extraPages);
    assert.deepEqual(productExtraNavigation, extraNavigation);
  } else {
    assert.equal(extraNavigation.length, 0);
    assert.deepEqual(Object.keys(value.state.dataProduct.notebooks), Object.keys(canonicalManifest.state.dataProduct.notebooks));
  }

  for (const key of ["changeHistory", "appliedChangeSetIds", "auditRecords", "queryRecords", "harnessTasks", "assistantConversation", "assistantConversationInitialized", "assistantSessions", "edsWorkspace"]) {
    assert.deepEqual(value.state[key], canonicalManifest.state[key], `Unrelated state changed: ${key}`);
  }
  for (const key of ["id", "name", "schemaVersion", "datasets", "recipes", "semanticLayer"]) {
    assert.deepEqual(value.state.dataProduct[key], canonicalManifest.state.dataProduct[key], `Unrelated dataProduct state changed: ${key}`);
  }
  for (const key of ["id", "siteId", "schemaVersion", "dataSources"]) {
    assert.deepEqual(value.state.appSpec[key], canonicalManifest.state.appSpec[key], `Unrelated appSpec state changed: ${key}`);
    assert.deepEqual(value.state.dataProduct.appSpec[key], canonicalManifest.state.dataProduct.appSpec[key], `Unrelated dataProduct appSpec state changed: ${key}`);
  }
}

async function verifySyntheticProject() {
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actual = await realpath(projectPath);
  assert.deepEqual(relative(approvedRoot, actual).split(sep), ["browser-1789916685499", "project"]);
  assert.equal((await lstat(projectPath)).isSymbolicLink(), false);
  for (const folder of ["tables", "files"]) {
    assert.equal(await realpath(join(projectPath, folder)), join(actual, folder));
    assert.equal((await lstat(join(projectPath, folder))).isSymbolicLink(), false);
  }

  const previous = JSON.parse(await readFile(priorReportPath, "utf8"));
  assert.equal(previous.passed, false);
  assert.equal(resolve(previous.projectPath), actual);

  canonicalBytes = await readFile(canonicalManifestPath);
  assert.equal(sha256(canonicalBytes), canonicalSha256);
  canonicalManifest = JSON.parse(canonicalBytes.toString("utf8"));
  assert.equal(canonicalManifest.id, expectedProjectId);
  assert.equal(canonicalManifest.name, expectedProjectName);
  assert.equal(canonicalManifest.stateRevision, 125);
  assert.equal(canonicalManifest.tables.length, 37);
  assert.equal(canonicalManifest.files.length, 15);
  assert.equal(canonicalManifest.state.appSpec.pages.length, 15);
  assert.equal(Object.keys(canonicalManifest.state.dataProduct.notebooks).length, 15);
  sourceDatasetId = canonicalManifest.tables[0].descriptor.datasetId;

  startBytes = await readFile(manifestPath);
  startManifest = JSON.parse(startBytes.toString("utf8"));
  assertOldDefinitionsPreserved(startManifest);
  await writeFile(join(evidenceDirectory, "manifest-backup", manifestName), startBytes, { flag: "wx" });

  assert.deepEqual((await readdir(join(projectPath, "tables"))).sort(), canonicalManifest.tables.map((entry) => entry.file).sort());
  assert.deepEqual((await readdir(join(projectPath, "files"))).sort(), canonicalManifest.files.map((entry) => entry.file).sort());
  for (const entry of canonicalManifest.tables) {
    assert.ok(validSyntheticName(entry.descriptor.originalFileName, entry.kind === "result"), `Unexpected table ownership: ${entry.descriptor.originalFileName}`);
    const bytes = await verifyRegularFile(join(projectPath, "tables", entry.file), entry);
    const rows = JSON.parse(bytes.toString("utf8")).rows;
    if (entry.kind !== "result") assert.deepEqual(rows, expectedSourceRows);
    originalResourceHashes.push({ folder: "tables", file: entry.file, bytes: entry.bytes, sha256: entry.sha256 });
  }
  for (const entry of canonicalManifest.files) {
    assert.ok(validSyntheticName(entry.name, false), `Unexpected file ownership: ${entry.name}`);
    const bytes = await verifyRegularFile(join(projectPath, "files", entry.file), entry);
    assert.equal(bytes.toString("utf8"), CELL_MODULES_CSV);
    originalResourceHashes.push({ folder: "files", file: entry.file, bytes: entry.bytes, sha256: entry.sha256 });
  }
  coverage.syntheticOwnership = true;
}

async function assertOriginalResourcesUnchanged() {
  for (const entry of originalResourceHashes) {
    await verifyRegularFile(join(projectPath, entry.folder, entry.file), entry);
  }
  assert.deepEqual((await readdir(join(projectPath, "tables"))).sort(), canonicalManifest.tables.map((entry) => entry.file).sort());
  assert.deepEqual((await readdir(join(projectPath, "files"))).sort(), canonicalManifest.files.map((entry) => entry.file).sort());
}

function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url });
  });
}

const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const cell = (kind) => page.getByRole("article", { name: `${labels[kind]}单元 ${titles[kind]}`, exact: true });

async function screenshot(name, focus, assertions) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide horizontal overflow is allowed");
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, phase, viewport: page.viewportSize(), assertions });
}

async function dismissNotice() {
  const button = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true });
  if (await button.isVisible()) await button.click();
}

async function openDataBrowser() {
  if (await dataBrowser().isVisible()) return;
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click();
  await dataBrowser().waitFor();
}

async function openProject() {
  await openDataBrowser();
  await dataBrowser().getByRole("navigation", { name: "数据资源分类", exact: true }).getByRole("button", { name: /项目文件夹/u }).click();
  await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
  const pending = page.waitForResponse((response) => {
    if (response.url() !== `${base}/api/projects` || response.request().method() !== "POST") return false;
    try { return response.request().postDataJSON()?.action === "open"; } catch { return false; }
  }, { timeout: 30_000 });
  await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(resolve(body.path), projectPath);
  assert.equal(body.manifest.id, expectedProjectId);
  handle = body.handle;
  await dataBrowser().waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), handle);
}

async function readManifest() {
  assert.ok(handle);
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text());
  const body = await response.json();
  assert.equal(body.handle, handle);
  assert.equal(resolve(body.path), projectPath);
  return body.manifest;
}

async function savedManifest(predicate = () => true) {
  const deadline = Date.now() + 20_000;
  let lastRevision;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const value = await readManifest();
    const label = await page.locator(".top-actions").textContent();
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/u.test(label ?? "")) {
      if (lastRevision !== value.stateRevision) { lastRevision = value.stateRevision; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 650) return value;
    } else {
      lastRevision = undefined;
      stableSince = 0;
    }
    await sleep(100);
  }
  throw new Error("Synthetic project did not reach a stable saved state");
}

async function createOrReuseWorkspace() {
  const current = await savedManifest();
  const matches = current.state.appSpec.pages.filter((item) => item.title === workspaceName);
  assert.ok(matches.length <= 1);
  if (matches.length === 1) {
    pageId = matches[0].id;
    const existing = current.state.dataProduct.notebooks[pageId];
    if (existing) {
      assert.deepEqual(existing, expectedNotebook(sourceDatasetId));
      return { created: false, manifest: current };
    }
  }
  let created = current;
  let pageCreated = false;
  if (matches.length === 0) {
    await dismissNotice();
    await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
    await menu.getByRole("button", { name: "新建界面", exact: true }).click();
    await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName);
    await menu.getByRole("button", { name: "创建", exact: true }).click();
    created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName));
    pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
    assert.equal(canonicalManifest.state.appSpec.pages.some((item) => item.id === pageId), false);
    pageCreated = true;
  }
  const state = structuredClone(created.state);
  state.dataProduct.notebooks = { ...state.dataProduct.notebooks, [pageId]: expectedNotebook(sourceDatasetId) };
  const response = await context.request.post(`${base}/api/projects`, {
    headers: { [projectHeader]: handle, origin: base },
    data: { action: "save", state, stateRevision: created.stateRevision },
  });
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  apiChecks.push({ type: "declared-five-cell-setup", source: "real scoped project save API", pageId, beforeRevision: created.stateRevision, afterRevision: body.stateRevision });
  const installed = await readManifest();
  assert.deepEqual(installed.state.dataProduct.notebooks[pageId], expectedNotebook(sourceDatasetId));
  return { created: pageCreated, manifest: installed };
}

async function selectWorkspace() {
  await page.getByLabel("切换工作界面", { exact: true }).click();
  const menu = page.getByRole("menu", { name: "工作界面列表", exact: true });
  await menu.getByRole("menuitem").filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
}

async function openNotebookAfterReload() {
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await selectWorkspace();
  await page.getByRole("tab", { name: "Notebook", exact: true }).click();
  await dismissNotice();
  await cell("data").waitFor();
}

async function runCell(kind, expectedRows) {
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 60_000 });
  await cell(kind).getByRole("button", { name: "▶ 运行", exact: true }).click();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, "success", JSON.stringify(body.run.cells));
  const target = body.run.cells.find((item) => item.cellId === ids[kind]);
  assert.ok(target, `Run receipt must contain ${kind}`);
  assert.deepEqual(target.table.rows, expectedRows);
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  runs.push({ scenario, phase, target: kind, run: body.run });
  return body.run;
}

async function assertMissingUi() {
  const python = cell("python");
  await python.waitFor();
  const bodyText = await page.locator("body").innerText();
  assert.ok(bodyText.includes(missingReason), "The exact server-owned missing-resource reason must be visible in the UI");
  assert.equal(await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: "＋ Python", exact: true }).count(), 0);
  assert.equal(await python.getByRole("button", { name: "编辑", exact: true }).isDisabled(), true);
  assert.equal(await python.getByRole("button", { name: "▶ 运行", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "▶ 全部运行", exact: true }).isDisabled(), true);
  if (await python.getByRole("button", { name: "查看Python", exact: true }).getAttribute("aria-expanded") !== "true") {
    await python.getByRole("button", { name: "查看Python", exact: true }).click();
  }
  assert.equal((await python.getByRole("region", { name: `${titles.python} Python`, exact: true }).locator("code").allInnerTexts()).join("\n"), CELL_MODULES_PYTHON);
  assert.equal(await python.locator(".notebook-result").count(), 0);
  return python;
}

async function assertBookUnchanged(expected, expectedRevision) {
  const value = await savedManifest();
  assert.equal(value.stateRevision, expectedRevision);
  assert.deepEqual(value.state.dataProduct.notebooks[pageId], expected);
  return value;
}

async function assertFinalPreservation() {
  finalManifest = await readManifest();
  assertOldDefinitionsPreserved(finalManifest);
  assert.equal(finalManifest.state.appSpec.pages.length, canonicalManifest.state.appSpec.pages.length + 1);
  assert.equal(finalManifest.state.appSpec.navigation.length, canonicalManifest.state.appSpec.navigation.length + 1);
  assert.equal(Object.keys(finalManifest.state.dataProduct.notebooks).length, Object.keys(canonicalManifest.state.dataProduct.notebooks).length + 1);
  assert.deepEqual(finalManifest.state.dataProduct.notebooks[pageId], expectedBook);
  await assertOriginalResourcesUnchanged();
  coverage.oldResourcesPreserved = true;
}

await verifySyntheticProject();

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  observe(page);

  await context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.href === "https://rsms.me/inter/inter.css") {
        assert.equal(request.method(), "GET");
        externalFontFixtures += 1;
        return await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      }
      if (url.origin !== base) {
        forbiddenRequests.push(url.origin);
        return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/connections") {
        assert.equal(request.method(), "GET", "Connection mutation is prohibited");
        directoryReads += 1;
        return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connections: [] }) });
      }
      if (url.pathname.startsWith("/api/connections/") || url.pathname.startsWith("/api/ai/")) {
        forbiddenRequests.push(url.pathname);
        return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/projects" && request.method() === "GET" && !request.headers()[projectHeader]) {
        recentProjectReads += 1;
        return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (url.pathname === "/api/projects") {
        const requestHandle = request.headers()[projectHeader];
        const body = request.method() === "POST" ? request.postDataJSON() : undefined;
        if (request.method() === "POST") {
          assert.ok(["open", "save"].includes(body?.action), `Unexpected project action: ${body?.action}`);
          if (body.action === "open") assert.equal(resolve(body.path), projectPath);
        }
        if (requestHandle && handle) assert.equal(requestHandle, handle);
        projectRequests.push({ scenario, method: request.method(), action: body?.action, scoped: Boolean(requestHandle) });
      }
      if (url.pathname === "/api/notebook/python") {
        assert.equal(request.method(), "GET");
        const source = phase === "missing-resource-fixture" ? "playwright-static-status-fixture" : "real-managed-3001";
        capabilityRequests.push({ scenario, phase, source, scoped: Boolean(request.headers()[projectHeader]) });
        if (phase === "missing-resource-fixture") {
          if (handle) assert.equal(request.headers()[projectHeader], handle);
          return await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(missingStatus) });
        }
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.method(), "POST");
        const body = request.postDataJSON();
        const record = { scenario, phase, targetCellId: body.targetCellId ?? null, action: body.action, documentCellIds: body.document?.cells.map((item) => item.id) };
        notebookRequests.push(record);
        if (phase === "missing-resource-fixture" && ![ids.table, ids.chart].includes(body.targetCellId)) {
          forbiddenRequests.push(`Missing-resource phase attempted unexpected Notebook target ${body.targetCellId ?? "all"}`);
          return await route.abort("blockedbyclient");
        }
      }
      return await route.continue();
    } catch (error) {
      routeErrors.push({ scenario, message: String(error) });
      return await route.abort("failed").catch(() => {});
    }
  });

  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });

  await step("Open the fixed synthetic project and append only one declared five-cell Notebook page", async () => {
    await openProject();
    const setup = await createOrReuseWorkspace();
    setupManifest = setup.manifest;
    expectedBook = expectedNotebook(sourceDatasetId);
    assert.deepEqual(setupManifest.state.dataProduct.notebooks[pageId], expectedBook);
    assertOldDefinitionsPreserved(setupManifest);
    assert.equal(setupManifest.tables.length, 37);
    assert.equal(setupManifest.files.length, 15);
    assert.ok(setupManifest.tables.length < 50);
    await assertOriginalResourcesUnchanged();
    coverage.setupOnlyAddsNotebookPage = true;
    apiChecks.push({
      type: "synthetic-setup-boundary",
      created: setup.created,
      baselineRevision: canonicalManifest.stateRevision,
      setupRevision: setupManifest.stateRevision,
      baselinePages: canonicalManifest.state.appSpec.pages.length,
      setupPages: setupManifest.state.appSpec.pages.length,
      tables: setupManifest.tables.length,
      files: setupManifest.files.length,
    });
  });

  await step("A static missing-resource GET keeps the saved Python source read-only without executing it", async () => {
    phase = "missing-resource-fixture";
    const statusCount = capabilityRequests.length;
    const runCount = notebookRequests.length;
    await openNotebookAfterReload();
    assert.ok(capabilityRequests.slice(statusCount).some((entry) => entry.source === "playwright-static-status-fixture" && entry.scoped));
    assert.equal(notebookRequests.length, runCount);
    const python = await assertMissingUi();
    assert.deepEqual((await readManifest()).state.dataProduct.notebooks[pageId], expectedBook);
    coverage.missingStatusFixture = true;
    coverage.oldPythonReadOnly = true;
    await screenshot("01-missing-python-readonly-1440", python, [
      "Exact missing-resource reason from the declared GET fixture is visible",
      "The persisted Python source remains viewable; create, edit, single-run and full-run controls are unavailable",
      "No Python execution request or transient result is present",
    ]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await screenshot("02-missing-python-readonly-1024", python, [
      "The same read-only Python definition and recovery guidance remain readable at 1024px",
      "This is a static capability-status fixture, not a physical removal from managed 3001",
    ]);
  });

  await step("Independent SQL to table and chart branches still execute on real managed 3001", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const before = notebookRequests.length;
    const tableRun = await runCell("table", SQL_EXPECTED);
    assert.equal(tableRun.cells.some((item) => item.cellId === ids.python), false);
    assert.match(await cell("table").innerText(), /East/u);
    assert.match(await cell("table").innerText(), /150/u);
    assert.match(await cell("table").innerText(), /South/u);
    assert.match(await cell("table").innerText(), /80/u);
    await screenshot("03-real-independent-table-1440", cell("table"), [
      "Real managed-3001 Data to SQL to Table execution returns East=150 and South=80",
      "The target closure excludes the saved Python cell",
    ]);
    coverage.independentTable = true;

    const chartRun = await runCell("chart", SQL_EXPECTED);
    assert.equal(chartRun.cells.some((item) => item.cellId === ids.python), false);
    const requests = notebookRequests.slice(before);
    assert.deepEqual(requests.map((item) => item.targetCellId), [ids.table, ids.chart]);
    assert.equal(requests.some((item) => item.targetCellId === ids.python || item.targetCellId === null), false);
    await page.setViewportSize({ width: 1024, height: 900 });
    await screenshot("04-real-independent-chart-1024", cell("chart"), [
      "Real managed-3001 chart target succeeds from the SQL branch while Python remains unavailable",
      "Run receipts contain East=150 and South=80 and no Python cell",
    ]);
    coverage.independentChart = true;
  });

  await step("Cancelling a SQL draft leaves the complete Notebook and project revision unchanged", async () => {
    const before = await savedManifest();
    const projectRequestCount = projectRequests.length;
    await cell("sql").getByRole("button", { name: "编辑", exact: true }).click();
    const editor = cell("sql").locator(".notebook-editor");
    await editor.getByLabel("SQL", { exact: true }).fill(cancelledSql);
    assert.equal(await editor.getByLabel("SQL", { exact: true }).inputValue(), cancelledSql);
    await editor.getByRole("button", { name: "取消编辑", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    const after = await assertBookUnchanged(expectedBook, before.stateRevision);
    assert.deepEqual(after, before);
    assert.equal(projectRequests.length, projectRequestCount);
    assert.equal(after.state.dataProduct.notebooks[pageId].cells.find((item) => item.id === ids.python).code, CELL_MODULES_PYTHON);
    if (await cell("sql").getByRole("button", { name: "查看SQL", exact: true }).getAttribute("aria-expanded") !== "true") {
      await cell("sql").getByRole("button", { name: "查看SQL", exact: true }).click();
    }
    assert.equal((await cell("sql").getByRole("region", { name: `${titles.sql} SQL`, exact: true }).locator("code").allInnerTexts()).join("\n"), CELL_MODULES_SQL);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await screenshot("05-cancel-keeps-saved-definitions-1440", cell("sql"), [
      "Cancelled SQL text is absent; the original saved SQL is still shown",
      "Project revision and the complete five-cell Notebook, including Python source, are byte-for-byte unchanged as JSON values",
    ]);
    coverage.cancelPreservesDefinition = true;
  });

  await step("Refreshing under the fixture preserves all definitions and performs no automatic run", async () => {
    const before = await savedManifest();
    const runCount = notebookRequests.length;
    await page.setViewportSize({ width: 1024, height: 900 });
    await openNotebookAfterReload();
    assert.equal(notebookRequests.length, runCount);
    const after = await readManifest();
    assert.equal(after.stateRevision, before.stateRevision);
    assert.deepEqual(after.state.dataProduct.notebooks[pageId], expectedBook);
    assert.equal(await page.locator(".notebook-result").count(), 0);
    const python = await assertMissingUi();
    await screenshot("06-refresh-retains-definitions-no-auto-run-1024", python, [
      "Refresh retains the five persisted definitions and exact Python source",
      "Transient SQL/table/chart results are gone and no automatic Notebook request was sent",
    ]);
    coverage.refreshPreservesDefinition = true;
  });

  await step("Restoring the real 3001 status re-enables the same Python definition for manual execution", async () => {
    phase = "live-3001";
    const statusCount = capabilityRequests.length;
    const runCount = notebookRequests.length;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openNotebookAfterReload();
    const liveResponse = await context.request.get(`${base}/api/notebook/python`, { headers: { [projectHeader]: handle } });
    liveStatus = await liveResponse.json();
    assert.equal(liveResponse.status(), 200, JSON.stringify(liveStatus));
    assert.equal(liveStatus.enabled, true);
    assert.equal(liveStatus.available, true);
    assert.ok(capabilityRequests.slice(statusCount).some((entry) => entry.source === "real-managed-3001"));
    assert.equal(notebookRequests.length, runCount);
    assert.deepEqual((await readManifest()).state.dataProduct.notebooks[pageId], expectedBook);
    assert.equal(await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: "＋ Python", exact: true }).isVisible(), true);
    assert.equal(await cell("python").getByRole("button", { name: "编辑", exact: true }).isEnabled(), true);
    assert.equal(await cell("python").getByRole("button", { name: "▶ 运行", exact: true }).isEnabled(), true);
    coverage.liveStatusRestored = true;

    const result = await runCell("python", WEIGHTED_EXPECTED);
    assert.deepEqual(result.cells.find((item) => item.cellId === ids.python).table.rows, WEIGHTED_EXPECTED);
    assert.equal(notebookRequests.at(-1).targetCellId, ids.python);
    assert.match(await cell("python").innerText(), /East/u);
    assert.match(await cell("python").innerText(), /300/u);
    assert.match(await cell("python").innerText(), /South/u);
    assert.match(await cell("python").innerText(), /160/u);
    await screenshot("07-real-python-restored-1440", cell("python"), [
      "Real managed-3001 GET reports Python enabled and available",
      "Manual real Python execution reuses the unchanged definition and returns East=300 and South=160",
    ]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await screenshot("08-real-python-restored-1024", cell("python"), [
      "Recovered manual Python result and controls remain readable at 1024px",
      "No definition migration, model request or external database is involved",
    ]);
    coverage.livePythonRun = true;
  });

  await assertFinalPreservation();
  const unexpectedConsoleErrors = consoleErrors;
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(routeErrors, []);
  assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads > 0);
  assert.ok(recentProjectReads > 0);
  assert.ok(Object.values(coverage).every(Boolean));
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
  console.error(error);
  await page?.screenshot({ path: join(evidenceDirectory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  try {
    if (handle) await assertFinalPreservation();
  } catch (preservationError) {
    passed = false;
    process.exitCode = 1;
    failure = failure ?? { scenario: "final old-resource preservation", message: String(preservationError), stack: preservationError instanceof Error ? preservationError.stack : undefined };
  }
  await browser?.close().catch(() => {});
  if (!finalManifest) {
    const bytes = await readFile(manifestPath);
    finalManifest = JSON.parse(bytes.toString("utf8"));
  }
  const finalBytes = await readFile(manifestPath);
  const report = {
    passed,
    base,
    directory: siteRelative(evidenceDirectory),
    projectPath: siteRelative(projectPath),
    previousReport: siteRelative(priorReportPath),
    project: {
      id: expectedProjectId,
      name: expectedProjectName,
      pageId,
      workspaceName,
      notebookName,
      backups: {
        runStart: `manifest-backup/${manifestName}`,
        canonicalPreAppend: siteRelative(canonicalManifestPath),
      },
      baseline: {
        sha256: canonicalSha256,
        bytes: canonicalBytes.length,
        stateRevision: canonicalManifest.stateRevision,
        tables: canonicalManifest.tables.length,
        files: canonicalManifest.files.length,
        pages: canonicalManifest.state.appSpec.pages.length,
        notebooks: Object.keys(canonicalManifest.state.dataProduct.notebooks).length,
      },
      runStart: {
        sha256: sha256(startBytes),
        bytes: startBytes.length,
        stateRevision: startManifest.stateRevision,
        tables: startManifest.tables.length,
        files: startManifest.files.length,
        pages: startManifest.state.appSpec.pages.length,
        notebooks: Object.keys(startManifest.state.dataProduct.notebooks).length,
      },
      final: {
        sha256: sha256(finalBytes),
        bytes: finalBytes.length,
        stateRevision: finalManifest.stateRevision,
        tables: finalManifest.tables.length,
        files: finalManifest.files.length,
        pages: finalManifest.state.appSpec.pages.length,
        notebooks: Object.keys(finalManifest.state.dataProduct.notebooks).length,
      },
      expectedDifference: "At most one fixed synthetic workspace/navigation entry and its fixed five-cell Notebook are appended. No old page, Notebook, table entry, original-file entry, table file or original file changes.",
    },
    coverage,
    checks,
    screenshots,
    apiChecks,
    runs,
    capabilityRequests,
    notebookRequests,
    projectRequests,
    fixtures: {
      pythonStatus: {
        source: "Playwright static replacement for GET /api/notebook/python only during phase=missing-resource-fixture",
        body: missingStatus,
      },
      connections: { source: "Playwright GET /api/connections fixture", reads: directoryReads },
      recentProjects: { source: "Playwright unscoped GET /api/projects fixture", reads: recentProjectReads },
      font: { source: "Playwright exact https://rsms.me/inter/inter.css fixture", reads: externalFontFixtures },
    },
    liveStatus,
    originalResourceHashes,
    consoleErrors,
    pageErrors,
    routeErrors,
    forbiddenRequests,
    failure,
    boundaries: [
      "The missing-resource browser phase is an explicit static GET status fixture. Managed 3001 vendor/python is never moved, removed, rebuilt or restarted, so this report is not physical-missing-resource server evidence.",
      "Physical missing-resource build, API and Agent/execution refusal are covered by separate isolated module/build tests and are not claimed by this browser report.",
      "The independent table/chart and recovered Python runs are real POST /api/notebook/run requests to managed 3001; no Notebook-run response is replaced.",
      "Only the fixed prior failed synthetic project is opened. Registry entries are not added or removed; all 37 table files, 15 original files, and 15 prior pages/Notebooks are preserved.",
      "One synthetic page and five-cell Notebook definition are intentionally retained for evidence. No model, external database, credential, deletion, service lifecycle operation, stable-port contact or publication occurs.",
    ],
    visualReview: { completed: false, note: "Every listed screenshot must be opened with view_image after this run; the script alone does not claim visual review." },
  };
  await writeFile(join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(evidenceDirectory, "report.json")), checks: checks.length, screenshots: screenshots.length, failure }, null, 2));
}
