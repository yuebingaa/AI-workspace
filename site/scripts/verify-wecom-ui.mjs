import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const base = "http://127.0.0.1:3001";
const evidence = resolve("evidence/wecom");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/api/ai/**", (route) => route.abort());
try {
  const actualResponse = await context.request.get(`${base}/api/settings/wecom`);
  assert.equal(actualResponse.status(), 200);
  const actual = await actualResponse.json();
  assert.equal(actual.available, true);
  assert.equal(actual.connected, false);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "配置企业微信连接" }).first().click();
  const dialog = page.getByRole("dialog", { name: "连接企业微信" });
  await dialog.getByText("尚未连接企业微信。", { exact: true }).waitFor();
  const connect = dialog.getByRole("button", { name: "扫码连接企业微信" });
  assert.equal(await connect.isDisabled(), true);
  await page.screenshot({ path: resolve(evidence, "wecom-disconnected-desktop.png") });

  // UI transitions are mocked: no login, account binding, live AI request or corporate read.
  let mock = { ...actual }; let posts = 0; let deletes = 0;
  await context.route("**/api/settings/wecom*", async (route) => {
    if (route.request().method() === "POST") {
      assert.equal(route.request().postDataJSON().consent, true); posts++;
      mock = { ...actual, pending: true, message: "请用企业微信扫描二维码并确认授权，二维码约 5 分钟有效。" };
    } else if (route.request().method() === "DELETE") { deletes++; mock = { ...actual }; }
    await route.fulfill({ json: mock });
  });
  await dialog.getByRole("checkbox").check();
  await connect.click();
  await dialog.getByText("等待扫码授权", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "取消授权", exact: true }).click();
  await dialog.getByText("尚未连接企业微信。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
  mock = { ...actual, connected: true, message: "已连接，可在 AI 对话中搜索文档、读取表格。" };
  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await dialog.getByText("已连接 · 只读模式", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, "wecom-connected-mock-desktop.png") });
  const example = "帮我在企业微信搜索销售报表，先列出候选文档让我选择";
  await dialog.getByRole("button", { name: example, exact: true }).click();
  assert.equal(await page.locator("textarea").first().inputValue(), example);
  await page.getByRole("button", { name: "配置企业微信连接" }).first().click();
  await dialog.getByRole("button", { name: "断开并移除本机凭据" }).click();
  await dialog.getByText("尚未连接企业微信。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({ path: resolve(evidence, "wecom-disconnected-mobile.png") });
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(posts, 1); assert.equal(deletes, 2); assert.deepEqual(errors, []);
  const report = { actualLocalComponentAvailable: actual.available, actualAccountConnected: false, realLoginPerformed: false, liveAiCalls: 0, mockedConsentAndPendingAndConnectedAndDisconnect: true, examplesFillComposer: true, mobileDialogFits: true, pageErrors: errors };
  await writeFile(resolve(evidence, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); await browser.close(); }
