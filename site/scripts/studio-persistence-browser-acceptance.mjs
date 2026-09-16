import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

// Isolated temporary workspace and synthetic definitions only. No user storage,
// project files, settings, model calls or existing browser profiles are modified.
const origin = "http://127.0.0.1:3001";
const evidence = resolve(".runtime", `studio-persistence-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [], consoleErrors = [], checks = [];
let modelRequests = 0, settingsWrites = 0, acceptedRestores = 0;
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
await context.route("**/api/ai/**", route => { modelRequests++; return route.abort(); });
await context.route("**/api/projects", route => route.request().method() === "GET"
  ? route.fulfill({ status: 200, json: { projects: [] } }) : route.abort());
await context.route("**/api/settings/**", route => {
  if (route.request().method() !== "GET") { settingsWrites++; return route.abort(); }
  return route.fulfill({ status: 200, json: route.request().url().endsWith("/wecom")
    ? { available: true, connected: false, pending: false, qrReady: false, failed: false, message: "尚未连接", tools: [] }
    : { configured: false, source: "none", model: "test-model", availableModels: [], persistence: "process-memory" } });
});
await context.addInitScript(() => {
  const original = Storage.prototype.setItem;
  window.syntheticSaveFailures = 0;
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && key === "datacanvas-ai:studio:v1"
      && sessionStorage.getItem("synthetic-storage-fault") === "on") {
      window.syntheticSaveFailures++;
      throw new DOMException("Synthetic storage quota exceeded", "QuotaExceededError");
    }
    return original.call(this, key, value);
  };
});
page.on("dialog", async dialog => {
  assert.equal(dialog.type(), "confirm");
  assert.match(dialog.message(), /确定从.*恢复工作区/);
  acceptedRestores++;
  await dialog.accept();
});
const menu = page.getByRole("navigation", { name: "工作区功能菜单" });
async function openMenu() {
  if (!await menu.isVisible()) await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
  await menu.waitFor();
}
async function action(label) {
  await openMenu();
  await menu.getByRole("textbox", { name: "查找功能或工作界面" }).fill(label);
  await menu.getByRole("button", { name: label, exact: true }).click();
}
async function createPage(name) {
  await openMenu();
  await menu.getByRole("button", { name: "新建界面", exact: true }).click();
  await menu.getByLabel("工作界面名称", { exact: true }).fill(name);
  await menu.getByRole("button", { name: "创建", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
}
async function persisted() {
  return page.evaluate(() => JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1")));
}
async function downloadBackup() {
  const pending = page.waitForEvent("download");
  await action("下载工作区备份");
  const download = await pending;
  const buffer = await readFile(await download.path());
  assert(buffer.length <= 5 * 1024 * 1024);
  return { buffer, value: JSON.parse(buffer.toString("utf8")) };
}
try {
  assert.equal((await page.goto(origin, { waitUntil: "networkidle" })).status(), 200);
  await page.waitForFunction(() => Boolean(localStorage.getItem("datacanvas-ai:studio:v1")));
  await createPage("合成保存验收");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1"))
    .appSpec.pages.some(item => item.title === "合成保存验收"));
  const backup = await downloadBackup();
  assert.equal(backup.value.format, "datacanvas-ai-studio-backup-v1");
  assert.equal(backup.value.state.version, 5);
  assert(backup.value.state.appSpec.pages.some(item => item.title === "合成保存验收"));
  const goodState = await persisted();
  checks.push("explicit page creation is saved; exported backup retains the v5 format");

  await page.evaluate(() => sessionStorage.setItem("synthetic-storage-fault", "on"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("alert").filter({ hasText: "本地保存失败" }).waitFor();
  assert.deepEqual(await persisted(), goodState);
  assert((await page.evaluate(() => window.syntheticSaveFailures)) >= 1);
  const failures = await page.evaluate(() => window.syntheticSaveFailures);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.syntheticSaveFailures), failures, "Failed autosave must not enter a retry/render loop");
  await page.screenshot({ path: join(evidence, "autosave-failure.png") });
  checks.push("failed automatic storage write shows feedback asynchronously and preserves the previous saved state");

  await createPage("合成未保存更改");
  assert(!(await persisted()).appSpec.pages.some(item => item.title === "合成未保存更改"));
  const unsavedBackup = await downloadBackup();
  assert(unsavedBackup.value.state.appSpec.pages.some(item => item.title === "合成未保存更改"));
  checks.push("explicit save failure keeps the in-memory edit available for backup");

  await page.evaluate(() => sessionStorage.removeItem("synthetic-storage-fault"));
  // Make the current durable state different from the backup. Otherwise a no-op
  // restore followed by reload could incorrectly look like successful recovery.
  await createPage("合成恢复前草稿");
  await page.waitForFunction(() => {
    const pages = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1")).appSpec.pages;
    return pages.some(item => item.title === "合成恢复前草稿")
      && pages.some(item => item.title === "合成未保存更改");
  });
  const chooser = page.waitForEvent("filechooser");
  await action("从备份文件恢复");
  await (await chooser).setFiles({ name: "synthetic-backup.json", mimeType: "application/json", buffer: backup.buffer });
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1"));
    return state.appSpec.pages.some(item => item.title === "合成保存验收")
      && !state.appSpec.pages.some(item => ["合成未保存更改", "合成恢复前草稿"].includes(item.title));
  });
  assert.equal(acceptedRestores, 1);
  await page.reload({ waitUntil: "networkidle" });
  const restored = await persisted();
  assert.deepEqual(restored.appSpec, backup.value.state.appSpec);
  assert.deepEqual(restored.dataProduct, backup.value.state.dataProduct);
  await openMenu();
  await menu.getByRole("button", { name: "合成保存验收", exact: false }).waitFor();
  assert.equal(await menu.getByRole("button", { name: /合成未保存更改/ }).count(), 0);
  await page.screenshot({ path: join(evidence, "restored-backup.png") });
  checks.push("confirmed restore survives refresh without being overwritten by old automatic saves");
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  assert.equal(modelRequests, 0); assert.equal(settingsWrites, 0);
  await writeFile(join(evidence, "report.json"), JSON.stringify({ origin, checks, errors, consoleErrors, modelRequests, settingsWrites }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, checks, errors, consoleErrors, modelRequests, settingsWrites }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ passed: false, evidence, checks, errors, consoleErrors, error: error.message }, null, 2));
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
