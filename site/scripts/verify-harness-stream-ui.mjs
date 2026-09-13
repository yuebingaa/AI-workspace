import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Exercise the real fetch/SSE parser and React UI with gated synthetic frames.
// This browser context never calls a paid model or reads the user's workspace.
const evidence = resolve(".runtime", "harness-stream-ui");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  window.__traceChecks = { requests: [], clears: [], aborted: 0, release: null };
  window.fetch = async (resource, init) => {
    const url = typeof resource === "string" ? resource : resource.url;
    if (url === "/api/ai/harness/conversation") {
      window.__traceChecks.clears.push(JSON.parse(init.body));
      return Response.json({ cleared: true });
    }
    if (url !== "/api/ai/harness/stream") return originalFetch(resource, init);
    const input = JSON.parse(init.body);
    window.__traceChecks.requests.push(input);
    const now = new Date().toISOString();
    const task = { id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey,
      instruction: input.instruction, pageId: input.pageId, role: "editor", state: "planning", createdAt: now, updatedAt: now,
      events: [], counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 }, trace: [] };
    let closed = false;
    const stream = new ReadableStream({ start(controller) {
      const emit = (type, message, extra = {}, terminal = false) => {
        if (closed) return;
        const sequence = task.trace.length + 1;
        const event = { id: `${task.id}:${sequence}`, sequence, taskId: task.id, timestamp: now, type, message, ...extra };
        task.trace.push(event);
        const data = new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`);
        // Deliberately split a Chinese UTF-8 sequence between chunks.
        for (let start = 0; start < data.length; start += 37) controller.enqueue(data.slice(start, start + 37));
      };
      const toolCall = { id: "offline_tool", name: "inspectDataset", status: "running", durationMs: 0 };
      emit("task_started", "任务已开始。", { taskState: "planning" });
      emit("context_loaded", "已加载当前页面上下文，数据内容按需读取。");
      emit("plan_created", "模型分析计划已制定。", { plan: { revision: 1, source: "model", steps: [
        { id: "inspect", objective: "检查已选数据结构", status: "active" },
        { id: "summarize", objective: "核实分析结论并回答", status: "pending" },
      ] } });
      emit("tool_started", "inspectDataset · 开始执行", { taskState: "executingTool", toolCall });
      const abort = () => { if (!closed) { closed = true; window.__traceChecks.aborted++; controller.error(new DOMException("Aborted", "AbortError")); } };
      init.signal.addEventListener("abort", abort, { once: true });
      window.__traceChecks.release = (outcome) => {
        if (closed) return;
        emit("tool_completed", "inspectDataset · 执行成功", { toolCall: { ...toolCall, status: "success", durationMs: 1800 } });
        emit("verification_started", "正在核实结论与目标是否一致。", { verificationStatus: "pending" });
        task.state = outcome === "failed" ? "failed" : "completed";
        emit("verification_completed", outcome === "failed" ? "缺少支持结论的证据。" : "本轮验收通过。", { verificationStatus: outcome === "failed" ? "failed" : "passed", evidenceIds: ["evidence_offline_1"] });
        task.resultMessage = outcome === "failed" ? "证据不足，未完成分析。" : "已完成数据检查，结果经过任务验收。";
        if (outcome === "failed") task.error = "缺少支持结论的证据。";
        emit("completed", "任务已结束。", { taskState: task.state }, true);
        closed = true; init.signal.removeEventListener("abort", abort); controller.close();
      };
    }, cancel() { closed = true; } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
});
const screenshots = [];
async function capture(name) {
  const path = resolve(evidence, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  screenshots.push(path);
}
try {
  await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  assert.equal(await page.locator(".assistant-diagnostics").count(), 0, "Workspace must not show the removed diagnostics bar");
  assert.equal(await page.getByText("运行详情", { exact: true }).count(), 0);
  const prompt = page.getByRole("textbox", { name: "AI 指令" });
  const send = async (text) => { await prompt.fill(text); await page.getByRole("button", { name: "发送 AI 指令" }).click(); };
  await send("检查当前数据结构并给出分析步骤");
  await page.locator(".harness-trace.running").getByText("inspectDataset · 开始执行", { exact: true }).waitFor();
  assert.equal(await page.locator(".harness-trace.running[open]").count(), 1);
  assert.equal(await page.getByText("已完成数据检查，结果经过任务验收。", { exact: true }).count(), 0, "Unfinished runs must not render a final answer");
  await capture("desktop-running");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile-running");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const box = await prompt.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height < 844);
  await page.evaluate(() => window.__traceChecks.release("completed"));
  await page.getByText("已完成数据检查，结果经过任务验收。", { exact: true }).waitFor();
  assert.equal(await page.locator(".harness-trace[open]").count(), 0);
  await capture("mobile-completed-collapsed");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".harness-trace > summary").click();
  await capture("desktop-completed-expanded");
  await page.getByRole("tab", { name: "看板", exact: true }).click();
  assert.equal(await page.locator(".assistant-diagnostics").count(), 0, "Sidebar must not show the removed diagnostics bar");
  assert.equal(await page.getByText("运行详情", { exact: true }).count(), 0);
  assert.equal(await page.locator(".harness-trace.success").count(), 1, "Per-answer execution trace must remain available");
  await capture("sidebar-without-diagnostics");
  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  await send("继续检查刚才的结果");
  await page.locator(".harness-trace.running").waitFor();
  await page.evaluate(() => window.__traceChecks.release("failed"));
  await page.locator(".harness-trace.failed").waitFor();
  assert.equal(await page.locator(".harness-trace.failed[open]").count(), 0);
  await page.locator(".harness-trace.failed > summary").click();
  await capture("desktop-verification-failed");
  await send("再检查一次数据结构");
  await page.locator(".harness-trace.running").waitFor();
  await page.getByRole("button", { name: "取消 AI 请求" }).click();
  await page.locator(".harness-trace.cancelled").waitFor();
  assert.equal(await page.evaluate(() => window.__traceChecks.aborted), 1);
  const ids = await page.evaluate(() => window.__traceChecks.requests.map((request) => request.conversation_id));
  assert.equal(new Set(ids).size, 1);
  await page.getByRole("button", { name: "清除上下文", exact: true }).click();
  await page.getByRole("heading", { name: "今天想从数据里发现什么？" }).waitFor();
  assert.equal(await page.evaluate(() => window.__traceChecks.clears.length), 1);
  await send("新会话检查数据结构");
  await page.locator(".harness-trace.running").waitFor();
  assert.notEqual(await page.evaluate(() => window.__traceChecks.requests.at(-1).conversation_id), ids[0]);
  await page.getByRole("button", { name: "取消 AI 请求" }).click();
  await page.locator(".harness-trace.cancelled").waitFor();
  assert.deepEqual(errors, []);
  const report = { mode: "isolated browser, gated synthetic SSE, no model calls", screenshots,
    checks: ["no top diagnostics bar in workspace or sidebar", "per-answer execution trace retained", "progress visible before completion", "verified answer only after terminal frame", "completed trace defaults collapsed", "mobile composer reachable without overflow", "failed verification distinct from success", "cancel interrupts stream", "follow-up reuses conversation_id", "clear deletes server memory and rotates conversation_id", "no page errors"] };
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await capture("failure");
  console.error(String(error), JSON.stringify(errors));
  throw error;
} finally { await browser.close(); }
