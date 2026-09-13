import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import writeXlsxFile from "write-excel-file/node";

const baseUrl = process.env.SPREADSHEET_WORKSPACE_BASE_URL || "http://localhost:3000";
const executablePath = process.env.SPREADSHEET_WORKSPACE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const evidenceDirectory = resolve("evidence", "spreadsheet-workspace");
await mkdir(evidenceDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const xlsxBuffer = await writeXlsxFile([{
  sheet: "库存",
  data: [
    [{ value: "product", type: String }, { value: "stock", type: String }],
    [{ value: "螺丝", type: String }, { value: 240, type: Number }],
    [{ value: "电机", type: String }, { value: 18, type: Number }],
  ],
}]).toBuffer();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
await page.addInitScript(() => localStorage.clear());

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  const workspace = page.locator(".spreadsheet-workspace");
  await workspace.waitFor({ state: "visible", timeout: 30_000 });
  const blankCanvas = page.locator(".empty-workspace-canvas");
  await blankCanvas.waitFor({ state: "visible", timeout: 30_000 });
  const initialInterfaceLabel = await page.locator(".interface-switcher:not(.compact-interface-switcher)>summary b").innerText();
  if (initialInterfaceLabel !== "空白工作界面") throw new Error(`首次进入的工作界面不是空白界面：${initialInterfaceLabel}`);

  const interfaceSwitcher = page.locator(".interface-switcher:not(.compact-interface-switcher)");
  await interfaceSwitcher.locator("summary").click();
  await interfaceSwitcher.locator("#interface-name").fill("质量分析");
  await interfaceSwitcher.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "质量分析" }).waitFor({ state: "visible" });
  await workspace.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDirectory, "blank-workspace.png"), fullPage: false });
  const workspaceEvidence = await workspace.evaluate((element) => ({
    text: element.innerText,
    width: element.getBoundingClientRect().width,
    tableVisible: Boolean(element.querySelector("table")),
    horizontalOverflow: element.querySelector(".spreadsheet-grid-scroll")
      ? getComputedStyle(element.querySelector(".spreadsheet-grid-scroll")).overflowX
      : null,
  }));
  const importButton = workspace.getByRole("button", { name: "导入本机表格" });
  const importButtonEvidence = await importButton.evaluate((element) => ({ disabled: element.disabled, outerHTML: element.outerHTML }));
  await importButton.click();
  await page.waitForTimeout(500);
  const dialogCountAfterClick = await page.locator(".csv-upload-dialog").count();
  if (dialogCountAfterClick === 0) throw new Error(`点击导入按钮后对话框未打开：${JSON.stringify(importButtonEvidence)}`);
  const dialog = page.locator(".csv-upload-dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.screenshot({ path: resolve(evidenceDirectory, "import-dialog.png") });
  const dialogEvidence = await dialog.evaluate((element) => ({
    text: element.innerText,
    accept: element.querySelector("input[type=file]")?.getAttribute("accept"),
    multiple: element.querySelector("input[type=file]")?.hasAttribute("multiple"),
    width: element.getBoundingClientRect().width,
  }));
  if (!workspaceEvidence.text.includes("表格工作区") || workspaceEvidence.tableVisible) throw new Error("初始表格工作区没有保持空白状态");
  if (!dialogEvidence.accept?.includes(".csv") || !dialogEvidence.accept.includes(".xlsx")) throw new Error("导入入口未同时接受 CSV 与 XLSX");
  if (!dialogEvidence.multiple) throw new Error("导入入口未开放多文件选择");
  await dialog.locator('input[type="file"]').setInputFiles([
    {
      name: "质量数据.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,amount,active\n张三,120,true\n李四,88,false", "utf8"),
    },
    {
      name: "库存数据.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: xlsxBuffer,
    },
  ]);
  const queueItems = dialog.locator(".spreadsheet-upload-file");
  await queueItems.nth(1).waitFor({ state: "visible" });
  const targetSelectors = dialog.getByLabel("放入界面");
  await targetSelectors.nth(1).selectOption({ label: "空白工作界面" });
  await dialog.screenshot({ path: resolve(evidenceDirectory, "multi-file-targets.png") });
  await dialog.getByRole("button", { name: "导入 2 份文件" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await workspace.getByText("螺丝", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  const sidePanel = page.locator(".left-panel");
  await sidePanel.getByRole("button", { name: "＋ 空白界面" }).waitFor({ state: "visible" });
  await sidePanel.getByRole("button", { name: "重命名质量分析" }).waitFor({ state: "visible" });
  await sidePanel.getByRole("button", { name: "删除质量分析" }).waitFor({ state: "visible" });
  page.once("dialog", (dialog) => dialog.accept("质量分析工作区"));
  await sidePanel.getByRole("button", { name: "重命名质量分析" }).click();
  await sidePanel.locator(".page-list-row > button", { hasText: "质量分析工作区" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "应用编辑" }).click();

  await sidePanel.getByRole("button", { name: "＋ 空白界面" }).click();
  await sidePanel.locator(".page-list-row > button", { hasText: "空白工作界面 2" }).waitFor({ state: "visible" });
  page.once("dialog", (dialog) => dialog.accept());
  await sidePanel.getByRole("button", { name: "删除空白工作界面 2" }).click();
  await page.getByRole("button", { name: "应用编辑" }).click();
  if (await sidePanel.locator(".page-list-row > button", { hasText: "空白工作界面 2" }).count()) throw new Error("删除工作界面后仍显示在左侧列表");
  await sidePanel.getByRole("button", { name: "打开原始表格" }).waitFor({ state: "visible" });
  const analysisButtonCount = await sidePanel.getByRole("button", { name: /AI 数据分析/u }).count();
  if (analysisButtonCount < 2) throw new Error("数据卡或原始 XLSX 卡缺少统一的 AI 数据分析入口");
  if (await sidePanel.getByRole("button", { name: "EDS 分析", exact: true }).count()) throw new Error("仍显示独立的 EDS 分析按钮");
  await sidePanel.screenshot({ path: resolve(evidenceDirectory, "embedded-ai-analysis.png") });
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await page.screenshot({ path: resolve(evidenceDirectory, "initial-interface-dataset.png"), fullPage: false });

  await interfaceSwitcher.locator("summary").click();
  await interfaceSwitcher.getByRole("menuitem", { name: /质量分析工作区/u }).click();
  await workspace.getByText("张三", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: resolve(evidenceDirectory, "second-interface-dataset.png"), fullPage: false });
  const importedEvidence = await workspace.evaluate((element) => ({
    text: element.innerText,
    tableHeaders: [...element.querySelectorAll("thead th")].map((item) => item.textContent?.trim()),
  }));
  if (!importedEvidence.text.includes("张三") || !importedEvidence.text.includes("120")) throw new Error("本机 CSV 数据未显示在表格工作区");
  if (workspaceEvidence.horizontalOverflow !== null) throw new Error("空白工作界面意外出现数据表滚动区");
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes("hydrated but some attributes"));
  if (unexpectedConsoleErrors.length) throw new Error(`页面控制台错误：${unexpectedConsoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ initialInterfaceLabel, workspaceEvidence, dialogEvidence, importedEvidence, screenshots: evidenceDirectory }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidenceDirectory, "failure.png"), fullPage: true });
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText().catch(() => "")).slice(0, 2_000),
    consoleErrors,
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
