import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { chromium } from "playwright-core";

// The only real mutation permitted is selecting this development service's engine.
// No project is opened and no model / Notebook execution is allowed.
const base = "http://127.0.0.1:3001";
const endpoint = `${base}/api/settings/agent-engine`;
const directory = resolve(".runtime", "dsh-settings-browser-2026-09-22", `browser-${Date.now()}`);
const expectedPlugins = [
  { id: "dsh-notebook", name: "Notebook 数据分析", tools: ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"] },
  { id: "dsh-excel-python", name: "Excel 原件与 Python", tools: ["inspectEdsRawWorkbook", "readEdsRawRows", "getKernelPackagesInfo"] },
  { id: "dsh-database", name: "只读数据库分析", tools: ["inspectConnectionSchema"] },
];
await mkdir(directory, { recursive: true });
const report = {
  passed: false, base, startedAt: new Date().toISOString(),
  scope: "Fresh isolated Edge; actual settings API; no project or model operations",
  checks: [], screenshots: [], pluginReadability: [], realApi: [], injectedResponses: [],
  forbiddenRequests: [], routeErrors: [], pageErrors: [], fixtures: { recentProjects: 0, connections: 0, fonts: 0 },
  visualReview: { status: "pending", note: "Screenshots must be opened and reviewed separately." },
};
let browser, page, initial, lastOwnedRevision, hasOwnedMutation = false, injectPatchFailure = false;
let realUiPatches = 0;
const summary = value => ({ engine: value.engine, revision: value.revision, activeTasks: value.activeTasks,
  persistence: value.persistence, dsh: { available: value.dsh.available, version: value.dsh.version } });

async function settings(method = "GET", input) {
  const response = await fetch(endpoint, { method, headers: { origin: base, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  assert.equal(response.status, 200, `Actual settings ${method} failed: ${response.status}`);
  assert.ok(["harness", "dsh"].includes(payload.engine));
  assert.ok(Number.isInteger(payload.revision));
  report.realApi.push({ source: "verification", method, status: response.status, ...summary(payload) });
  return payload;
}
function dialog() { return page.getByRole("dialog", { name: "Agent 执行与插件", exact: true }); }
function selection(engine) { return dialog().locator(`input[name="agent-execution-engine"][value="${engine}"]`); }
async function snapshot(file, scenario, source = "actual-settings-api") {
  const path = resolve(directory, file);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  const viewport = page.viewportSize();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${file}: page horizontally overflows`);
  if (await dialog().isVisible()) {
    const geometry = await dialog().evaluate(element => ({ width: element.getBoundingClientRect().width,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
      overflow: element.scrollWidth > element.clientWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= viewport.width);
    assert.equal(geometry.overflow, false, `${file}: dialog horizontally overflows`);
  }
  report.screenshots.push({ file, scenario, source, viewport, pageHorizontalOverflow: overflow, reviewed: false });
}
async function openSettings(captureMenu = false) {
  await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "工作区功能菜单", exact: true });
  await navigation.locator("summary").filter({ hasText: "设置与备份" }).click();
  await navigation.getByRole("button", { name: "Agent 执行与插件", exact: true }).scrollIntoViewIfNeeded();
  if (captureMenu) await snapshot("01-navigation-1440.png", "Workspace menu > Settings and backup > Agent execution and plugins");
  await navigation.getByRole("button", { name: "Agent 执行与插件", exact: true }).click();
  await dialog().waitFor({ state: "visible" });
  await dialog().locator(".agent-engine-current").waitFor();
  await dialog().getByText("正在读取执行引擎状态…", { exact: true }).waitFor({ state: "hidden" });
}
async function snapshotPluginCards(file, scenario) {
  const cards = dialog().locator(".agent-engine-plugins article");
  assert.equal(await cards.count(), expectedPlugins.length);
  await cards.last().scrollIntoViewIfNeeded();
  await snapshot(file, scenario);
  const geometry = await dialog().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll(".agent-engine-plugins article")].map(card => {
      const rect = card.getBoundingClientRect();
      return { name: card.querySelector("h4")?.textContent, fullyInsideDialog: rect.top >= bounds.top && rect.bottom <= bounds.bottom,
        horizontalOverflow: card.scrollWidth > card.clientWidth, tools: [...card.querySelectorAll("code")].map(code => code.textContent) };
    });
  });
  report.pluginReadability.push({ file, cards: geometry });
  for (const card of geometry) {
    assert.equal(card.fullyInsideDialog, true, `${file}: ${card.name} is clipped`);
    assert.equal(card.horizontalOverflow, false, `${file}: ${card.name} overflows horizontally`);
  }
}
async function applyEngine(engine) {
  await selection(engine).check();
  const request = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "PATCH");
  await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).click();
  const response = await request;
  assert.equal(response.status(), 200);
  const payload = await response.json();
  assert.equal(payload.engine, engine); assert.equal(payload.activeTasks, 0);
  lastOwnedRevision = payload.revision;
  hasOwnedMutation = true;
  await dialog().getByRole("status").filter({ hasText: "仅对后续任务生效" }).waitFor();
  assert.equal(await selection(engine).isChecked(), true);
  assert.equal(await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).isDisabled(), true);
  return payload;
}

try {
  initial = await settings();
  assert.equal(initial.activeTasks, 0, "Refuse to change settings while any task is active");
  assert.equal(initial.dsh.available, true, "DSH must be genuinely available; do not fabricate successful switching");
  assert.deepEqual(initial.plugins.map(({ id, name, tools }) => ({ id, name, tools })), expectedPlugins,
    "The development API must expose this batch's real three-plugin catalog");
  report.initial = summary(initial);
  const alternateEngine = initial.engine === "harness" ? "dsh" : "harness";
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN",
    reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.href === "https://rsms.me/inter/inter.css") {
        report.fixtures.fonts++; return await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      }
      if (url.origin !== base) {
        report.forbiddenRequests.push({ method, path: "external-origin" }); return await route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        report.fixtures.recentProjects++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' });
      }
      if (url.pathname === "/api/connections" && method === "GET") {
        report.fixtures.connections++; return await route.fulfill({ status: 200, contentType: "application/json", body: '{"connections":[]}' });
      }
      if (url.href === endpoint) {
        assert.ok(["GET", "PATCH"].includes(method));
        if (method === "PATCH") {
          assert.deepEqual(Object.keys(request.postDataJSON()).sort(), ["engine", "revision"]);
          assert.ok(["harness", "dsh"].includes(request.postDataJSON().engine));
          if (injectPatchFailure) {
            injectPatchFailure = false;
            report.injectedResponses.push({ method, path: url.pathname, status: 503, source: "explicit Playwright route fixture; server not called" });
            return await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "验收注入：服务暂不可用，请刷新状态后重试。" } }) });
          }
          realUiPatches++;
        }
        const response = await route.fetch();
        const value = await response.json();
        report.realApi.push({ source: "browser", method, status: response.status(), ...(response.ok() ? summary(value) : {}) });
        if (method === "PATCH" && response.ok()) {
          lastOwnedRevision = value.revision;
          hasOwnedMutation = true;
        }
        return await route.fulfill({ response });
      }
      if (url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/projects/")
        || url.pathname.startsWith("/api/datasets") || url.pathname.startsWith("/api/connections/")
        || url.pathname === "/api/notebook/run" || (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(method))) {
        report.forbiddenRequests.push({ method, path: url.pathname }); return await route.abort("blockedbyclient");
      }
      return await route.continue();
    } catch (error) {
      report.routeErrors.push({ method, path: url.pathname, message: String(error).slice(0, 500) });
      return await route.abort("failed").catch(() => {});
    }
  });
  page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message.slice(0, 500)));
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });
  await openSettings(true);
  assert.equal(await selection(initial.engine).isChecked(), true);
  assert.equal(await selection("dsh").isDisabled(), false);
  assert.equal(await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).isDisabled(), true);
  for (const plugin of expectedPlugins) {
    const card = dialog().locator(".agent-engine-plugins article").filter({ has: page.getByRole("heading", { name: plugin.name, exact: true }) });
    await card.waitFor();
    assert.deepEqual(await card.locator("code").allTextContents(), plugin.tools);
  }
  const scope = await dialog().locator("#agent-engine-scope").textContent();
  for (const text of ["已选数据源", "Excel 原件", "Notebook Python", "已授权只读数据库", "Python 须部署能力可用", "连接须允许 AI 使用"]) {
    assert.ok(scope.includes(text), `Missing actual capability condition: ${text}`);
  }
  const catalogNotice = await dialog().locator(".agent-engine-plugins > .agent-engine-muted").textContent();
  assert.ok(catalogNotice.includes("不代表全部已启用"));
  assert.ok(catalogNotice.includes("草稿仍须由你确认采用"));
  await snapshot("02-initial-engine-1440.png", `Actual initial engine ${initial.engine} and read-only plugin catalog; not an assertion of source default`);
  report.checks.push({ name: "initial selection and navigation", passed: true, source: "actual API and UI" });
  await snapshotPluginCards("02b-three-plugin-cards-1440.png", "All three actual capability cards; attachment, deployment and AI authorization conditions, not execution evidence");
  await dialog().evaluate(element => { element.scrollTop = 0; });
  report.checks.push({ name: "Excel Python database capability conditions", passed: true,
    source: "actual settings API and three UI cards; no capability execution", plugins: expectedPlugins });

  await selection(alternateEngine).check();
  assert.equal(await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).isEnabled(), true);
  await snapshot("03-unapplied-selection-1440.png", `${alternateEngine} selected but not applied; current engine remains ${initial.engine}`);
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  const afterCancel = await settings();
  assert.equal(afterCancel.engine, initial.engine); assert.equal(afterCancel.revision, initial.revision);
  assert.equal(realUiPatches, 0);
  await openSettings();
  assert.equal(await selection(initial.engine).isChecked(), true);
  await snapshot("04-cancel-keeps-initial-1440.png", `Reopened after cancel: initial ${initial.engine} engine and selection preserved`);
  report.checks.push({ name: "selection cancellation", passed: true, source: "actual GET; zero PATCH before cancel" });

  const switched = await applyEngine(alternateEngine);
  assert.equal(switched.revision, initial.revision + 1);
  assert.equal((await settings()).engine, alternateEngine);
  await dialog().locator("footer").scrollIntoViewIfNeeded();
  await snapshot("05-alternate-applied-1440.png", `Actual PATCH switched to ${alternateEngine}; no model or task execution`);
  report.checks.push({ name: "switch to alternate engine", passed: true, source: "actual PATCH and GET" });

  await selection(initial.engine).check();
  injectPatchFailure = true;
  await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).click();
  await dialog().getByRole("alert").filter({ hasText: "验收注入" }).waitFor();
  await dialog().getByText("尚未确认服务器上的当前引擎，请先刷新状态再操作。", { exact: true }).waitFor();
  assert.equal(await selection(initial.engine).isDisabled(), true);
  assert.equal(await dialog().getByRole("button", { name: "应用执行引擎", exact: true }).isDisabled(), true);
  const afterFailure = await settings();
  assert.equal(afterFailure.engine, alternateEngine); assert.equal(afterFailure.revision, switched.revision);
  await dialog().locator("footer").scrollIntoViewIfNeeded();
  await snapshot("06-injected-503-needs-refresh-1440.png", "Explicit injected PATCH 503; further changes locked pending refresh", "injected PATCH 503 + actual unchanged GET");
  report.checks.push({ name: "failed PATCH locks settings", passed: true, source: "explicit 503 fixture; actual server state unchanged" });

  await page.setViewportSize({ width: 1024, height: 900 });
  await dialog().getByRole("button", { name: "刷新状态", exact: true }).click();
  await dialog().getByRole("alert").waitFor({ state: "hidden" });
  await dialog().getByText("正在读取执行引擎状态…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await selection(alternateEngine).isChecked(), true);
  assert.equal(await selection(initial.engine).isDisabled(), false);
  await dialog().evaluate(element => { element.scrollTop = 0; });
  await snapshot("07-refreshed-selection-1024.png", `Actual GET after failure clears error and restores current ${alternateEngine} server selection at 1024`);
  await snapshotPluginCards("07b-three-plugin-cards-1024.png", "All three capability cards including database conditions remain readable at 1024");
  report.checks.push({ name: "refresh and 1024 layout", passed: true, source: "actual GET and viewport checks" });

  const restored = await applyEngine(initial.engine);
  assert.equal(restored.revision, initial.revision + 2);
  assert.equal((await settings()).engine, initial.engine);
  await dialog().locator("footer").scrollIntoViewIfNeeded();
  await snapshot("08-restored-initial-1024.png", `Actual PATCH restores initial ${initial.engine} engine with a new monotonic revision`);
  assert.equal(realUiPatches, 2); assert.equal(report.injectedResponses.length, 1);
  assert.deepEqual(report.forbiddenRequests, []); assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.pageErrors, []);
  report.checks.push({ name: "restore original engine", passed: true, source: "actual PATCH and GET; original revision not rewritten" });
  report.passed = true;
} catch (error) {
  report.error = String(error).slice(0, 1_000);
  if (page) await snapshot("failure.png", "Failure during browser verification").catch(() => {});
} finally {
  // Restore only our own switch; never overwrite a concurrent user's revision.
  try {
    if (hasOwnedMutation && initial) {
      const current = await settings();
      if (current.engine !== initial.engine) {
        assert.equal(current.activeTasks, 0, "Cannot restore during another task");
        assert.equal(current.revision, lastOwnedRevision, "Concurrent settings change: do not overwrite");
        report.restoredInFinally = summary(await settings("PATCH", { engine: initial.engine, revision: current.revision }));
      }
    }
    if (initial) {
      report.final = summary(await settings());
      assert.equal(report.final.engine, initial.engine); assert.equal(report.final.activeTasks, 0);
    }
  } catch (error) { report.passed = false; report.cleanupError = String(error).slice(0, 1_000); }
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, evidence: relative(process.cwd(), directory), screenshots: report.screenshots.length,
    initial: report.initial, final: report.final, error: report.error, cleanupError: report.cleanupError }, null, 2));
}
if (!report.passed) process.exitCode = 1;
