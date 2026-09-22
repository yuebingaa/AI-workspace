// Uses the existing managed 3001 only. Faults affect this run's new synthetic files.
// No HTTP failures are mocked: each diagnostic comes from a real filesystem read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001";
const runId = Date.now();
const directory = resolve(".runtime/hex-project-file-diagnostics-2026-09-21", `browser-${runId}`);
const backupDirectory = join(directory, "fault-backups");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--reuse-failed-project"), "Use --reuse-failed-project with one explicitly approved synthetic path");
const reusePath = args.length ? resolve(args[1]) : null;
const projectPath = reusePath ?? join(directory, "project");
const workspaceName = `M6 文件诊断 ${runId}`;
const fileName = `project-file-diagnostics-${runId}.csv`;
const trashFileName = `project-file-diagnostics-${runId}-trash.csv`;
const projectHeader = "x-agentcanvas-project";
const manifestName = "agentcanvas.project.json";
const syntheticRows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cells = {
  data: { label: "Data", title: "文件诊断合成销售源", output: "sales_data" },
  sql: { label: "SQL", title: "文件诊断地区 SQL", output: "sales_totals" },
};

await mkdir(backupDirectory, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], forbiddenRequests = [], routeErrors = [];
const expectedFailures = [], apiChecks = [], faults = [], restorationErrors = [], runs = [], priorFileHashes = [];
const ids = {}, ownResources = new Map();
const coverage = { realSetup: false, missingOriginal: false, missingTableReferences: false, archivedRestoreAtomicity: false };
let scenario = "preflight", passed = false, failure, browser, context, page, handle, projectId, pageId, datasetId;
let priorManifest = null, reuseEvidence = null, rootIdentity, originalEntry, tableEntry, trashEntry;
let directoryReads = 0, recentProjectReads = 0;

async function regularFile(path) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular non-link file: ${siteRelative(path)}`);
  return stat;
}
async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
async function verifyReuse() {
  if (!reusePath) return;
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actual = await realpath(reusePath), parts = relative(approvedRoot, actual).split(sep);
  assert.ok(parts.length === 2 && /^browser-\d+$/u.test(parts[0]) && parts[1] === "project", "Reuse is restricted to the approved capability-test subtree");
  assert.equal((await lstat(reusePath)).isSymbolicLink(), false);
  const previousReport = join(dirname(actual), "report.json");
  const previous = JSON.parse(await readFile(previousReport, "utf8"));
  assert.equal(previous.passed, false, "Successful acceptance projects may not be reused");
  assert.equal(resolve(previous.projectPath), actual);
  await regularFile(join(actual, manifestName));
  const bytes = await readFile(join(actual, manifestName));
  priorManifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(priorManifest.name, "Python 能力关闭与恢复验收");
  for (const entry of priorManifest.tables) {
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    assert.ok(["capability-toggle-sales.csv", "project-save-recovery-sales.csv"].includes(entry.descriptor.originalFileName)
      || /^project-save-recovery-\d+\.csv$/u.test(entry.descriptor.originalFileName)
      || /^project-file-diagnostics-\d+(?:-trash)?\.csv$/u.test(entry.descriptor.originalFileName));
    const path = join(actual, "tables", entry.file); await regularFile(path);
    const payload = await readFile(path); assert.equal(hash(payload), entry.sha256);
    assert.deepEqual(JSON.parse(payload.toString("utf8")).rows, syntheticRows);
    priorFileHashes.push({ folder: "tables", file: entry.file, sha256: hash(payload) });
  }
  for (const entry of priorManifest.files) {
    assert.match(entry.file, /^file-[a-f0-9-]{36}\.csv$/u);
    const path = join(actual, "files", entry.file); await regularFile(path);
    const payload = await readFile(path);
    assert.equal(payload.toString("utf8"), CELL_MODULES_CSV); assert.equal(hash(payload), entry.sha256);
    priorFileHashes.push({ folder: "files", file: entry.file, sha256: hash(payload) });
  }
  for (const previousBook of Object.values(priorManifest.state?.dataProduct.notebooks ?? {})) {
    for (const previousCell of previousBook.cells) {
      assert.ok(["data", "sql"].includes(previousCell.kind), "Reuse accepts only known synthetic Data/SQL definitions");
      if (previousCell.kind === "sql") assert.equal(previousCell.sql, CELL_MODULES_SQL);
      else assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === previousCell.sourceDataSourceId));
    }
  }
  await writeFile(join(directory, "prior-manifest.json"), bytes, { flag: "wx" });
  reuseEvidence = { mode: "approved-failed-synthetic-project", path: siteRelative(actual),
    reason: "The existing recent-project index reached 100 entries; no entries or limits were changed. Only this run's workspace and resources are added.",
    previousReport: siteRelative(previousReport), previousPassed: false, backup: "prior-manifest.json", backupSha256: hash(bytes),
    priorTableIds: priorManifest.tables.map((entry) => entry.descriptor.datasetId), priorFileIds: priorManifest.files.map((entry) => entry.id),
    priorNotebookPageIds: Object.keys(priorManifest.state?.dataProduct.notebooks ?? {}), priorFileHashes, preserved: false };
}
async function checkRoot() {
  assert.equal(await realpath(projectPath), rootIdentity.path);
  const stat = await lstat(projectPath);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.dev, rootIdentity.dev); assert.equal(stat.ino, rootIdentity.ino);
  await regularFile(join(projectPath, manifestName));
  assert.equal(JSON.parse(await readFile(join(projectPath, manifestName), "utf8")).id, projectId);
}
async function registerOwn(folder, entry) {
  await checkRoot();
  const id = folder === "tables" ? entry.descriptor.datasetId : entry.id;
  const old = folder === "tables" ? priorManifest?.tables.map((item) => item.descriptor.datasetId) : priorManifest?.files.map((item) => item.id);
  assert.equal(old?.includes(id) ?? false, false, "Old resources must never become fault targets");
  assert.match(entry.file, folder === "tables" ? /^table-[a-f0-9-]{36}\.json$/u : /^file-[a-f0-9-]{36}\.csv$/u);
  if (folder === "tables") assert.ok([fileName, trashFileName].includes(entry.descriptor.originalFileName));
  else { assert.equal(entry.name, fileName); assert.deepEqual(entry.datasetIds, [datasetId]); }
  const path = join(projectPath, folder, entry.file);
  assert.equal(await realpath(join(projectPath, folder)), join(rootIdentity.path, folder));
  await regularFile(path);
  const bytes = await readFile(path); assert.equal(hash(bytes), entry.sha256);
  if (folder === "tables") assert.deepEqual(JSON.parse(bytes.toString("utf8")).rows, syntheticRows);
  else assert.equal(bytes.toString("utf8"), CELL_MODULES_CSV);
  ownResources.set(id, { id, folder, file: entry.file, path, sha256: entry.sha256, bytes: bytes.length });
}
async function faultFile(id, kind) {
  assert.ok(kind === "missing" || kind === "changed");
  await checkRoot();
  const own = ownResources.get(id); assert.ok(own, "Only this run's registered resource IDs may be faulted");
  assert.equal(await realpath(join(projectPath, own.folder)), join(rootIdentity.path, own.folder));
  assert.equal(relative(projectPath, own.path), join(own.folder, own.file));
  await regularFile(own.path); assert.equal(hash(await readFile(own.path)), own.sha256);
  assert.equal(faults.some((item) => item.id === id && !item.restored), false);
  const backup = join(backupDirectory, `${faults.length + 1}-${own.file}`);
  assert.equal(await realpath(backupDirectory), backupDirectory); assert.equal(await absent(backup), true);
  const evidence = { ...own, kind, scenario, backup, restored: false, injected: false };
  await rename(own.path, backup); faults.push(evidence);
  if (kind === "changed") {
    const bytes = Buffer.from(`synthetic-corruption-${runId}\n`);
    evidence.changedSha256 = hash(bytes);
    await writeFile(own.path, bytes, { flag: "wx" });
  }
  evidence.injected = true;
  assert.equal(hash(await readFile(backup)), own.sha256);
  return evidence;
}
async function restoreFault(item) {
  if (item.restored) return;
  await checkRoot();
  assert.equal(await realpath(join(projectPath, item.folder)), join(rootIdentity.path, item.folder));
  assert.equal(await realpath(backupDirectory), backupDirectory);
  await regularFile(item.backup); assert.equal(hash(await readFile(item.backup)), item.sha256);
  if (!(await absent(item.path))) {
    assert.equal(item.kind, "changed", "Never overwrite an unexpected file at a missing-file target");
    await regularFile(item.path); assert.equal(hash(await readFile(item.path)), item.changedSha256, "Never remove bytes not created by this run");
    await unlink(item.path);
  }
  await rename(item.backup, item.path);
  assert.equal(hash(await readFile(item.path)), item.sha256); item.restored = true;
}
function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url });
  });
}
const editor = () => page.locator(".notebook-editor");
const cell = (kind) => page.getByRole("article", { name: `${cells[kind].label}单元 ${cells[kind].title}`, exact: true });
const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const book = (manifest) => manifest.state?.dataProduct.notebooks?.[pageId];
async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
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
async function closeDataBrowser() {
  await dataBrowser().getByRole("button", { name: "关闭数据浏览器", exact: true }).click();
  await dataBrowser().waitFor({ state: "hidden" });
}
async function category(name) {
  await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name }).click();
}
async function selectTable(entry) {
  await dataBrowser().getByLabel("搜索数据表", { exact: true }).fill(entry.descriptor.originalFileName);
  await dataBrowser().locator(".data-browser-table-list").getByRole("button").filter({ hasText: entry.descriptor.source.name }).click();
}
async function readManifest() {
  assert.ok(handle, "Only the synthetic project handle may be read");
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text());
  const session = await response.json(); assert.equal(session.handle, handle); assert.equal(resolve(session.path), projectPath);
  if (projectId) assert.equal(session.manifest.id, projectId);
  return session.manifest;
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
async function saveEditor() {
  await editor().getByRole("button", { name: "保存单元", exact: true }).click();
  const renameButton = page.getByRole("button", { name: "确认改名并保存", exact: true });
  if (await renameButton.isVisible()) await renameButton.click();
  await editor().waitFor({ state: "hidden" });
}
async function addCell(kind) {
  await dismissNotice();
  await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: `＋ ${cells[kind].label}`, exact: true }).click();
  await editor().getByLabel("单元名称", { exact: true }).fill(cells[kind].title);
  await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill(cells[kind].output);
  if (kind === "data") await editor().getByLabel("数据源", { exact: true }).selectOption(datasetId);
  else {
    await editor().locator(".notebook-input-list label").filter({ hasText: cells.data.output }).getByRole("checkbox").check();
    await editor().getByLabel("SQL", { exact: true }).fill(CELL_MODULES_SQL);
  }
  await saveEditor(); await cell(kind).waitFor();
  const value = await savedManifest((manifest) => book(manifest)?.cells.some((item) => item.title === cells[kind].title));
  ids[kind] = book(value).cells.find((item) => item.title === cells[kind].title).id;
}
async function runSql() {
  await dismissNotice();
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45_000 });
  await cell("sql").getByRole("button", { name: "▶ 运行", exact: true }).click();
  const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result.error));
  assert.equal(result.run.status, "success", JSON.stringify(result.run.cells.map((item) => item.error)));
  assert.deepEqual(result.run.cells.find((item) => item.cellId === ids.sql).table.rows, SQL_EXPECTED);
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  await cell("sql").locator(".notebook-result").waitFor(); runs.push({ scenario, run: result.run });
}
async function failedOperation(button, matches, entry, folder, kind) {
  const pending = page.waitForResponse(matches); await button.click();
  const response = await pending, body = await response.json(); assert.equal(response.status(), 409, JSON.stringify(body));
  const message = body.error?.message; assert.equal(typeof message, "string");
  assert.ok(message.includes(`${folder}/${entry.file}`), "Diagnostic must identify the relative file location");
  assert.match(message, kind === "missing" ? /缺失|不存在|找不到/u : /修改|变化|损坏|校验/u);
  assert.equal(message.includes(projectPath), false, "Diagnostic must not expose the machine's absolute path");
  await dataBrowser().getByRole("alert").filter({ hasText: message }).waitFor();
  expectedFailures.push({ scenario, status: response.status(), url: response.url(), message, type: kind, source: "real-filesystem-fault" });
  return message;
}
function restoreResponse(response) {
  return response.url() === `${base}/api/projects` && response.request().method() === "POST"
    && response.request().postDataJSON()?.action === "restoreTable" && response.request().postDataJSON()?.datasetId === trashEntry.descriptor.datasetId;
}
async function assertPriorPreserved() {
  if (!priorManifest) return;
  const value = await readManifest();
  for (const entry of priorManifest.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
  for (const entry of priorManifest.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
  for (const [id, definition] of Object.entries(priorManifest.state?.dataProduct.notebooks ?? {})) {
    assert.deepEqual(value.state.dataProduct.notebooks[id], definition, `Previous Notebook ${id} must stay unchanged`);
  }
  for (const entry of priorFileHashes) assert.equal(hash(await readFile(join(projectPath, entry.folder, entry.file))), entry.sha256);
  reuseEvidence.preserved = true;
}
function expectedConsoleError(item) {
  return /Failed to load resource:.*status of 409/u.test(item.text)
    && expectedFailures.some((entry) => entry.url === item.url && entry.scenario === item.scenario);
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
        const body = request.postDataJSON();
        if (["open", "create"].includes(body.action)) assert.equal(body.path, projectPath);
      }
      if (url.pathname === "/api/notebook/run") {
        assert.equal(request.headers()[projectHeader], handle);
        assert.ok(request.postDataJSON().document.cells.every((item) => ["data", "sql"].includes(item.kind)));
      }
      await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real isolated workspace, newly imported files and Data-to-SQL baseline", async () => {
    await openDataBrowser(); await category(/项目文件夹/u);
    if (!reusePath) await dataBrowser().getByLabel("项目名称", { exact: true }).fill("M6 项目文件诊断合成验收");
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const action = reusePath ? "open" : "create";
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects`
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === action);
    await dataBrowser().getByRole("button", { name: reusePath ? "打开已有项目" : "新建本地项目", exact: true }).click();
    const response = await pending; assert.equal(response.status(), 200, await response.text());
    await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1"));
    const first = await savedManifest(); projectId = first.id; pageId = first.state.appSpec.pages[0].id;
    const stat = await lstat(projectPath); rootIdentity = { path: await realpath(projectPath), dev: stat.dev, ino: stat.ino };
    await checkRoot();
    if (reusePath) {
      assert.equal(projectId, priorManifest.id); await dismissNotice();
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
      const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
      await menu.getByRole("button", { name: "新建界面", exact: true }).click();
      await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName);
      await menu.getByRole("button", { name: "创建", exact: true }).click();
      const created = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName));
      pageId = created.state.appSpec.pages.find((item) => item.title === workspaceName).id;
      assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false);
      Object.assign(reuseEvidence, { addedWorkspaceId: pageId, addedWorkspaceName: workspaceName });
    }
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploaded = page.waitForResponse((item) => item.url() === `${base}/api/datasets` && item.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click();
    const uploadedResponse = await uploaded; assert.equal(uploadedResponse.status(), 201); datasetId = (await uploadedResponse.json()).dataset.datasetId;
    await upload.waitFor({ state: "hidden" });
    const imported = await savedManifest((value) => value.files.some((item) => item.datasetIds.includes(datasetId)));
    tableEntry = imported.tables.find((item) => item.descriptor.datasetId === datasetId);
    originalEntry = imported.files.find((item) => item.datasetIds.includes(datasetId));
    await registerOwn("tables", tableEntry); await registerOwn("files", originalEntry);
    await addCell("data"); await addCell("sql"); await runSql(); await savedManifest();
    const extra = await context.request.post(`${base}/api/datasets`, { headers: { [projectHeader]: handle, origin: base,
      "content-type": "text/csv", "x-file-name": trashFileName }, data: CELL_MODULES_CSV });
    assert.equal(extra.status(), 201, await extra.text());
    const extraId = (await extra.json()).dataset.datasetId;
    trashEntry = (await readManifest()).tables.find((item) => item.descriptor.datasetId === extraId);
    await registerOwn("tables", trashEntry); await assertPriorPreserved();
    await shot("01-new-workspace-live-sql-1440", cell("sql"), ["Real local SQL: East=150 / South=80", "Only this run's two tables and one original are added; old resources and notebooks are preserved"]);
    coverage.realSetup = true;
  });
  await step("Missing original download identifies the file while the independent table still runs", async () => {
    const before = await savedManifest(), fault = await faultFile(originalEntry.id, "missing");
    await openDataBrowser(); await category(/原始文件/u);
    const row = dataBrowser().getByRole("article", { name: `原始文件 ${originalEntry.name}`, exact: true });
    await failedOperation(row.getByRole("button", { name: "下载原件", exact: true }),
      (response) => response.url() === `${base}/api/projects/files?id=${originalEntry.id}` && response.request().method() === "GET",
      originalEntry, "files", "missing");
    assert.deepEqual(await readManifest(), before);
    await shot("02-original-missing-diagnostic-1440", dataBrowser(), ["Real missing original GET returns 409", "The same relative files/ path and recovery guidance reach the visible download error"]);
    await closeDataBrowser(); await page.setViewportSize({ width: 1024, height: 900 });
    await runSql(); assert.equal(await absent(fault.path), true);
    await shot("03-original-missing-table-runs-1024", cell("sql"), ["The original is still absent", "The independent project Dataset still executes the same SQL totals"]);
    await restoreFault(fault);
    await openDataBrowser(); await category(/原始文件/u);
    const downloadPending = page.waitForEvent("download");
    await dataBrowser().getByRole("article", { name: `原始文件 ${originalEntry.name}`, exact: true }).getByRole("button", { name: "下载原件", exact: true }).click();
    const download = await downloadPending; assert.equal((await readFile(await download.path())).toString("utf8"), CELL_MODULES_CSV);
    await closeDataBrowser(); await savedManifest(); coverage.missingOriginal = true;
  });
  await step("Missing table preview fails without dropping its saved Notebook reference", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const before = await savedManifest(), fault = await faultFile(datasetId, "missing");
    await openDataBrowser(); await category(/数据表/u); await selectTable(tableEntry);
    await failedOperation(dataBrowser().getByRole("button", { name: "预览数据 / 字段", exact: true }),
      (response) => response.url() === `${base}/api/datasets/${datasetId}`, tableEntry, "tables", "missing");
    const after = await readManifest(); assert.deepEqual(after, before);
    assert.equal(book(after).cells.find((item) => item.id === ids.data).sourceDataSourceId, datasetId);
    assert.ok(after.state.appSpec.dataSources.some((item) => item.id === datasetId));
    await dataBrowser().getByText(/正在被引用：/u).waitFor();
    assert.equal(await dataBrowser().getByRole("button", { name: "移入回收站", exact: true }).isDisabled(), true);
    await shot("04-table-missing-reference-retained-1440", dataBrowser(), ["Real table GET fails with tables/ path", "Saved Data-cell source ID, source registry and reference-protected deletion remain unchanged"]);
    await restoreFault(fault); await closeDataBrowser(); await runSql(); await savedManifest();
    coverage.missingTableReferences = true;
  });
  await step("Missing or changed archived table stays archived; original bytes restore the same ID", async () => {
    const trashId = trashEntry.descriptor.datasetId;
    const deleted = await context.request.delete(`${base}/api/datasets/${trashId}`, { headers: { [projectHeader]: handle, origin: base } });
    assert.equal(deleted.status(), 204, await deleted.text());
    const archived = await readManifest(); assert.ok(archived.tables.find((item) => item.descriptor.datasetId === trashId).deletedAt);
    const manifestBytes = await readFile(join(projectPath, manifestName));
    const missing = await faultFile(trashId, "missing");
    await page.setViewportSize({ width: 1024, height: 900 }); await openDataBrowser(); await category(/回收站/u); await selectTable(trashEntry);
    await failedOperation(dataBrowser().getByRole("button", { name: "恢复数据表", exact: true }), restoreResponse, trashEntry, "tables", "missing");
    assert.deepEqual(await readManifest(), archived); assert.deepEqual(await readFile(join(projectPath, manifestName)), manifestBytes);
    await shot("05-archived-missing-restore-refused-1024", dataBrowser(), ["Restore reads the real missing payload before catalog mutation", "deletedAt, stateRevision and exact manifest bytes are unchanged"]);
    await restoreFault(missing);
    const changed = await faultFile(trashId, "changed"); await page.setViewportSize({ width: 1440, height: 1000 });
    await failedOperation(dataBrowser().getByRole("button", { name: "恢复数据表", exact: true }), restoreResponse, trashEntry, "tables", "changed");
    assert.deepEqual(await readManifest(), archived); assert.deepEqual(await readFile(join(projectPath, manifestName)), manifestBytes);
    await shot("06-archived-changed-restore-refused-1440", dataBrowser(), ["Real hash mismatch is rejected", "The archived entry and all exact manifest bytes still match the pre-failure snapshot"]);
    await restoreFault(changed);
    await dataBrowser().getByRole("button", { name: "刷新", exact: true }).click(); await selectTable(trashEntry);
    const pending = page.waitForResponse(restoreResponse);
    await dataBrowser().getByRole("button", { name: "恢复数据表", exact: true }).click();
    const response = await pending; assert.equal(response.status(), 200, await response.text());
    await dataBrowser().waitFor({ state: "hidden" });
    const details = page.getByRole("dialog", { name: `${trashEntry.descriptor.source.name} 数据源详情`, exact: true }); await details.waitFor();
    await page.setViewportSize({ width: 1024, height: 900 });
    await details.getByRole("navigation", { name: "数据源详情标签" }).getByRole("button", { name: "数据预览", exact: true }).click();
    const restored = await savedManifest((value) => value.tables.some((item) => item.descriptor.datasetId === trashId && !item.deletedAt));
    assert.deepEqual(restored.tables.find((item) => item.descriptor.datasetId === trashId), trashEntry);
    const rows = await context.request.get(`${base}/api/datasets/${trashId}`, { headers: { [projectHeader]: handle } });
    assert.equal(rows.status(), 200); assert.deepEqual((await rows.json()).rows, syntheticRows);
    await shot("07-original-bytes-same-id-restored-1024", details, ["Restoring the exact original bytes enables successful recovery", "The original Dataset ID, descriptor, payload hash and rows are unchanged"]);
    apiChecks.push({ type: "archived-restore", datasetId: trashId, missingStatus: 409, changedStatus: 409, restoredStatus: 200,
      failedRestoreManifestSha256: hash(manifestBytes), originalSha256: trashEntry.sha256, sameId: true });
    coverage.archivedRestoreAtomicity = true;
  });
  await assertPriorPreserved();
  for (const own of ownResources.values()) assert.equal(hash(await readFile(own.path)), own.sha256);
  assert.ok(faults.every((item) => item.restored)); assert.equal(expectedFailures.length, 4);
  assert.equal(pageErrors.length, 0); assert.equal(routeErrors.length, 0); assert.equal(forbiddenRequests.length, 0);
  assert.deepEqual(consoleErrors.filter((item) => !expectedConsoleError(item)), []);
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, message: String(error) }; console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(directory, "failure.png"), animations: "disabled" }).then(() => {
      screenshots.push({ file: "failure.png", scenario, viewport: page.viewportSize(), assertions: ["Actual failure state; not a successful acceptance screenshot"] });
    }).catch(() => {});
  }
} finally {
  for (const item of [...faults].reverse()) {
    try { await restoreFault(item); } catch (error) {
      restorationErrors.push({ id: item.id, file: `${item.folder}/${item.file}`, backup: siteRelative(item.backup), message: String(error) }); passed = false;
    }
  }
  if (handle && priorManifest) {
    try { await assertPriorPreserved(); } catch (error) { passed = false; failure ??= { scenario: "final-preservation-check", message: String(error) }; }
  }
  await browser?.close();
  const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || entry.name === `browser-${runId}`) continue;
    const previousReport = join(dirname(directory), entry.name, "report.json");
    if (await absent(previousReport)) continue;
    const previous = JSON.parse(await readFile(previousReport, "utf8"));
    attemptHistory.push({ report: siteRelative(previousReport), passed: previous.passed, checks: previous.checks?.length,
      failure: previous.failure ? { scenario: previous.failure.scenario, message: previous.failure.message } : undefined,
      restorationErrors: previous.restorationErrors, faultsRestored: previous.faults?.every((item) => item.restored) });
  }
  const report = { passed, base, directory: siteRelative(directory), projectPath: siteRelative(projectPath), handle, projectId, pageId, datasetId,
    workspaceName, coverage, checks, screenshots, failure, attemptHistory, reuseEvidence, apiChecks, runs, expectedFailures,
    faults: faults.map(({ path, backup, ...item }) => ({ ...item, path: siteRelative(path), backup: siteRelative(backup) })), restorationErrors,
    ownResources: [...ownResources.values()].map(({ path, ...item }) => ({ ...item, path: siteRelative(path) })),
    fixtures: { directoryReads, recentProjectReads, description: "Empty connection/recent-project listings only. No file, restore, dataset or Notebook response was injected." },
    consoleErrors, expectedConsoleErrors: consoleErrors.filter(expectedConsoleError), unexpectedConsoleErrors: consoleErrors.filter((item) => !expectedConsoleError(item)),
    pageErrors, routeErrors, forbiddenRequests, visualReview: { completed: false, note: "Screenshots must be actually inspected with view_image after execution." } };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(directory, "report.json")), checks: checks.length, screenshots: screenshots.length,
    expectedFailures: expectedFailures.length, restorationErrors: restorationErrors.length }));
}
if (!passed) process.exitCode = 1;
