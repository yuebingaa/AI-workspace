// Managed 3001 only; a new synthetic local project and an isolated Edge profile.
// The disabled browser phase replaces only the Python capability-status GET.
// It does not claim that the already-running 3001 server was restarted disabled.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  CELL_LABELS,
  CELL_MODULES_CSV,
  CELL_MODULES_PYTHON,
  CELL_MODULES_SQL,
  CELL_OUTPUTS,
  CELL_TITLES,
  SQL_EXPECTED,
  WEIGHTED_EXPECTED,
} from "./fixtures/cell-modules.mjs";

const base = "http://127.0.0.1:3001";
const directory = resolve(".runtime/hex-notebook-capability-toggle-2026-09-20", `browser-${Date.now()}`);
const projectPath = resolve(directory, "project");
const disabledStatus = {
  engine: "pyodide",
  enabled: false,
  available: false,
  reason: "Python Notebook 能力已通过服务器配置关闭",
};

await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

const checks = [];
const screenshots = [];
const pageErrors = [];
const consoleErrors = [];
const forbiddenRequests = [];
const notebookRequests = [];
const capabilityRequests = [];
const runs = [];
const ids = {};
let phase = "enabled-live";
let scenario = "setup";
let passed = false;
let failure;
let handle;
let pageId;
let datasetId;
let definitionBeforeDisable;
let liveInitialStatus;
let liveRecoveredStatus;
let directoryReads = 0;

page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== base || url.pathname.startsWith("/api/ai/")) {
    forbiddenRequests.push(url.origin === base ? url.pathname : url.origin);
    return route.abort("blockedbyclient");
  }
  if (url.pathname === "/api/connections") {
    if (request.method() !== "GET") {
      forbiddenRequests.push("Connection write prohibited");
      return route.abort("blockedbyclient");
    }
    directoryReads++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections: [] }),
    });
  }
  if (url.pathname === "/api/notebook/python" && request.method() === "GET") {
    capabilityRequests.push({ phase, source: phase === "disabled-ui-fixture" ? "playwright-status-fixture" : "live-3001" });
    if (phase === "disabled-ui-fixture") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(disabledStatus),
      });
    }
  }
  if (url.pathname === "/api/notebook/run" && request.method() === "POST") {
    const body = request.postDataJSON();
    notebookRequests.push({
      phase,
      targetCellId: body.targetCellId,
      action: body.action,
      cellKinds: body.document?.cells.map((cell) => cell.kind),
    });
    // In the simulated disabled UI only the independent SQL branch may reach
    // the live, enabled 3001 server. A Python request here would make the test
    // accidentally exercise the wrong server configuration.
    if (phase === "disabled-ui-fixture" && body.targetCellId !== ids.sql) {
      forbiddenRequests.push(`Unexpected disabled-phase Notebook target: ${body.targetCellId ?? "all"}`);
      return route.abort("blockedbyclient");
    }
  }
  return route.continue();
});

const editor = () => page.locator(".notebook-editor");
const cell = (kind) => page.getByRole("article", { name: `${CELL_LABELS[kind]}单元 ${CELL_TITLES[kind]}`, exact: true });
const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });

async function step(name, action) {
  scenario = name;
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function shot(name, target, assertions) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide desktop overflow");
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: "disabled" });
  screenshots.push({ file: `${name}.png`, phase, viewport: page.viewportSize(), scenario, assertions });
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

async function manifest(predicate = (value) => Boolean(value.state)) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${base}/api/projects`, {
      headers: { "x-agentcanvas-project": handle },
    });
    assert.equal(response.status(), 200);
    const value = (await response.json()).manifest;
    const state = await page.locator(".top-actions").textContent();
    if (predicate(value) && /已保存到本地项目|已打开本地项目/.test(state ?? "")) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Synthetic project did not finish saving");
}

async function savedDocument(predicate = () => true) {
  const saved = await manifest((value) => {
    const book = value.state?.dataProduct.notebooks?.[pageId];
    return Boolean(book && predicate(book));
  });
  return saved.state.dataProduct.notebooks[pageId];
}

async function save() {
  await editor().getByRole("button", { name: "保存单元", exact: true }).click();
  const confirmRename = page.getByRole("button", { name: "确认改名并保存", exact: true });
  if (await confirmRename.isVisible()) await confirmRename.click();
  await editor().waitFor({ state: "hidden" });
}

async function start(kind) {
  await dismissNotice();
  await page.getByRole("group", { name: "添加分析单元", exact: true })
    .getByRole("button", { name: `＋ ${CELL_LABELS[kind]}`, exact: true }).click();
  await editor().waitFor();
  await editor().getByLabel("单元名称", { exact: true }).fill(CELL_TITLES[kind]);
  if (CELL_OUTPUTS[kind]) {
    await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill(CELL_OUTPUTS[kind]);
  }
}

async function saveNew(kind) {
  await save();
  await cell(kind).waitFor();
  const document = await savedDocument((value) => value.cells.some((item) => item.title === CELL_TITLES[kind]));
  ids[kind] = document.cells.find((item) => item.title === CELL_TITLES[kind]).id;
}

async function run(kind, expectedStatus = "success") {
  await dismissNotice();
  const pending = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45_000 });
  await cell(kind).getByRole("button", { name: "▶ 运行", exact: true }).click();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body.error));
  assert.equal(body.run.status, expectedStatus, JSON.stringify(body.run.cells.map((item) => item.error)));
  await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
  runs.push({ phase, run: body.run });
  return body.run;
}

async function livePythonStatus() {
  const response = await context.request.get(`${base}/api/notebook/python`, {
    headers: { "x-agentcanvas-project": handle },
  });
  assert.equal(response.status(), 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.available, true, JSON.stringify(body));
  return body;
}

try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60_000 });

  await step("Create one isolated project with real Data, SQL and Python definitions", async () => {
    await openDataBrowser();
    await dataBrowser().getByRole("navigation", { name: "数据资源分类" })
      .getByRole("button", { name: /项目文件夹/ }).click();
    await dataBrowser().getByLabel("项目名称", { exact: true }).fill("Python 能力关闭与恢复验收");
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    await dataBrowser().getByRole("button", { name: "新建本地项目", exact: true }).click();
    await dataBrowser().waitFor({ state: "hidden" });
    handle = await page.evaluate(() => localStorage.getItem("agentcanvas:last-local-project:v1"));
    assert.ok(handle);
    pageId = (await manifest()).state.appSpec.pages[0].id;
    liveInitialStatus = await livePythonStatus();

    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
    await upload.locator('input[type="file"]').setInputFiles({
      name: "capability-toggle-sales.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(CELL_MODULES_CSV),
    });
    const uploaded = page.waitForResponse((response) => response.url() === `${base}/api/datasets`
      && response.request().method() === "POST");
    await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click();
    const response = await uploaded;
    assert.equal(response.status(), 201);
    datasetId = (await response.json()).dataset.datasetId;
    await upload.waitFor({ state: "hidden" });
    await manifest((value) => value.tables.length === 1 && value.files.length === 1);

    await start("data");
    await editor().getByLabel("数据源", { exact: true }).selectOption(datasetId);
    await saveNew("data");
    await start("sql");
    await editor().getByLabel("SQL", { exact: true }).fill(CELL_MODULES_SQL);
    await saveNew("sql");
    assert.deepEqual((await run("sql")).cells.at(-1).table.rows, SQL_EXPECTED);
    await start("python");
    await editor().getByLabel("Python", { exact: true }).fill(CELL_MODULES_PYTHON);
    await saveNew("python");
    assert.deepEqual((await run("python")).cells.at(-1).table.rows, WEIGHTED_EXPECTED);
    definitionBeforeDisable = await savedDocument((value) => value.cells.length === 3);
    await shot("01-live-python-before-disable-1440", cell("python"), [
      "Real 3001 reports Python enabled and available",
      "The synthetic Python result is East=300 and South=160",
    ]);
  });

  await step("A disabled capability-status fixture hides creation and preserves the old Python definition read-only", async () => {
    phase = "disabled-ui-fixture";
    const statusCalls = capabilityRequests.length;
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await dismissNotice();
    await page.getByText("Python 能力已关闭", { exact: false }).first().waitFor();
    assert.ok(capabilityRequests.length > statusCalls);
    assert.equal(await page.getByRole("group", { name: "添加分析单元", exact: true })
      .getByRole("button", { name: "＋ Python", exact: true }).count(), 0);
    assert.deepEqual(await savedDocument(), definitionBeforeDisable);

    const python = cell("python");
    assert.match(await python.innerText(), /能力已关闭/);
    assert.match(await python.innerText(), /定义已保留/);
    assert.equal(await python.getByRole("button", { name: "编辑", exact: true }).isDisabled(), true);
    assert.equal(await python.getByRole("button", { name: "▶ 运行", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "▶ 全部运行", exact: true }).isDisabled(), true);
    await python.getByRole("button", { name: "查看Python", exact: true }).click();
    assert.match(await python.getByRole("region", { name: `${CELL_TITLES.python} Python`, exact: true }).innerText(), /weighted_data/);
    assert.equal(await python.locator("table").count(), 0, "A prior Python result must not reappear as fresh");
    await shot("02-disabled-python-readonly-1440", python, [
      "Capability status is an explicit Playwright GET fixture, not a restarted disabled server",
      "Python creation is absent; the saved definition remains viewable while edit/run are disabled",
    ]);
  });

  await step("The independent local SQL branch still runs while the simulated disabled UI blocks Python", async () => {
    const before = notebookRequests.length;
    const result = await run("sql");
    assert.deepEqual(result.cells.at(-1).table.rows, SQL_EXPECTED);
    const phaseRequests = notebookRequests.slice(before);
    assert.equal(phaseRequests.length, 1);
    assert.equal(phaseRequests[0].targetCellId, ids.sql);
    assert.equal(notebookRequests.some((item) => item.phase === "disabled-ui-fixture" && item.targetCellId === ids.python), false);
    assert.deepEqual(await savedDocument(), definitionBeforeDisable);
    await shot("03-disabled-ui-independent-sql-1440", cell("sql"), [
      "Real local Data-to-SQL execution returns East=150 and South=80",
      "The live server is still enabled; this screenshot verifies UI gating and an independent branch only",
    ]);
  });

  await step("Restoring the real default 3001 status re-enables the same Python definition and execution", async () => {
    phase = "enabled-live";
    const statusCalls = capabilityRequests.length;
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await dismissNotice();
    await page.getByRole("group", { name: "添加分析单元", exact: true })
      .getByRole("button", { name: "＋ Python", exact: true }).waitFor();
    assert.ok(capabilityRequests.length > statusCalls);
    liveRecoveredStatus = await livePythonStatus();
    assert.deepEqual(await savedDocument(), definitionBeforeDisable);
    const python = cell("python");
    assert.equal(await python.getByRole("button", { name: "编辑", exact: true }).isEnabled(), true);
    assert.equal(await python.getByRole("button", { name: "▶ 运行", exact: true }).isEnabled(), true);
    const result = await run("python");
    assert.deepEqual(result.cells.at(-1).table.rows, WEIGHTED_EXPECTED);
    await shot("04-live-python-restored-1440", python, [
      "The same saved Python definition is enabled again without migration",
      "Real default 3001 Python execution again returns East=300 and South=160",
    ]);
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(forbiddenRequests, []);
  assert.ok(directoryReads > 0);
  passed = true;
} catch (error) {
  failure = { scenario, message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
  await page.screenshot({ path: resolve(directory, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  const report = {
    passed,
    failure,
    directory,
    projectPath,
    checks,
    screenshots,
    ids,
    runs,
    capabilityRequests,
    notebookRequests,
    liveInitialStatus,
    liveRecoveredStatus,
    pageErrors,
    consoleErrors,
    forbiddenRequests,
    directoryReads,
    coverage: {
      disabledUi: {
        verified: true,
        statusSource: "Playwright replacement for GET /api/notebook/python only",
        status: disabledStatus,
      },
      disabledServerHttp: {
        verified: false,
        reason: "STABLE-RUNTIME forbids starting another site on an ad-hoc port, and managed 3001 was not restarted with NOTEBOOK_PYTHON_ENABLED=false. Real server refusal is covered by module/API tests, not this browser report.",
      },
      independentSqlDuringDisabledUi: {
        verified: true,
        executionSource: "real managed 3001 with its default enabled server configuration",
      },
      enabledRecovery: {
        verified: passed,
        statusSource: "real GET /api/notebook/python on managed 3001",
        executionSource: "real POST /api/notebook/run on managed 3001",
      },
    },
    boundaries: [
      "New synthetic local project, generated CSV and isolated Edge profile only; no user project or business data.",
      "No model, external database, credentials, service lifecycle operation, stable publication or non-loopback request.",
      "The disabled browser phase replaces only the capability-status GET and prohibits Python POSTs; it must not be cited as real disabled-server HTTP evidence.",
      "Project and screenshots are retained below .runtime for inspection; the development recent-project index will contain this synthetic evidence project.",
    ],
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed, checks: checks.length, screenshots: screenshots.length, directory, failure }, null, 2));
}
