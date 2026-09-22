// Existing managed 3001 only. All writes target this run's synthetic project.
// 503 cases are explicit transport fixtures; conflict and persistence use real APIs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, CELL_MODULES_SQL, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001";
const runId = Date.now();
const directory = resolve(".runtime/hex-project-save-recovery-2026-09-21", `browser-${runId}`);
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--reuse-failed-project"), "Use --reuse-failed-project with one explicitly approved synthetic path");
const reusePath = args.length ? resolve(args[1]) : null;
const projectPath = reusePath ?? resolve(directory, "project");
const workspaceName = `M6 保存恢复 ${runId}`;
const projectHeader = "x-agentcanvas-project";
const cells = {
  data: { label: "Data", title: "恢复验收合成销售源", output: "sales_data" },
  sql: { label: "SQL", title: "恢复验收地区 SQL", output: "sales_totals" },
};

await mkdir(directory, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let priorManifest = null, reuseEvidence = null;
const priorFileHashes = [];
if (reusePath) {
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actual = await realpath(reusePath), parts = relative(approvedRoot, actual).split(sep);
  assert.ok(parts.length === 2 && /^browser-\d+$/u.test(parts[0]) && parts[1] === "project", "Reuse is restricted to the prior capability-test evidence subtree");
  assert.equal((await lstat(reusePath)).isSymbolicLink(), false);
  const priorReport = JSON.parse(await readFile(join(dirname(actual), "report.json"), "utf8"));
  assert.equal(priorReport.passed, false, "Successful acceptance projects may not be reused");
  assert.equal(resolve(priorReport.projectPath), actual);
  const bytes = await readFile(join(actual, "agentcanvas.project.json"));
  priorManifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(priorManifest.name, "Python 能力关闭与恢复验收");
  for (const entry of priorManifest.tables) {
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    assert.ok(["capability-toggle-sales.csv", "project-save-recovery-sales.csv"].includes(entry.descriptor.originalFileName)
      || /^project-save-recovery-\d+\.csv$/u.test(entry.descriptor.originalFileName));
    const payload = await readFile(join(actual, "tables", entry.file));
    assert.equal(hash(payload), entry.sha256);
    assert.deepEqual(JSON.parse(payload.toString("utf8")).rows,
      [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }]);
    priorFileHashes.push({ folder: "tables", file: entry.file, sha256: hash(payload) });
  }
  for (const entry of priorManifest.files) {
    assert.match(entry.file, /^file-[a-f0-9-]{36}\.csv$/u);
    const payload = await readFile(join(actual, "files", entry.file));
    assert.equal(payload.toString("utf8"), CELL_MODULES_CSV); assert.equal(hash(payload), entry.sha256);
    priorFileHashes.push({ folder: "files", file: entry.file, sha256: hash(payload) });
  }
  for (const previousBook of Object.values(priorManifest.state?.dataProduct.notebooks ?? {})) {
    for (const previousCell of previousBook.cells) {
      assert.ok(["data", "sql"].includes(previousCell.kind), "Only known synthetic Data/SQL definitions may be reused");
      if (previousCell.kind === "sql") assert.equal(previousCell.sql, CELL_MODULES_SQL);
      else assert.ok(priorManifest.tables.some((entry) => entry.descriptor.datasetId === previousCell.sourceDataSourceId));
    }
  }
  await writeFile(resolve(directory, "prior-manifest.json"), bytes);
  reuseEvidence = { mode: "approved-failed-synthetic-project", path: actual,
    reason: "The managed development recent-project registry reached its existing 100-entry limit; no registry entries were removed.",
    previousReport: join(dirname(actual), "report.json"), previousPassed: false, backup: "prior-manifest.json", backupSha256: hash(bytes),
    priorTableIds: priorManifest.tables.map((entry) => entry.descriptor.datasetId), priorFileIds: priorManifest.files.map((entry) => entry.id),
    priorNotebookPageIds: Object.keys(priorManifest.state?.dataProduct.notebooks ?? {}), priorFileHashes, preserved: false };
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block",
});
let page = await context.newPage();
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], forbiddenRequests = [];
const routeErrors = [], projectRequests = [], projectResponses = [], notebookRequests = [], runs = [];
const apiChecks = [], injections = [], dialogs = [], ids = {};
const coverage = { reopen: false, uncommittedRetry: false, lostAcknowledgement: false, conflictAndDiscard: false };
let scenario = "setup", phase = "live", passed = false, failure, handle, projectId, pageId, datasetId;
let directoryReads = 0, recentProjectReads = 0, armedSave = null;
let originalFiles, originalTables, originalDataset;

function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url });
  });
  target.on("response", (response) => {
    const request = response.request(), url = new URL(response.url());
    if (url.origin === base && url.pathname === "/api/projects") {
      projectResponses.push({ scenario, phase, method: request.method(), status: response.status(),
        action: request.method() === "POST" ? request.postDataJSON()?.action : undefined });
    }
  });
}
observe(page);

function requestTitle(body) {
  return body?.state?.dataProduct?.notebooks?.[pageId]?.cells.find((cell) => cell.id === ids.sql)?.title;
}

await context.route("**/*", async (route) => {
  try {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base || url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/connections/")) {
      forbiddenRequests.push(url.origin === base ? url.pathname : url.origin);
      return await route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/connections") {
      assert.equal(request.method(), "GET", "Connection mutations are prohibited");
      directoryReads++;
      return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connections: [] }) });
    }
    if (url.pathname === "/api/projects") {
      const requestHandle = request.headers()[projectHeader];
      if (request.method() === "GET" && !requestHandle) {
        recentProjectReads++;
        return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (handle && requestHandle) assert.equal(requestHandle, handle, "Browser request must remain in its synthetic project");
      const body = request.method() === "POST" ? request.postDataJSON() : undefined;
      const entry = { scenario, phase, method: request.method(), action: body?.action,
        stateRevision: body?.stateRevision, title: requestTitle(body), source: "live-3001" };
      projectRequests.push(entry);
      if (body?.action === "create") assert.equal(body.path, projectPath);
      if (body?.action === "save" && armedSave && entry.title === armedSave.title) {
        const injection = armedSave; armedSave = null;
        assert.equal(requestHandle, handle);
        const evidence = { scenario, mode: injection.mode, title: entry.title, baseRevision: body.stateRevision };
        if (injection.mode === "lost-acknowledgement") {
          const actual = await route.fetch({ maxRedirects: 0 });
          assert.equal(actual.status(), 200, await actual.text());
          const acknowledged = await actual.json();
          assert.equal(acknowledged.stateRevision, body.stateRevision + 1);
          evidence.committedRevision = acknowledged.stateRevision;
          evidence.actualStatus = actual.status();
          entry.source = "real-save-then-injected-503";
        } else {
          assert.equal(injection.mode, "uncommitted");
          evidence.actualStatus = null;
          entry.source = "injected-503-without-server-save";
        }
        evidence.browserStatus = 503; injections.push(evidence);
        return await route.fulfill({ status: 503, contentType: "application/json", headers: { "cache-control": "no-store" },
          body: JSON.stringify({ error: { message: injection.mode === "uncommitted"
            ? "验收注入：本次保存暂时不可用，尚未写入磁盘" : "验收注入：保存响应丢失，请核对磁盘后重试" } }) });
      }
    }
    if (url.pathname === "/api/notebook/run" && request.method() === "POST") {
      const body = request.postDataJSON();
      assert.ok(body.document?.cells.every((cell) => ["data", "sql"].includes(cell.kind)), "Only local Data and SQL cells may run");
      assert.equal(request.headers()[projectHeader], handle);
      notebookRequests.push({ scenario, targetCellId: body.targetCellId, action: body.action, revision: body.document.revision });
    }
    await route.continue();
  } catch (error) {
    routeErrors.push({ scenario, message: String(error) });
    await route.abort("failed").catch(() => {});
  }
});

const editor = () => page.locator(".notebook-editor");
const cell = (kind) => page.getByRole("article", { name: `${cells[kind].label}单元 ${cells[kind].title}`, exact: true });
const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const book = (manifest) => manifest.state?.dataProduct.notebooks?.[pageId];
const sqlTitle = (manifest) => book(manifest)?.cells.find((item) => item.id === ids.sql)?.title;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
function expectedConsoleError(item) {
  return /Failed to load resource:.*status of (503|409)/u.test(item.text) && item.url === `${base}/api/projects`;
}

async function step(name, action) {
  scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`);
}
async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide desktop overflow");
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, phase, viewport: page.viewportSize(), assertions });
}
async function dismissNotice() {
  const button = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true });
  if (await button.isVisible()) await button.click();
}
async function openDataBrowser() {
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click();
  await dataBrowser().waitFor();
}
async function closeDataBrowser() {
  await dataBrowser().getByRole("button", { name: "关闭数据浏览器", exact: true }).click();
  await dataBrowser().waitFor({ state: "hidden" });
}
async function readManifest() {
  assert.ok(handle, "Only the synthetic project created by this run may be read");
  const response = await context.request.get(`${base}/api/projects`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200, await response.text());
  const session = await response.json();
  assert.equal(session.handle, handle); assert.equal(resolve(session.path), projectPath);
  if (projectId) assert.equal(session.manifest.id, projectId);
  return session.manifest;
}
async function savedManifest(predicate = (value) => Boolean(value.state)) {
  const deadline = Date.now() + 20_000;
  let lastRevision, stableSince = 0;
  while (Date.now() < deadline) {
    const value = await readManifest();
    const label = await page.locator(".top-actions").textContent();
    if (predicate(value) && /已保存到本地项目|已确认上次修改保存到本地项目|已打开本地项目/.test(label ?? "")) {
      if (lastRevision !== value.stateRevision) { lastRevision = value.stateRevision; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 650) return value;
    } else { stableSince = 0; lastRevision = undefined; }
    await sleep(100);
  }
  throw new Error("Synthetic project did not reach a stable saved state");
}
async function readDataset() {
  assert.ok(handle && datasetId);
  const response = await context.request.get(`${base}/api/datasets/${datasetId}`, { headers: { [projectHeader]: handle } });
  assert.equal(response.status(), 200); return response.json();
}
async function assertResourcesUnchanged() {
  const value = await readManifest();
  assert.deepEqual(value.tables, originalTables); assert.deepEqual(value.files, originalFiles);
  assert.deepEqual(await readDataset(), originalDataset);
  const ownOriginal = originalFiles.find((entry) => entry.datasetIds.includes(datasetId)); assert.ok(ownOriginal);
  const original = await context.request.get(`${base}/api/projects/files?id=${encodeURIComponent(ownOriginal.id)}`,
    { headers: { [projectHeader]: handle } });
  assert.equal(original.status(), 200); assert.equal(await original.text(), CELL_MODULES_CSV);
  if (priorManifest) {
    for (const entry of priorManifest.tables) assert.deepEqual(value.tables.find((item) => item.descriptor.datasetId === entry.descriptor.datasetId), entry);
    for (const entry of priorManifest.files) assert.deepEqual(value.files.find((item) => item.id === entry.id), entry);
    for (const [id, definition] of Object.entries(priorManifest.state?.dataProduct.notebooks ?? {})) {
      assert.deepEqual(value.state.dataProduct.notebooks[id], definition, `Previous Notebook ${id} must stay unchanged`);
    }
    for (const entry of priorFileHashes) assert.equal(hash(await readFile(join(projectPath, entry.folder, entry.file))), entry.sha256);
    reuseEvidence.preserved = true;
  }
}
async function selectWorkspace() {
  if (!reusePath) return;
  await page.getByLabel("切换工作界面", { exact: true }).click();
  await page.getByRole("menu", { name: "工作界面列表", exact: true }).getByRole("menuitem")
    .filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
}
async function saveEditor() {
  await editor().getByRole("button", { name: "保存单元", exact: true }).click();
  const rename = page.getByRole("button", { name: "确认改名并保存", exact: true });
  if (await rename.isVisible()) await rename.click();
  await editor().waitFor({ state: "hidden" });
}
async function addCell(kind) {
  await dismissNotice();
  await page.getByRole("group", { name: "添加分析单元", exact: true })
    .getByRole("button", { name: `＋ ${cells[kind].label}`, exact: true }).click();
  await editor().waitFor();
  await editor().getByLabel("单元名称", { exact: true }).fill(cells[kind].title);
  await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill(cells[kind].output);
  if (kind === "data") await editor().getByLabel("数据源", { exact: true }).selectOption(datasetId);
  else {
    await editor().locator(".notebook-input-list label").filter({ hasText: cells.data.output }).getByRole("checkbox").check();
    await editor().getByLabel("SQL", { exact: true }).fill(CELL_MODULES_SQL);
  }
  await saveEditor(); await cell(kind).waitFor();
  const saved = await savedManifest((value) => book(value)?.cells.some((item) => item.title === cells[kind].title));
  ids[kind] = book(saved).cells.find((item) => item.title === cells[kind].title).id;
}
function nextSaveResponse(title) {
  return page.waitForResponse((response) => response.url() === `${base}/api/projects`
    && response.request().method() === "POST" && response.request().postDataJSON()?.action === "save"
    && requestTitle(response.request().postDataJSON()) === title, { timeout: 30_000 });
}
async function renameSql(title, expectedStatus, injectionMode) {
  await cell("sql").getByRole("button", { name: "编辑", exact: true }).click();
  await editor().getByLabel("单元名称", { exact: true }).fill(title);
  if (injectionMode) armedSave = { mode: injectionMode, title };
  const pending = nextSaveResponse(title);
  await saveEditor(); cells.sql.title = title; await cell("sql").waitFor();
  const response = await pending;
  assert.equal(response.status(), expectedStatus, await response.text());
  assert.equal(armedSave, null, "The intended save fault must actually be injected");
  if (expectedStatus !== 200) await page.locator(".persistence-notice").filter({ hasText: /验收注入|另一窗口|冲突/ }).waitFor();
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
  runs.push({ scenario, run: result.run });
  await cell("sql").locator(".notebook-result").waitFor();
  return result.run;
}
async function retrySuccessfully() {
  const before = projectRequests.length;
  await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).click();
  await dataBrowser().getByText("保存完成，修改已写入本地项目。", { exact: true }).waitFor();
  // The compact 1024 layout intentionally hides the redundant header status.
  // The successful-save notice above is the visible user-facing assertion.
  await dataBrowser().locator(".project-save-status.saved").waitFor({ state: "attached" });
  return projectRequests.slice(before);
}
async function discardDialog(accept) {
  const pending = page.waitForEvent("dialog");
  const click = dataBrowser().getByRole("button", { name: "放弃未保存修改并重新打开", exact: true }).click();
  const dialog = await pending;
  assert.equal(dialog.type(), "confirm"); assert.match(dialog.message(), /放弃当前窗口尚未保存/);
  dialogs.push({ scenario, action: accept ? "accept" : "dismiss", message: dialog.message() });
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await click;
}

try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await step("Real project Data-to-SQL save, closed-tab reopen, empty result cache and matching rerun", async () => {
    await openDataBrowser();
    await dataBrowser().getByRole("navigation", { name: "数据资源分类" }).getByRole("button", { name: /项目文件夹/ }).click();
    if (!reusePath) await dataBrowser().getByLabel("项目名称", { exact: true }).fill("M6 项目保存恢复合成验收");
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const openAction = reusePath ? "open" : "create";
    const created = page.waitForResponse((response) => response.url() === `${base}/api/projects`
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === openAction);
    await dataBrowser().getByRole("button", { name: reusePath ? "打开已有项目" : "新建本地项目", exact: true }).click();
    const createdResponse = await created;
    assert.equal(createdResponse.status(), 200, `Synthetic project creation failed: ${await createdResponse.text()}`);
    await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1"));
    const first = await savedManifest(); projectId = first.id; pageId = first.state.appSpec.pages[0].id;
    if (reusePath) {
      assert.equal(projectId, priorManifest.id);
      await dismissNotice();
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
      const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
      await menu.getByRole("button", { name: "新建界面", exact: true }).click();
      await menu.getByLabel("工作界面名称", { exact: true }).fill(workspaceName);
      await menu.getByRole("button", { name: "创建", exact: true }).click();
      const createdPage = await savedManifest((value) => value.state.appSpec.pages.some((item) => item.title === workspaceName));
      pageId = createdPage.state.appSpec.pages.find((item) => item.title === workspaceName).id;
      assert.equal(priorManifest.state.appSpec.pages.some((item) => item.id === pageId), false);
      reuseEvidence.addedWorkspaceId = pageId; reuseEvidence.addedWorkspaceName = workspaceName;
    }
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: `project-save-recovery-${runId}.csv`,
      mimeType: "text/csv", buffer: Buffer.from(CELL_MODULES_CSV) });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets` && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201); datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: "hidden" });
    await savedManifest((value) => value.tables.length === (priorManifest?.tables.length ?? 0) + 1
      && value.files.some((entry) => entry.datasetIds.includes(datasetId)));
    await addCell("data"); await addCell("sql"); await runSql();
    const before = await savedManifest(); originalTables = before.tables; originalFiles = before.files; originalDataset = await readDataset();
    assert.equal(originalDataset.rows.length, 3);
    await shot("01-live-sql-saved-1440", cell("sql"), ["Real 3001 local SQL gives East=150 / South=80", "This run's Data and SQL definitions are saved in its isolated synthetic workspace"]);
    const runCount = notebookRequests.length;
    await page.close(); page = await context.newPage(); observe(page);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
    await selectWorkspace();
    await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice();
    await cell("sql").waitFor(); assert.deepEqual(book(await savedManifest()), book(before));
    assert.equal(await cell("sql").locator(".notebook-result").count(), 0);
    assert.equal(await cell("sql").locator(".notebook-cell-status").innerText(), "待运行");
    assert.equal(notebookRequests.length, runCount, "Reopening must not automatically execute the Notebook");
    await assertResourcesUnchanged();
    await shot("02-reopened-without-run-cache-1024", cell("sql"), ["The old tab was closed and a new tab restored the same project", "Definitions, Dataset and original CSV remain; prior transient SQL output is absent"]);
    await runSql(); await savedManifest();
    await shot("03-reopened-real-sql-rerun-1024", cell("sql"), ["Explicit rerun gives the original East=150 / South=80 totals"]);
    coverage.reopen = true;
  });

  await step("Injected uncommitted 503 retains local edits and explicit retry uses real GET plus POST", async () => {
    phase = "uncommitted-503"; await page.setViewportSize({ width: 1440, height: 1000 });
    const before = await savedManifest();
    await renameSql("保存暂时失败后的新标题", 503, "uncommitted");
    const failed = await readManifest();
    assert.equal(failed.stateRevision, before.stateRevision); assert.equal(sqlTitle(failed), sqlTitle(before));
    await openDataBrowser(); await dataBrowser().locator(".project-save-status.error").waitFor();
    await shot("04-uncommitted-save-failure-1440", dataBrowser(), ["503 is injected without forwarding the save to 3001", "Disk revision and title remain unchanged; local edit and retry control are retained"]);
    phase = "uncommitted-retry-live";
    const requests = await retrySuccessfully();
    assert.ok(requests.some((item) => item.method === "GET" && item.source === "live-3001"));
    assert.equal(requests.filter((item) => item.action === "save").length, 1);
    const after = await savedManifest((value) => sqlTitle(value) === cells.sql.title);
    assert.equal(after.stateRevision, before.stateRevision + 1);
    apiChecks.push({ type: "uncommitted-retry", beforeRevision: before.stateRevision, afterRevision: after.stateRevision });
    await shot("05-uncommitted-retry-saved-1440", dataBrowser(), ["Explicit retry reads the real project and writes the retained title once", "Real disk revision advances by exactly one"]);
    await closeDataBrowser(); await cell("sql").waitFor(); await assertResourcesUnchanged();
    coverage.uncommittedRetry = true;
  });

  await step("Real committed save with injected lost response is acknowledged without a duplicate revision", async () => {
    phase = "lost-acknowledgement-503"; await page.setViewportSize({ width: 1024, height: 900 });
    const before = await savedManifest();
    await renameSql("响应丢失但磁盘已保存的标题", 503, "lost-acknowledgement");
    const committed = await readManifest();
    assert.equal(committed.stateRevision, before.stateRevision + 1); assert.equal(sqlTitle(committed), cells.sql.title);
    await openDataBrowser(); await dataBrowser().locator(".project-save-status.error").waitFor();
    await shot("06-lost-response-failure-1024", dataBrowser(), ["route.fetch really committed the title before the browser received an injected 503", "The browser keeps its dirty definition until explicit reconciliation"]);
    phase = "lost-acknowledgement-retry-live";
    const requests = await retrySuccessfully();
    assert.ok(requests.some((item) => item.method === "GET" && item.source === "live-3001"));
    assert.equal(requests.filter((item) => item.action === "save").length, 0, "An acknowledged lost response must not produce another save");
    const after = await savedManifest((value) => sqlTitle(value) === cells.sql.title);
    assert.equal(after.stateRevision, committed.stateRevision); assert.deepEqual(after.state, committed.state);
    apiChecks.push({ type: "lost-acknowledgement", beforeRevision: before.stateRevision, committedRevision: committed.stateRevision,
      afterRetryRevision: after.stateRevision, retrySaveRequests: 0 });
    await shot("07-lost-response-reconciled-1024", dataBrowser(), ["Real GET confirms the previously committed candidate", "Retry marks it saved without POST or another revision"]);
    await closeDataBrowser(); await assertResourcesUnchanged(); coverage.lostAcknowledgement = true;
  });

  await step("Real second-writer conflict rejects retry; cancel preserves edits and confirmed discard reopens disk", async () => {
    phase = "real-conflict"; await page.setViewportSize({ width: 1440, height: 1000 });
    const before = await savedManifest(), diskTitle = "磁盘另一窗口保留的标题";
    const externalState = structuredClone(before.state);
    const externalBook = externalState.dataProduct.notebooks[pageId];
    externalBook.cells.find((item) => item.id === ids.sql).title = diskTitle; externalBook.revision++;
    const external = await context.request.post(`${base}/api/projects`, { headers: { [projectHeader]: handle, origin: base },
      data: { action: "save", state: externalState, stateRevision: before.stateRevision } });
    assert.equal(external.status(), 200, await external.text());
    const acknowledgement = await external.json(); assert.equal(acknowledgement.stateRevision, before.stateRevision + 1);
    const otherWriter = await readManifest(); assert.equal(sqlTitle(otherWriter), diskTitle);
    apiChecks.push({ type: "real-independent-writer", beforeRevision: before.stateRevision, afterRevision: otherWriter.stateRevision });
    await renameSql("当前窗口尚未保存的冲突标题", 409);
    assert.deepEqual((await readManifest()).state, otherWriter.state);
    await openDataBrowser(); await dataBrowser().locator(".project-save-status.error").waitFor();
    await shot("08-real-version-conflict-1440", dataBrowser(), ["An independent real API write advanced the revision", "The browser save received a real 409 and did not overwrite the other definition"]);
    const retryStart = projectRequests.length;
    await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).click();
    await dataBrowser().getByRole("alert").filter({ hasText: /另一窗口|冲突|磁盘/ }).waitFor();
    await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).waitFor();
    const retryRequests = projectRequests.slice(retryStart);
    assert.ok(retryRequests.some((item) => item.method === "GET"));
    assert.equal(retryRequests.filter((item) => item.action === "save").length, 0);
    assert.deepEqual(await readManifest(), otherWriter);
    await shot("09-real-conflict-retry-refused-1440", dataBrowser(), ["Retry reads the real competing definition and refuses to POST", "Other writer state, revision and all resources are unchanged"]);
    await page.setViewportSize({ width: 1024, height: 900 });
    const beforeCancel = projectRequests.length;
    await discardDialog(false);
    assert.equal(await dataBrowser().isVisible(), true); assert.equal(projectRequests.length, beforeCancel);
    assert.deepEqual(await readManifest(), otherWriter);
    await shot("10-discard-cancelled-1024", dataBrowser(), ["The actual browser confirmation was dismissed", "Error and both recovery controls remain; no project request was caused by cancellation"]);
    await closeDataBrowser(); await cell("sql").waitFor();
    assert.equal(await cell("sql").getByRole("heading", { level: 2 }).innerText(), cells.sql.title);
    await openDataBrowser();
    await discardDialog(true); await dataBrowser().waitFor({ state: "hidden" });
    cells.sql.title = diskTitle;
    await selectWorkspace();
    await page.getByRole("tab", { name: "Notebook", exact: true }).click(); await dismissNotice(); await cell("sql").waitFor();
    const reopened = await savedManifest((value) => sqlTitle(value) === diskTitle);
    assert.equal(reopened.stateRevision, otherWriter.stateRevision);
    assert.deepEqual(book(reopened), book(otherWriter)); assert.equal(await cell("sql").locator(".notebook-result").count(), 0);
    await assertResourcesUnchanged();
    await shot("11-confirmed-discard-reopened-1024", cell("sql"), ["Accepting the real confirmation reopens the other writer's disk title", "No extra revision is written; Dataset and original CSV remain intact"]);
    coverage.conflictAndDiscard = true;
  });

  assert.deepEqual(pageErrors, []); assert.deepEqual(routeErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.equal(injections.length, 2); assert.ok(directoryReads > 0); assert.ok(recentProjectReads > 0);
  const unexpectedConsole = consoleErrors.filter((item) => !expectedConsoleError(item));
  assert.deepEqual(unexpectedConsole, [], "Only the two explicit 503s and real project conflict may produce console resource errors");
  assert.ok(Object.values(coverage).every(Boolean)); passed = true;
} catch (error) {
  failure = { scenario, phase, message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  const attemptHistory = [];
  for (const entry of await readdir(dirname(directory), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^browser-\d+$/u.test(entry.name) || resolve(dirname(directory), entry.name) === directory) continue;
    try {
      const reportPath = resolve(dirname(directory), entry.name, "report.json");
      const prior = JSON.parse(await readFile(reportPath, "utf8"));
      if (!prior.passed) attemptHistory.push({ report: siteRelative(reportPath), passed: false,
        scenario: prior.failure?.scenario, phase: prior.failure?.phase,
        message: prior.failure?.message, completedChecks: prior.checks?.length ?? 0, screenshots: prior.screenshots?.length ?? 0 });
    } catch { /* An unfinished parallel run is not a completed failure report. */ }
  }
  const consoleSummary = { total: consoleErrors.length,
    expected503: consoleErrors.filter((item) => expectedConsoleError(item) && /status of 503/u.test(item.text)).length,
    expected409: consoleErrors.filter((item) => expectedConsoleError(item) && /status of 409/u.test(item.text)).length,
    unexpected: consoleErrors.filter((item) => !expectedConsoleError(item)).length };
  const reportedReuse = reuseEvidence ? { ...reuseEvidence, path: siteRelative(reuseEvidence.path), previousReport: siteRelative(reuseEvidence.previousReport) } : null;
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ passed, failure, directory: siteRelative(directory), projectPath: siteRelative(projectPath), reuseEvidence: reportedReuse, handle, projectId, pageId,
    datasetId, ids, checks, screenshots, coverage, runs, notebookRequests, projectRequests, projectResponses, apiChecks,
    injections, dialogs, pageErrors, consoleErrors, consoleSummary, attemptHistory, forbiddenRequests, routeErrors, directoryReads, recentProjectReads,
    visualReview: "Screenshots must separately be opened with view_image; this script does not claim visual review.",
    boundaries: [
      reusePath ? "An explicitly approved failed capability-test synthetic project is reused because the recent-project registry is full; the original manifest is backed up and this run adds a separate workspace and its own generated CSV Dataset."
        : "One new synthetic project, generated CSV and isolated Edge context; all project and Dataset reads/writes are scoped to the generated identifiers.",
      "Data import, original CSV, local DuckDB SQL, persisted definitions, project GET/POST and second-writer conflict use real managed 3001.",
      "First 503 does not reach the server. Second 503 replaces a real successful route.fetch response. Neither fixture is a physical network outage.",
      "Connections GET and unscoped recent-project GET use explicit empty-list fixtures; model, connection-query and non-loopback browser requests are blocked.",
      "Cancellation uses the real browser confirm dialog; its post-dismiss page is captured. All screenshots require separate visual inspection.",
      "Synthetic resources and evidence are retained below .runtime. Reuse never removes registry entries, existing resources or prior Notebook definitions; their IDs, metadata and file hashes are verified unchanged.",
      "No user project, real model, external database, service lifecycle, stable publication, deletion or mobile acceptance is involved.",
    ] }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, runs: runs.length, directory, failure }, null, 2));
}
