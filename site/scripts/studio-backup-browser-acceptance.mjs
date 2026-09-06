import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CdpClient,
  loopbackUrl,
  readBoundedResponseBytes,
  selectCdpPageTarget,
} from "./eds-browser-acceptance.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:3102";
const DEFAULT_CDP_URL = "http://127.0.0.1:9223";
const MAX_CDP_TARGET_LIST_BYTES = 1024 * 1024;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "浏览器表达式执行失败");
  return response.result.value;
}

async function waitFor(client, expression, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`等待超时：${label}`);
}

async function waitForDownloadedBackup(directory, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(directory);
    const completed = names.filter((name) => name.startsWith("datacanvas-workspace-") && name.endsWith(".json"));
    if (completed.length === 1 && !names.some((name) => name.endsWith(".crdownload"))) return join(directory, completed[0]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("等待工作区备份下载超时");
}

async function main() {
  const baseUrl = loopbackUrl("STUDIO_BACKUP_BASE_URL", process.env.STUDIO_BACKUP_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const cdpUrl = loopbackUrl("STUDIO_BACKUP_CDP_URL", process.env.STUDIO_BACKUP_CDP_URL?.trim() || DEFAULT_CDP_URL);
  const downloadDirectory = await mkdtemp(join(tmpdir(), "datacanvas-backup-acceptance-"));
  let client;
  try {
    const targetResponse = await fetch(new URL("/json/list", cdpUrl), { signal: AbortSignal.timeout(5_000) });
    if (!targetResponse.ok) throw new Error(`Edge 调试目标查询失败：${targetResponse.status}`);
    const targetListBytes = await readBoundedResponseBytes(targetResponse, MAX_CDP_TARGET_LIST_BYTES, "CDP 目标列表");
    const targets = JSON.parse(targetListBytes.toString("utf8"));
    const { socketUrl } = selectCdpPageTarget(targets, cdpUrl);
    client = new CdpClient(socketUrl.href);
    await client.connect();
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("DOM.enable"),
      client.send("Network.enable"),
      client.send("Emulation.setDeviceMetricsOverride", {
        width: 1100,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDirectory,
      eventsEnabled: true,
    });
    await client.send("Page.navigate", { url: baseUrl.href });
    await waitFor(client, `document.readyState === "complete" && Boolean(document.querySelector('textarea[aria-label="AI 指令"]'))`, "工作台加载");
    await evaluate(client, `(() => { localStorage.clear(); location.reload(); return true; })()`);
    await waitFor(client, `document.readyState === "complete" && Boolean(document.querySelector('textarea[aria-label="AI 指令"]'))`, "安全演示状态重载");

    const publishOpened = await evaluate(client, `(() => { const button = document.querySelector(".top-actions .publish"); button?.click(); return Boolean(button); })()`);
    assert(publishOpened, "顶部缺少发布入口");
    await waitFor(client, `Boolean(document.querySelector(".publish-readiness-dialog"))`, "发布准备说明打开");
    const publishDialog = await evaluate(client, `(() => ({
      text: document.querySelector(".publish-readiness-dialog")?.innerText || "",
      focusInside: document.querySelector(".publish-readiness-dialog")?.contains(document.activeElement) || false,
    }))()`);
    assert(publishDialog.text.includes("当前按钮不会直接提交代码或部署网站") && publishDialog.text.includes("浏览器本地草稿"), "发布准备说明缺少保存与部署边界");
    assert(publishDialog.focusInside, "发布准备说明打开后焦点未进入弹层");
    await evaluate(client, `document.querySelector('button[aria-label="关闭发布准备说明"]')?.click()`);
    await waitFor(client, `!document.querySelector(".publish-readiness-dialog") && document.activeElement === document.querySelector(".top-actions .publish")`, "关闭发布说明并恢复焦点");

    const submitted = await evaluate(client, `(() => {
      const textarea = document.querySelector('textarea[aria-label="AI 指令"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!textarea || !setter) return false;
      setter.call(textarea, "你好");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    assert(submitted, "无法填写本地对话测试消息");
    await waitFor(client, `(() => { const button = document.querySelector('button[aria-label="发送 AI 指令"]'); if (!button || button.disabled) return false; button.click(); return true; })()`, "发送本地对话");
    await waitFor(client, `document.querySelectorAll(".conversation-turn").length === 1 && document.body.innerText.includes("本地回复")`, "本地对话写入上下文");

    const menuOpened = await evaluate(client, `(() => { const summary = document.querySelector('.backup-menu>summary'); summary?.click(); return Boolean(summary); })()`);
    assert(menuOpened, "顶部缺少工作区备份菜单");
    const downloadClicked = await evaluate(client, `(() => { const button = [...document.querySelectorAll('.backup-menu button')].find((item) => item.textContent.trim() === "下载备份"); button?.click(); return Boolean(button); })()`);
    assert(downloadClicked, "工作区备份菜单缺少下载动作");
    const backupPath = await waitForDownloadedBackup(downloadDirectory);
    const backupBytes = await readFile(backupPath);
    assert(backupBytes.byteLength > 0 && backupBytes.byteLength <= MAX_BACKUP_BYTES, "下载的工作区备份大小无效");
    const serialized = backupBytes.toString("utf8");
    const backup = JSON.parse(serialized);
    assert(backup.format === "datacanvas-ai-studio-backup-v1", "工作区备份格式版本错误");
    assert(backup.state?.assistantConversation?.length === 1, "工作区备份未包含一轮本地对话");
    assert(!/sk-[A-Za-z0-9_-]{12,}/u.test(serialized), "工作区备份疑似包含 API Key");
    assert(!serialized.includes("input.xlsx") && !serialized.includes("output.xlsx") && !serialized.includes("/api/exports/"), "工作区备份包含原始验收文件名或下载令牌");
    assert(!(await evaluate(client, `performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/ai/harness"))`)), "本地对话或备份错误调用了 Harness API");
    await evaluate(client, `(() => { const menu = document.querySelector('.backup-menu'); if (menu) menu.open = false; return true; })()`);

    const cleared = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "清除上下文"); button?.click(); return Boolean(button); })()`);
    assert(cleared, "页面缺少清除上下文动作");
    await waitFor(client, `document.querySelectorAll(".conversation-turn").length === 0 && JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1")).assistantConversation.length === 0`, "清空页面与本地对话");
    await evaluate(client, `window.confirm = () => true`);
    const documentNode = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    const input = await client.send("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector: 'input[aria-label="选择工作区备份文件"]',
    });
    assert(input.nodeId, "页面缺少工作区备份文件输入");
    await client.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [backupPath] });
    await waitFor(client, `document.querySelectorAll(".conversation-turn").length === 1 && document.body.innerText.includes("已从“datacanvas-workspace-")`, "备份恢复页面状态");
    const restored = await evaluate(client, `(() => {
      const state = JSON.parse(localStorage.getItem("datacanvas-ai:studio:v1"));
      return {
        turns: document.querySelectorAll(".conversation-turn").length,
        storedTurns: state.assistantConversation.length,
        latestInstruction: state.assistantConversation.at(-1)?.instruction,
        pendingTasks: state.harnessTasks.filter((task) => task.state === "planning" || task.state === "executingTool").length,
      };
    })()`);
    assert(restored.turns === 1 && restored.storedTurns === 1 && restored.latestInstruction === "你好", "备份恢复后的页面与 localStorage 不一致");
    assert(restored.pendingTasks === 0, "备份恢复后自动继续了未完成 Harness 任务");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(client, `getComputedStyle(document.querySelector(".header-more-menu")).display !== "none"`, "窄屏操作收纳菜单显示");
    await waitFor(client, `(() => {
      const pages = document.querySelector(".pages-panel-slot")?.getBoundingClientRect();
      const assistant = document.querySelector(".assistant-panel-slot")?.getBoundingClientRect();
      return Boolean(pages && assistant && pages.right <= 0 && assistant.left >= document.documentElement.clientWidth);
    })()`, "窄屏侧栏退出主画布");
    const responsiveHeader = await evaluate(client, `(() => {
      const topbar = document.querySelector(".topbar");
      const workspace = document.querySelector(".workspace");
      const secondary = document.querySelector(".topbar-secondary-actions");
      const more = document.querySelector(".header-more-menu");
      const brand = document.querySelector(".brand");
      const actions = document.querySelector(".top-actions");
      const rect = (node) => node?.getBoundingClientRect();
      const topbarRect = rect(topbar);
      const workspaceRect = rect(workspace);
      const brandRect = rect(brand);
      const actionsRect = rect(actions);
      const canvasRect = rect(document.querySelector(".canvas-area"));
      const pagesRect = rect(document.querySelector(".pages-panel-slot"));
      const assistantRect = rect(document.querySelector(".assistant-panel-slot"));
      const overflowCandidates = [...document.querySelectorAll("body *")]
        .map((node) => ({
          node,
          rect: node.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1))
        .slice(0, 8)
        .map(({ node, rect }) => ({
          tag: node.tagName,
          className: typeof node.className === "string" ? node.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        }));
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        topbarClientWidth: topbar?.clientWidth,
        topbarScrollWidth: topbar?.scrollWidth,
        topbarHeight: topbarRect?.height,
        workspaceTop: workspaceRect?.top,
        secondaryDisplay: secondary ? getComputedStyle(secondary).display : null,
        moreDisplay: more ? getComputedStyle(more).display : null,
        brandEndsBeforeActions: Boolean(brandRect && actionsRect && brandRect.right <= actionsRect.left),
        canvasWidth: canvasRect?.width,
        canvasLeft: canvasRect?.left,
        pagesPosition: getComputedStyle(document.querySelector(".pages-panel-slot")).position,
        assistantPosition: getComputedStyle(document.querySelector(".assistant-panel-slot")).position,
        closedPagesRight: pagesRect?.right,
        closedAssistantLeft: assistantRect?.left,
        overflowCandidates,
      };
    })()`);
    assert(responsiveHeader.documentWidth <= responsiveHeader.viewportWidth, `窄屏顶栏导致页面横向溢出：${JSON.stringify(responsiveHeader)}`);
    assert(responsiveHeader.topbarHeight === 64 && responsiveHeader.workspaceTop === 64, "窄屏顶栏高度异常或遮挡工作区");
    assert(responsiveHeader.secondaryDisplay === "none" && responsiveHeader.moreDisplay !== "none", "窄屏桌面操作未正确收进更多菜单");
    assert(responsiveHeader.brandEndsBeforeActions, "窄屏品牌区域与操作区域发生重叠");
    assert(responsiveHeader.pagesPosition === "fixed" && responsiveHeader.assistantPosition === "fixed", "窄屏左右侧栏仍参与三栏布局");
    assert(responsiveHeader.canvasLeft === 0 && responsiveHeader.canvasWidth === responsiveHeader.topbarClientWidth, "窄屏主画布未独占工作区宽度");
    assert(responsiveHeader.closedPagesRight <= 0 && responsiveHeader.closedAssistantLeft >= responsiveHeader.topbarClientWidth, "窄屏关闭的侧栏仍遮挡主画布");
    const pagesOpened = await evaluate(client, `(() => { const button = [...document.querySelectorAll('.compact-panel-entry')].find((item) => item.textContent.trim() === "页面"); button?.click(); return Boolean(button); })()`);
    assert(pagesOpened, "窄屏缺少页面面板入口");
    await waitFor(client, `(() => { const panel = document.querySelector('.pages-panel-slot'); const rect = panel?.getBoundingClientRect(); return Boolean(panel?.classList.contains('open') && document.querySelector('.compact-panel-scrim') && rect && Math.abs(rect.left) < 1); })()`, "窄屏页面抽屉打开");
    const pagesDrawer = await evaluate(client, `(() => { const rect = document.querySelector('.pages-panel-slot')?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right } : null; })()`);
    assert(pagesDrawer?.left === 0 && pagesDrawer.right <= responsiveHeader.topbarClientWidth, "窄屏页面抽屉未贴合视口");
    await evaluate(client, `document.querySelector('button[aria-label="关闭页面与结构面板"]')?.click()`);
    await waitFor(client, `(() => { const panel = document.querySelector('.pages-panel-slot'); const rect = panel?.getBoundingClientRect(); return Boolean(!panel?.classList.contains('open') && rect && rect.right <= 0); })()`, "窄屏页面抽屉关闭");
    const assistantOpened = await evaluate(client, `(() => { const button = [...document.querySelectorAll('.compact-panel-entry')].find((item) => item.textContent.trim() === "AI 助手"); button?.click(); return Boolean(button); })()`);
    assert(assistantOpened, "窄屏缺少 AI 助手面板入口");
    await waitFor(client, `(() => { const panel = document.querySelector('.assistant-panel-slot'); const rect = panel?.getBoundingClientRect(); return Boolean(panel?.classList.contains('open') && document.querySelector('.compact-panel-scrim') && rect && Math.abs(rect.right - document.documentElement.clientWidth) < 1); })()`, "窄屏 AI 助手抽屉打开");
    const assistantDrawer = await evaluate(client, `(() => { const rect = document.querySelector('.assistant-panel-slot')?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right } : null; })()`);
    assert(assistantDrawer?.right === responsiveHeader.topbarClientWidth && assistantDrawer.left >= 0, "窄屏 AI 助手抽屉未贴合视口");
    await evaluate(client, `document.querySelector('button[aria-label="关闭 AI 助手面板"]')?.click()`);
    await waitFor(client, `(() => { const panel = document.querySelector('.assistant-panel-slot'); const rect = panel?.getBoundingClientRect(); return Boolean(!panel?.classList.contains('open') && rect && rect.left >= document.documentElement.clientWidth); })()`, "窄屏 AI 助手抽屉关闭");
    const moreMenuOpened = await evaluate(client, `(() => { const summary = document.querySelector('.header-more-menu>summary'); summary?.click(); return Boolean(summary); })()`);
    assert(moreMenuOpened, "窄屏缺少更多工作区操作入口");
    await waitFor(client, `document.querySelector('.header-more-menu')?.open === true && document.querySelector('.header-more-menu')?.innerText.includes("恢复演示数据")`, "窄屏更多菜单展开");
    console.log(JSON.stringify({
      status: "passed",
      backupBytes: backupBytes.byteLength,
      restoredTurns: restored.storedTurns,
      harnessRequests: 0,
      containsApiKey: false,
      containsOriginalWorkbook: false,
      publishDialogVerified: true,
      responsiveHeaderVerified: true,
    }, null, 2));
  } finally {
    client?.close();
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) await main();
