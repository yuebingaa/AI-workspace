import { chromium } from "playwright-core";

const baseUrl = process.env.AI_WORKSPACE_BASE_URL || "http://localhost:3000";
const executablePath = process.env.AI_WORKSPACE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: "zh-CN" });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
await page.addInitScript(() => localStorage.clear());

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  const openSidebar = page.getByRole("button", { name: "打开侧边栏" });
  if (await openSidebar.count()) await openSidebar.click();
  const sidePanel = page.locator(".left-panel");
  await sidePanel.getByRole("button", { name: "＋ 空白界面" }).click();
  await sidePanel.locator(".page-list-row > button", { hasText: "空白工作界面 2" }).waitFor({ state: "visible" });

  const prompt = page.getByRole("textbox", { name: "AI 指令" });
  await prompt.fill("帮我把空白工作界面删除");
  await page.getByRole("button", { name: "发送 AI 指令" }).click();
  await page.getByRole("button", { name: "确认并应用" }).waitFor({ state: "visible", timeout: 120_000 });
  const assistantText = await page.locator(".right-panel").innerText();
  if (!assistantText.includes("删除工作界面“空白工作界面”")) {
    throw new Error(`AI 没有生成目标工作界面的删除预览：${assistantText.slice(-1_500)}`);
  }
  await page.getByRole("button", { name: "画布预览" }).click();
  await page.getByRole("button", { name: "确认并应用" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "确认并应用" }).click();
  if (await sidePanel.getByRole("button", { name: "删除空白工作界面", exact: true }).count()) {
    throw new Error("确认并应用后，空白工作界面仍存在。");
  }
  await sidePanel.getByRole("button", { name: "删除空白工作界面 2", exact: true }).waitFor({ state: "visible" });
  if (consoleErrors.length) throw new Error(`页面控制台错误：${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ passed: true, assistantText: assistantText.slice(-800) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    body: (await page.locator("body").innerText().catch(() => "")).slice(-3_000),
    consoleErrors,
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
