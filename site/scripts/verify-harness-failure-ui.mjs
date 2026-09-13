import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Optional argument: a captured task from the opt-in real-model acceptance.
// The isolated browser replays it without making model calls or changing credentials.
const fixture = process.argv[2] ? JSON.parse(await readFile(resolve(process.argv[2]), "utf8")) : null;
const evidence = resolve(".runtime/failure-explanation/browser");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
let mode = "task";
let requests = 0;
let reply;
await page.route("**/api/ai/harness/stream", async (route) => {
  requests++;
  if (mode === "network") return route.abort("failed");
  if (mode === "credentials") return route.fulfill({ status: 401, contentType: "application/json",
    body: JSON.stringify({ error: { message: "DeepSeek API Key 无效。" } }) });
  const input = route.request().postDataJSON();
  const now = new Date().toISOString();
  const id = `harness_${input.idempotencyKey}`;
  const task = fixture ? JSON.parse(JSON.stringify(fixture).replaceAll(fixture.id, id)) : {
    id, state: "failed", createdAt: now, updatedAt: now, role: "editor", events: [],
    counters: { loopCount: 3, modelCallCount: 4, toolCallCount: 2 }, terminationCode: "toolExecutionFailed",
    error: "工具重复失败，恢复次数已用尽。", resultMessage: "这次暂时没能完成销售数据检查。可以缩小分析范围后再试。当前看板没有改动。",
  };
  Object.assign(task, { idempotencyKey: input.idempotencyKey, pageId: input.pageId, instruction: input.instruction });
  reply = task.resultMessage;
  const event = { id: `${id}:1`, taskId: id, sequence: 1, timestamp: now, type: "completed", taskState: "failed", message: "任务未完成。" };
  // Replay every original event so the diagnostics are also inspected in the real UI.
  const trace = task.trace?.length ? task.trace : [event];
  task.trace = trace;
  const body = trace.map((item, index) => `event: ${item.type}\ndata: ${JSON.stringify({ event: item, ...(index === trace.length - 1 ? { task } : {}) })}\n\n`).join("");
  await route.fulfill({ status: 200, contentType: "text/event-stream", body });
});
try {
  await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "AI 指令" });
  const send = async (instruction) => { await prompt.fill(instruction); await page.getByRole("button", { name: "发送 AI 指令" }).click(); };
  const latest = () => page.locator(".conversation-turn").last();
  const answer = () => latest().locator(".assistant-message p");
  await send(fixture?.instruction ?? "检查销售数据集并给出结论");
  await page.getByRole("button", { name: "重试这次任务", exact: true }).waitFor();
  assert.equal(await answer().innerText(), reply);
  assert.equal(await page.getByText(reply, { exact: true }).count(), 1);
  assert.equal(await page.locator(".validation-error").count(), 0);
  assert.equal(await page.locator(".harness-trace.failed[open]").count(), 0);
  await page.screenshot({ path: resolve(evidence, "model-explanation.png"), animations: "disabled" });
  await latest().locator(".harness-trace > summary").click();
  assert.equal(await latest().locator(".harness-trace[open]").count(), 1);
  await page.screenshot({ path: resolve(evidence, "failure-details.png"), animations: "disabled" });
  await page.getByRole("button", { name: "重试这次任务", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".conversation-turn").length === 2);
  await page.getByRole("button", { name: "重试这次任务", exact: true }).waitFor();
  assert.equal(requests, 2);
  mode = "network";
  await send("重新检查销售数据的分布");
  await page.waitForFunction(() => document.querySelectorAll(".conversation-turn").length === 3);
  assert.match(await answer().innerText(), /检查网络后重试/);
  assert.equal(await page.locator(".validation-error").count(), 0);
  await page.screenshot({ path: resolve(evidence, "network-fallback.png"), animations: "disabled" });
  mode = "credentials";
  await send("分析销售数据并检查异常");
  await page.waitForFunction(() => document.querySelectorAll(".conversation-turn").length === 4);
  assert.match(await answer().innerText(), /重新验证密钥/);
  assert.equal(await page.locator(".validation-error").count(), 0);
  assert.deepEqual(pageErrors, []);
  const report = { mode: fixture ? "real narration replay through actual SSE parser and React UI" : "synthetic task replay",
    liveApiCalls: 0, requests, checks: ["one conversational explanation", "no duplicate red error card", "technical details expandable",
      "retry submits a new task", "network errors explained locally", "credential errors explained locally", "no page errors"] };
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidence, "failed.png"), animations: "disabled" });
  console.error(String(error), pageErrors);
  throw error;
} finally { await browser.close(); }
