import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { chromium } from "playwright-core";

// Existing managed 3001, fresh browser storage, synthetic Notebook API receipt.
// This verifies the real preview UI, not SQL/Python execution or user projects.
const red = process.argv.includes("--red");
const base = "http://127.0.0.1:3001";
const directory = resolve(".runtime/preview-own-values-2026-09-23", `${red ? "red" : "green"}-${Date.now()}`);
const title = "合成回执 · 特殊字段预览";
const names = ["seq", "toString", "constructor", "__proto__", "hasOwnProperty"];
const special = names.slice(1);
const rows = Array.from({ length: 25 }, (_, index) => {
  const seq = index + 1;
  if (seq === 1) return { seq };
  if (seq === 25) return Object.fromEntries([["seq", seq], ...special.map(name => [name, null])]);
  return { seq, toString: seq === 2 ? "=1+1" : `a${String(seq).padStart(2, "0")}`,
    constructor: `c${String(seq).padStart(2, "0")}`, hasOwnProperty: `h${String(seq).padStart(2, "0")}` };
});
const table = { fields: names.map(name => ({ name, label: name, type: name === "seq" ? "number" : "string" })), rows, truncated: false };
const own = (row, name) => Object.hasOwn(row, name) ? row[name] : undefined;
const shown = row => names.map(name => String(own(row, name) ?? "NULL"));
function sorted(name, direction) {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const x = own(a.row, name), y = own(b.row, name);
    if (x == null || y == null) return x == null && y == null ? a.index - b.index : x == null ? 1 : -1;
    return (direction === "ascending" ? 1 : -1) * (x < y ? -1 : x > y ? 1 : 0) || a.index - b.index;
  }).map(item => item.row);
}
await mkdir(resolve(directory, "downloads"), { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", serviceWorkers: "block", acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { passed: false, red, mode: "Synthetic JSON Notebook receipt through the real schema/cache and preview UI",
  liveModels: 0, liveDatabase: 0, liveNotebook: 0, liveProjectReadsOrWrites: 0,
  limitation: "Zod record parsing drops own __proto__; browser covers missing __proto__ and own toString/constructor/hasOwnProperty. Own __proto__ preservation belongs to direct helper/component tests. No SQL/Python execution claimed.",
  checks: [], screenshots: [], downloads: [], requests: [], replacements: [], blocked: [], pageErrors: [] };
page.on("pageerror", error => report.pageErrors.push(error.message));
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) { report.blocked.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort("blockedbyclient"); }
  if (!url.pathname.startsWith("/api/")) return route.continue();
  const method = request.method();
  report.requests.push({ method, path: url.pathname });
  const replacements = { "/api/connections": { connections: [] }, "/api/projects": { projects: [] },
    "/api/notebook/python": { enabled: false, available: false, reason: "隔离预览验收，不执行 Python" } };
  if (method === "GET" && Object.hasOwn(replacements, url.pathname)) {
    report.replacements.push(url.pathname);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(replacements[url.pathname]) });
  }
  if (url.pathname === "/api/notebook/run" && method === "POST") {
    const input = request.postDataJSON();
    assert.equal(input.action, "run"); assert.equal(input.document.cells.length, 1);
    const cell = input.document.cells[0]; assert.equal(cell.kind, "parameter"); assert.equal(cell.title, title);
    assert.equal(input.targetCellId, cell.id);
    const runId = `synthetic_preview_${Date.now()}`;
    const run = { runId, revision: input.document.revision, startedAt: new Date().toISOString(), status: "success",
      dataSignature: "synthetic-preview-only", notice: "合成 API 回执；仅验收表格预览，未执行 SQL / Python。",
      cells: [{ cellId: cell.id, status: "success", durationMs: 0, table,
        resultRef: { resultId: `${runId}:${cell.id}`, runId, cellId: cell.id, revision: input.document.revision,
          mode: "table", inputResultIds: [], rowCount: rows.length, complete: true, dataSignature: "synthetic-preview-only", accessMode: "user" } }] };
    report.replacements.push("POST /api/notebook/run: explicit synthetic table");
    await writeFile(resolve(directory, "synthetic-receipt.json"), JSON.stringify({ run }, null, 2));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run }) });
  }
  report.blocked.push(`${method} ${url.pathname}`);
  return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Synthetic preview acceptance blocks this API." } }) });
});
const cell = () => page.getByRole("article", { name: `参数单元 ${title}`, exact: true });
const region = () => cell().getByRole("region", { name: "当前预览导出", exact: true });
async function step(name, action) { await action(); report.checks.push(name); console.log(`PASS ${name}`); }
async function screenshot(name, scene, target = cell()) {
  if (target) await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide overflow");
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: "disabled" });
  report.screenshots.push({ file: `${name}.png`, scene, viewport: page.viewportSize(), visuallyReviewed: false });
}
async function visibleRows() { return cell().locator("tbody tr").evaluateAll(items => items.map(row => [...row.querySelectorAll("td")].map(td => td.textContent))); }
async function sort(name, direction) {
  const button = cell().getByRole("button", { name: `按${name}排序`, exact: true }); await button.click();
  assert.equal(await button.evaluate(element => element.closest("th").getAttribute("aria-sort")), direction);
}
async function verifyOrder(expected) {
  assert.deepEqual(await visibleRows(), expected.slice(0, 20).map(shown));
  assert.equal(await cell().getByRole("button", { name: "上一页结果", exact: true }).isDisabled(), true);
  await cell().getByRole("button", { name: "下一页结果", exact: true }).click();
  assert.deepEqual(await visibleRows(), expected.slice(20).map(shown));
  assert.equal(await cell().getByRole("button", { name: "下一页结果", exact: true }).isDisabled(), true);
}
async function download(name, expected) {
  const requestCount = report.requests.length;
  const pending = page.waitForEvent("download");
  await cell().getByRole("button", { name: "导出当前预览 CSV", exact: true }).click();
  const item = await pending; assert.equal(await item.failure(), null);
  const file = `downloads/${name}.csv`; await item.saveAs(resolve(directory, file));
  const bytes = await readFile(resolve(directory, file));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const records = [names, ...expected.map(row => names.map(name => {
    const value = own(row, name); return value == null ? "" : value === "=1+1" ? "'=1+1" : String(value);
  }))];
  assert.deepEqual(parse(bytes, { bom: true, record_delimiter: "\r\n" }), records);
  assert.equal(bytes.toString("utf8"), "\ufeff" + records.map(record => record.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n");
  assert.equal(report.requests.length, requestCount, "Export must not fetch or execute");
  assert.match(await region().getByRole("status").innerText(), /25 行.*1 个/);
  report.downloads.push({ file, dataRows: 25, bytes: bytes.length, protection: "'=1+1 verified in CSV text; no spreadsheet app opened" });
}
try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("tab", { name: "Notebook", exact: true }).click();
  const notice = page.locator(".persistence-notice").getByRole("button", { name: "知道了", exact: true });
  if (await notice.isVisible()) await notice.click();
  await page.getByRole("group", { name: "添加分析单元", exact: true }).getByRole("button", { name: "＋ 参数", exact: true }).click();
  const editor = page.locator(".notebook-editor");
  await editor.getByLabel("单元名称", { exact: true }).fill(title);
  await editor.getByLabel("参数值", { exact: true }).fill("仅用于预览 UI 回执夹具；没有真实参数或 SQL / Python 执行");
  await editor.getByRole("button", { name: "保存单元", exact: true }).click(); await editor.waitFor({ state: "hidden" });
  await cell().getByRole("button", { name: "▶ 运行", exact: true }).click();
  await cell().locator("tbody tr").first().waitFor();
  const original = await visibleRows();
  if (red) {
    assert.match(original[0][1], /function toString/); assert.match(original[0][2], /function Object/);
    assert.equal(original[0][3], "[object Object]"); assert.match(original[0][4], /function hasOwnProperty/);
    report.checks.push("RED: sparse special fields render inherited functions/Object instead of NULL");
    await screenshot("01-missing-fields-inherit-prototype-1440", "修前：第 1 行缺失特殊字段显示原型函数 / [object Object]；API 回执为合成数据。");
  } else {
    await step("Sparse fields display NULL while own special strings survive", async () => {
      assert.deepEqual(original, rows.slice(0, 20).map(shown));
      assert.deepEqual(await cell().locator("tbody tr").first().locator("td").evaluateAll(items => items.map(item => item.title)), shown(rows[0]));
      await screenshot("01-missing-fields-null-own-values-1440", "修后：第 1 行缺失值均显示 NULL；实际 own 字段文本保留，公式样文本按文本显示。");
    });
    await step("Ascending and descending both keep missing and explicit null last across 20-row pages", async () => {
      await sort("toString", "ascending"); await verifyOrder(sorted("toString", "ascending"));
      await screenshot("02-ascending-null-last-page-1440", "升序第二页：5 行，缺失第 1 行与显式 null 第 25 行都在末尾；首尾翻页按钮状态正确。");
      await sort("toString", "descending"); await verifyOrder(sorted("toString", "descending"));
      await page.setViewportSize({ width: 1024, height: 1000 });
      await screenshot("03-descending-null-last-page-1024", "1024 降序第二页：缺失与显式 null 仍在末尾；五列同屏，无页面级横向溢出。");
    });
    await step("CSV contains all 25 rows in current order, empty missing fields and protected formula text", async () => {
      await download("01-descending-all-25", sorted("toString", "descending"));
      await screenshot("04-csv-all-preview-success-1024", "下载成功：第二页只显示 5 行，CSV 包含全部 25 行，1 个公式样文本有单引号保护；仅下载合成夹具。", region());
    });
    await step("Every special column sorts and reset returns all original rows without a request", async () => {
      const count = report.requests.length;
      for (const name of ["constructor", "hasOwnProperty", "__proto__"]) {
        await sort(name, "ascending"); await verifyOrder(sorted(name, "ascending"));
        await sort(name, "descending"); await verifyOrder(sorted(name, "descending"));
      }
      await sort("__proto__", "none"); await verifyOrder(rows);
      assert.equal(report.requests.length, count);
    });
    await step("Browser download failure remains retryable and retry preserves preview", async () => {
      await page.evaluate(() => {
        const original = URL.createObjectURL;
        URL.createObjectURL = (...args) => { URL.createObjectURL = original; void args; throw new Error("Synthetic object URL allocation failure"); };
      });
      await cell().getByRole("button", { name: "导出当前预览 CSV", exact: true }).click();
      assert.match(await region().getByRole("alert").innerText(), /失败.*重试/);
      assert.deepEqual(await visibleRows(), rows.slice(20).map(shown));
      await screenshot("05-csv-failure-retryable-1024", "明确注入浏览器 object URL 分配失败：错误与重试入口可见，结果仍在。", region());
      await download("02-retry-original-all-25", rows);
      assert.equal(await region().getByRole("alert").count(), 0);
    });
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blocked, []);
  assert.equal(report.requests.filter(request => request.path === "/api/notebook/run").length, 1);
  report.passed = true;
} catch (error) {
  report.failure = (error.stack ?? String(error)).replaceAll(resolve("..") + "\\", "").replaceAll(resolve("..") + "/", "");
  await screenshot("failure", "验收脚本失败现场", null).catch(() => {});
} finally {
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, red, directory, checks: report.checks, failure: report.failure }, null, 2));
  await browser.close();
}
if (!report.passed) process.exitCode = 1;
