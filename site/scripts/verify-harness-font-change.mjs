import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.HARNESS_FONT_TEST_BASE_URL || "http://localhost:3000";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const instruction = process.env.HARNESS_FONT_TEST_INSTRUCTION || "把本月收入标题字体改成微软雅黑，字号 24，颜色改成蓝色并加粗。";
const expectChange = process.env.HARNESS_FONT_TEST_EXPECT_CHANGE !== "0";
const evidenceDirectory = resolve("evidence", "harness-font-change");
await mkdir(evidenceDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await page.addInitScript(() => localStorage.clear());

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await page.getByRole("textbox", { name: "AI 指令" }).fill(instruction);
  if (!expectChange) {
    await page.getByRole("button", { name: "发送 AI 指令" }).click();
    const reply = page.locator(".assistant-message").filter({ hasText: /可以。目前(?:能|支持)/u }).last();
    await reply.waitFor({ state: "visible", timeout: 10_000 });
    const text = (await reply.innerText()).replace(/\s+/gu, " ").trim();
    await page.screenshot({ path: resolve(evidenceDirectory, "font-capability-reply.png"), fullPage: false });
    console.log(JSON.stringify({ localCapabilityReply: text }, null, 2));
    if (!text.includes("字体") || !text.includes("微软雅黑") || !text.includes("待确认预览") || !text.includes("本地回复")) {
      throw new Error(`字体能力回答不完整：${text}`);
    }
    process.exitCode = 0;
  } else {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => (
      candidate.url().includes("/api/ai/harness") && candidate.request().method() === "POST"
    ), { timeout: 120_000 }),
    page.getByRole("button", { name: "发送 AI 指令" }).click(),
  ]);
  const body = await response.json();
  const task = body?.task;
  const update = task?.pendingChangeSet?.operations?.find((operation) => operation.type === "updateNodeProps");
  if (task?.state === "awaitingConfirmation") {
    await page.getByText("已生成 1 项待确认变更", { exact: false }).last().waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.screenshot({ path: resolve(evidenceDirectory, "font-change-result.png"), fullPage: false });
  const result = {
    httpStatus: response.status(),
    taskState: task?.state,
    terminationCode: task?.terminationCode,
    error: task?.error,
    resultMessage: task?.resultMessage,
    contextUsage: task?.contextUsage,
    recentEvents: task?.events?.slice(-8).map((event) => ({ type: event.type, state: event.state, message: event.message })),
    operation: update ? { nodeId: update.nodeId, props: update.props } : undefined,
    visualPreflight: task?.evidence?.records?.filter((record) => record.stage === "preflight").map((record) => ({ kind: record.kind, summary: record.summary })),
  };
  console.log(JSON.stringify(result, null, 2));
  const successful = task?.state === "awaitingConfirmation" && Boolean(update);
  if (response.status() !== 200 || !successful) {
    throw new Error(`字体变更未生成待确认 ChangeSet：${JSON.stringify(result)}`);
  }
  }
} finally {
  await browser.close();
}
