// Managed development site (127.0.0.1:3001) only.
// This verifier temporarily changes one approved synthetic manifest. Every replacement is
// guarded by the exact hash last written by this process, and finally restores original bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { CELL_MODULES_CSV, SQL_EXPECTED } from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001";
const runId = Date.now();
const evidenceDirectory = resolve(".runtime/hex-project-compatibility-2026-09-21", `browser-${runId}`);
const projectPath = resolve(".runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project");
const manifestPath = join(projectPath, "agentcanvas.project.json");
const priorReportPath = join(dirname(projectPath), "report.json");
const projectHeader = "x-agentcanvas-project";
const expectedOriginalSha256 = "49c05388a1db85a6e46abdb146f8dbd06a8ac4286084a9abfb01016bbcb804e9";
const expectedProjectId = "c5613c9c-1509-4542-a272-fe5aac668d52";
const expectedProjectName = "Python 能力关闭与恢复验收";
const supportedWorkspaceVersion = 6;
const unknownKind = "futureMatrix";
const secretMarker = `PRIVATE_UNKNOWN_SOURCE_${runId}_DO_NOT_RENDER`;
const editedTitle = `兼容性拒写后保留的本地标题 ${runId}`;
const expectedSourceRows = [
  { region: "East", amount: 100 },
  { region: "East", amount: 50 },
  { region: "South", amount: 80 },
];
const doubledRows = SQL_EXPECTED.map((row) => ({ ...row, revenue: row.revenue * 2 }));

assert.equal(process.argv.length, 2, "This verifier has a single fixed approved synthetic target and accepts no arguments");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

await mkdir(join(evidenceDirectory, "manifest-backup"), { recursive: true });

const checks = [];
const screenshots = [];
const mutations = [];
const apiChecks = [];
const projectRequests = [];
const projectResponses = [];
const notebookRequests = [];
const pageErrors = [];
const consoleErrors = [];
const routeErrors = [];
const forbiddenRequests = [];
const resourceHashes = [];
const coverage = {
  syntheticOwnership: false,
  unknownOpenRejected: false,
  closeKeepsTemporaryWorkspace: false,
  newerVersionOpenRejected: false,
  recoveredOpenWithoutAutoRun: false,
  unknownSaveRejected: false,
  retryStillRejected: false,
  restoredRetrySaved: false,
  exactRestoration: false,
};

let scenario = "preflight";
let passed = false;
let failure;
let browser;
let context;
let page;
let handle;
let expectedManifestHash;
let originalBytes;
let originalManifest;
let unknownBytes;
let unknownHash;
let versionBytes;
let versionHash;
let baseNotebookId;
let baseCellId;
let originalCellTitle;
let unknownPosition;
let directoryReads = 0;
let recentProjectReads = 0;
let externalFontFixtures = 0;
let finalManifestBeforeRestore;
let consoleSummary = { expectedProject409: 0, unexpected: 0 };

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

async function verifyFile(path, expectedHash) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${path} must be a regular, non-link file`);
  const bytes = await readFile(path);
  assert.equal(sha256(bytes), expectedHash, `${path} must match its manifest hash`);
  return bytes;
}

async function verifySyntheticProject() {
  const approvedRoot = await realpath(resolve(".runtime/hex-notebook-capability-toggle-2026-09-20"));
  const actualProject = await realpath(projectPath);
  const parts = relative(approvedRoot, actualProject).split(sep);
  assert.deepEqual(parts, ["browser-1789916685499", "project"], "Only the explicitly approved failed synthetic project may be changed");
  assert.equal((await lstat(projectPath)).isSymbolicLink(), false);
  for (const folder of ["tables", "files"]) {
    assert.equal(await realpath(join(projectPath, folder)), join(actualProject, folder));
    assert.equal((await lstat(join(projectPath, folder))).isSymbolicLink(), false);
  }

  const priorReport = JSON.parse(await readFile(priorReportPath, "utf8"));
  assert.equal(priorReport.passed, false, "Only a prior failed synthetic acceptance project may be reused");
  assert.equal(resolve(priorReport.projectPath), actualProject);

  originalBytes = await readFile(manifestPath);
  assert.equal(sha256(originalBytes), expectedOriginalSha256, "The fixed synthetic manifest baseline changed; do not overwrite it");
  originalManifest = JSON.parse(originalBytes.toString("utf8"));
  assert.equal(originalManifest.id, expectedProjectId);
  assert.equal(originalManifest.name, expectedProjectName);
  assert.equal(originalManifest.format, "agentcanvas-local-project-v1");
  assert.equal(originalManifest.state.version, supportedWorkspaceVersion);
  assert.equal(originalManifest.stateRevision, 125);
  assert.equal(originalManifest.tables.length, 37);
  assert.equal(originalManifest.files.length, 15);

  const expectedTableFiles = originalManifest.tables.map((entry) => entry.file).sort();
  const expectedOriginalFiles = originalManifest.files.map((entry) => entry.file).sort();
  assert.deepEqual((await readdir(join(projectPath, "tables"))).sort(), expectedTableFiles);
  assert.deepEqual((await readdir(join(projectPath, "files"))).sort(), expectedOriginalFiles);

  for (const entry of originalManifest.tables) {
    assert.match(entry.file, /^table-[a-f0-9-]{36}\.json$/u);
    const result = entry.kind === "result";
    assert.ok(validSyntheticName(entry.descriptor.originalFileName, result), `Unexpected table ownership: ${entry.descriptor.originalFileName}`);
    const bytes = await verifyFile(join(projectPath, "tables", entry.file), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const rows = JSON.parse(bytes.toString("utf8")).rows;
    if (result) assert.ok([JSON.stringify(SQL_EXPECTED), JSON.stringify(doubledRows)].includes(JSON.stringify(rows)));
    else assert.deepEqual(rows, expectedSourceRows);
    resourceHashes.push({ folder: "tables", file: entry.file, sha256: entry.sha256, bytes: entry.bytes });
  }
  for (const entry of originalManifest.files) {
    assert.match(entry.file, /^file-[a-f0-9-]{36}\.csv$/u);
    assert.ok(validSyntheticName(entry.name, false), `Unexpected original-file ownership: ${entry.name}`);
    const bytes = await verifyFile(join(projectPath, "files", entry.file), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(bytes.toString("utf8"), CELL_MODULES_CSV);
    resourceHashes.push({ folder: "files", file: entry.file, sha256: entry.sha256, bytes: entry.bytes });
  }

  const notebooks = Object.entries(originalManifest.state.dataProduct.notebooks);
  assert.equal(notebooks.length, 15);
  const knownKinds = new Set(["data", "sql", "semanticQuery", "table", "python", "chart", "text"]);
  for (const [, notebook] of notebooks) for (const cell of notebook.cells) {
    assert.ok(knownKinds.has(cell.kind), `Unexpected pre-existing cell kind ${cell.kind}`);
    if (cell.kind === "data") assert.ok(originalManifest.tables.some((entry) => entry.descriptor.datasetId === cell.sourceDataSourceId));
    if (cell.kind === "python") {
      assert.equal(cell.fileNames.length, 1);
      assert.ok(originalManifest.files.some((entry) => entry.name === cell.fileNames[0]));
    }
  }
  [baseNotebookId] = notebooks[0];
  assert.equal(baseNotebookId, "page_workspace_start");
  assert.equal(notebooks[0][1].cells.length, 1);
  baseCellId = notebooks[0][1].cells[0].id;
  originalCellTitle = notebooks[0][1].cells[0].title;
  unknownPosition = { notebookIndex: 1, cellIndex: 2, kind: unknownKind };

  await writeFile(join(evidenceDirectory, "manifest-backup", "agentcanvas.project.json"), originalBytes, { flag: "wx" });
  expectedManifestHash = expectedOriginalSha256;
  coverage.syntheticOwnership = true;
}

function buildUnknownManifest() {
  const value = structuredClone(originalManifest);
  value.state.dataProduct.notebooks[baseNotebookId].cells.push({
    id: `compat_unknown_${runId}`,
    kind: unknownKind,
    title: secretMarker,
    source: `source:${secretMarker}`,
    code: `print(${JSON.stringify(secretMarker)})`,
    payload: { confidentialMarker: secretMarker },
  });
  return value;
}

async function replaceManifest(nextBytes, reason) {
  const current = await readFile(manifestPath);
  const currentHash = sha256(current);
  assert.equal(currentHash, expectedManifestHash, `Refusing ${reason}: manifest no longer matches this verifier's expected hash`);
  const nextHash = sha256(nextBytes);
  await writeFile(manifestPath, nextBytes);
  const written = await readFile(manifestPath);
  assert.equal(sha256(written), nextHash, `${reason} did not write the expected bytes`);
  mutations.push({ reason, fromSha256: currentHash, toSha256: nextHash, bytes: nextBytes.length });
  expectedManifestHash = nextHash;
}

async function assertResourcesUnchanged() {
  for (const entry of resourceHashes) {
    const bytes = await readFile(join(projectPath, entry.folder, entry.file));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha256(bytes), entry.sha256, `${entry.folder}/${entry.file} changed`);
  }
  assert.deepEqual((await readdir(join(projectPath, "tables"))).sort(), originalManifest.tables.map((entry) => entry.file).sort());
  assert.deepEqual((await readdir(join(projectPath, "files"))).sort(), originalManifest.files.map((entry) => entry.file).sort());
}

function observe(target) {
  target.setDefaultTimeout(20_000);
  target.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  target.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url });
  });
  target.on("response", (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (url.origin === base && url.pathname === "/api/projects") {
      let action;
      try { action = request.method() === "POST" ? request.postDataJSON()?.action : undefined; } catch { /* Captured explicitly below. */ }
      projectResponses.push({ scenario, method: request.method(), action, status: response.status(), scoped: Boolean(request.headers()[projectHeader]) });
    }
  });
}

const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const compatibilityNotice = () => page.getByRole("alert", { name: "项目兼容性检查", exact: true });
const baseCell = (title = editedTitle) => page.getByRole("article", { name: `Data单元 ${title}`, exact: true });

async function openDataBrowser() {
  if (await dataBrowser().isVisible()) return;
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click();
  await dataBrowser().waitFor();
}

async function closeDataBrowser() {
  await dataBrowser().getByRole("button", { name: "关闭数据浏览器", exact: true }).click();
  await dataBrowser().waitFor({ state: "hidden" });
}

async function selectProjectsCategory() {
  const navigation = dataBrowser().getByRole("navigation", { name: "数据资源分类", exact: true });
  await navigation.getByRole("button", { name: /项目文件夹/u }).click();
}

async function openProject(expectedStatus) {
  await openDataBrowser();
  await selectProjectsCategory();
  await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
  const pending = page.waitForResponse((response) => {
    if (response.url() !== `${base}/api/projects` || response.request().method() !== "POST") return false;
    try { return response.request().postDataJSON()?.action === "open"; } catch { return false; }
  }, { timeout: 30_000 });
  await dataBrowser().getByRole("button", { name: "打开已有项目", exact: true }).click();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status(), expectedStatus, JSON.stringify(body));
  if (expectedStatus === 200) {
    assert.equal(resolve(body.path), projectPath);
    assert.equal(body.manifest.id, expectedProjectId);
    handle = body.handle;
    await dataBrowser().waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), handle);
  }
  return { response, body };
}

async function screenshot(name, focus, assertions) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide horizontal overflow is allowed");
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, viewport: page.viewportSize(), assertions });
}

function assertCompatibilityBody(body, expected) {
  assert.equal(typeof body.error?.message, "string");
  assert.deepEqual(body.error.compatibility, expected);
  assert.equal(JSON.stringify(body).includes(secretMarker), false, "Compatibility API metadata must not disclose unknown cell content");
}

async function assertUnknownNotice() {
  const notice = compatibilityNotice();
  await notice.waitFor();
  const text = await notice.innerText();
  assert.match(text, /项目定义与当前版本不兼容/u);
  assert.match(text, /第 1 个 Notebook · 第 2 个单元/u);
  assert.ok(text.includes(unknownKind));
  assert.equal(text.includes(secretMarker), false, "Compatibility UI must not render the source marker");
  assert.equal((await page.locator("body").innerText()).includes(secretMarker), false, "The source marker must not appear anywhere in the rendered page");
  return notice;
}

function assertOwnedSavedManifest(value) {
  assert.equal(value.id, originalManifest.id);
  assert.equal(value.name, originalManifest.name);
  assert.equal(value.format, originalManifest.format);
  assert.equal(value.stateRevision, originalManifest.stateRevision + 1);
  assert.deepEqual(value.tables, originalManifest.tables);
  assert.deepEqual(value.files, originalManifest.files);
  assert.equal(JSON.stringify(value).includes(secretMarker), false);
  const currentBook = value.state.dataProduct.notebooks[baseNotebookId];
  const originalBook = originalManifest.state.dataProduct.notebooks[baseNotebookId];
  assert.equal(currentBook.revision, originalBook.revision + 1);
  assert.equal(currentBook.cells.length, originalBook.cells.length);
  assert.equal(currentBook.cells.find((cell) => cell.id === baseCellId)?.title, editedTitle);

  const normalizedCurrent = structuredClone(value);
  const normalizedOriginal = structuredClone(originalManifest);
  normalizedCurrent.updatedAt = normalizedOriginal.updatedAt;
  normalizedCurrent.stateRevision = normalizedOriginal.stateRevision;
  normalizedCurrent.state.savedAt = normalizedOriginal.state.savedAt;
  normalizedCurrent.state.dataProduct.notebooks[baseNotebookId].revision = originalBook.revision;
  normalizedCurrent.state.dataProduct.notebooks[baseNotebookId].cells.find((cell) => cell.id === baseCellId).title = originalCellTitle;
  assert.deepEqual(normalizedCurrent, normalizedOriginal, "Only the intended local title, notebook revision and save timestamps may change");
}

async function adoptSuccessfulSave() {
  const bytes = await readFile(manifestPath);
  const currentHash = sha256(bytes);
  assert.notEqual(currentHash, expectedManifestHash, "Successful retry must replace the restored original manifest");
  const value = JSON.parse(bytes.toString("utf8"));
  assertOwnedSavedManifest(value);
  mutations.push({ reason: "real API retry save", fromSha256: expectedManifestHash, toSha256: currentHash, bytes: bytes.length });
  expectedManifestHash = currentHash;
  finalManifestBeforeRestore = { sha256: currentHash, stateRevision: value.stateRevision, editedTitle };
  return value;
}

async function safelyRestoreOriginal(reason) {
  if (!originalBytes || !expectedManifestHash) return;
  const current = await readFile(manifestPath);
  const currentHash = sha256(current);
  if (currentHash === expectedOriginalSha256) {
    expectedManifestHash = expectedOriginalSha256;
    return;
  }
  // A crash after our successful POST can leave the expected hash one transition behind.
  // Adopt only an exact, narrowly validated result of this verifier's intended title edit.
  if (currentHash !== expectedManifestHash && expectedManifestHash === expectedOriginalSha256) {
    const value = JSON.parse(current.toString("utf8"));
    assertOwnedSavedManifest(value);
    mutations.push({ reason: "adopt verified real API retry before restoration", fromSha256: expectedManifestHash, toSha256: currentHash, bytes: current.length });
    expectedManifestHash = currentHash;
  }
  assert.equal(currentHash, expectedManifestHash, `Refusing ${reason}: concurrent manifest change detected`);
  await replaceManifest(originalBytes, reason);
  assert.equal(sha256(await readFile(manifestPath)), expectedOriginalSha256);
}

await verifySyntheticProject();
const unknownManifest = buildUnknownManifest();
unknownBytes = jsonBytes(unknownManifest);
unknownHash = sha256(unknownBytes);
const versionManifest = structuredClone(originalManifest);
versionManifest.state.version = supportedWorkspaceVersion + 1;
versionBytes = jsonBytes(versionManifest);
versionHash = sha256(versionBytes);

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
      if (url.pathname === "/api/projects") {
        const requestHandle = request.headers()[projectHeader];
        if (request.method() === "GET" && !requestHandle) {
          recentProjectReads += 1;
          return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
        }
        const body = request.method() === "POST" ? request.postDataJSON() : undefined;
        const action = body?.action;
        if (request.method() === "POST") {
          assert.ok(["open", "save"].includes(action), `Unexpected project action ${action}`);
          if (action === "open") assert.equal(resolve(body.path), projectPath);
          if (action === "save") {
            assert.equal(requestHandle, handle, "Save must stay scoped to the opened synthetic project");
            const candidateBook = body.state?.dataProduct?.notebooks?.[baseNotebookId];
            assert.equal(candidateBook?.cells?.find((cell) => cell.id === baseCellId)?.title, editedTitle);
            assert.equal(JSON.stringify(body).includes(secretMarker), false);
          }
        }
        if (requestHandle && handle) assert.equal(requestHandle, handle, "Scoped reads must stay in the opened synthetic project");
        projectRequests.push({ scenario, method: request.method(), action, handle: requestHandle ?? null });
      }
      if (url.pathname === "/api/notebook/run") {
        notebookRequests.push({ scenario, method: request.method() });
      }
      return await route.continue();
    } catch (error) {
      routeErrors.push({ scenario, message: String(error) });
      return await route.abort("failed").catch(() => {});
    }
  });

  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });

  await step("Unknown Notebook kind is rejected by real open with bounded metadata only", async () => {
    await replaceManifest(unknownBytes, "inject one unknown Notebook kind for open rejection");
    assert.equal(expectedManifestHash, unknownHash);
    const { body } = await openProject(409);
    const expected = { code: "project_incompatible", reason: "notebook-cells", cells: [unknownPosition], total: 1, omitted: 0 };
    assertCompatibilityBody(body, expected);
    const notice = await assertUnknownNotice();
    assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), null);
    apiChecks.push({ operation: "open", fault: "unknown Notebook kind", status: 409, compatibility: body.error.compatibility, sourceMarkerDisclosed: false });
    await screenshot("01-unknown-kind-open-rejected-1440", notice, [
      "Real managed 3001 POST open returns 409 and identifies Notebook 1 / cell 2 / futureMatrix",
      "The unknown title, source, code and nested marker are absent from API metadata and the rendered page",
      "The project is not installed or executed",
    ]);
    coverage.unknownOpenRejected = true;
  });

  await step("Closing the failed-open dialog keeps the original temporary workspace", async () => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await closeDataBrowser();
    assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), null);
    const temporaryText = await page.locator("body").innerText();
    assert.match(temporaryText, /空白工作界面/u);
    assert.equal(temporaryText.includes(expectedProjectName), false);
    await screenshot("02-close-keeps-temporary-workspace-1024", null, [
      "Closing the rejected open returns to the unchanged temporary workspace",
      "No project handle is stored and the incompatible project name is not installed",
    ]);
    coverage.closeKeepsTemporaryWorkspace = true;
  });

  await step("A newer persisted workspace version is also rejected by real open", async () => {
    await replaceManifest(originalBytes, "restore exact original bytes after unknown-open rejection");
    await replaceManifest(versionBytes, "inject workspace version 7 for open rejection");
    assert.equal(expectedManifestHash, versionHash);
    const { body } = await openProject(409);
    const expected = { code: "project_incompatible", reason: "workspace-version", supportedVersion: 6, detectedVersion: 7 };
    assertCompatibilityBody(body, expected);
    const notice = compatibilityNotice();
    await notice.waitFor();
    const text = await notice.innerText();
    assert.match(text, /工作台版本 7 高于当前支持的版本 6/u);
    assert.equal(text.includes(secretMarker), false);
    apiChecks.push({ operation: "open", fault: "workspace version 7", status: 409, compatibility: body.error.compatibility });
    await screenshot("03-newer-workspace-version-rejected-1024", notice, [
      "Real managed 3001 POST open returns 409 for persisted workspace version 7",
      "The card states supported version 6 and refuses conversion, deletion or blank overwrite",
    ]);
    await closeDataBrowser();
    coverage.newerVersionOpenRejected = true;
  });

  await step("Restoring the original manifest makes explicit open succeed without Notebook auto-run", async () => {
    await replaceManifest(originalBytes, "restore exact original bytes after newer-version rejection");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const beforeRuns = notebookRequests.length;
    const { body } = await openProject(200);
    assert.equal(body.manifest.stateRevision, originalManifest.stateRevision);
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    const cell = baseCell(originalCellTitle);
    await cell.waitFor();
    assert.equal(await cell.locator(".notebook-result").count(), 0);
    assert.equal(await cell.locator(".notebook-cell-status").innerText(), "待运行");
    // Let the compatible project's own Dataset restoration finish before changing
    // its manifest externally. Otherwise unrelated in-flight reads would correctly
    // encounter the later compatibility gate and muddy the save-only evidence.
    await sleep(2_500);
    await page.waitForLoadState("networkidle");
    assert.equal(notebookRequests.length, beforeRuns, "Opening a compatible project must not execute Notebook cells");
    await screenshot("04-restored-open-no-auto-run-1440", cell, [
      "The same folder opens successfully only after exact manifest restoration",
      "Saved Notebook definition is visible as pending with no result cache and no run request",
    ]);
    coverage.recoveredOpenWithoutAutoRun = true;
  });

  await step("An external unknown-kind update rejects real autosave and retains the local edit", async () => {
    await replaceManifest(unknownBytes, "inject unknown kind while the compatible project remains open");
    const cell = baseCell(originalCellTitle);
    await cell.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = cell.locator(".notebook-editor");
    await editor.getByLabel("单元名称", { exact: true }).fill(editedTitle);
    const pending = page.waitForResponse((response) => {
      if (response.url() !== `${base}/api/projects` || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.action === "save"; } catch { return false; }
    }, { timeout: 30_000 });
    await editor.getByRole("button", { name: "保存单元", exact: true }).click();
    const response = await pending;
    const body = await response.json();
    assert.equal(response.status(), 409, JSON.stringify(body));
    assertCompatibilityBody(body, { code: "project_incompatible", reason: "notebook-cells", cells: [unknownPosition], total: 1, omitted: 0 });
    assert.equal(sha256(await readFile(manifestPath)), unknownHash, "Rejected save must not change the incompatible manifest");
    const edited = baseCell();
    await edited.waitFor();
    assert.equal(await edited.getByRole("heading", { level: 2 }).innerText(), editedTitle);
    await page.locator(".persistence-notice").filter({ hasText: /备份|未保存/u }).waitFor();
    await screenshot("05-real-save-409-keeps-local-edit-1440", edited, [
      "Manual title edit remains in the open window after a real save 409",
      "Autosave is paused; the external incompatible manifest is unchanged and no Notebook run occurs",
    ]);
    apiChecks.push({ operation: "save", fault: "external unknown Notebook kind", status: 409, compatibility: body.error.compatibility, diskSha256: unknownHash });
    coverage.unknownSaveRejected = true;
  });

  await step("Explicit retry re-reads the still-incompatible manifest and refuses another write", async () => {
    await openDataBrowser();
    const notice = await assertUnknownNotice();
    assert.match(await dataBrowser().innerText(), /自动保存已暂停/u);
    await page.setViewportSize({ width: 1024, height: 900 });
    const responseCount = projectResponses.length;
    const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects`
      && response.request().method() === "GET" && Boolean(response.request().headers()[projectHeader]), { timeout: 30_000 });
    await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).click();
    const response = await pending;
    const body = await response.json();
    assert.equal(response.status(), 409, JSON.stringify(body));
    assertCompatibilityBody(body, { code: "project_incompatible", reason: "notebook-cells", cells: [unknownPosition], total: 1, omitted: 0 });
    await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).waitFor();
    assert.equal(projectResponses.slice(responseCount).some((entry) => entry.action === "save"), false, "Retry must not POST after incompatible re-read");
    assert.equal(sha256(await readFile(manifestPath)), unknownHash);
    assert.equal(await baseCell().getByRole("heading", { level: 2 }).innerText(), editedTitle);
    const projectHeaderBox = await dataBrowser().locator(".data-browser-project").boundingBox();
    const projectIdentityBox = await dataBrowser().locator(".data-browser-project > div").boundingBox();
    assert.ok(projectHeaderBox && projectHeaderBox.height <= 140, "Compatibility status must not make the project header excessively tall");
    assert.ok(projectIdentityBox && projectIdentityBox.width >= 250, "Project name/path must retain readable width at 1024px");
    await screenshot("06-retry-still-refused-1024", notice, [
      "Retry performs a real scoped GET, receives 409, and sends no save POST",
      "The compatibility card, recovery controls and local edited title remain retained",
    ]);
    apiChecks.push({ operation: "retry read", fault: "unknown Notebook kind still present", status: 409, compatibility: body.error.compatibility, savePosted: false });
    coverage.retryStillRejected = true;
  });

  await step("After exact restoration, explicit retry saves the retained edit through real GET and POST", async () => {
    await replaceManifest(originalBytes, "restore exact original bytes before explicit save retry");
    const pendingRead = page.waitForResponse((response) => response.url() === `${base}/api/projects`
      && response.request().method() === "GET" && Boolean(response.request().headers()[projectHeader]), { timeout: 30_000 });
    const pendingSave = page.waitForResponse((response) => {
      if (response.url() !== `${base}/api/projects` || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.action === "save"; } catch { return false; }
    }, { timeout: 30_000 });
    await dataBrowser().getByRole("button", { name: "重试保存", exact: true }).click();
    const readResponse = await pendingRead;
    assert.equal(readResponse.status(), 200, await readResponse.text());
    const saveResponse = await pendingSave;
    const saveBody = await saveResponse.json();
    assert.equal(saveResponse.status(), 200, JSON.stringify(saveBody));
    assert.equal(saveBody.stateRevision, originalManifest.stateRevision + 1);
    const value = await adoptSuccessfulSave();
    assert.equal(value.state.dataProduct.notebooks[baseNotebookId].cells.find((cell) => cell.id === baseCellId).title, editedTitle);
    await dataBrowser().getByText("保存完成，修改已写入本地项目。", { exact: true }).waitFor();
    await dataBrowser().locator(".project-save-status.saved").waitFor({ state: "attached" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await screenshot("07-restored-explicit-retry-succeeds-1024", dataBrowser().getByText("保存完成，修改已写入本地项目。", { exact: true }), [
      "After external restoration, explicit retry performs a real scoped GET and one real save POST",
      "The retained local title reaches revision 126; no unknown cell or source marker is persisted",
    ]);
    apiChecks.push({ operation: "retry read and save", restored: true, readStatus: 200, saveStatus: 200, stateRevision: saveBody.stateRevision, savedSha256: expectedManifestHash });
    coverage.restoredRetrySaved = true;
  });

  assert.equal(notebookRequests.length, 0, "No open, edit, failure or retry step may execute a Notebook");
  const expectedProject409 = consoleErrors.filter((entry) => entry.url === `${base}/api/projects` && /status of 409/u.test(entry.text));
  const unexpectedConsoleErrors = consoleErrors.filter((entry) => !expectedProject409.includes(entry));
  consoleSummary = { expectedProject409: expectedProject409.length, unexpected: unexpectedConsoleErrors.length };
  assert.equal(expectedProject409.length, projectResponses.filter((entry) => entry.status === 409).length,
    "Each real project compatibility 409 should be the only expected browser console resource error");
  assert.deepEqual(unexpectedConsoleErrors, [], "Non-project-409 browser console errors are not accepted");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(routeErrors, []);
  assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads > 0);
  assert.ok(recentProjectReads > 0);
  await assertResourcesUnchanged();
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
  await page?.screenshot({ path: join(evidenceDirectory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  try {
    await safelyRestoreOriginal("final exact original-byte restoration");
    await assertResourcesUnchanged();
    const restored = await readFile(manifestPath);
    assert.equal(restored.equals(originalBytes), true, "Final manifest bytes must exactly equal the baseline backup");
    coverage.exactRestoration = true;
  } catch (restoreError) {
    passed = false;
    process.exitCode = 1;
    failure = failure ?? { scenario: "final exact original-byte restoration", message: String(restoreError), stack: restoreError instanceof Error ? restoreError.stack : undefined };
  }

  const report = {
    passed,
    base,
    directory: siteRelative(evidenceDirectory),
    projectPath: siteRelative(projectPath),
    previousReport: siteRelative(priorReportPath),
    project: { id: expectedProjectId, name: expectedProjectName, originalSha256: expectedOriginalSha256, originalBytes: originalBytes?.length,
      originalStateRevision: originalManifest?.stateRevision, backup: "manifest-backup/agentcanvas.project.json", finalExactOriginalBytes: coverage.exactRestoration },
    faults: { unknown: { sha256: unknownHash, kind: unknownKind, position: unknownPosition, sourceMarkerDisclosed: false },
      newerWorkspace: { sha256: versionHash, supportedVersion: 6, detectedVersion: 7 } },
    handle,
    editedTitle,
    finalManifestBeforeRestore,
    coverage,
    checks,
    screenshots,
    apiChecks,
    mutations,
    projectRequests,
    projectResponses,
    notebookRequests,
    resourceHashes,
    fixtures: {
      directoryReads,
      recentProjectReads,
      externalFontFixtures,
      description: "Only GET /api/connections, unscoped GET /api/projects, and exact https://rsms.me/inter/inter.css use fixtures. Project open/read/save and every 409 compatibility response come from real managed 3001. No model, external database, project, save, or Notebook-run response is injected.",
    },
    consoleErrors,
    consoleSummary,
    pageErrors,
    routeErrors,
    forbiddenRequests,
    failure,
    boundaries: [
      "Only the fixed prior failed synthetic project is used. Its registry entry, table files and original files are never removed or replaced.",
      "Unknown-kind and version faults are temporary manifest-only mutations. Every replacement checks the current exact SHA first; final cleanup restores the original manifest bytes and rechecks every resource hash.",
      "Unknown cell contents are deliberate secret markers used only to prove non-disclosure. The API/UI may expose bounded 1-based positions and the valid unknown kind, but never title, source, code or nested payload.",
      "All project compatibility failures are real HTTP 409 responses from managed development port 3001. The stable port 3000 is not contacted or published.",
      "No Notebook execution, model request, external database, deletion, schema relaxation, service lifecycle action or user project is involved.",
    ],
    visualReview: { completed: false, note: "Every listed screenshot must be opened with view_image after the run; this script alone does not claim visual review." },
  };
  await writeFile(join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, report: siteRelative(join(evidenceDirectory, "report.json")), checks: checks.length, screenshots: screenshots.length, restored: coverage.exactRestoration, failure }, null, 2));
}
