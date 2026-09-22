import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import pg from "pg";
import { validateOwner } from "./adventureworks.mjs";
import { bindAdventureWorks, CONNECTION_ID } from "./bind-dev-adventureworks.mjs";

const script = fileURLToPath(import.meta.url);
const site = resolve(dirname(script), "../..");
const base = "http://127.0.0.1:3001";
const sql = `SELECT t.name AS region, COUNT(*)::integer AS orders,
  SUM(h.subtotal)::double precision AS revenue, SUM(h.subtotal)::text AS revenue_exact
FROM sales.salesorderheader h
JOIN sales.salesterritory t ON t.territoryid = h.territoryid
GROUP BY t.territoryid, t.name
ORDER BY t.name`;
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function independentExpectedRows(runtimeDir) {
  const owner = validateOwner(await readJson(join(runtimeDir, "owner.json")), runtimeDir);
  assert.equal(owner.phase, "ready", "The isolated fixture restore must be verified first");
  const credentials = await readJson(join(runtimeDir, "credentials.private.json"));
  assert.equal(credentials.ownerId, owner.id);
  assert.equal(credentials.username, owner.readerUser);
  const client = new pg.Client({ host: owner.host, port: owner.port, database: owner.database,
    user: owner.readerUser, password: credentials.password, ssl: false,
    connectionTimeoutMillis: 5000, query_timeout: 15000, application_name: "agentcanvas-aw-browser-truth" });
  await client.connect();
  try {
    const identity = (await client.query("SELECT current_user AS identity, current_setting('default_transaction_read_only') AS readonly")).rows[0];
    assert.equal(identity.identity, owner.readerUser);
    assert.equal(identity.readonly, "on");
    // Independent grouping and label lookup, not a replay of the UI JOIN query.
    const totals = (await client.query("SELECT territoryid, COUNT(*)::int AS orders, SUM(subtotal)::text AS exact FROM sales.salesorderheader GROUP BY territoryid")).rows;
    const territories = new Map((await client.query("SELECT territoryid, name FROM sales.salesterritory")).rows.map((row) => [row.territoryid, row.name]));
    assert.equal(totals.length, 10);
    assert.equal(totals.reduce((sum, row) => sum + row.orders, 0), 31465);
    return totals.map((row) => {
      assert.ok(territories.has(row.territoryid), "Every order territory must have a label");
      return { region: territories.get(row.territoryid), orders: row.orders, revenue: Number(row.exact), revenue_exact: row.exact };
    }).sort((a, b) => a.region.localeCompare(b.region, "en"));
  } finally { await client.end(); }
}

export async function runAdventureWorksBrowser({ runtimeDir, registerProject = bindAdventureWorks }) {
  assert.ok(isAbsolute(runtimeDir), "An explicit absolute owned test runtime is required");
  const directory = join(site, ".runtime", "hex-foundation-2026-09-16", `browser-${Date.now()}`);
  const projectPath = join(directory, "project");
  await mkdir(directory, { recursive: true });
  const checks = [], errors = [], screenshots = [], queries = [], network = [], navigations = [];
  const startedAt = Date.now();
  let dashboardAlignment, annualDashboardAlignment, catalogSummary;
  let aiRequests = 0, browser, page, expectedRows, failure;
  const screenshot = async (name) => { await page.screenshot({ path: join(directory, name) }); screenshots.push(name); };
  const manifest = () => readJson(join(projectPath, "agentcanvas.project.json"));
  async function savedWhen(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await manifest();
      if (predicate(current)) return current;
      await new Promise((next) => setTimeout(next, 100));
    }
    throw new Error("The test project's expected disk state was not saved within 10 seconds");
  }
  const documentFrom = (current) => Object.values(current.state?.dataProduct?.notebooks ?? {})[0];
  const measureLabels = (plot) => plot.evaluate((element) => {
    const bars = Array.from(element.querySelectorAll(".recharts-bar-rectangle"));
    return Array.from(element.querySelectorAll(".recharts-category-labels > small")).map((label, index) => {
      // A label fills its grid cell, so compare the painted text, not that cell.
      const range = document.createRange(); range.selectNodeContents(label);
      const text = range.getBoundingClientRect(), bar = bars[index]?.getBoundingClientRect();
      return { label: label.textContent,
        centerDeltaPx: bar ? Math.abs(text.x + text.width / 2 - bar.x - bar.width / 2) : null };
    });
  });
  function assertLabels(alignment, count) {
    assert.equal(alignment.length, count);
    assert.ok(alignment.every((item) => item.centerDeltaPx !== null && item.centerDeltaPx <= 1),
      `Dashboard text must align with its bar: ${JSON.stringify(alignment)}`);
  }
  try {
    expectedRows = await independentExpectedRows(runtimeDir);
    checks.push("Independent reader-only PostgreSQL grouping verified 10 territories and 31,465 orders");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, acceptDownloads: true, reducedMotion: "reduce" });
    await context.route("**/api/ai/**", (route) => { aiRequests++; return route.abort(); });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push({ elapsedMs: Date.now() - startedAt, path: new URL(frame.url()).pathname });
    });
    const requestSummary = (request) => {
      const path = new URL(request.url()).pathname;
      if (!["/api/connections", "/api/notebook/run", "/api/projects"].includes(path)) return null;
      let action;
      try { action = request.postDataJSON()?.action; } catch { /* GET or non-JSON requests have no action. */ }
      return { elapsedMs: Date.now() - startedAt, path, method: request.method(), ...(action ? { action } : {}) };
    };
    page.on("response", (response) => {
      const summary = requestSummary(response.request());
      if (summary) network.push({ ...summary, status: response.status() });
    });
    page.on("requestfailed", (request) => {
      const summary = requestSummary(request);
      if (summary) network.push({ ...summary, failure: request.failure()?.errorText });
    });
    await page.goto(base, { waitUntil: "networkidle" });
    const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器", exact: true });
    async function openBrowser() {
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
      await page.getByRole("navigation", { name: "工作区功能菜单" }).getByRole("button", { name: "数据浏览器", exact: true }).click();
      await dataBrowser().waitFor();
    }
    await openBrowser();
    await dataBrowser().getByLabel("项目名称", { exact: true }).fill("AdventureWorks 数据库到看板验收");
    await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
    const createdResponse = page.waitForResponse((response) => response.url() === `${base}/api/projects`
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === "create");
    await dataBrowser().getByRole("button", { name: "新建本地项目", exact: true }).click();
    const created = await createdResponse;
    assert.equal(created.status(), 200);
    const session = await created.json();
    assert.equal(resolve(session.path), resolve(projectPath));
    await dataBrowser().waitFor({ state: "hidden" });
    const registered = await registerProject(runtimeDir, session.handle);
    assert.equal(registered.connectionId, CONNECTION_ID);
    assert.equal(registered.allowAi, false);
    assert.equal(registered.site, base);
    checks.push("Created a dedicated project through UI and added only its new handle to the test connection scope");

    // Re-enter through the real persisted project after development config reload.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    const connections = page.locator(".notebook-connections");
    await connections.locator("summary").click();
    await connections.getByRole("button", { name: "刷新连接", exact: true }).click();
    const connection = connections.locator(".notebook-connection").filter({ hasText: "AdventureWorks 本地测试" });
    await connection.waitFor();
    assert.match(await connection.innerText(), /仅手动查询/);
    const testing = page.waitForResponse((response) => response.url() === `${base}/api/connections`
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === "test");
    await connection.getByRole("button", { name: "测试连接", exact: true }).click();
    const tested = await testing;
    assert.equal(tested.status(), 200, JSON.stringify(await tested.json()));
    await connections.getByText("连接测试通过。", { exact: true }).waitFor();
    const catalogResponse = page.waitForResponse((response) => response.url() === `${base}/api/connections`
      && response.request().method() === "POST" && response.request().postDataJSON()?.action === "schema");
    await connection.getByRole("button", { name: "浏览字段", exact: true }).click();
    const catalog = await (await catalogResponse).json();
    assert.ok(catalog.columns.some((column) => column.table_schema === "sales" && column.table_name === "salesorderheader"));
    assert.ok(catalog.catalog?.revision > 0);
    assert.equal(catalog.truncated, false);
    assert.equal(catalog.catalog.complete, true);
    catalogSummary = { tableCount: catalog.catalog.tableCount, columnCount: catalog.columns.length,
      complete: catalog.catalog.complete, revision: catalog.catalog.revision };
    await page.getByLabel("搜索数据库表与字段", { exact: true }).fill("salesorderheader");
    await screenshot("01-real-postgresql-catalog.png");
    checks.push("Real connection test, catalog synchronization and field search without HTTP/database mocks");

    await connection.getByRole("button", { name: "新建 SQL", exact: true }).click();
    const editor = () => page.locator(".notebook-editor");
    async function saveCell() {
      await editor().getByRole("button", { name: "保存单元", exact: true }).click();
      await editor().waitFor({ state: "hidden" });
    }
    await editor().getByLabel("单元名称", { exact: true }).fill("地区订单与销售额");
    await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill("territory_totals");
    await editor().getByLabel("数据库连接", { exact: true }).selectOption(CONNECTION_ID);
    await editor().getByLabel("SQL", { exact: true }).fill(sql);
    await saveCell();
    await connections.locator("summary").click();
    const queryArticle = () => page.getByRole("article", { name: "数据库 SQL单元 地区订单与销售额", exact: true });
    async function run(button) {
      const waiting = page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45000 });
      const [response] = await Promise.all([waiting, button.click()]);
      const body = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.run.status, "success", JSON.stringify(body));
      await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" });
      queries.push({ runId: body.run.runId, cells: body.run.cells.map(({ cellId, status, durationMs, resultRef }) =>
        ({ cellId, status, durationMs, rowCount: resultRef?.rowCount, complete: resultRef?.complete, connectionId: resultRef?.connectionId })) });
      return body;
    }
    const first = await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    const queryCellId = first.run.cells[0].cellId;
    assert.deepEqual(first.run.cells[0].table.rows, expectedRows);
    assert.equal(first.run.cells[0].resultRef.connectionId, CONNECTION_ID);
    assert.equal(first.run.cells[0].resultRef.complete, true);
    assert.equal(first.run.cells[0].resultRef.accessMode, "user");
    assert.equal(first.run.cells[0].table.fields.find((field) => field.name === "revenue_exact").type, "string");
    await queryArticle().scrollIntoViewIfNeeded(); await screenshot("02-real-query-results.png");
    checks.push("Notebook warehouse SQL matches independent PostgreSQL truth including exact-decimal text and numeric chart projection");

    await page.getByRole("button", { name: "＋ 表格", exact: true }).click();
    await editor().getByLabel("单元名称", { exact: true }).fill("地区汇总明细");
    await editor().getByLabel("上游输出", { exact: true }).selectOption(queryCellId);
    await editor().getByLabel("展示字段（逗号分隔，使用结果中的字段名）", { exact: true }).fill("region, orders, revenue, revenue_exact");
    await saveCell();
    await page.getByRole("button", { name: "＋ 图表", exact: true }).click();
    await editor().getByLabel("单元名称", { exact: true }).fill("AdventureWorks 地区销售额");
    await editor().getByLabel("上游输出", { exact: true }).selectOption(queryCellId);
    await editor().getByLabel("分类字段", { exact: true }).fill("region");
    await editor().getByLabel("数值字段（逗号分隔，最多 4 个）", { exact: true }).fill("revenue");
    await saveCell();
    const all = await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    assert.deepEqual(all.run.cells[1].table.rows, expectedRows);
    assert.deepEqual(all.run.cells[2].table.rows, expectedRows.map(({ region, revenue }) => ({ region, revenue })));
    const chartArticle = () => page.getByRole("article", { name: "图表单元 AdventureWorks 地区销售额", exact: true });
    await chartArticle().scrollIntoViewIfNeeded();
    assert.equal(await chartArticle().locator(".recharts-bar-rectangle").count(), 10);
    await screenshot("03-notebook-chart.png");
    checks.push("Real SQL outputs drive table and ten-region chart cells through declared dependencies");

    const saved = await run(queryArticle().getByRole("button", { name: "保存为 Dataset", exact: true }));
    const provenance = saved.snapshot.dataset.provenance;
    assert.deepEqual(provenance.connectionIds, [CONNECTION_ID]);
    assert.equal(provenance.lineage.complete, true);
    assert.equal(provenance.lineage.rowCount, 10);
    assert.equal(provenance.lineage.steps.length, 1);
    assert.equal(JSON.parse(provenance.lineage.steps[0].definition).sql, sql);
    assert.ok(provenance.lineage.steps[0].catalogRef);
    assert.equal(saved.snapshot.dataset.aiAccessPolicy, "pending");
    const recent = page.getByRole("region", { name: "最近保存的数据集", exact: true });
    await recent.locator(".dataset-provenance > summary").click();
    const download = page.waitForEvent("download");
    await recent.getByRole("button", { name: "下载来源记录", exact: true }).click();
    await (await download).saveAs(join(directory, "dataset-provenance.json"));
    assert.deepEqual(await readJson(join(directory, "dataset-provenance.json")), provenance);
    const beforePreview = await savedWhen((current) => documentFrom(current)?.cells.length === 3
      && current.tables.some((entry) => entry.descriptor.datasetId === saved.snapshot.dataset.datasetId));
    const savedTable = beforePreview.tables.find((entry) => entry.descriptor.datasetId === saved.snapshot.dataset.datasetId);
    assert.deepEqual(savedTable.descriptor.provenance, provenance);
    const payload = await readJson(join(projectPath, "tables", savedTable.file));
    assert.deepEqual(payload.rows, saved.snapshot.rows);
    const exactField = saved.snapshot.dataset.fieldMappings.find((field) => field.originalName === "revenue_exact").normalizedName;
    assert.deepEqual(payload.rows.map((row) => row[exactField]), expectedRows.map((row) => row.revenue_exact));
    checks.push("Dataset persisted to disk with exact values, pending AI authorization and downloadable query/catalog provenance");

    const formalPages = structuredClone(beforePreview.state.appSpec.pages);
    // Saving a SQL-only dependency closure replaces the displayed run, so execute
    // the document again before requesting a chart-based Dashboard snapshot.
    await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    await run(chartArticle().getByRole("button", { name: "生成看板预览 ↗", exact: true }));
    await page.getByRole("button", { name: "应用编辑", exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "看板", exact: true }).getAttribute("aria-selected"), "true");
    const previewState = await savedWhen((current) => current.tables.length >= 2);
    assert.deepEqual(previewState.state.appSpec.pages, formalPages);
    assert.equal(await page.locator(".canvas-area .recharts-bar-rectangle").count(), 10);
    await screenshot("04-dashboard-unapplied-preview.png");
    await page.getByRole("button", { name: "应用编辑", exact: true }).click();
    const applied = await savedWhen((current) => JSON.stringify(current.state.appSpec.pages) !== JSON.stringify(formalPages));
    assert.match(JSON.stringify(applied.state.appSpec.pages), /AdventureWorks 地区销售额/);
    await page.getByRole("button", { name: "应用编辑", exact: true }).waitFor({ state: "hidden" });
    await screenshot("05-dashboard-confirmed.png");
    checks.push("Dashboard preview does not modify formal nodes; explicit confirmation adds the actual ten-region chart");

    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    const projectBeforeReload = await manifest();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    assert.equal(await page.locator(".notebook-cell").count(), 3);
    assert.equal(await page.locator(".notebook-cell-output table").count(), 0);
    const reopened = await manifest();
    assert.deepEqual(reopened.state.appSpec.pages, projectBeforeReload.state.appSpec.pages);
    assert.deepEqual(documentFrom(reopened), documentFrom(projectBeforeReload));
    const rerun = await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    assert.deepEqual(rerun.run.cells[0].table.rows, expectedRows);
    await openBrowser();
    await dataBrowser().getByRole("button", { name: /已保存结果/ }).click();
    await dataBrowser().locator(".dataset-provenance > summary").click();
    assert.match(await dataBrowser().locator(".dataset-provenance").innerText(), /10 行完整结果/);
    await screenshot("06-reopened-project-provenance.png");
    await dataBrowser().getByRole("button", { name: "关闭数据浏览器", exact: true }).click();
    await page.getByRole("tab", { name: "看板", exact: true }).click();
    assert.equal(await page.locator(".canvas-area .recharts-bar-rectangle").count(), 10);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Desktop page must not overflow horizontally");
    await screenshot("07-reopened-dashboard.png");
    checks.push("Reopening the real project restores Notebook definitions, persisted Dataset/provenance and confirmed Dashboard; old execution results are not restored as fresh");
    dashboardAlignment = await measureLabels(page.locator(".canvas-area .recharts-bar-plot"));
    assertLabels(dashboardAlignment, 10);
    checks.push("Dashboard category text aligns with its corresponding bar after project reopening");

    // A sparse horizontal chart exercises the 520px minimum plot width, which
    // must not retain the fixed 84px category slots used by the old renderer.
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await page.getByRole("button", { name: "＋ 数据库 SQL", exact: true }).click();
    await editor().getByLabel("单元名称", { exact: true }).fill("年度订单数");
    await editor().getByLabel("输出表名（SQL 中使用）", { exact: true }).fill("annual_orders");
    await editor().getByLabel("数据库连接", { exact: true }).selectOption(CONNECTION_ID);
    await editor().getByLabel("SQL", { exact: true }).fill("SELECT EXTRACT(YEAR FROM orderdate)::text AS order_year, COUNT(*)::integer AS orders FROM sales.salesorderheader GROUP BY EXTRACT(YEAR FROM orderdate) ORDER BY order_year");
    await saveCell();
    const annual = await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    const annualQuery = annual.run.cells.at(-1);
    assert.equal(annualQuery.table.rows.length, 4);
    assert.equal(annualQuery.table.rows.reduce((sum, row) => sum + row.orders, 0), 31465);
    await page.getByRole("button", { name: "＋ 图表", exact: true }).click();
    await editor().getByLabel("单元名称", { exact: true }).fill("AdventureWorks 年度订单数");
    await editor().getByLabel("上游输出", { exact: true }).selectOption(annualQuery.cellId);
    await editor().getByLabel("分类字段", { exact: true }).fill("order_year");
    await editor().getByLabel("数值字段（逗号分隔，最多 4 个）", { exact: true }).fill("orders");
    await saveCell();
    await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
    await run(page.getByRole("article", { name: "图表单元 AdventureWorks 年度订单数", exact: true })
      .getByRole("button", { name: "生成看板预览 ↗", exact: true }));
    await page.getByRole("button", { name: "应用编辑", exact: true }).click();
    await page.getByRole("button", { name: "应用编辑", exact: true }).waitFor({ state: "hidden" });
    await savedWhen((current) => JSON.stringify(current.state.appSpec.pages).includes("AdventureWorks 年度订单数"));
    const annualPlot = () => page.locator(".canvas-area .chart-card").filter({ hasText: "AdventureWorks 年度订单数" }).locator(".recharts-bar-plot");
    await annualPlot().scrollIntoViewIfNeeded();
    assert.equal(await annualPlot().locator(".recharts-category-labels.vertical").count(), 0);
    annualDashboardAlignment = await measureLabels(annualPlot());
    assertLabels(annualDashboardAlignment, 4);
    await screenshot("08-four-year-horizontal-labels.png");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "看板", exact: true }).click();
    await annualPlot().scrollIntoViewIfNeeded();
    assertLabels(await measureLabels(annualPlot()), 4);
    await screenshot("09-reopened-two-chart-dashboard.png");
    checks.push("Real four-year SQL totals preserve 31,465 orders and render centered horizontal labels before and after saving/reopening the second chart");
    assert.deepEqual(errors, []);
    assert.equal(aiRequests, 0, "This acceptance must not invoke any AI endpoint");
  } catch (error) {
    failure = error instanceof Error ? error.message : "Browser acceptance failed";
    if (page) await screenshot("failure.png").catch(() => {});
  } finally {
    await browser?.close();
    const report = { passed: !failure, mode: "Real isolated PostgreSQL reader, real website queries/storage/rendering; no model or HTTP mocks",
      checks, errors, aiRequests, queries, screenshots, expectedRows, network, navigations, catalogSummary,
      dashboardAlignment, annualDashboardAlignment, ...(failure ? { error: failure } : {}),
      project: "project", directory: relative(site, directory).replaceAll("\\", "/") };
    await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ passed: report.passed, directory: report.directory, checks: checks.length, screenshots, ...(failure ? { error: failure } : {}) }, null, 2));
  }
  return { passed: !failure, directory };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [runtimeDir, ...extra] = process.argv.slice(2);
  assert.ok(runtimeDir && isAbsolute(runtimeDir) && !extra.length,
    "Usage: node scripts/test-database/browser-adventureworks.mjs ABSOLUTE_OWNED_TEST_RUNTIME");
  const result = await runAdventureWorksBrowser({ runtimeDir: resolve(runtimeDir) });
  if (!result.passed) process.exitCode = 1;
}
