import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// UI-only acceptance. Every task below is explicitly synthetic SSE replay.
// Fresh browser storage; no project creation, real model, Notebook or database run.
// All /api/ traffic and non-local origins are intercepted before reaching a server.
const base = "http://127.0.0.1:3001";
const directory = resolve(".runtime/assistant-answer-2026-09-23", `browser-${Date.now()}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const report = {
  passed: false, mode: "synthetic SSE replay through actual client parser and React UI",
  isolation: "fresh nonpersistent browser context; temporary localStorage workspace; all API and external network blocked/replaced",
  liveModelCalls: 0, liveNotebookRuns: 0, liveDatabaseCalls: 0, liveProjectReadsOrWrites: 0,
  checks: [], screenshots: [], pageErrors: [], networkEscapes: [], fixtureRequests: [],
};
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== base || url.pathname.startsWith("/api/")) {
    report.networkEscapes.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
});
await context.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window);
  window.__answerUi = { next: null, release: null, requests: [], apiReplacements: [], blockedApi: [] };
  window.fetch = async (resource, init = {}) => {
    const rawUrl = typeof resource === "string" ? resource : resource.url;
    const url = new URL(rawUrl, location.href);
    if (url.origin !== location.origin) return nativeFetch(resource, init);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(resource, init);
    const fixture = window.__answerUi;
    if (url.pathname === "/api/ai/harness/stream") {
      if (!fixture.next) throw new Error("No synthetic answer fixture is armed; real model calls are forbidden.");
      const input = JSON.parse(init.body);
      const choice = { ...fixture.next };
      fixture.requests.push({ instruction: input.instruction, state: choice.state, held: Boolean(choice.hold) });
      const now = new Date().toISOString();
      const task = {
        id: `harness_${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey,
        instruction: input.instruction, pageId: input.pageId, role: "editor", state: "planning",
        createdAt: now, updatedAt: now, events: [], trace: [],
        counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 },
      };
      let closed = false;
      return new Response(new ReadableStream({ start(controller) {
        const emit = (type, message, terminal = false) => {
          const event = { id: `${task.id}:${task.trace.length + 1}`, sequence: task.trace.length + 1,
            taskId: task.id, timestamp: now, type, message, taskState: task.state };
          task.trace.push(event);
          controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ event, ...(terminal ? { task } : {}) })}\n\n`));
        };
        emit("task_started", "合成 UI 回放：等待完成或取消；没有模型或工具调用。");
        init.signal?.addEventListener("abort", () => {
          if (closed) return;
          closed = true;
          controller.error(new DOMException("Synthetic replay aborted", "AbortError"));
        }, { once: true });
        fixture.release = () => {
          if (closed) return;
          task.state = choice.state;
          task.resultMessage = choice.response;
          if (choice.state === "failed") {
            task.error = "合成失败回执：没有执行真实业务。";
            task.terminationCode = "toolExecutionFailed";
          }
          emit("completed", choice.state === "failed" ? "合成回放未完成。" : "合成回放完成。", true);
          closed = true;
          controller.close();
        };
        if (!choice.hold) fixture.release();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if ((init.method ?? "GET") === "GET" && url.pathname === "/api/connections") {
      fixture.apiReplacements.push(url.pathname);
      return Response.json({ connections: [] });
    }
    if ((init.method ?? "GET") === "GET" && url.pathname === "/api/notebook/python") {
      fixture.apiReplacements.push(url.pathname);
      return Response.json({ enabled: false, available: false, reason: "隔离 UI 验收不运行 Notebook" });
    }
    if ((init.method ?? "GET") === "GET" && url.pathname === "/api/projects") {
      fixture.apiReplacements.push(url.pathname);
      return Response.json({ projects: [] });
    }
    fixture.blockedApi.push(`${init.method ?? "GET"} ${url.pathname}`);
    return Response.json({ error: { message: "UI-only acceptance blocks this API." } }, { status: 403 });
  };
});

const formatted = [
  "## 参数核对 · 合成回答", "", "当前区域为 **East**，字段名是 `region`。", "",
  "1. 核对当前参数定义", "2. 保留原始回答字符串", "", "- 仅展示格式化结果", "- 此回放没有执行业务", "",
  "### 示例代码", "", "```sql", "SELECT region, amount", "FROM sample;", "```",
].join("\n");
const incomplete = [
  "未闭合格式按原文展示：", "", "保留 **未闭合粗体", "", "保留 `未闭合代码", "",
  "1. 单独编号不会变成列表", "", "```sql", "SELECT '**围栏内仍是文字**';", "# 未闭合围栏内的标题",
].join("\n");
const unsafe = [
  "以下均为合成安全测试文本：", "",
  '<script>window.__answerExecuted = true</script>',
  '<img src="https://answer-fixture.invalid/image.png" onerror="window.__answerExecuted = true">',
  '<iframe src="https://answer-fixture.invalid/frame"></iframe>',
  '[点此](javascript:alert("fixture"))',
  '![图片](https://answer-fixture.invalid/image.png)',
  '<a href="javascript:alert(1)">链接</a>', "", "| 名称 | 值 |", "| --- | --- |", "| 区域 | East |",
].join("\n");
const longWord = "LongUnbrokenToken".repeat(12);
const longCode = `SELECT ${"long_column_name_".repeat(25)} FROM sample;`;
const longResponse = ["**宽度检查**", "", longWord, "", "```sql", longCode, "```", "", "长代码仅在代码框内横向滚动。"].join("\n");
const failedResponse = "**合成失败**：这次检查未完成。请缩小范围后重试；原有内容没有改动。";
const conversation = () => page.getByRole("log", { name: "AI 对话上下文", exact: true });
const latest = () => conversation().locator(".conversation-turn").last();
const answer = () => latest().locator(".assistant-answer");
async function arm(response, state = "completed", hold = false) {
  await page.evaluate((next) => { window.__answerUi.next = next; }, { response, state, hold });
}
async function send(instruction) {
  await page.getByRole("textbox", { name: "AI 指令", exact: true }).fill(instruction);
  await page.getByRole("button", { name: "发送 AI 指令", exact: true }).click();
}
async function freshConversation() {
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".conversation-turn"));
}
async function screenshot(name, scene) {
  await page.mouse.move(1, 1);
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  report.screenshots.push({ name, path, scene, viewport: page.viewportSize(), visuallyReviewed: false });
}
async function step(name, action) {
  await action();
  report.checks.push(name);
  console.log(`PASS ${name}`);
}
async function topOfConversation() {
  await conversation().evaluate((element) => { element.scrollTop = 0; });
}
async function assertFormatted() {
  await answer().waitFor();
  assert.equal(await answer().locator("strong").innerText(), "East");
  assert.equal(await answer().locator("p code").innerText(), "region");
  assert.equal(await answer().locator("ol > li").count(), 2);
  assert.equal(await answer().locator("ul > li").count(), 2);
  assert.equal(await answer().locator("h3").innerText(), "参数核对 · 合成回答");
  assert.equal(await answer().locator("h4").innerText(), "示例代码");
  assert.equal(await answer().locator("pre code").innerText(), "SELECT region, amount\nFROM sample;");
}
async function assertLayout() {
  const layout = await answer().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      width: rect.width, parentWidth: element.parentElement.getBoundingClientRect().width,
      outside: [...element.children].filter((child) => child.getBoundingClientRect().right > rect.right + 1).map((child) => child.tagName) };
  });
  assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.width <= layout.parentWidth + 1, JSON.stringify(layout));
  assert.deepEqual(layout.outside, []);
  return layout;
}
async function currentStorage() {
  await page.waitForFunction(() => Boolean(localStorage.getItem("datacanvas-ai:studio:v1")));
  return page.evaluate(() => JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1")));
}
try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
  await step("1440 AI workspace renders paragraphs, bold, inline code, numbered and unordered lists, headings and fenced code", async () => {
    await arm(formatted);
    await send("合成 UI 回放：展示格式化答案");
    await assertFormatted();
    await assertLayout();
    await topOfConversation();
    await screenshot("01-formatted-workspace-1440", "1440×1000 AI 工作台；合成成功回执，标题、粗体、行内代码、两类列表和围栏代码。");
  });
  await step("Refresh preserves the exact raw response and renders the same answer in the 1024 Notebook sidebar", async () => {
    await page.waitForFunction((expected) => {
      const saved = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1") ?? "null");
      return saved?.assistantConversation.at(-1)?.response === expected;
    }, formatted);
    const before = await currentStorage();
    assert.equal(before.assistantSessions.items.find((item) => item.id === before.assistantSessions.activeId).turns.at(-1).response, formatted);
    assert.equal(before.harnessTasks.at(-1).resultMessage, formatted);
    report.fixtureRequests.push(...await page.evaluate(() => window.__answerUi.requests));
    await page.reload({ waitUntil: "networkidle" });
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await assertFormatted();
    await assertLayout();
    const after = await currentStorage();
    assert.equal(after.assistantConversation.at(-1).response, formatted);
    assert.equal(after.assistantSessions.items.find((item) => item.id === after.assistantSessions.activeId).turns.at(-1).response, formatted);
    assert.deepEqual(await page.evaluate(() => window.__answerUi.requests), []);
    await topOfConversation();
    await screenshot("02-formatted-restored-notebook-1024", "1024×1000 Notebook 侧栏；刷新恢复同一原始字符串，重新格式化且没有重新提交任务。");
  });
  await step("Unclosed bold, inline code and code fence fall back to literal text; a single numbered line remains a paragraph", async () => {
    await freshConversation();
    await arm(incomplete);
    await send("合成 UI 回放：未闭合格式");
    await answer().waitFor();
    const text = await answer().innerText();
    for (const literal of ["**未闭合粗体", "`未闭合代码", "```sql", "**围栏内仍是文字**", "# 未闭合围栏内的标题", "1. 单独编号"]) assert.ok(text.includes(literal), literal);
    assert.equal(await answer().locator("pre, strong, code, ol, h3, h4").count(), 0);
    await assertLayout();
    await topOfConversation();
    await screenshot("03-incomplete-literal-notebook-1024", "1024×1000 Notebook 侧栏；未闭合粗体、行内代码和围栏保留标记，单条编号保持原文。");
  });
  await step("HTML, scripts, images, iframes, javascript links and Markdown tables stay literal with no elements or network", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
    await freshConversation();
    await arm(unsafe);
    await send("合成 UI 回放：检查不支持的内容按文字展示");
    await answer().waitFor();
    const text = await answer().innerText();
    for (const line of unsafe.split("\n").filter(Boolean)) assert.ok(text.includes(line), line);
    assert.equal(await answer().locator("script, img, iframe, a, table, style, svg, object, embed").count(), 0);
    assert.equal(await page.evaluate(() => window.__answerExecuted), undefined);
    assert.deepEqual(report.networkEscapes, []);
    await assertLayout();
    await topOfConversation();
    await screenshot("04-unsafe-literal-workspace-1440", "1440×1000 AI 工作台；HTML、脚本、图片、iframe、javascript 链接及表格以字面文字可见；DOM / 网络断言另行验证。");
  });
  await step("Long words wrap and long code scrolls inside its own container in the 1024 Notebook sidebar", async () => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await freshConversation();
    await arm(longResponse);
    await send("合成 UI 回放：检查长文本宽度");
    await answer().waitFor();
    assert.ok((await answer().innerText()).includes(longWord));
    assert.equal(await answer().locator("pre code").innerText(), longCode);
    const pre = await answer().locator("pre").evaluate((element) => {
      element.scrollLeft = 80;
      const result = { width: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).overflowX, scrolled: element.scrollLeft };
      element.scrollLeft = 0;
      return result;
    });
    assert.ok(pre.scroll > pre.width, JSON.stringify(pre));
    assert.ok(pre.scrolled > 0, JSON.stringify(pre));
    assert.ok(["auto", "scroll"].includes(pre.overflow), JSON.stringify(pre));
    report.longTextLayout = { ...await assertLayout(), code: pre };
    await topOfConversation();
    await screenshot("05-long-code-notebook-1024", "1024×1000 Notebook 侧栏；无空格长词换行，代码框内部横向滚动，不撑破答案与页面宽度。");
  });
  await step("A failed reply stays plain text exactly once, retains retry, and retry creates one new synthetic task", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
    await freshConversation();
    await arm(failedResponse, "failed");
    await send("合成 UI 回放：失败和重试入口");
    await latest().getByRole("button", { name: "重试这次任务", exact: true }).waitFor();
    assert.equal(await latest().locator(".assistant-message p").innerText(), failedResponse);
    assert.equal(await page.getByText(failedResponse, { exact: true }).count(), 1);
    assert.equal(await latest().locator(".assistant-answer, strong").count(), 0);
    assert.equal(await page.locator(".validation-error").count(), 0);
    assert.equal(await latest().locator(".harness-trace.failed[open]").count(), 0);
    await latest().locator(".harness-trace > summary").click();
    assert.equal(await latest().locator(".harness-trace[open]").count(), 1);
    await latest().locator(".harness-trace > summary").click();
    await topOfConversation();
    await screenshot("06-failed-once-retry-workspace-1440", "1440×1000 AI 工作台；合成失败答复只出现一次，粗体标记保持纯文本，重试按钮可见，失败过程可展开和收起。");
    const before = await page.evaluate(() => window.__answerUi.requests.length);
    await latest().getByRole("button", { name: "重试这次任务", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".conversation-turn").length === 2);
    await latest().getByRole("button", { name: "重试这次任务", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__answerUi.requests.length), before + 1);
    assert.equal(await latest().locator(".assistant-message p").innerText(), failedResponse);
    assert.equal(await latest().getByText(failedResponse, { exact: true }).count(), 1);
  });
  await step("Running execution details expand and collapse while cancel remains usable; cancellation stays plain and persists", async () => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await freshConversation();
    await arm("不会完成的合成回答", "completed", true);
    await send("合成 UI 回放：执行过程与取消");
    const trace = conversation().locator(".harness-trace.running");
    await trace.waitFor();
    assert.equal(await trace.getAttribute("open"), "");
    await trace.locator(":scope > summary").click();
    assert.equal(await trace.getAttribute("open"), null);
    assert.ok(await page.getByRole("button", { name: "取消 AI 请求", exact: true }).isEnabled());
    await trace.locator(":scope > summary").click();
    assert.equal(await trace.getAttribute("open"), "");
    await topOfConversation();
    await screenshot("07-running-expand-cancel-notebook-1024", "1024×1000 Notebook 侧栏；合成执行过程展开，已验证收起 / 展开，底部取消按钮仍可操作。");
    await page.getByRole("button", { name: "取消 AI 请求", exact: true }).click();
    await conversation().locator(".harness-trace.cancelled").waitFor();
    assert.equal(await latest().locator(".assistant-answer").count(), 0);
    const cancelledText = await latest().locator(".assistant-message p").innerText();
    assert.equal(cancelledText, "这次任务已经停止。如果还需要继续，可以重新发送请求。当前看板没有改动。");
    assert.match(await latest().locator(".conversation-meta").innerText(), /已取消/);
    assert.equal(await latest().getByText(cancelledText, { exact: true }).count(), 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
    await screenshot("08-cancelled-workspace-1440", "1440×1000 AI 工作台；用户实际点击取消后显示已取消，答复仍为原纯文本，无成功结果。");
    report.fixtureRequests.push(...await page.evaluate(() => window.__answerUi.requests));
    const apiBeforeReload = await page.evaluate(() => ({ replaced: window.__answerUi.apiReplacements, blocked: window.__answerUi.blockedApi }));
    report.apiReplacements = apiBeforeReload.replaced;
    assert.deepEqual(apiBeforeReload.blocked, []);
    await page.reload({ waitUntil: "networkidle" });
    await conversation().locator(".harness-trace.cancelled").waitFor();
    assert.equal(await latest().locator(".assistant-message p").innerText(), cancelledText);
    assert.deepEqual(await page.evaluate(() => window.__answerUi.requests), []);
  });
  await step("Bold skips double-star markers inside inline code; c#, four-backtick and tilde fences keep their entire remainder literal", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "AI 工作台", exact: true }).click();
    const variants = ["````", "~~~", "```c#"];
    for (const fence of variants) {
      await freshConversation();
      const remainder = [fence, "**围栏内保留标记**", "# 不生成标题", "- 不生成列表一", "- 不生成列表二", "```", "", "**闭合标记后也按原文保留**"].join("\n");
      await arm(`**粗体内的 \`value**literal\` 保持完整**。\n\n${remainder}`);
      await send(`合成 UI 回放：格式保真 ${fence}`);
      await answer().waitFor();
      assert.equal(await answer().locator("strong").count(), 1);
      assert.equal(await answer().locator("strong").innerText(), "粗体内的 value**literal 保持完整");
      assert.equal(await answer().locator("strong code").innerText(), "value**literal");
      assert.equal(await answer().locator("code").count(), 1);
      assert.equal(await answer().locator("pre, h3, h4, ul, ol").count(), 0);
      assert.equal(await answer().locator("p").last().textContent(), remainder);
      await assertLayout();
    }
    report.fidelityVariants = variants;
    report.fixtureRequests.push(...await page.evaluate(() => window.__answerUi.requests));
    await topOfConversation();
    await screenshot("09-inline-code-unknown-fence-workspace-1440", "1440×1000 AI 工作台；粗体内代码 value**literal 不误闭合，未知 c# 围栏至末尾保留字面原文。四反引号与波浪号另经独立回放断言。");
  });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.networkEscapes, []);
  assert.deepEqual(await page.evaluate(() => window.__answerUi.blockedApi), []);
  report.passed = true;
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, directory, checks: report.checks.length, screenshots: report.screenshots.length, syntheticTasks: report.fixtureRequests.length }));
} catch (error) {
  report.error = String(error);
  await screenshot("failure", "本次失败时的实际页面；不计通过。");
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.error(JSON.stringify({ directory, error: String(error), pageErrors: report.pageErrors, networkEscapes: report.networkEscapes }));
  throw error;
} finally {
  await browser.close();
}
