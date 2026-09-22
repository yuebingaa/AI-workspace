// Actual managed 3001 read-only inspection. No project is registered, opened, edited or executed.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const base = "http://127.0.0.1:3001";
const runId = Date.now();
const evidence = resolve(".runtime/hex-project-inspection-2026-09-21", `browser-${runId}`);
const projectsRoot = join(evidence, "unregistered-projects");
const manifestName = "agentcanvas.project.json";
const unknownMarker = `UNKNOWN_PAYLOAD_NOT_FOR_DISPLAY_${runId}`;
const sourceTailMarker = `SQL_TRUNCATED_TAIL_${runId}`;
const shortSql = "SELECT value AS synthetic_total FROM threshold_input";
const longSql = `${shortSql}\n${"-- bounded synthetic SQL source for read-only inspection\n".repeat(65)}-- ${sourceTailMarker}`;
const unknownKind = "futureMatrix";
const timestamp = "2026-09-21T00:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const siteRelative = (path) => relative(process.cwd(), path).split(sep).join("/");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
assert.equal(process.argv.length, 2, "Only fresh synthetic fixtures owned by this verifier are permitted");

const fixtures = {};
const checks = [], screenshots = [], apiChecks = [], requests = [], responses = [];
const pageErrors = [], consoleErrors = [], routeErrors = [], forbiddenRequests = [], cancelledRequests = [];
let browser, context, page, scenario = "setup", failure, indexPath, initialIndex, initialTrees;
let passed = false, fixtureDirectoryReads = 0, fixtureRecentReads = 0, fixtureFonts = 0;
let delayNextInspection = false, delayedReady, releaseDelayed, delayedFinished;

function state() {
  const appSpec = { id: "inspection_app", siteId: "inspection_site", schemaVersion: "1.0", dataSources: [],
    navigation: [{ id: "inspection_nav", title: "只读验收", pageId: "inspection_page" }],
    pages: [{ id: "inspection_page", title: "只读验收", route: "/inspection", root: { id: "inspection_root", type: "PageRoot", props: {}, children: [] } }] };
  const notebook = { name: "合成分析步骤（不执行）", revision: 2, cells: [
    { id: "threshold", title: "合成输入参数", kind: "parameter", outputName: "threshold_input", parameter: { type: "number", value: 230 } },
    { id: "short_sql", title: "合法 SQL 只读源码", kind: "sql", inputCellIds: ["threshold"], outputName: "synthetic_summary", sql: shortSql },
    { id: "long_sql", title: "长 SQL 有界展示", kind: "sql", inputCellIds: ["threshold"], outputName: "bounded_summary", sql: longSql },
  ] };
  return { version: 6, dataProduct: { id: "inspection_product", name: "合成项目", schemaVersion: "1.0", datasets: [], recipes: [],
    semanticLayer: { models: [], selectedByWorkspace: {} }, notebooks: { inspection_page: notebook }, appSpec }, appSpec,
    changeHistory: [], appliedChangeSetIds: [], auditRecords: [], queryRecords: [], harnessTasks: [], assistantConversation: [],
    assistantConversationInitialized: true, assistantSessions: null, edsWorkspace: null, savedAt: timestamp };
}

function manifest(name) {
  return { format: "agentcanvas-local-project-v1", id: randomUUID(), name, createdAt: timestamp, updatedAt: timestamp,
    stateRevision: 4, state: state(), tables: [], files: [] };
}

async function writeFixture(key, value) {
  const path = join(projectsRoot, key);
  await mkdir(join(path, "tables"), { recursive: true });
  await mkdir(join(path, "files"));
  await writeFile(join(path, manifestName), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fixtures[key] = { path, name: typeof value === "string" ? "坏 JSON 合成项目" : value.name };
}

async function fileDigest(path) {
  try {
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Only regular non-link files may be hashed");
    const bytes = await readFile(path);
    return { exists: true, bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) { if (error?.code === "ENOENT") return { exists: false }; throw error; }
}

async function treeDigest(root, directory = root) {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false, "Synthetic fixture tree must not contain links");
    const name = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) entries.push({ path: name, directory: true }, ...await treeDigest(root, path));
    else entries.push({ path: name, ...await fileDigest(path) });
  }
  return entries;
}

async function unchanged() {
  assert.deepEqual(await treeDigest(projectsRoot), initialTrees, "Read-only inspection must not change any fixture bytes or create files");
  assert.deepEqual(await fileDigest(indexPath), initialIndex, "The managed dev recent-project index must remain byte-identical");
}

async function step(name, action) { scenario = name; await action(); checks.push(name); console.log(`PASS ${name}`); }
const dialog = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
const panel = () => dialog().locator("main").filter({ has: page.getByRole("heading", { name: "项目步骤 · 只读查看", exact: true }) });

async function openDataBrowser() {
  if (await dialog().isVisible()) return;
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill("Data Browser");
  await menu.getByRole("button", { name: "数据浏览器", exact: true }).click();
  await dialog().waitFor();
}

async function projectList() {
  await openDataBrowser();
  if (await dialog().getByRole("button", { name: "返回项目列表", exact: true }).isVisible()) {
    await dialog().getByRole("button", { name: "返回项目列表", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "只读查看步骤");
  }
  await dialog().getByRole("navigation", { name: "数据资源分类", exact: true }).getByRole("button", { name: /项目文件夹/u }).click();
  await dialog().getByLabel("项目文件夹绝对路径", { exact: true }).waitFor();
}

function assertNoSession(value) {
  assert.equal(Object.hasOwn(value, "handle"), false, "Inspection must not issue a project handle");
  assert.equal(Object.hasOwn(value, "manifest"), false, "Inspection must not return a raw project manifest");
}

function assertSuccess(value, unknown) {
  assertNoSession(value);
  assert.equal(value.mode, "read-only");
  assert.equal(value.unknownCellCount, unknown ? 1 : 0);
  assert.equal(value.notebooks.length, 1);
  const cells = value.notebooks[0].cells;
  assert.equal(cells.find((cell) => cell.id === "short_sql")?.source?.text, shortSql);
  const long = cells.find((cell) => cell.id === "long_sql");
  assert.equal(long.source.language, "sql");
  assert.ok(long.source.text.length <= 2000);
  assert.equal(long.source.truncated, true);
  assert.equal(JSON.stringify(value).includes(sourceTailMarker), false);
  assert.equal(JSON.stringify(value).includes(unknownMarker), false);
  assert.equal(cells.filter((cell) => cell.support === "unknown").length, unknown ? 1 : 0);
  if (unknown) {
    const unsupported = cells.find((cell) => cell.support === "unknown");
    assert.equal(unsupported.kind, unknownKind);
    assert.equal(Object.hasOwn(unsupported, "source"), false);
  }
}

async function inspect(key, expectSuccess = true) {
  await projectList();
  await dialog().getByLabel("项目文件夹绝对路径", { exact: true }).fill(fixtures[key].path);
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/projects/inspect` && response.request().method() === "POST");
  await dialog().getByRole("button", { name: "只读查看步骤", exact: true }).click();
  const response = await pending;
  const body = await response.json();
  assertNoSession(body);
  assert.equal(response.ok(), expectSuccess, JSON.stringify(body));
  apiChecks.push({ fixture: key, status: response.status(), success: response.ok(), noHandle: true });
  await panel().waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), null);
  if (expectSuccess) {
    assertSuccess(body, key === "unknown");
    await panel().getByText(fixtures[key].name, { exact: true }).waitFor();
    assert.match(await panel().innerText(), /不会切换当前项目，不执行代码，也不保存修改/u);
  } else await panel().getByRole("alert").waitFor();
  return body;
}

async function screenshot(name, focus, assertions) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page must not overflow the desktop viewport");
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, scenario, viewport: page.viewportSize(), assertions });
}

async function waitForInspectionApi() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const response = await fetch(`${base}/api/projects/inspect`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 405) return;
    await sleep(500);
  }
  throw new Error("Managed 3001 inspection endpoint is not ready; no project mutation attempted");
}

await mkdir(projectsRoot, { recursive: true });
try {
  const normal = manifest("只读检查 · 合法已知步骤");
  const unknown = manifest("只读检查 · 含未知步骤");
  unknown.state.dataProduct.notebooks.inspection_page.cells.splice(2, 0, { id: "future_step", title: "合成未知矩阵步骤", kind: unknownKind,
    code: unknownMarker, source: unknownMarker, payload: { marker: unknownMarker } });
  const invalid = manifest("只读检查 · 非法已知步骤");
  invalid.state.dataProduct.notebooks.inspection_page.cells[1].sql = 123;
  const future = manifest("只读检查 · 较新工作台版本"); future.state.version = 7;
  await writeFixture("normal", normal); await writeFixture("unknown", unknown); await writeFixture("invalid-known", invalid);
  await writeFixture("future-version", future); await writeFixture("bad-json", '{"format":"agentcanvas-local-project-v1", invalid JSON');
  initialTrees = await treeDigest(projectsRoot);
  const runtimeLocation = JSON.parse(await readFile(resolve(".runtime/runtime-location.json"), "utf8"));
  const runtimeConfig = JSON.parse(await readFile(join(runtimeLocation.root, "config.json"), "utf8"));
  indexPath = join(runtimeConfig.devState, "local-projects.json");
  initialIndex = await fileDigest(indexPath);
  await waitForInspectionApi();

  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push({ scenario, message: error.message }));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ scenario, text: message.text(), url: message.location().url }); });
  page.on("requestfailed", (request) => { if (request.url() === `${base}/api/projects/inspect`) cancelledRequests.push({ scenario, error: request.failure()?.errorText }); });
  page.on("response", (response) => { if (response.url() === `${base}/api/projects/inspect`) responses.push({ scenario, status: response.status() }); });
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (url.href === "https://rsms.me/inter/inter.css") { fixtureFonts += 1; return await route.fulfill({ status: 200, contentType: "text/css", body: "" }); }
      if (url.origin !== base) { forbiddenRequests.push(url.origin); return await route.abort("blockedbyclient"); }
      if (url.pathname === "/api/connections" && request.method() === "GET") {
        fixtureDirectoryReads += 1; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"connections":[]}' });
      }
      if (url.pathname === "/api/projects" && request.method() === "GET" && !request.headers()["x-agentcanvas-project"]) {
        fixtureRecentReads += 1; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' });
      }
      if (url.pathname === "/api/projects/inspect") {
        assert.equal(request.method(), "POST"); assert.equal(request.headers()["x-agentcanvas-project"], undefined);
        const body = request.postDataJSON(); assert.deepEqual(Object.keys(body), ["path"]);
        const fixture = Object.entries(fixtures).find(([, entry]) => resolve(body.path) === entry.path)?.[0];
        assert.ok(fixture, "Only newly owned, unregistered fixtures may be inspected");
        requests.push({ scenario, fixture, method: request.method() });
        if (delayNextInspection) {
          delayNextInspection = false;
          const response = await route.fetch(); assert.equal(response.status(), 200);
          let finish; delayedFinished = new Promise((done) => { finish = done; });
          const held = new Promise((done) => { releaseDelayed = done; });
          delayedReady(); await held;
          try { await route.fulfill({ response }); } catch { /* The intended AbortController may already have cancelled delivery. */ }
          finish(); return;
        }
        return await route.continue();
      }
      if (url.pathname.startsWith("/api/projects") || url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/connections")
        || url.pathname === "/api/notebook/run" || (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))) {
        forbiddenRequests.push(`${request.method()} ${url.pathname}`); return await route.abort("blockedbyclient");
      }
      return await route.continue();
    } catch (error) { routeErrors.push({ scenario, message: String(error) }); return await route.abort("failed").catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });

  await step("Unknown current-version cell opens in real read-only inspection without exposing its payload", async () => {
    await inspect("unknown");
    await panel().getByText("当前版本不支持此单元", { exact: true }).waitFor();
    assert.ok((await panel().innerText()).includes(unknownKind));
    assert.equal((await page.locator("body").innerText()).includes(unknownMarker), false);
    assert.equal(await dialog().getByRole("navigation", { name: "数据资源分类" }).count(), 0);
    assert.equal(await panel().getByRole("button", { name: /运行|保存|采用|AI|Agent/u }).count(), 0);
    await screenshot("01-unknown-read-only-1440", panel().getByText("当前版本不支持此单元", { exact: true }), ["Real unregistered-project inspection succeeds", "Unknown payload is absent, no execution or save controls"]);
  });
  await step("Known SQL is readable and long source remains bounded at 1440 and 1024", async () => {
    await panel().getByText("查看 SQL 源码", { exact: true }).first().click();
    assert.ok((await panel().innerText()).includes(shortSql));
    await screenshot("02-known-sql-source-1440", panel().getByText(shortSql, { exact: true }), ["A validated known SQL cell exposes only read-only source", "No editor, execution or adoption action"]);
    await panel().getByText("查看 SQL 源码", { exact: true }).last().click();
    const codeBlocks = panel().locator("pre");
    assert.ok((await codeBlocks.last().innerText()).length <= 2000);
    assert.equal((await panel().innerText()).includes(sourceTailMarker), false);
    await page.setViewportSize({ width: 1024, height: 900 });
    const truncatedNotice = panel().getByText("源码仅显示前段，未修改原文件。", { exact: true });
    await truncatedNotice.waitFor();
    assert.ok(await codeBlocks.last().evaluate((element) => element.clientHeight <= 320 && element.scrollHeight > element.clientHeight), "Long source scrolls inside its bounded code viewport");
    await screenshot("03-bounded-long-source-1024", panel().locator("li").filter({ hasText: "长 SQL 有界展示" }), ["Long SQL text is bounded, truncation notice is visible and tail marker not rendered", "Desktop dialog remains within viewport, with long source scrolling inside its own code block"]);
  });
  await step("Returning to the project list and inspecting a fully supported project does not open it", async () => {
    await projectList();
    await screenshot("04-return-to-project-list-1024", dialog().getByLabel("项目文件夹绝对路径", { exact: true }), ["Explicit return closes the inspection subview", "Current workspace remains temporary"]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await inspect("normal");
    assert.equal(await panel().getByText("当前版本不支持此单元", { exact: true }).count(), 0);
    await screenshot("05-known-project-read-only-1440", panel(), ["A fully valid project uses the same read-only route", "No project handle or registry entry created"]);
  });
  for (const [key, width, height, shot] of [["invalid-known", 1024, 900, "06-invalid-known-rejected-1024"], ["future-version", 1024, 900, "07-future-version-rejected-1024"], ["bad-json", 1440, 1000, "08-invalid-json-rejected-1440"]]) {
    await step(`Invalid fixture ${key} produces a real inspect failure, never a partial editable project`, async () => {
      await page.setViewportSize({ width, height }); await inspect(key, false);
      await screenshot(shot, panel().getByRole("alert"), ["Real managed API rejects this unsupported or invalid fixture", "Return/retry remain available and no project is installed"]);
    });
  }
  await step("Returning during a held real inspection cancels adoption and ignores late delivery", async () => {
    await inspect("unknown");
    const ready = new Promise((done) => { delayedReady = done; }); delayNextInspection = true;
    await dialog().getByRole("button", { name: "重新读取", exact: true }).click();
    await ready;
    await panel().getByRole("status").filter({ hasText: "正在读取项目步骤" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "返回项目列表");
    await screenshot("09-reread-loading-retains-focus-1440", panel(), ["Re-read holds a real API response", "When the re-read button unmounts, focus remains on the available back button"]);
    await dialog().getByRole("button", { name: "返回项目列表", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "只读查看步骤");
    releaseDelayed(); await delayedFinished; await sleep(250);
    await dialog().getByRole("heading", { name: "本地项目文件夹", exact: true }).waitFor();
    assert.equal(await panel().count(), 0);
    await page.setViewportSize({ width: 1024, height: 900 });
    await screenshot("10-cancelled-inspection-keeps-list-1024", dialog(), ["Only response delivery was delayed; server inspection was real", "Returning restores trigger focus and late data does not replace the project list"]);
  });
  await step("Closing and reloading preserve the temporary workspace without automatic inspection", async () => {
    await inspect("unknown");
    await dialog().getByRole("button", { name: "关闭数据浏览器", exact: true }).click();
    await dialog().waitFor({ state: "hidden" });
    const before = requests.length; await page.reload({ waitUntil: "networkidle" });
    assert.equal(requests.length, before);
    assert.equal(await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1")), null);
    assert.equal(await dialog().count(), 0);
    await screenshot("11-reloaded-temporary-workspace-1024", null, ["Refresh neither reopens inspection nor installs the inspected project", "No automatic execution, save or project registration"]);
  });
  await unchanged();
  const expectedHttpErrors = consoleErrors.filter((entry) => entry.url === `${base}/api/projects/inspect` && /status of (?:400|403|404|409|413|500)/u.test(entry.text));
  assert.equal(expectedHttpErrors.length, responses.filter((entry) => entry.status >= 400).length);
  assert.deepEqual(consoleErrors.filter((entry) => !expectedHttpErrors.includes(entry)), []);
  assert.deepEqual(pageErrors, []); assert.deepEqual(routeErrors, []); assert.deepEqual(forbiddenRequests, []);
  assert.ok(screenshots.length >= 6); passed = true;
} catch (error) {
  failure = { scenario, message: String(error).replaceAll(process.cwd(), "<workspace>") }; process.exitCode = 1;
  await page?.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  releaseDelayed?.(); await browser?.close().catch(() => {});
  if (initialTrees && initialIndex && indexPath) {
    try { await unchanged(); } catch (error) { passed = false; process.exitCode = 1; failure ??= { scenario: "final no-write verification", message: String(error) }; }
  }
  const expectedHttpErrors = consoleErrors.filter((entry) => entry.url === `${base}/api/projects/inspect` && /status of (?:400|403|404|409|413|500)/u.test(entry.text));
  const report = { passed, base, directory: siteRelative(evidence), checks, screenshots, apiChecks,
    fixtures: { paths: Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, siteRelative(value.path)])), initialTrees,
      description: "New synthetic unregistered folders only. GET connection/recent-project lists and external font CSS are fixtures; all inspection responses are from managed 3001. Cancellation delays delivery of one real response only.",
      directoryReads: fixtureDirectoryReads, recentProjectReads: fixtureRecentReads, externalFontCss: fixtureFonts },
    projectIndex: { before: initialIndex, unchanged: passed }, requests, responses, cancelledRequests,
    consoleSummary: { expectedHttpErrors: expectedHttpErrors.length, unexpected: consoleErrors.length - expectedHttpErrors.length },
    consoleErrors, pageErrors, routeErrors, forbiddenRequests, failure,
    boundaries: ["No project open/create/save/register action or project handle is used.", "No SQL/Python/Agent/model/database execution or service lifecycle action.",
      "Fixture directories remain byte-identical and are retained as evidence; no user project was accessed."],
    visualReview: { completed: false, note: "Actual screenshots must be opened and checked after this run." } };
  await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, report: siteRelative(join(evidence, "report.json")), failure }, null, 2));
}
