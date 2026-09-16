import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

// Existing managed 3001 only. Catalog UI uses a marked fixture; local SQL and project storage are real.
const base = "http://127.0.0.1:3001";
const directory = resolve(".runtime", "data-foundation-2026-09-14", `browser-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks = [], errors = [];
let aiRequests = 0;
async function newPage(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, reducedMotion: "reduce" });
  await context.route("**/api/ai/**", (route) => { aiRequests++; return route.abort(); });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
async function noPageOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page has horizontal overflow");
}
try {
  const catalogPage = await newPage();
  let version = 1, calls = 0, failSync = false;
  await catalogPage.route("**/api/connections", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { connections: [{ id: "fixture_sales", name: "合成目录验收", kind: "postgresql", allowAi: false }] } });
    const body = request.postDataJSON(); calls++;
    if (body.refresh && failSync) return route.fulfill({ status: 400, json: { error: { message: "合成目录同步失败" } } });
    if (body.refresh) version++;
    return route.fulfill({ json: { columns: [
      { table_catalog: "synthetic", table_schema: "sales", table_name: "orders", column_name: "order_id", data_type: "integer", table_id: "orders", column_id: "order_id" },
      { table_catalog: "synthetic", table_schema: "sales", table_name: "orders", column_name: "amount", data_type: "numeric", table_id: "orders", column_id: "amount" },
      { table_catalog: "synthetic", table_schema: "sales", table_name: "customers", column_name: "customer_id", data_type: "integer", table_id: "customers", column_id: "customer_id" },
    ], truncated: true, catalog: { id: "catalog_fixture", connectionId: "fixture_sales", revision: version,
      schemaFingerprint: "a".repeat(64), syncedAt: "2026-09-14T00:00:00.000Z", complete: false, freshness: "fresh", storage: "persistent", tableCount: 2 } } });
  });
  await catalogPage.goto(base, { waitUntil: "networkidle" });
  await catalogPage.getByRole("tab", { name: "Notebook", exact: true }).click();
  await catalogPage.locator(".notebook-connections summary").click();
  await catalogPage.getByRole("button", { name: "浏览字段", exact: true }).click();
  await catalogPage.getByLabel("搜索数据库表与字段", { exact: true }).fill("ORDERS");
  await catalogPage.getByRole("status").filter({ hasText: "匹配 2 个字段" }).waitFor();
  assert.equal(await catalogPage.locator(".connection-catalog tbody tr").count(), 2);
  assert.match(await catalogPage.locator(".connection-catalog").innerText(), /目录不完整/);
  await catalogPage.getByRole("button", { name: "同步目录", exact: true }).click();
  await catalogPage.locator(".connection-catalog-toolbar b").filter({ hasText: "v2" }).waitFor();
  failSync = true;
  await catalogPage.getByRole("button", { name: "同步目录", exact: true }).click();
  await catalogPage.getByText(/仍显示上次同步的目录/).waitFor();
  assert.match(await catalogPage.locator(".connection-catalog-toolbar").innerText(), /v2/);
  checks.push("Fixture catalog: search, explicit partial state, version refresh and retention after failed sync");
  await catalogPage.screenshot({ path: join(directory, "catalog-desktop.png") });
  await catalogPage.setViewportSize({ width: 390, height: 844 });
  const assistantToggle = catalogPage.getByRole("button", { name: "AI 助手", exact: true });
  if (await assistantToggle.getAttribute("aria-expanded") === "true") await assistantToggle.click();
  await catalogPage.waitForFunction(() => Array.from(document.querySelectorAll(".workspace-panel-slot")).every((panel) => {
    const style = getComputedStyle(panel); const rect = panel.getBoundingClientRect();
    return style.display === "none" || style.visibility === "hidden" || rect.right <= 0 || rect.left >= innerWidth;
  }));
  const mobileSearch = catalogPage.getByLabel("搜索数据库表与字段", { exact: true });
  await mobileSearch.click(); await mobileSearch.fill("customers");
  await catalogPage.getByRole("status").filter({ hasText: "匹配 1 个字段" }).waitFor();
  await noPageOverflow(catalogPage);
  const searchBox = await mobileSearch.boundingBox(); assert.ok(searchBox && searchBox.x >= 0 && searchBox.x + searchBox.width <= 390);
  await catalogPage.locator(".connection-catalog").scrollIntoViewIfNeeded();
  await catalogPage.screenshot({ path: join(directory, "catalog-mobile.png") });
  await catalogPage.getByRole("button", { name: "查询表", exact: true }).click();
  assert.equal(await catalogPage.locator(".notebook-editor").getByLabel("SQL", { exact: true }).inputValue(), 'SELECT * FROM "sales"."customers" LIMIT 100');
  checks.push("Catalog mobile search and table-to-SQL action work after closing the existing assistant panel; no page overflow");
  assert.equal(calls, 3);

  const page = await newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  const projectPath = join(directory, "synthetic-project");
  const dataBrowser = () => page.getByRole("dialog", { name: "Data Browser 数据浏览器" });
  async function openBrowser() {
    await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
    await page.getByRole("navigation", { name: "工作区功能菜单" }).getByRole("button", { name: "数据浏览器", exact: true }).click();
    await dataBrowser().waitFor();
  }
  await openBrowser();
  await dataBrowser().getByLabel("项目名称", { exact: true }).fill("数据底座合成验收");
  await dataBrowser().getByLabel("项目文件夹绝对路径", { exact: true }).fill(projectPath);
  await dataBrowser().getByRole("button", { name: "新建本地项目", exact: true }).click();
  await dataBrowser().waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "Notebook", exact: true }).click();
  await page.locator(".notebook-heading").getByRole("button", { name: "导入数据", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "导入本机表格", exact: true });
  await upload.locator('input[type="file"]').setInputFiles({ name: "synthetic-foundation-sales.csv", mimeType: "text/csv", buffer: Buffer.from("region,amount\nEast,100\nEast,50\nSouth,80\n") });
  await upload.getByRole("button", { name: "导入 1 份文件", exact: true }).click();
  await upload.waitFor({ state: "hidden" });
  const dismiss = page.getByRole("button", { name: "知道了", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  async function saveCell() { await page.locator(".notebook-editor").getByRole("button", { name: "保存单元", exact: true }).click(); await page.locator(".notebook-editor").waitFor({ state: "hidden" }); }
  await page.getByRole("button", { name: "＋ Data", exact: true }).click();
  await page.locator(".notebook-editor").getByLabel("输出表名（SQL 中使用）", { exact: true }).fill("sales"); await saveCell();
  await page.getByRole("button", { name: "＋ SQL", exact: true }).click();
  const sql = "SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY region";
  await page.locator(".notebook-editor").getByLabel("SQL", { exact: true }).fill(sql); await saveCell();
  async function run(button) {
    const [response] = await Promise.all([page.waitForResponse((response) => response.url() === `${base}/api/notebook/run`, { timeout: 45_000 }), button.click()]);
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body)); assert.equal(body.run.status, "success", JSON.stringify(body));
    await page.getByRole("button", { name: "停止运行", exact: true }).waitFor({ state: "hidden" }); return body;
  }
  const firstRun = await run(page.getByRole("button", { name: "▶ 全部运行", exact: true }));
  assert.deepEqual(firstRun.run.cells.at(-1).table.rows, [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }]);
  const saved = await run(page.getByRole("article", { name: "SQL单元 SQL 数据分析", exact: true }).getByRole("button", { name: "保存为 Dataset", exact: true }));
  const provenance = saved.snapshot.dataset.provenance;
  assert.equal(provenance.lineage.steps.length, 2); assert.equal(provenance.lineage.complete, true);
  assert.equal(JSON.parse(provenance.lineage.steps[1].definition).sql, sql);
  checks.push("Actual CSV import, DuckDB aggregation and Dataset save retain exact SQL and dependency receipt");
  const recent = page.getByRole("region", { name: "最近保存的数据集" });
  await recent.locator(".dataset-provenance > summary").click();
  const download = page.waitForEvent("download");
  await recent.getByRole("button", { name: "下载来源记录", exact: true }).click();
  const downloaded = await download; const downloadedPath = join(directory, "downloaded-provenance.json"); await downloaded.saveAs(downloadedPath);
  assert.deepEqual(JSON.parse(await readFile(downloadedPath, "utf8")), provenance);
  checks.push("Source receipt downloads as matching JSON without result rows");
  const manifest = JSON.parse(await readFile(join(projectPath, "agentcanvas.project.json"), "utf8"));
  assert.deepEqual(manifest.tables.find((entry) => entry.descriptor.datasetId === saved.snapshot.dataset.datasetId).descriptor.provenance, provenance);
  await page.reload({ waitUntil: "networkidle" });
  await openBrowser();
  await dataBrowser().getByRole("button", { name: /已保存结果/ }).click();
  await dataBrowser().locator(".dataset-provenance > summary").click();
  assert.match(await dataBrowser().locator(".dataset-provenance").innerText(), /2 行完整结果/);
  await dataBrowser().locator(".dataset-provenance li details").last().locator("summary").click();
  assert.match(await dataBrowser().locator(".dataset-provenance pre").last().innerText(), /SUM\(amount\)/);
  checks.push("Dataset provenance survives actual disk save and browser reload in Data Browser");
  await page.screenshot({ path: join(directory, "dataset-provenance-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await noPageOverflow(page);
  await dataBrowser().locator(".dataset-provenance").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, "dataset-provenance-mobile.png") });
  checks.push("Source details remain readable on mobile");
  assert.deepEqual(errors, []); assert.equal(aiRequests, 0);
  await writeFile(join(directory, "report.json"), JSON.stringify({ passed: true, checks, errors, aiRequests,
    catalogMode: "mocked HTTP fixture; no external database", executionMode: "real local DuckDB and project persistence", projectPath }, null, 2));
  console.log(JSON.stringify({ directory, checks, errors, aiRequests }, null, 2));
} catch (error) {
  await writeFile(join(directory, "report.json"), JSON.stringify({ passed: false, checks, errors, aiRequests, error: error.message, stack: error.stack }, null, 2));
  for (const context of browser.contexts()) for (const [index, page] of context.pages().entries()) await page.screenshot({ path: join(directory, `failure-${context === browser.contexts()[0] ? "catalog" : "dataset"}-${index}.png`) }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
