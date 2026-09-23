import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Explicit synthetic SSE / isolated temporary-browser acceptance; never a real AI test.
// API replacements below are exhaustive; all other API and external traffic is blocked.
const red = process.argv.includes("--red");
const base = "http://127.0.0.1:3001";
const directory = resolve(".runtime/assistant-retry-restore-2026-09-23", `${red ? "red" : "browser"}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const report = { passed: false, red, mode: "synthetic SSE through real client parser / temporary localStorage",
  liveModels: 0, liveDatabase: 0, liveNotebook: 0, liveProjectReadsOrWrites: 0,
  checks: [], screenshots: [], pageErrors: [], networkEscapes: [], requests: [], apiReplacements: [], blockedApi: [] };
page.on("pageerror", error => report.pageErrors.push(error.message));
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.origin !== base || url.pathname.startsWith("/api/")) {
    report.networkEscapes.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  }
  await route.continue();
});
await context.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window);
  window.__retryUi = { next: null, requests: [], apiReplacements: [], blockedApi: [] };
  window.fetch = async (resource, init = {}) => {
    const url = new URL(typeof resource === "string" ? resource : resource.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return nativeFetch(resource, init);
    const fixture = window.__retryUi;
    if (url.pathname === "/api/ai/harness/stream") {
      if (!fixture.next) throw new Error("No synthetic replay armed; real tasks forbidden.");
      const input = JSON.parse(init.body), choice = { ...fixture.next };
      fixture.next = null;
      fixture.requests.push({ instruction: input.instruction, conversationId: input.conversationId, state: choice.state, hold: Boolean(choice.hold) });
      const now = new Date().toISOString();
      const task = { id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey,
        instruction: input.instruction, pageId: input.pageId, role: "editor", state: "planning",
        createdAt: now, updatedAt: now, events: [], trace: [], counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 } };
      let closed = false;
      return new Response(new ReadableStream({ start(controller) {
        const emit = (type, message, terminal = false) => {
          const event = { id: `${task.id}:${task.trace.length + 1}`, sequence: task.trace.length + 1,
            taskId: task.id, timestamp: now, type, message, taskState: task.state };
          task.trace.push(event);
          controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`));
        };
        emit("task_started", "合成 UI 验收；没有模型、数据库或 Notebook 执行。");
        init.signal?.addEventListener("abort", () => {
          if (closed) return;
          closed = true; controller.error(new DOMException("Synthetic replay aborted", "AbortError"));
        }, { once: true });
        if (choice.hold) return;
        task.state = choice.state; task.resultMessage = choice.response;
        if (choice.state === "failed" || choice.state === "blocked") {
          task.error = "合成回执：没有执行真实业务。";
          task.terminationCode = choice.state === "failed" ? "toolExecutionFailed" : "missingRequirements";
        }
        emit("completed", "合成回放结束。", true); closed = true; controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const replacements = {
      "/api/connections": { connections: [] }, "/api/projects": { projects: [] },
      "/api/notebook/python": { enabled: false, available: false, reason: "隔离 UI 验收不运行 Notebook" },
    };
    if ((init.method ?? "GET") === "GET" && replacements[url.pathname]) {
      fixture.apiReplacements.push(url.pathname); return Response.json(replacements[url.pathname]);
    }
    fixture.blockedApi.push(`${init.method ?? "GET"} ${url.pathname}`);
    return Response.json({ error: { message: "UI acceptance blocks this API." } }, { status: 403 });
  };
});
const conversation = () => page.getByRole("log", { name: "AI 对话上下文", exact: true });
const latest = () => conversation().locator(".conversation-turn").last();
const retry = () => page.getByRole("button", { name: "重试这次任务", exact: true });
const failed = "合成失败：未完成分析，原有内容没有改动。";
const blocked = "合成受阻：当前能力未授权；没有执行分析。";
const cancelled = "这次任务已经停止。如果还需要继续，可以重新发送请求。当前看板没有改动。";
const firstInstruction = "合成 UI 验收：失败恢复";
const count = () => page.evaluate(() => window.__retryUi.requests.length);
async function arm(response, state = "completed", hold = false) {
  await page.evaluate(next => { window.__retryUi.next = next; }, { response, state, hold });
}
async function send(instruction) {
  await page.getByRole("textbox", { name: "AI 指令", exact: true }).fill(instruction);
  await page.getByRole("button", { name: "发送 AI 指令", exact: true }).click();
}
async function fresh() {
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".conversation-turn"));
  assert.equal(await retry().count(), 0);
  assert.equal(await page.locator(".validation-error").count(), 0);
}
async function select(title) {
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await page.getByRole("menuitemradio").filter({ hasText: title }).click();
  await latest().waitFor();
}
async function collect() {
  const fixture = await page.evaluate(() => window.__retryUi);
  report.requests.push(...fixture.requests); report.apiReplacements.push(...fixture.apiReplacements); report.blockedApi.push(...fixture.blockedApi);
}
async function reload() {
  await page.waitForFunction(() => Boolean(localStorage.getItem("datacanvas-ai:studio:v1")));
  await collect(); await page.reload({ waitUntil: "networkidle" });
  await latest().waitFor(); assert.equal(await count(), 0);
}
async function screenshot(name, scene) {
  await conversation().evaluate(element => { element.scrollTop = 0; });
  await page.mouse.move(1, 1);
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  report.screenshots.push({ name, path, scene, viewport: page.viewportSize(), visuallyReviewed: false });
}
async function terminal(text, state, expectedRetry = 1) {
  await latest().locator(`.conversation-meta`).waitFor();
  assert.match(await latest().getAttribute("class"), new RegExp(state));
  assert.equal(await latest().locator(".assistant-message p").innerText(), text);
  assert.equal(await page.getByText(text, { exact: true }).count(), 1);
  assert.equal(await retry().count(), expectedRetry);
  assert.equal(await page.locator(".validation-error").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
async function step(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  await arm(failed, "failed"); await send(firstInstruction); await retry().waitFor();
  await terminal(failed, "failed");
  await screenshot("01-failed-initial-1440", "合成失败首轮，唯一失败正文与重试入口。");
  await step("New empty conversation clears retry and switch back restores failure without automatically submitting", async () => {
    const before = await count(); await fresh();
    await screenshot("02-empty-no-stale-error-1440", "新空会话，不继承旧失败、错误或重试按钮。");
    await select(firstInstruction); await terminal(failed, "failed", red ? 0 : 1);
    assert.equal(await count(), before);
    await screenshot("03-failed-switch-restored-1440", red ? "修复前复现：切回失败会话，重试入口丢失。" : "切回失败会话，重试入口恢复；未自动发送。");
  });
  await step("Refresh restores failure and retry in 1024 Notebook sidebar without submitting", async () => {
    await reload(); await page.setViewportSize({ width: 1024, height: 1000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await terminal(failed, "failed", red ? 0 : 1);
    await screenshot("04-failed-refresh-sidebar-1024", red ? "修复前复现：刷新后失败仍保留，重试入口丢失。" : "1024 Notebook 侧栏刷新恢复失败与唯一重试入口，任务 0 次自动重发。");
  });
  if (!red) {
    await step("Restored retry submits exactly one synthetic task and success clears stale retry/error", async () => {
      await arm("恢复后重试成功；此结果为合成 UI 回放。");
      const before = await count(); await retry().click();
      await latest().locator(".assistant-answer").waitFor();
      assert.equal(await count(), before + 1); assert.equal(await retry().count(), 0);
      assert.equal(await page.locator(".validation-error").count(), 0);
      await screenshot("05-retry-success-sidebar-1024", "恢复后的重试只发送一次合成任务，成功后不遗留错误或重试按钮。");
    });
    await step("Cancelled task restores retry after switch and reload, no duplicate answer or auto retry", async () => {
      await fresh(); await arm("不会完成的合成结果", "completed", true); await send("合成 UI 验收：取消恢复");
      await page.getByRole("button", { name: "取消 AI 请求", exact: true }).click();
      await conversation().locator(".harness-trace.cancelled").waitFor();
      await fresh(); await select("合成 UI 验收：取消恢复"); await terminal(cancelled, "cancelled");
      await reload(); await terminal(cancelled, "cancelled");
      await screenshot("06-cancelled-restored-sidebar-1024", "真实点击取消，再切会话和刷新后保留已取消、唯一原文与重试入口；未自动重发。");
    });
    await step("Blocked task restores retry after switch and reload with no automatic action", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
      await fresh(); await arm(blocked, "blocked"); await send("合成 UI 验收：受阻恢复"); await retry().waitFor();
      await fresh(); await select("合成 UI 验收：受阻恢复"); await terminal(blocked, "blocked");
      await reload(); await terminal(blocked, "blocked");
      await screenshot("07-blocked-restored-workspace-1440", "合成受阻回执经切换与刷新，保持受限状态与重试，不改变授权。");
    });
    await step("Exported synthetic backup restores failed reply and retry, rotates context, and does not submit", async () => {
      await fresh(); await arm(failed, "failed"); await send("合成 UI 验收：备份恢复失败"); await retry().waitFor();
      await page.getByRole("button", { name: "打开工作区菜单", exact: true }).click();
      await page.getByRole("textbox", { name: "查找功能或工作界面", exact: true }).fill("下载工作区备份");
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载工作区备份", exact: true }).click();
      const download = await downloadPromise, backupPath = resolve(directory, "synthetic-workspace-backup.json");
      await download.saveAs(backupPath);
      const contextBefore = await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1"));
        return saved.assistantSessions.items.find(item => item.id === saved.assistantSessions.activeId).contextId;
      });
      await fresh(); const before = await count();
      page.once("dialog", dialog => dialog.dismiss());
      await page.getByLabel("选择工作区备份文件", { exact: true }).setInputFiles(backupPath);
      assert.equal(await conversation().locator(".conversation-turn").count(), 0);
      assert.equal(await retry().count(), 0); assert.equal(await count(), before);
      page.once("dialog", dialog => dialog.accept());
      await page.getByLabel("选择工作区备份文件", { exact: true }).setInputFiles(backupPath);
      await latest().waitFor(); await terminal(failed, "failed");
      assert.equal(await count(), before);
      const contextAfter = await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1"));
        return saved.assistantSessions.items.find(item => item.id === saved.assistantSessions.activeId).contextId;
      });
      assert.notEqual(contextAfter, contextBefore);
      await screenshot("08-backup-restored-retry-1440", "仅导入本轮浏览器导出的合成备份，恢复失败与重试；上下文轮换，无模型/项目写入。");
      await fresh(); assert.equal(await count(), before);
      await select(firstInstruction);
      await latest().locator(".assistant-answer").waitFor();
      assert.equal(await retry().count(), 0); assert.equal(await page.locator(".validation-error").count(), 0);
      await screenshot("09-success-session-no-stale-retry-1440", "再次切到已成功会话，不借用其他会话的失败和重试入口。");
    });
  }
  await collect(); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.networkEscapes, []); assert.deepEqual(report.blockedApi, []);
  report.passed = true;
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, red, directory, screenshots: report.screenshots.length, checks: report.checks.length, syntheticTasks: report.requests.length }));
} catch (error) {
  report.error = String(error); await screenshot("failure", "本轮实际失败页，不计通过。"); await collect();
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.error(JSON.stringify({ directory, error: String(error) })); throw error;
} finally { await browser.close(); }
