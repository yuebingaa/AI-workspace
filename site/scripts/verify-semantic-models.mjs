import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// An isolated browser and synthetic CSV only. Never publish, use user storage,
// or send a request to an external model during this UI verification.
const evidence = resolve(".runtime", "semantic-models");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
page.setDefaultTimeout(15_000);
const errors = [], screenshots = [], measurements = [];
let submitted;
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/ai/harness/stream", async (route) => {
  submitted = route.request().postDataJSON();
  await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "隔离浏览器验收：已拦截请求，未调用外部模型。" }) });
});
const snapshot = () => page.evaluate(() => JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1")));
const manager = page.getByRole("dialog", { name: "语义模型管理" });
async function capture(name, inspectDialog = false) {
  const file = resolve(evidence, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" }); screenshots.push(file);
  if (inspectDialog) {
    const metrics = await manager.evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect(), footer = dialog.querySelector("footer").getBoundingClientRect();
      const body = dialog.querySelector(".semantic-manager-body");
      return { viewport: innerWidth, dialogLeft: rect.left, dialogRight: rect.right, dialogTop: rect.top, dialogBottom: rect.bottom,
        footerBottom: footer.bottom, viewportHeight: innerHeight, overflow: body.scrollWidth - body.clientWidth };
    });
    measurements.push({ name, ...metrics });
    assert(metrics.dialogLeft >= 0 && metrics.dialogRight <= metrics.viewport, "Dialog must fit the viewport");
    assert(metrics.dialogTop >= 0 && metrics.dialogBottom <= metrics.viewportHeight, "Dialog must fit vertically");
    assert(metrics.footerBottom <= metrics.viewportHeight, "Action buttons must remain visible");
    assert(metrics.overflow <= 2, "Form must reflow instead of overflowing horizontally");
  }
}
try {
  await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle", timeout: 30_000 });
  const workspace = page.locator(".spreadsheet-workspace");
  await workspace.getByRole("button", { name: "导入本机表格" }).click();
  const upload = page.locator(".csv-upload-dialog");
  await upload.locator('input[type="file"]').setInputFiles({ name: "语义模型测试销售.csv", mimeType: "text/csv",
    buffer: Buffer.from("region,amount\n华东,100\n华东,50\n华南,80", "utf8") });
  await upload.getByRole("button", { name: "导入 1 份文件" }).click();
  await upload.waitFor({ state: "hidden" });
  await workspace.getByText("华南", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  const sidebar = page.locator(".left-panel"), section = sidebar.locator(".semantic-section");
  await section.getByRole("button", { name: "＋ 创建", exact: true }).click();
  await manager.getByLabel("模型名称", { exact: true }).fill("销售分析");
  await manager.getByLabel("业务说明", { exact: true }).fill("按地区汇总销售金额，演示数据，不含个人信息。");
  await manager.getByRole("button", { name: "＋ 添加维度", exact: true }).click();
  await manager.getByLabel("维度1名称", { exact: true }).fill("销售区域");
  await manager.getByLabel("维度1标识", { exact: true }).fill("area");
  await manager.getByRole("button", { name: "＋ 添加指标", exact: true }).click();
  await manager.getByLabel("指标1名称", { exact: true }).fill("销售额");
  await manager.getByLabel("指标1标识", { exact: true }).fill("revenue");
  await manager.getByLabel("指标1字段", { exact: true }).selectOption("amount");
  await manager.getByLabel("指标1计算方式", { exact: true }).selectOption("sum");
  await manager.getByRole("button", { name: "预览计算" }).click();
  await manager.locator(".semantic-preview").getByText("150", { exact: true }).waitFor();
  assert.equal(await manager.locator(".semantic-preview").getByText("80", { exact: true }).count(), 1);
  await capture("desktop-editor", true);
  await manager.locator(".semantic-preview").scrollIntoViewIfNeeded();
  await capture("desktop-preview", true);
  await manager.getByRole("button", { name: "保存并选择" }).click();
  await manager.waitFor({ state: "hidden" });
  await section.locator('.semantic-model-row.selected').waitFor();
  const saved = await snapshot(), model = saved.dataProduct.semanticLayer.models[0];
  assert.equal(model.name, "销售分析"); assert.equal(model.version, 1);
  assert.equal(model.measures[0].aggregation, "sum");
  assert.equal(Object.values(saved.dataProduct.semanticLayer.selectedByWorkspace)[0], model.id);
  await capture("desktop-selected");

  await section.getByRole("button", { name: "＋ 创建", exact: true }).click();
  await manager.getByLabel("模型名称", { exact: true }).fill("平均单笔金额");
  await manager.getByRole("button", { name: "＋ 添加指标", exact: true }).click();
  await manager.getByLabel("指标1名称", { exact: true }).fill("平均金额");
  await manager.getByLabel("指标1字段", { exact: true }).selectOption("amount");
  await manager.getByLabel("指标1计算方式", { exact: true }).selectOption("average");
  await manager.getByRole("button", { name: "保存并选择" }).click();
  await manager.waitFor({ state: "hidden" });
  assert.equal((await snapshot()).dataProduct.semanticLayer.models.length, 2);
  await section.locator(".semantic-model-row").filter({ has: page.getByText("销售分析", { exact: true }) }).locator("button").first().click();
  assert.equal(Object.values((await snapshot()).dataProduct.semanticLayer.selectedByWorkspace)[0], model.id);
  await capture("multiple-models");
  await section.getByRole("button", { name: "管理语义模型 平均单笔金额", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await manager.getByRole("button", { name: "删除模型", exact: true }).click();
  await manager.waitFor({ state: "hidden" });
  assert.equal(Object.values((await snapshot()).dataProduct.semanticLayer.selectedByWorkspace)[0], model.id);

  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  await page.locator(".semantic-context").getByText(/销售分析/).waitFor();
  await page.getByRole("button", { name: "添加上下文", exact: true }).click();
  await page.getByRole("menuitem", { name: "选择语义模型", exact: true }).click();
  const modelMenu = page.getByRole("menu", { name: "语义模型", exact: true });
  assert.equal(await modelMenu.getByRole("menuitemradio", { name: /销售分析/ }).getAttribute("aria-checked"), "true");
  await capture("context-menu");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "AI 指令", exact: true }).fill("按销售区域统计销售额，不修改看板");
  await page.getByRole("button", { name: "发送 AI 指令" }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="取消 AI 请求"]'));
  await page.getByText("Harness 服务暂时不可用。", { exact: true }).first().waitFor();
  assert.equal(submitted.semanticModel.id, model.id);
  assert.equal(submitted.dataSourceId, model.sourceDatasetId);
  assert.equal(submitted.semanticModel.measures[0].aggregation, "sum");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  await section.locator('.semantic-model-row.selected').waitFor();
  await section.getByRole("button", { name: "管理语义模型 销售分析", exact: true }).click();
  await manager.getByLabel("模型名称", { exact: true }).fill("销售分析修订版");
  await manager.getByRole("button", { name: "保存并选择" }).click();
  await manager.waitFor({ state: "hidden" });
  const updated = (await snapshot()).dataProduct.semanticLayer.models[0];
  assert.equal(updated.id, model.id); assert.equal(updated.version, 2);
  await sidebar.getByRole("button", { name: "＋ 空白界面", exact: true }).click();
  await section.getByText("暂无模型。导入表格后，可创建自己的分析口径。", { exact: true }).waitFor();
  assert.equal(await section.getByRole("button", { name: "＋ 创建", exact: true }).isEnabled(), false);
  await sidebar.locator(".page-list-row > button").filter({ hasText: /^◉?\s*空白工作界面$/ }).click();
  await section.getByRole("button", { name: "管理语义模型 销售分析修订版", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile-editor", true);
  await manager.getByRole("button", { name: "预览计算" }).click();
  await manager.locator(".semantic-preview").scrollIntoViewIfNeeded();
  await capture("mobile-preview", true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforeDelete = (await snapshot()).dataProduct;
  page.once("dialog", (dialog) => dialog.dismiss());
  await manager.getByRole("button", { name: "删除模型", exact: true }).click();
  assert.equal((await snapshot()).dataProduct.semanticLayer.models.length, 1);
  page.once("dialog", (dialog) => dialog.accept());
  await manager.getByRole("button", { name: "删除模型", exact: true }).click();
  await manager.waitFor({ state: "hidden" });
  const afterDelete = (await snapshot()).dataProduct;
  assert.deepEqual(afterDelete.semanticLayer, { models: [], selectedByWorkspace: {} });
  assert.deepEqual(afterDelete.datasets, beforeDelete.datasets);
  assert.deepEqual(afterDelete.appSpec, beforeDelete.appSpec);
  assert.deepEqual(errors, []);
  const report = { passed: true, baseUrl: "http://127.0.0.1:3001", externalModelCalled: false,
    checks: ["real CSV import", "create/preview/save", "multiple models and switching", "select in sidebar and AI context", "AI request model/version binding", "reload persistence", "edit/version increment", "workspace isolation", "mobile reflow and preview", "delete confirmation and original data preservation"],
    modelId: model.id, measurements, screenshots, errors };
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidence, "failure.png") }).catch(() => {});
  throw error;
} finally { await browser.close(); }
