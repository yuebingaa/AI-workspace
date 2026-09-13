import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Isolated browser and synthetic data; model responses are stubbed to verify the UI contract.
const baseUrl = process.env.AGENT_WORKSPACE_BASE_URL || "http://127.0.0.1:3001";
const evidence = resolve(".runtime", "agent-workspace");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const errors = [];
const requests = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route(/\/api\/ai\/harness(?:\/stream)?$/, async (route) => {
  const payload = route.request().postDataJSON();
  requests.push(payload);
  const now = new Date().toISOString();
  const task = {
    id: `harness_${payload.idempotencyKey}`,
    idempotencyKey: payload.idempotencyKey,
    instruction: payload.instruction,
    pageId: payload.pageId,
    role: "editor",
    state: "awaitingConfirmation",
    createdAt: now,
    updatedAt: now,
    events: [],
    counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 },
    resultMessage: "已生成工作界面改名预览，名称将变为销售洞察，确认后应用。",
    pendingChangeSet: {
      id: "change_agent_workspace_browser",
      title: "调整工作界面名称",
      status: "ready",
      operations: [{ id: "rename_workspace", type: "updatePage", pageId: payload.pageId, title: "销售洞察", label: "重命名工作界面", description: "将当前工作界面改名为销售洞察" }],
    },
  };
  if (payload.instruction === "生成处理结果供界面验证") {
    task.state = "completed";
    task.resultMessage = "筛选结果已生成。";
    delete task.pendingChangeSet;
    task.tableArtifact = {
      id: "artifact_sales_browser", name: "销售筛选结果", sourceDataSourceId: payload.dataSourceId,
      sourceName: "销售示例", fields: [{ name: "region", label: "地区", type: "string" }, { name: "amount", label: "金额", type: "number" }],
      rows: [{ region: "华东", amount: 120 }], totalRowCount: 1, previewRowCount: 1, truncated: false,
      transformations: ["保留 amount >= 100 的记录"], createdAt: now,
    };
  }
  task.trace = [
    { type: "task_started", message: "任务已开始。" },
    { type: "context_loaded", message: "已加载示例数据源描述，数据内容按需读取。" },
    { type: "plan_created", message: "模型分析计划已制定。", plan: { revision: 1, source: "model", steps: [{ id: "preview", objective: "生成预览并等待确认", status: "completed" }] } },
    { type: "tool_completed", message: "createChangeSetPreview · 执行成功", toolCall: { id: "mock_tool_1", name: "createChangeSetPreview", status: "success", durationMs: 180 } },
    { type: "verification_completed", message: "本轮验收通过。", verificationStatus: "passed" },
    { type: "completed", message: "任务结束。", taskState: task.state },
  ].map((event, index) => ({ ...event, id: `${task.id}:${index + 1}`, sequence: index + 1, taskId: task.id, timestamp: now }));
  await route.fulfill({ contentType: "text/event-stream", body: task.trace.map((event) =>
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ event, ...(event.type === "completed" ? { task } : {}) })}\n\n`).join("") });
});

const agentTab = page.getByRole("tab", { name: "AI 工作台", exact: true });
const canvasTab = page.getByRole("tab", { name: "看板", exact: true });
const prompt = page.getByRole("textbox", { name: "AI 指令" });
const report = { mode: "isolated browser / stubbed Harness response", screenshots: [], checks: [] };

async function screenshot(name) {
  const path = resolve(evidence, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  report.screenshots.push(path);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await agentTab.click();
  await page.getByRole("heading", { name: "今天想从数据里发现什么？" }).waitFor();
  assert.equal(await prompt.count(), 1, "Only one shared composer should exist");
  await screenshot("desktop-empty");
  for (const [name, viewport] of [["tablet-empty", { width: 820, height: 900 }], ["mobile-empty", { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await screenshot(name);
    const box = await prompt.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height < viewport.height, "Composer must stay in the viewport");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-wide horizontal overflow");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const plus = page.getByRole("button", { name: "添加附件或上下文", exact: true });
  await plus.click();
  await screenshot("context-menu-root");
  await page.getByRole("menuitem", { name: "添加处理配方或结果", exact: true }).click();
  await page.getByRole("menu", { name: "处理配方或结果", exact: true }).getByText("暂无处理配方或结果").waitFor();
  await screenshot("context-results-empty");
  await page.keyboard.press("Escape");
  await page.getByRole("menuitem", { name: "选择数据连接", exact: true }).click();
  await screenshot("context-connections-empty");
  assert.ok((await page.getByRole("menu", { name: "数据连接", exact: true }).innerText()).includes("数据库连接功能尚未接入"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "添加上下文菜单", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "生成可视化" }).click();
  const draft = await prompt.inputValue();
  assert.ok(draft.includes("可视化预览"));
  assert.equal(requests.length, 0, "Suggestion buttons must not submit requests");
  await page.locator('.right-panel input[accept="image/jpeg,image/png,image/webp"]').setInputFiles({
    name: "参考截图.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGAAAAAASUVORK5CYII=", "base64"),
  });
  await canvasTab.click();
  assert.equal(await prompt.inputValue(), draft);
  assert.equal(await page.getByRole("button", { name: "移除图片 参考截图.png" }).count(), 1);
  await page.getByRole("button", { name: "在 AI 工作台中打开" }).click();
  assert.equal(await prompt.inputValue(), draft);
  await agentTab.focus();
  await agentTab.press("ArrowRight");
  assert.equal(await canvasTab.getAttribute("aria-selected"), "true");
  await canvasTab.press("Home");
  assert.equal(await agentTab.getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "移除图片 参考截图.png" }).click();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await agentTab.getAttribute("aria-selected"), "true", "View preference should survive reload");
  report.checks.push("mode switching preserves the shared draft and attachment", "suggestions fill without sending", "view preference survives reload");

  await page.getByRole("button", { name: "添加上下文", exact: true }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "添加文件或图片", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([
    { name: "销售示例.csv", mimeType: "text/csv", buffer: Buffer.from("region,amount\n华东,120\n华南,88", "utf8") },
    { name: "库存示例.csv", mimeType: "text/csv", buffer: Buffer.from("product,stock\n螺丝,240\n电机,18", "utf8") },
    { name: "一起选择的图片.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGAAAAAASUVORK5CYII=", "base64") },
  ]);
  const dialog = page.locator(".csv-upload-dialog");
  await dialog.getByRole("button", { name: "导入 2 份文件" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 20_000 });
  await page.getByRole("button", { name: "移除图片 一起选择的图片.png" }).click();
  await plus.click();
  await page.getByRole("menuitem", { name: "选择工作界面与数据表", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索工作界面与数据表" }).fill("销售示例");
  assert.equal(await page.getByRole("menuitemradio").count(), 1, "Search must filter both tables and workspaces");
  await screenshot("context-data-search");
  await page.getByRole("menuitemradio", { name: /销售示例/u }).click();
  await page.getByRole("button", { name: "取消指定数据表 销售示例" }).waitFor();
  await plus.click();
  await page.getByRole("menuitem", { name: "添加处理配方或结果", exact: true }).click();
  await screenshot("context-results");
  await page.getByRole("menuitem", { name: /销售示例 标准预览配方/u }).click();
  assert.ok((await prompt.inputValue()).includes("配方"));
  assert.equal(requests.length, 0, "Selecting context and recipes must not submit requests");
  report.checks.push("unified file chooser accepts images and multiple CSVs", "searchable context menus select data", "recipe selection fills a question without sending", "database connection entry shows an honest empty state");

  await prompt.fill("请将当前工作界面改名为销售洞察");
  await page.getByRole("button", { name: "发送 AI 指令" }).click();
  await page.getByRole("button", { name: "画布预览", exact: true }).waitFor();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].conversation_id);
  assert.equal(await page.locator(".harness-trace[open]").count(), 0, "Finished trace must default to collapsed");
  await page.locator(".harness-trace > summary").last().click();
  await screenshot("trace-awaiting-confirmation");
  assert.equal(requests[0].appSpec.dataSources.find((source) => source.id === requests[0].dataSourceId)?.name, "销售示例");
  assert.ok(await page.getByRole("button", { name: "确认并应用" }).isDisabled(), "Confirmation still requires a canvas preview");
  await page.getByRole("button", { name: "画布预览", exact: true }).click();
  assert.equal(await canvasTab.getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "确认并应用" }).click();
  await page.waitForFunction(() => document.querySelector(".workspace-mode-context")?.textContent.includes("销售洞察"));
  await screenshot("canvas-confirmed");
  await agentTab.click();
  const notice = page.getByRole("button", { name: "知道了", exact: true });
  if (await notice.isVisible()) await notice.click();
  assert.ok((await page.getByRole("log").innerText()).includes("请将当前工作界面改名为销售洞察"));
  report.checks.push("import and select actual synthetic CSV data", "selected dataset reaches Harness", "preview switches to canvas before confirmation", "conversation survives mode switching");

  await prompt.fill("生成处理结果供界面验证");
  await page.getByRole("button", { name: "发送 AI 指令" }).click();
  await page.getByRole("log").getByText("筛选结果已生成。", { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].conversation_id, requests[0].conversation_id, "Follow-ups keep the conversation identity");
  assert.equal(requests[1].conversationContext.recentMessages.length, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    await plus.click();
    await page.getByRole("menuitem", { name: "添加处理配方或结果", exact: true }).click();
    await page.getByRole("menuitem", { name: /销售筛选结果/u }).click();
    assert.equal(await canvasTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("tab", { name: /^AI 处理结果/u }).getAttribute("aria-selected"), "true", "Result shortcuts must select the AI result tab, even after manually selecting source data");
    if (attempt === 0) {
      await page.getByRole("tab", { name: /^原始数据/u }).click();
      await agentTab.click();
    }
  }
  await screenshot("context-selected-artifact");
  await plus.click();
  await page.getByRole("menuitem", { name: "添加处理配方或结果", exact: true }).hover();
  await page.getByRole("menuitem", { name: /销售筛选结果/u }).hover();
  await screenshot("sidebar-context-menu");
  const sidebarMenuBox = await page.getByRole("menu", { name: "处理配方或结果", exact: true }).boundingBox();
  assert.ok(sidebarMenuBox.x >= 0 && sidebarMenuBox.x + sidebarMenuBox.width <= 1440);
  await page.getByRole("textbox", { name: "搜索处理配方或结果" }).focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await agentTab.click();
  report.checks.push("result shortcuts open the correct table tab", "sidebar submenus remain inside the viewport and support mouse navigation");

  for (let index = 0; index < 12; index++) {
    await prompt.fill("你好");
    await page.getByRole("button", { name: "发送 AI 指令" }).click();
    await page.waitForFunction((count) => document.querySelectorAll(".conversation-turn").length >= count, index + 3);
  }
  assert.equal(requests.length, 2, "Local greetings must not invoke a real model");
  const composerBefore = await page.locator(".prompt-box").boundingBox();
  const log = page.getByRole("log");
  await log.evaluate((element) => { element.scrollTop = 0; });
  const metrics = await log.evaluate((element) => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }));
  const composerAfter = await page.locator(".prompt-box").boundingBox();
  assert.ok(metrics.total > metrics.height && metrics.top === 0);
  assert.ok(Math.abs(composerAfter.y - composerBefore.y) < 1, "Composer must not move while reading history");
  await screenshot("desktop-history");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile-history");
  assert.ok(await prompt.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
  }), "Mobile composer must not be covered by side panels");
  await plus.click();
  await page.getByRole("menuitem", { name: "选择工作界面与数据表", exact: true }).click();
  await screenshot("mobile-context-menu");
  const submenuBox = await page.getByRole("menu", { name: "工作界面与数据表", exact: true }).boundingBox();
  assert.ok(submenuBox.x >= 0 && submenuBox.x + submenuBox.width <= 390 && submenuBox.y >= 0 && submenuBox.y + submenuBox.height <= 844);
  await page.getByRole("button", { name: "返回上下文菜单" }).click();
  await page.keyboard.press("Escape");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  report.checks.push("long history scrolls independently of the composer", "no page errors or horizontal overflow");
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await screenshot("failure");
  console.error(JSON.stringify({ error: String(error), errors, text: (await page.locator("body").innerText()).slice(-3000) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
