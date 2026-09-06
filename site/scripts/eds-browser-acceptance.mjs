import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyEdsDownloadBytes } from "./verify-eds-download.mjs";

const EXPECTED_SOURCE_SHA256 = "F44CD94DECBDF797B0606258CB7DFE704FC34EB68E35FCECBF41D1A5409434C3";
const EXPECTED_TEMPLATE_SHA256 = "AADDAE8B24140A0C5FADAE715A8B2324C76E722B28F7075941DA94C20006F04E";
const DEFAULT_BASE_URL = "http://127.0.0.1:3102";
const DEFAULT_CDP_URL = "http://127.0.0.1:9223";
const CDP_CONNECT_TIMEOUT_MS = 5_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_CDP_TARGET_LIST_BYTES = 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50];
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export function parseCdpMessageFrame(data) {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    throw new Error("CDP WebSocket 返回无法解析的 JSON 帧");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("CDP WebSocket 返回的 JSON 帧必须是对象");
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (!hasId) {
    if (typeof message.method !== "string" || message.method.length === 0) {
      throw new Error("CDP WebSocket 事件帧缺少有效 method");
    }
    return message;
  }
  if (!Number.isSafeInteger(message.id) || message.id < 1) {
    throw new Error("CDP WebSocket 响应帧包含无效 id");
  }

  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw new Error("CDP WebSocket 响应帧必须且只能包含 result 或 error");
  if (hasError && (
    !message.error
    || typeof message.error !== "object"
    || !Number.isSafeInteger(message.error.code)
    || typeof message.error.message !== "string"
  )) {
    throw new Error("CDP WebSocket 响应帧包含无效 error");
  }
  return message;
}

export class CdpClient {
  constructor(url, options = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.connectTimeoutMs = options.connectTimeoutMs ?? CDP_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? CDP_COMMAND_TIMEOUT_MS;
    const WebSocketConstructor = options.WebSocketConstructor ?? WebSocket;
    this.socket = new WebSocketConstructor(url);
  }

  async connect() {
    await new Promise((resolveConnection, rejectConnection) => {
      const timer = setTimeout(() => {
        cleanup();
        this.socket.close();
        rejectConnection(new Error(`CDP WebSocket 连接超过 ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleError);
        this.socket.removeEventListener("close", handleClose);
      };
      const handleOpen = () => { cleanup(); resolveConnection(); };
      const handleError = () => { cleanup(); rejectConnection(new Error("CDP WebSocket 连接失败")); };
      const handleClose = () => { cleanup(); rejectConnection(new Error("CDP WebSocket 在连接前关闭")); };
      this.socket.addEventListener("open", handleOpen, { once: true });
      this.socket.addEventListener("error", handleError, { once: true });
      this.socket.addEventListener("close", handleClose, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = parseCdpMessageFrame(event.data);
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error("CDP WebSocket 帧校验失败"));
        this.socket.close();
        return;
      }
      if (!("id" in message)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("error", () => this.rejectPending(new Error("CDP WebSocket 发生错误")));
    this.socket.addEventListener("close", () => this.rejectPending(new Error("CDP WebSocket 已关闭")));
  }

  rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`CDP 命令 ${method} 超过 ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  close() {
    this.socket.close();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fileSystemErrorCode(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function delay(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function requiredEnvironmentPath(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  if (!isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return resolve(value);
}

export function loopbackUrl(name, value) {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(`${name} 只允许 HTTP 回环地址`);
  }
  return url;
}

export function loopbackWebSocketUrl(name, value) {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(`${name} 只允许 WS 回环地址`);
  }
  return url;
}

export function sameOriginUrl(name, value, expectedBase) {
  const expectedUrl = expectedBase instanceof URL ? expectedBase : new URL(expectedBase);
  const url = new URL(value, expectedUrl);
  if (url.origin !== expectedUrl.origin || url.username || url.password) {
    throw new Error(`${name} 必须与 ${expectedUrl.origin} 同源且不含凭据`);
  }
  return url;
}

function effectivePort(url) {
  if (url.port) return url.port;
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

export function selectCdpPageTarget(targets, cdpBase) {
  if (!Array.isArray(targets)) throw new Error("CDP 目标列表必须为数组");
  const pageTargets = targets.filter((candidate) => candidate && typeof candidate === "object" && candidate.type === "page");
  if (pageTargets.length !== 1) throw new Error(`CDP 必须且只能包含一个页面目标，实际为 ${pageTargets.length}`);
  const target = pageTargets[0];
  if (target.url !== "about:blank") throw new Error(`CDP 页面目标必须为空白页，实际为 ${String(target.url)}`);
  if (typeof target.webSocketDebuggerUrl !== "string") throw new Error("CDP 页面目标缺少 WebSocket 地址");
  const socketUrl = loopbackWebSocketUrl("Edge CDP WebSocket", target.webSocketDebuggerUrl);
  const cdpUrl = cdpBase instanceof URL ? cdpBase : new URL(cdpBase);
  if (effectivePort(socketUrl) !== effectivePort(cdpUrl)) {
    throw new Error("Edge CDP WebSocket 端口与配置的 CDP 端口不一致");
  }
  return { target, socketUrl };
}

export async function readBoundedResponseBytes(response, maximumBytes = MAX_DOWNLOAD_BYTES, label = "下载") {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error(`${label}大小上限无效`);
  const declaredValue = response.headers.get("content-length");
  let declaredLength = null;
  if (declaredValue !== null) {
    if (!/^(0|[1-9]\d*)$/u.test(declaredValue)) throw new Error(`${label} Content-Length 无效`);
    declaredLength = Number(declaredValue);
    if (!Number.isSafeInteger(declaredLength)) throw new Error(`${label} Content-Length 超出安全整数范围`);
    if (declaredLength > maximumBytes) throw new Error(`${label}声明大小超过 ${maximumBytes} 字节上限`);
  }
  if (!response.body) throw new Error(`${label}响应缺少正文流`);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label}实际大小超过 ${maximumBytes} 字节上限`);
    }
    chunks.push(Buffer.from(value));
  }
  if (declaredLength !== null && declaredLength !== totalBytes) {
    throw new Error(`${label} Content-Length ${declaredLength} 与正文 ${totalBytes} 不一致`);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function assertPortableEvidence(value) {
  if (typeof value === "string") {
    if (win32.isAbsolute(value) || posix.isAbsolute(value)) {
      throw new Error(`证据包含绝对文件系统路径：${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPortableEvidence(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertPortableEvidence(item);
  }
}

export async function renameEvidenceWithRetry(source, destination, options = {}) {
  const platform = options.platform ?? process.platform;
  const renamePath = options.rename ?? rename;
  const wait = options.wait ?? delay;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renamePath(source, destination);
      return;
    } catch (error) {
      const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || retryDelay === undefined || !TRANSIENT_WINDOWS_RENAME_CODES.has(fileSystemErrorCode(error) ?? "")) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}

async function checkedWorkbook(path, expectedHash, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} 不是普通文件`);
  if (extname(path).toLocaleLowerCase("en-US") !== ".xlsx") throw new Error(`${label} 必须是 .xlsx`);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (sha256 !== expectedHash) throw new Error(`${label} SHA-256 与固定验收原件不一致`);
  return { bytes, sizeBytes: bytes.byteLength, sha256 };
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

async function waitFor(client, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`等待超时：${label}`);
}

async function setFile(client, index, filePath, expectedInputCount) {
  const document = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputs = await client.send("DOM.querySelectorAll", {
    nodeId: document.root.nodeId,
    selector: '.eds-dialog input[type="file"]',
  });
  assert(inputs.nodeIds.length === expectedInputCount, `预期 ${expectedInputCount} 个文件输入，实际 ${inputs.nodeIds.length}`);
  await client.send("DOM.setFileInputFiles", { nodeId: inputs.nodeIds[index], files: [filePath] });
}

export async function publishEvidenceAtomically({
  evidenceDir,
  downloadedBytes,
  screenshotBytes,
  evidence,
}) {
  const evidenceParent = dirname(evidenceDir);
  const temporaryEvidenceDir = await mkdtemp(join(evidenceParent, `.${basename(evidenceDir)}-`));
  try {
    await writeFile(join(temporaryEvidenceDir, "EDS-browser-result.xlsx"), downloadedBytes);
    await writeFile(join(temporaryEvidenceDir, "eds-ui-browser-acceptance.png"), screenshotBytes);
    await writeFile(join(temporaryEvidenceDir, "browser-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await renameEvidenceWithRetry(temporaryEvidenceDir, evidenceDir);
  } catch (error) {
    await rm(temporaryEvidenceDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  if (typeof WebSocket !== "function") throw new Error("需要 Node.js 22.13 或更高版本的全局 WebSocket");
  const sourcePath = requiredEnvironmentPath("EDS_REAL_SOURCE_PATH");
  const browserMode = process.env.EDS_BROWSER_MODE?.trim() || "standard";
  const createWorkspace = process.env.EDS_BROWSER_CREATE_WORKSPACE?.trim() === "1";
  const aiChartPrompt = process.env.EDS_BROWSER_AI_CHART_PROMPT?.trim() || "";
  const aiColorChange = Boolean(aiChartPrompt)
    && /颜色|配色|色彩|blue|green|violet|orange|red|teal/iu.test(aiChartPrompt);
  const aiValueLabelChange = Boolean(aiChartPrompt)
    && /柱顶|顶部(?:数字|数值|标签)|数据标签|显示(?:数字|数值|标签)/iu.test(aiChartPrompt);
  const aiStyleChange = (aiColorChange || aiValueLabelChange)
    && !/新增|创建|生成|插入/iu.test(aiChartPrompt);
  const aiRequestedChartType = /环形图|圆环图|甜甜圈图/iu.test(aiChartPrompt)
    ? "donut"
    : /饼(?:状)?图/iu.test(aiChartPrompt)
      ? "pie"
      : /面积图/iu.test(aiChartPrompt)
        ? "area"
        : /折线图|曲线图/iu.test(aiChartPrompt)
          ? "line"
          : /柱状图|柱形图|条形图/iu.test(aiChartPrompt)
            ? "bar"
            : "";
  const testConversationScroll = process.env.EDS_BROWSER_TEST_CONVERSATION_SCROLL?.trim() === "1";
  assert(browserMode === "standard" || browserMode === "acceptance", "EDS_BROWSER_MODE 只能是 standard 或 acceptance");
  assert(aiChartPrompt.length <= 1_000, "EDS_BROWSER_AI_CHART_PROMPT 不能超过 1000 字符");
  assert(!aiChartPrompt || createWorkspace, "AI 图表验收必须同时启用 EDS_BROWSER_CREATE_WORKSPACE=1");
  assert(!testConversationScroll || createWorkspace, "AI 对话滚动验收必须同时启用 EDS_BROWSER_CREATE_WORKSPACE=1");
  const templatePath = browserMode === "acceptance" ? requiredEnvironmentPath("EDS_REAL_TEMPLATE_PATH") : null;
  const evidenceDir = requiredEnvironmentPath("EDS_BROWSER_EVIDENCE_DIR");
  if (existsSync(evidenceDir)) throw new Error("EDS_BROWSER_EVIDENCE_DIR 已存在，拒绝覆盖");
  const evidenceParent = dirname(evidenceDir);
  const parentMetadata = await stat(evidenceParent);
  if (!parentMetadata.isDirectory()) throw new Error("EDS_BROWSER_EVIDENCE_DIR 的父路径不是目录");
  await access(evidenceParent);
  const baseUrl = loopbackUrl("EDS_BROWSER_BASE_URL", process.env.EDS_BROWSER_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const cdpUrl = loopbackUrl("EDS_BROWSER_CDP_URL", process.env.EDS_BROWSER_CDP_URL?.trim() || DEFAULT_CDP_URL);
  const viewportWidth = Number(process.env.EDS_BROWSER_VIEWPORT_WIDTH?.trim() || 1440);
  const viewportHeight = Number(process.env.EDS_BROWSER_VIEWPORT_HEIGHT?.trim() || 1100);
  assert(Number.isSafeInteger(viewportWidth) && viewportWidth >= 320 && viewportWidth <= 4096, "EDS_BROWSER_VIEWPORT_WIDTH 必须是 320–4096 的整数");
  assert(Number.isSafeInteger(viewportHeight) && viewportHeight >= 480 && viewportHeight <= 4096, "EDS_BROWSER_VIEWPORT_HEIGHT 必须是 480–4096 的整数");
  const source = await checkedWorkbook(sourcePath, EXPECTED_SOURCE_SHA256, "input.xlsx");
  const template = templatePath
    ? await checkedWorkbook(templatePath, EXPECTED_TEMPLATE_SHA256, "output.xlsx")
    : null;

  const targetResponse = await fetch(new URL("/json/list", cdpUrl), { signal: AbortSignal.timeout(5_000) });
  if (!targetResponse.ok) throw new Error(`Edge 调试目标查询失败：${targetResponse.status}`);
  const targetListBytes = await readBoundedResponseBytes(targetResponse, MAX_CDP_TARGET_LIST_BYTES, "CDP 目标列表");
  let targets;
  try {
    targets = JSON.parse(targetListBytes.toString("utf8"));
  } catch {
    throw new Error("CDP 目标列表不是有效 JSON");
  }
  const { socketUrl: targetSocketUrl } = selectCdpPageTarget(targets, cdpUrl);
  const client = new CdpClient(targetSocketUrl.href);
  await client.connect();

  try {
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("DOM.enable"),
      client.send("Emulation.setDeviceMetricsOverride", {
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);
    await client.send("Page.navigate", { url: baseUrl.href });
    await waitFor(
      client,
      `document.readyState === "complete" && [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "EDS 分析")`,
      "工作台与 EDS 入口",
    );
    const finalPageUrl = await evaluate(client, "location.href");
    sameOriginUrl("Edge 最终页面", finalPageUrl, baseUrl);
    await waitFor(client, `(() => {
      if (document.querySelector(".eds-dialog")) return true;
      [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "EDS 分析")?.click();
      return false;
    })()`, "EDS 对话框打开");
    const initialFocusInside = await evaluate(client, `document.querySelector(".eds-dialog").contains(document.activeElement)`);
    assert(initialFocusInside, "EDS 对话框打开后焦点未进入模态框");
    const defaultState = await evaluate(client, `({
      fileInputs: document.querySelectorAll('.eds-dialog input[type="file"]').length,
      hasVisibleAcceptancePicker: document.body.innerText.includes("验收基准（可选）"),
      templateVersionVisible: document.body.innerText.includes("EDS-REPORT-2026.09"),
      ruleVersionVisible: document.body.innerText.includes("EDS-RULES-2026.09"),
    })`);
    assert(defaultState.fileInputs === 1 && !defaultState.hasVisibleAcceptancePicker, "默认界面未保持单文件业务流程");
    assert(defaultState.templateVersionVisible && defaultState.ruleVersionVisible, "默认界面缺少模板或规则版本");

    await setFile(client, 0, sourcePath, 1);
    await waitFor(client, `document.body.innerText.includes("input.xlsx")`, "输入工作簿选择");
    if (browserMode === "acceptance") {
      const advancedOpened = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "高级验收"); button?.click(); return Boolean(button); })()`);
      assert(advancedOpened, "无法打开高级验收入口");
      await waitFor(client, `document.querySelectorAll('.eds-dialog input[type="file"]').length === 2 && document.body.innerText.includes("验收基准（可选）")`, "高级验收入口展开");
      await setFile(client, 1, templatePath, 2);
      await waitFor(client, `document.body.innerText.includes("output.xlsx") && !document.querySelector(".eds-run-button").disabled`, "验收基准选择与运行入口解锁");
    } else {
      await waitFor(client, `!document.querySelector(".eds-run-button").disabled`, "单文件运行入口解锁");
    }
    await evaluate(client, `document.querySelector(".eds-run-button").click()`);
    const expectedHeading = browserMode === "acceptance" ? "验收基准比对全部一致" : "分析与报表已生成";
    await waitFor(client, `Boolean(document.querySelector(".eds-result")) && document.body.innerText.includes(${JSON.stringify(expectedHeading)})`, "真实 EDS 分析结果", 45_000);

    const result = await evaluate(client, `(() => ({
      bodyText: document.querySelector(".eds-result").innerText,
      kpis: [...document.querySelectorAll(".eds-kpis article")].map((item) => item.innerText),
      chartSections: document.querySelectorAll(".eds-charts section").length,
      chartRows: document.querySelectorAll(".eds-chart-row").length,
      downloadUrl: document.querySelector("[data-download-url]")?.getAttribute("data-download-url"),
      dialogBusy: document.querySelector(".eds-dialog")?.getAttribute("aria-busy"),
    }))()`);
    assert(result.bodyText.includes("EDS-REPORT-2026.09") && result.bodyText.includes("EDS-RULES-2026.09"), "结果页缺少模板或规则版本");
    if (browserMode === "acceptance") {
      assert(result.bodyText.includes("核心统计 560/560"), "页面缺少核心 560/560 证据");
      assert(result.bodyText.includes("整表数字 660/660"), "页面缺少完整 660/660 证据");
    } else {
      assert(!result.bodyText.includes("560/560") && result.bodyText.includes("标准自动分析"), "普通结果错误显示目标表比对或缺少模式说明");
    }
    assert(result.bodyText.includes("4,651") && result.bodyText.includes("293"), "页面缺少业务 KPI 证据");
    assert(result.chartSections === 2 && result.chartRows === 24, "页面图表数量与固定验收不一致");
    assert(result.downloadUrl?.startsWith("/api/exports/"), "下载地址缺失或非法");
    assert(result.dialogBusy === "false", "分析完成后 dialog 仍处于 busy");

    const downloadUrl = sameOriginUrl("EDS 下载地址", result.downloadUrl, baseUrl);
    const downloadResponse = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) });
    const download = {
      status: downloadResponse.status,
      contentType: downloadResponse.headers.get("content-type"),
      contentLength: downloadResponse.headers.get("content-length"),
      disposition: downloadResponse.headers.get("content-disposition"),
    };
    assert(download.status === 200, `下载状态错误：${download.status}`);
    const downloadedBytes = await readBoundedResponseBytes(downloadResponse);
    assert(downloadedBytes.subarray(0, 2).toString() === "PK", "下载文件不是 XLSX ZIP");
    const independentComparison = await verifyEdsDownloadBytes(source.bytes, downloadedBytes);
    let screenshotBytes;
    let resetState = { sourceRetained: false, templateRetained: false, runDisabled: true };
    let focusRestored = false;
    let reopenFocusInside = false;
    let workspaceState = null;
    let responsiveLayout = null;
    let aiChartState = null;
    let originalWorkbookState = null;
    let sidebarState = null;
    let interfaceSwitcherState = null;
    let assistantResizeState = null;
    let conversationScrollState = null;
    if (createWorkspace) {
      const created = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "生成 EDS 分析看板"); button?.click(); return Boolean(button); })()`);
      assert(created, "结果页缺少生成 EDS 分析看板动作");
      await waitFor(client, `!document.querySelector(".eds-dialog") && document.body.innerText.includes("飞达异常分析看板")`, "EDS 看板进入主界面");
      workspaceState = await evaluate(client, `(() => {
        const serialized = localStorage.getItem("datacanvas-ai:studio:v1") || "";
        const stored = serialized ? JSON.parse(serialized) : null;
        const auditText = stored?.auditRecords?.[0]?.operationSummary || "";
        return {
          mainText: document.querySelector(".dashboard")?.innerText || "",
          metricCards: document.querySelectorAll(".dashboard .metric-card").length,
          charts: document.querySelectorAll(".dashboard .chart-card").length,
          tableRows: document.querySelectorAll(".dashboard .table-card tbody tr").length,
          storedVersion: stored?.version,
          storedInputRows: stored?.edsWorkspace?.summary?.inputRows,
          storedOccurrences: stored?.edsWorkspace?.summary?.totalOccurrences,
          storedBreakdowns: (stored?.edsWorkspace?.lineSummary?.length || 0) + (stored?.edsWorkspace?.issueSummary?.length || 0),
          storedLineIssueBreakdowns: stored?.edsWorkspace?.lineIssueSummary?.length || 0,
          storedPage: stored?.appSpec?.pages?.some((page) => page.id === "page_eds_analysis"),
          storedSources: stored?.appSpec?.dataSources?.filter((source) => source.id === "dataset_eds_overview" || source.id === "dataset_eds_breakdown").length,
          auditHasSummary: auditText.includes("派生汇总（不含原始行）") && auditText.includes("异常293次") && auditText.includes("EDS-REPORT-2026.09"),
          containsRawFileName: serialized.includes("input.xlsx") || serialized.includes("output.xlsx"),
          containsDownloadToken: serialized.includes("/api/exports/") || serialized.includes("exportArtifact") || serialized.includes("sourceSheets"),
        };
      })()`);
      assert(workspaceState.mainText.includes("4,651") && workspaceState.mainText.includes("293") && workspaceState.mainText.includes("231.78"), "主看板缺少真实 EDS KPI");
      assert(workspaceState.metricCards === 4 && workspaceState.charts === 2 && workspaceState.tableRows === 24, "主看板组件或汇总行数量不正确");
      assert(workspaceState.storedVersion === 5 && workspaceState.storedInputRows === 4_651 && workspaceState.storedOccurrences === 293, "localStorage 未保存受控 EDS 汇总");
      assert(workspaceState.storedBreakdowns === 24 && workspaceState.storedPage && workspaceState.storedSources === 2, "localStorage 缺少 EDS 页面或数据源");
      assert(workspaceState.storedLineIssueBreakdowns === 140, "localStorage 缺少线体与异常类型交叉汇总");
      assert(workspaceState.auditHasSummary, "审计正文缺少 EDS 派生汇总或版本");
      assert(!workspaceState.containsRawFileName && !workspaceState.containsDownloadToken, "localStorage 泄漏了原始文件名、下载令牌或原始表目录");

      if (viewportWidth > 1200) {
        const interfaceOpened = await evaluate(client, `(() => {
          const summary = document.querySelector(".interface-switcher>summary");
          summary?.click();
          return Boolean(summary);
        })()`);
        assert(interfaceOpened, "顶部缺少工作界面切换器");
        await waitFor(client, `Boolean(document.querySelector(".interface-switcher[open] [role='menu']"))`, "打开工作界面切换器");
        interfaceSwitcherState = await evaluate(client, `(() => {
          const switcher = document.querySelector(".interface-switcher");
          const option = switcher?.querySelector("button[role='menuitem']");
          const state = {
            currentLabel: switcher?.querySelector("summary")?.innerText || "",
            optionCount: switcher?.querySelectorAll("button[role='menuitem']").length || 0,
            optionText: option?.innerText || "",
            legacyNameVisible: (switcher?.innerText || "").includes("零售经营分析"),
          };
          option?.click();
          return state;
        })()`);
        await waitFor(client, `!document.querySelector(".interface-switcher[open]")`, "选择工作界面后关闭菜单");
        assert(interfaceSwitcherState.currentLabel.includes("EDS 飞达异常分析") && interfaceSwitcherState.optionCount === 1, "顶部界面切换器未注册当前 EDS 界面");
        assert(interfaceSwitcherState.optionText.includes("当前") && !interfaceSwitcherState.legacyNameVisible, "界面切换器仍混入旧演示界面");
      } else {
        const compactInterfaceOpened = await evaluate(client, `(() => {
          const summary = document.querySelector(".compact-interface-switcher>summary");
          if (!summary || getComputedStyle(summary.parentElement).display === "none") return false;
          summary.click();
          return true;
        })()`);
        assert(compactInterfaceOpened, "紧凑顶栏缺少工作界面入口");
        await waitFor(client, `Boolean(document.querySelector(".compact-interface-switcher[open] [role='menu']"))`, "打开紧凑工作界面菜单");
        interfaceSwitcherState = await evaluate(client, `(() => {
          const switcher = document.querySelector(".compact-interface-switcher");
          const option = switcher?.querySelector("button[role='menuitem']");
          const state = {
            currentLabel: option?.innerText || "",
            optionCount: switcher?.querySelectorAll("button[role='menuitem']").length || 0,
            optionText: option?.innerText || "",
            legacyNameVisible: (switcher?.innerText || "").includes("零售经营分析"),
            compact: true,
          };
          option?.click();
          return state;
        })()`);
        await waitFor(client, `!document.querySelector(".compact-interface-switcher[open]")`, "选择紧凑工作界面后关闭菜单");
        assert(interfaceSwitcherState.currentLabel.includes("EDS 飞达异常分析") && interfaceSwitcherState.optionCount === 1, "紧凑界面菜单未注册当前 EDS 界面");
        assert(interfaceSwitcherState.optionText.includes("当前") && !interfaceSwitcherState.legacyNameVisible, "紧凑界面菜单仍混入旧演示界面");
      }

      if (viewportWidth <= 960) {
        const assistantOpened = await evaluate(client, `(() => {
          const button = [...document.querySelectorAll("button.compact-panel-entry")].find((item) => item.textContent.trim() === "AI 助手");
          button?.click();
          return Boolean(button);
        })()`);
        assert(assistantOpened, "窄屏缺少 AI 助手抽屉入口");
        await waitFor(client, `document.querySelector(".assistant-panel-slot")?.classList.contains("open")`, "打开窄屏 AI 助手抽屉");
      }
      await waitFor(client, `(() => {
        const panel = document.querySelector(".assistant-panel-slot");
        const handle = panel?.querySelector(".assistant-resize-handle");
        const panelRect = panel?.getBoundingClientRect();
        const handleRect = handle?.getBoundingClientRect();
        if (!panelRect || !handleRect || !panelRect.width) return false;
        const x = handleRect.left + handleRect.width / 2;
        const y = handleRect.top + Math.min(180, handleRect.height / 2);
        const transform = getComputedStyle(panel).transform;
        const animationSettled = transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
        return animationSettled && document.elementFromPoint(x, y) === handle;
      })()`, "AI 助手分隔条进入可拖动位置");
      const assistantResizeStart = await evaluate(client, `(() => {
        const panel = document.querySelector(".assistant-panel-slot");
        const handle = panel?.querySelector(".assistant-resize-handle");
        const panelRect = panel?.getBoundingClientRect();
        const handleRect = handle?.getBoundingClientRect();
        return {
          panelWidth: panelRect?.width || 0,
          handleX: handleRect ? handleRect.left + handleRect.width / 2 : 0,
          handleY: handleRect ? handleRect.top + Math.min(180, handleRect.height / 2) : 0,
          role: handle?.getAttribute("role") || "",
          orientation: handle?.getAttribute("aria-orientation") || "",
          label: handle?.getAttribute("aria-label") || "",
        };
      })()`);
      assert(assistantResizeStart.panelWidth > 0 && assistantResizeStart.handleX > 0, "AI 助手缺少可拖拽分隔条");
      assert(assistantResizeStart.role === "separator" && assistantResizeStart.orientation === "vertical" && assistantResizeStart.label.includes("调整"), "AI 助手分隔条缺少可访问语义");
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: assistantResizeStart.handleX, y: assistantResizeStart.handleY, button: "left", buttons: 1, clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: assistantResizeStart.handleX - 96, y: assistantResizeStart.handleY, button: "left", buttons: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: assistantResizeStart.handleX - 96, y: assistantResizeStart.handleY, button: "left", clickCount: 1 });
      await waitFor(client, `document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width >= ${Math.round(assistantResizeStart.panelWidth + 70)}`, "向左拖宽 AI 助手");
      const widthAfterPointer = await evaluate(client, `document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width || 0`);
      await evaluate(client, `(() => {
        const handle = document.querySelector(".assistant-resize-handle");
        handle?.focus();
        handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      })()`);
      await waitFor(client, `document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width <= ${Math.round(widthAfterPointer - 20)}`, "键盘缩窄 AI 助手");
      const widthAfterKeyboard = await evaluate(client, `document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width || 0`);
      await evaluate(client, `document.querySelector(".assistant-resize-handle")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      const expectedDefaultWidth = viewportWidth > 1200 ? 350 : viewportWidth > 960 ? 290 : Math.min(360, viewportWidth - 44);
      await waitFor(client, `Math.abs((document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width || 0) - ${expectedDefaultWidth}) <= 1`, "双击恢复 AI 助手默认宽度");
      assistantResizeState = {
        initialWidth: assistantResizeStart.panelWidth,
        widthAfterPointer,
        widthAfterKeyboard,
        restoredWidth: await evaluate(client, `document.querySelector(".assistant-panel-slot")?.getBoundingClientRect().width || 0`),
        accessibleSeparator: true,
      };
      if (viewportWidth <= 960) {
        await evaluate(client, `document.querySelector(".assistant-panel-slot .compact-panel-close")?.click()`);
        await waitFor(client, `!document.querySelector(".assistant-panel-slot")?.classList.contains("open")`, "关闭窄屏 AI 助手抽屉");
      }

      let collapsedSidebar = null;
      if (viewportWidth > 960) {
        const minimumExpandedSidebarWidth = viewportWidth > 1200 ? 245 : 205;
        collapsedSidebar = await evaluate(client, `(() => ({
          width: document.querySelector(".pages-panel-slot")?.getBoundingClientRect().width || 0,
          railVisible: getComputedStyle(document.querySelector(".workspace-sidebar-rail")).display !== "none",
          panelVisible: getComputedStyle(document.querySelector(".left-panel")).display !== "none",
          toggleLabel: document.querySelector(".workspace-sidebar-rail button")?.getAttribute("aria-label") || "",
        }))()`);
        assert(collapsedSidebar.railVisible && !collapsedSidebar.panelVisible && collapsedSidebar.toggleLabel === "打开侧边栏", "左侧默认状态不是可操作的折叠图标栏");
        await evaluate(client, `document.querySelector('button[aria-label="打开侧边栏"]')?.click()`);
        await waitFor(client, `document.querySelector(".workspace")?.classList.contains("pages-expanded") && getComputedStyle(document.querySelector(".left-panel")).display !== "none" && document.querySelector(".pages-panel-slot")?.getBoundingClientRect().width >= ${minimumExpandedSidebarWidth}`, "展开左侧工作区");
      } else {
        await evaluate(client, `[...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "页面")?.click()`);
        await waitFor(client, `document.querySelector(".pages-panel-slot")?.classList.contains("open") && getComputedStyle(document.querySelector(".left-panel")).display !== "none"`, "打开窄屏页面抽屉");
      }

      sidebarState = await evaluate(client, `(() => {
        const panel = document.querySelector(".left-panel");
        return {
          text: panel?.innerText || "",
          mode: ${JSON.stringify(viewportWidth > 960 ? "desktop-rail" : "compact-drawer")},
          collapsedWidth: ${collapsedSidebar?.width ?? 0},
          expandedWidth: document.querySelector(".pages-panel-slot")?.getBoundingClientRect().width || 0,
          navigationItems: panel?.querySelectorAll(".page-list-row").length || 0,
          datasetCards: [...(panel?.querySelectorAll(".data-card") || [])].map((item) => item.innerText),
          disabledControls: panel?.querySelectorAll("button:disabled").length || 0,
          hasLayerTree: Boolean(panel?.querySelector(".layer-tree")),
        };
      })()`);
      assert(sidebarState.navigationItems === 1 && sidebarState.text.includes("EDS 异常分析"), "左侧未收敛为当前 EDS 页面");
      assert(!sidebarState.text.includes("经营总览") && !sidebarState.text.includes("销售分析") && !sidebarState.text.includes("客户洞察"), "左侧仍展示旧零售演示页面");
      assert(!sidebarState.text.includes("retail_orders") && sidebarState.datasetCards.length === 2, "左侧仍展示旧测试数据集或缺少 EDS 派生数据");
      assert(sidebarState.disabledControls === 0 && !sidebarState.hasLayerTree && !sidebarState.text.includes("···"), "左侧仍包含不可操作控件或静态图层树");
      if (viewportWidth > 960) assert(sidebarState.expandedWidth >= (viewportWidth > 1200 ? 245 : 205), "左侧栏展开后没有获得完整内容宽度");

      const originalWorkbookOpened = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "打开原始表格"); button?.click(); return Boolean(button); })()`);
      assert(originalWorkbookOpened, "主界面缺少原始表格入口");
      await waitFor(client, `Boolean(document.querySelector(".original-workbook-dialog[aria-busy='false']")) && document.querySelectorAll(".original-workbook-table-scroll tbody tr").length > 0`, "原始工作簿只读预览", 30_000);
      originalWorkbookState = await evaluate(client, `(() => ({
        fileText: document.querySelector(".original-workbook-dialog>header")?.innerText || "",
        privacyText: document.querySelector(".original-workbook-privacy")?.innerText || "",
        sheetTabs: document.querySelectorAll(".original-workbook-tabs [role='tab']").length,
        visibleRows: document.querySelectorAll(".original-workbook-table-scroll tbody tr").length,
        localStorageContainsFileName: (localStorage.getItem("datacanvas-ai:studio:v1") || "").includes("input.xlsx"),
      }))()`);
      assert(originalWorkbookState.fileText.includes("input.xlsx"), "原始表格预览未显示当前会话文件");
      assert(originalWorkbookState.sheetTabs >= 2 && originalWorkbookState.visibleRows > 0 && originalWorkbookState.visibleRows <= 50, "原始表格工作表或分页行数不正确");
      assert(originalWorkbookState.privacyText.includes("不进入 AI 上下文") && !originalWorkbookState.localStorageContainsFileName, "原始表格越过会话级数据边界");
      await evaluate(client, `document.querySelector('button[aria-label="关闭原始表格"]')?.click()`);
      await waitFor(client, `!document.querySelector(".original-workbook-dialog")`, "关闭原始工作簿预览");
      if (viewportWidth > 960) {
        await evaluate(client, `document.querySelector('button[aria-label="收起侧边栏"]')?.click()`);
        await waitFor(client, `!document.querySelector(".workspace")?.classList.contains("pages-expanded") && document.activeElement?.getAttribute("aria-label") === "打开侧边栏"`, "收起左侧工作区并恢复焦点");
        sidebarState.collapseWorked = true;
      }

      if (viewportWidth <= 1200) {
        responsiveLayout = await evaluate(client, `(() => {
          const bounds = (element) => {
            const rect = element?.getBoundingClientRect();
            return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } : null;
          };
          const overlaps = (left, right) => Boolean(left && right && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top);
          const canvas = document.querySelector(".canvas-design-viewport");
          const switcher = document.querySelector(".eds-canvas-switcher");
          const tabs = switcher?.querySelector('[role="tablist"]')?.getBoundingClientRect();
          const action = switcher?.querySelector(".eds-canvas-ai-action")?.getBoundingClientRect();
          const metricBounds = [...document.querySelectorAll(".dashboard .metric-card")].map(bounds);
          const chartBounds = bounds(document.querySelector(".dashboard .dash-grid .chart-card"));
          const qualityBounds = bounds(document.querySelector(".dashboard .dash-grid .quality-card"));
          const initialScrollLeft = canvas?.scrollLeft || 0;
          if (canvas) canvas.scrollLeft = Math.min(180, canvas.scrollWidth - canvas.clientWidth);
          const movedScrollLeft = canvas?.scrollLeft || 0;
          return {
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            workspaceWidth: document.querySelector(".workspace")?.getBoundingClientRect().width || 0,
            canvasClientWidth: canvas?.clientWidth || 0,
            canvasScrollWidth: canvas?.scrollWidth || 0,
            canvasAriaLabel: canvas?.getAttribute("aria-label") || "",
            initialScrollLeft,
            movedScrollLeft,
            dashboardWidth: document.querySelector(".dashboard")?.getBoundingClientRect().width || 0,
            metricColumns: new Set(metricBounds.map((rect) => Math.round(rect?.left || 0))).size,
            chartQualityOverlap: overlaps(chartBounds, qualityBounds),
            chartQualitySameRow: Boolean(chartBounds && qualityBounds && Math.abs(chartBounds.top - qualityBounds.top) <= 1),
            chartBounds,
            qualityBounds,
            qualityValueOverflow: [...document.querySelectorAll(".dashboard .quality-card li b")].some((element) => element.scrollWidth > element.clientWidth + 1),
            tabs: tabs ? { left: tabs.left, right: tabs.right, top: tabs.top, bottom: tabs.bottom, width: tabs.width } : null,
            action: action ? { left: action.left, right: action.right, top: action.top, bottom: action.bottom, width: action.width } : null,
            sameControlRow: Boolean(tabs && action && (
              Math.abs(tabs.top - action.top) <= 1
              || Math.abs((tabs.top + tabs.bottom) / 2 - (action.top + action.bottom) / 2) <= 1
            )),
            controlsOverlap: Boolean(tabs && action && tabs.left < action.right && tabs.right > action.left && tabs.top < action.bottom && tabs.bottom > action.top),
          };
        })()`);
        assert(responsiveLayout.documentWidth <= responsiveLayout.viewportWidth + 1, "窄桌面布局产生全局横向滚动");
        assert(responsiveLayout.workspaceWidth <= responsiveLayout.viewportWidth + 1, "窄桌面工作区宽度超过视口");
        assert(responsiveLayout.canvasScrollWidth > responsiveLayout.canvasClientWidth, "窄桌面中间画布没有提供横向滚动范围");
        assert(responsiveLayout.canvasAriaLabel === "看板滚动区域", "中间画布横向滚动区域缺少可访问名称");
        assert(responsiveLayout.movedScrollLeft > responsiveLayout.initialScrollLeft, "中间画布无法左右滚动");
        assert(responsiveLayout.dashboardWidth >= 1000, "窄桌面看板仍被压缩而未保留设计宽度");
        assert(responsiveLayout.metricColumns === 4, "窄桌面四项指标被强制重排");
        assert(responsiveLayout.chartQualitySameRow, "窄桌面图表卡与规则卡未保留桌面排列");
        assert(!responsiveLayout.chartQualityOverlap, "窄桌面图表卡与规则卡发生重叠");
        assert(!responsiveLayout.qualityValueOverflow, "窄桌面规则版本文字溢出卡片");
        assert(responsiveLayout.sameControlRow && !responsiveLayout.controlsOverlap, "班次切换与 AI 分析按钮未保持同一工具栏行或发生重叠");
        assert(responsiveLayout.tabs?.width >= 94 && responsiveLayout.action?.width >= 90, "班次或 AI 分析按钮被挤压到不可用宽度");
      }

      await client.send("Page.reload", { ignoreCache: true });
      await waitFor(client, `document.readyState === "complete" && document.body.innerText.includes("飞达异常分析看板") && document.querySelectorAll(".dashboard .table-card tbody tr").length === 24`, "刷新恢复 EDS 看板");
      const restored = await evaluate(client, `({
        mainText: document.querySelector(".dashboard")?.innerText || "",
        navVisible: document.body.innerText.includes("EDS 异常分析"),
        datasetContext: document.querySelector(".context-pill")?.innerText || "",
      })`);
      assert(restored.mainText.includes("4,651") && restored.mainText.includes("231.78"), "刷新后 EDS KPI 未恢复");
      assert(restored.navVisible && restored.datasetContext.includes("EDS 分析总览"), "刷新后 EDS 页面或 AI 数据上下文未恢复");
      if (testConversationScroll) {
        const seeded = await evaluate(client, `(() => {
          const key = "datacanvas-ai:studio:v1";
          const stored = JSON.parse(localStorage.getItem(key));
          stored.assistantConversation = Array.from({ length: 12 }, (_, index) => ({
            id: "browser_scroll_turn_" + index,
            instruction: "第 " + (index + 1) + " 轮测试：检查当前 EDS 看板",
            response: "第 " + (index + 1) + " 轮回复：这是用于验证聊天记录独立滚动的受控测试内容。输入框应始终固定在助手底部。",
            createdAt: new Date(Date.UTC(2026, 8, 5, 6, index, 0)).toISOString(),
            state: "success",
          }));
          stored.assistantConversationInitialized = true;
          localStorage.setItem(key, JSON.stringify(stored));
          location.reload();
          return true;
        })()`);
        assert(seeded, "无法准备 AI 对话滚动验收上下文");
        await waitFor(client, `document.readyState === "complete" && document.querySelectorAll(".conversation-turn").length === 12`, "恢复多轮 AI 对话");
        conversationScrollState = await evaluate(client, `(() => {
          const panel = document.querySelector(".assistant-panel-slot>.right-panel");
          const conversation = panel?.querySelector(".conversation");
          const prompt = panel?.querySelector(".prompt-box");
          if (!panel || !conversation || !prompt) return null;
          const promptBefore = prompt.getBoundingClientRect();
          conversation.scrollTop = conversation.scrollHeight;
          conversation.dispatchEvent(new Event("scroll", { bubbles: true }));
          const bottomScrollTop = conversation.scrollTop;
          conversation.scrollTop = 0;
          conversation.dispatchEvent(new Event("scroll", { bubbles: true }));
          const promptAfter = prompt.getBoundingClientRect();
          return {
            panelOverflowY: getComputedStyle(panel).overflowY,
            conversationOverflowY: getComputedStyle(conversation).overflowY,
            panelScrollTop: panel.scrollTop,
            conversationClientHeight: conversation.clientHeight,
            conversationScrollHeight: conversation.scrollHeight,
            bottomScrollTop,
            topScrollTop: conversation.scrollTop,
            promptTopBefore: promptBefore.top,
            promptTopAfter: promptAfter.top,
            promptBottomBefore: promptBefore.bottom,
            promptBottomAfter: promptAfter.bottom,
          };
        })()`);
        assert(conversationScrollState, "AI 助手缺少独立对话滚动区域");
        assert(conversationScrollState.panelOverflowY === "hidden" && conversationScrollState.panelScrollTop === 0, "AI 助手外层仍可滚动");
        assert(conversationScrollState.conversationOverflowY === "auto" && conversationScrollState.conversationScrollHeight > conversationScrollState.conversationClientHeight, "AI 对话记录没有独立滚动范围");
        assert(conversationScrollState.bottomScrollTop > 0 && conversationScrollState.topScrollTop === 0, "AI 对话记录无法从底部向上滚动");
        assert(Math.abs(conversationScrollState.promptTopBefore - conversationScrollState.promptTopAfter) <= 1 && Math.abs(conversationScrollState.promptBottomBefore - conversationScrollState.promptBottomAfter) <= 1, "滚动聊天记录时底部输入框发生位移");
      }
      if (aiChartPrompt) {
        const promptEntered = await evaluate(client, `(() => {
          const textarea = document.querySelector('textarea[aria-label="AI 指令"]');
          if (!textarea) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setter?.call(textarea, ${JSON.stringify(aiChartPrompt)});
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`);
        assert(promptEntered, "EDS AI 指令输入框不存在");
        await waitFor(client, `(() => {
          const button = document.querySelector('button[aria-label="发送 AI 指令"]');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`, "发送 EDS 图表指令");
        await waitFor(client, `document.querySelector(".harness-task-card summary span.awaitingConfirmation") && document.body.innerText.includes("结构化变更计划")`, "EDS 图表 ChangeSet 待确认", 90_000);
        const beforePreview = await evaluate(client, `({
          error: document.querySelector(".conversation .validation-error")?.innerText || "",
          taskText: document.querySelector(".harness-task-card")?.textContent || "",
          chartCount: document.querySelectorAll(".dashboard .chart-card").length,
          hasChartOperation: document.querySelector(".change-plan")?.innerText.includes("添加组件") || false,
          hasStyleOperation: document.querySelector(".change-plan")?.innerText.includes("修改组件属性") || false,
        })`);
        assert(!beforePreview.error, `EDS 图表 ChangeSet 生成失败：${beforePreview.error}`);
        assert(
          beforePreview.chartCount === 2 && (aiStyleChange ? beforePreview.hasStyleOperation : beforePreview.hasChartOperation),
          aiStyleChange ? "正式页面在预览前被修改，或缺少柱形图颜色更新操作" : "正式页面在预览前被修改，或缺少新增图表操作",
        );
        const previewClicked = await evaluate(client, `(() => {
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "画布预览");
          button?.click();
          return Boolean(button);
        })()`);
        assert(previewClicked, "EDS 图表 ChangeSet 缺少画布预览按钮");
        await waitFor(
          client,
          aiStyleChange
            ? aiValueLabelChange
              ? `document.querySelectorAll(".dashboard .chart-card").length === 2 && document.querySelectorAll(".dashboard .chart-card .bar-value").length > 0`
              : `document.querySelectorAll(".dashboard .chart-card").length === 2 && Boolean(document.querySelector('.dashboard .chart-card[data-chart-color="blue"]'))`
            : aiRequestedChartType
              ? `document.querySelectorAll(".dashboard .chart-card").length === 3 && Boolean(document.querySelector('.dashboard .chart-card[data-chart-type=${JSON.stringify(aiRequestedChartType)}]'))`
              : `document.querySelectorAll(".dashboard .chart-card").length === 3 && document.body.innerText.includes("B5FSL01")`,
          aiStyleChange ? (aiValueLabelChange ? "柱顶数字画布预览" : "蓝色柱形图画布预览") : `${aiRequestedChartType || "B5FSL01"} 图表画布预览`,
        );
        aiChartState = await evaluate(client, `({
          prompt: ${JSON.stringify(aiChartPrompt)},
          changeKind: ${JSON.stringify(aiStyleChange ? "style" : "addChart")},
          taskText: document.querySelector(".harness-task-card")?.textContent || "",
          chartCount: document.querySelectorAll(".dashboard .chart-card").length,
          chartTitles: [...document.querySelectorAll(".dashboard .chart-card .card-head b")].map((item) => item.textContent.trim()),
          chartColors: [...document.querySelectorAll(".dashboard .chart-card")].map((item) => item.getAttribute("data-chart-color")),
          chartTypes: [...document.querySelectorAll(".dashboard .chart-card")].map((item) => item.getAttribute("data-chart-type")),
          valueLabelCount: document.querySelectorAll(".dashboard .chart-card .bar-value").length,
          previewStatus: document.querySelector(".change-plan .plan-head")?.innerText || "",
          applyEnabled: ![...document.querySelectorAll("button")].find((item) => item.textContent.includes("确认并应用"))?.disabled,
        })`);
        assert(
          aiStyleChange
            ? aiValueLabelChange
              ? aiChartState.chartCount === 2 && aiChartState.valueLabelCount > 0
              : aiChartState.chartCount === 2 && aiChartState.chartColors.includes("blue")
            : aiChartState.chartCount === 3 && (aiRequestedChartType
              ? aiChartState.chartTypes.includes(aiRequestedChartType)
              : aiChartState.chartTitles.some((title) => title.includes("B5FSL01"))),
          aiStyleChange ? (aiValueLabelChange ? "画布预览未显示柱顶数字" : "画布预览未把现有柱形图切换为蓝色") : `画布预览未生成${aiRequestedChartType || "B5FSL01"}图表`,
        );
        assert(aiChartState.taskText.includes("数据可视化 v1.0.0"), "Harness 任务没有记录自动加载的数据可视化 Skill");
      }
      if (viewportWidth > 960) {
        await evaluate(client, `document.querySelector('button[aria-label="打开侧边栏"]')?.click()`);
        await waitFor(client, `document.querySelector(".workspace")?.classList.contains("pages-expanded")`, "截图前重新展开左侧工作区");
      } else {
        await evaluate(client, `[...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "页面")?.click()`);
        await waitFor(client, `document.querySelector(".pages-panel-slot")?.classList.contains("open")`, "截图前重新打开窄屏页面抽屉");
      }
      const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
      screenshotBytes = Buffer.from(screenshot.data, "base64");
    } else {
      const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
      screenshotBytes = Buffer.from(screenshot.data, "base64");
      await evaluate(client, `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "重新选择工作簿").click()`);
      await waitFor(client, `!document.querySelector(".eds-result") && document.querySelector(".eds-run-button")?.disabled === true`, "重新选择状态清理");
      resetState = await evaluate(client, `({
        sourceRetained: document.body.innerText.includes("input.xlsx"),
        templateRetained: document.body.innerText.includes("output.xlsx"),
        runDisabled: document.querySelector(".eds-run-button").disabled,
      })`);
      assert(!resetState.sourceRetained && !resetState.templateRetained && resetState.runDisabled, "重新选择后旧文件或运行状态未清理");

      await evaluate(client, `document.querySelector('.eds-dialog button[aria-label="关闭"]').click()`);
      await waitFor(client, `!document.querySelector(".eds-dialog") && document.activeElement?.textContent.trim() === "EDS 分析"`, "关闭后触发按钮回焦");
      focusRestored = await evaluate(client, `document.activeElement?.textContent.trim() === "EDS 分析"`);
      await evaluate(client, `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "EDS 分析").click()`);
      await waitFor(client, `Boolean(document.querySelector(".eds-dialog")) && document.querySelector(".eds-dialog").contains(document.activeElement)`, "重新打开与焦点进入");
      reopenFocusInside = await evaluate(client, `document.querySelector(".eds-dialog").contains(document.activeElement)`);
    }

    const downloadedPath = join(evidenceDir, "EDS-browser-result.xlsx");
    const screenshotPath = join(evidenceDir, "eds-ui-browser-acceptance.png");
    const evidence = {
      generatedAt: new Date().toISOString(),
      baseUrl: baseUrl.href,
      inputs: {
        source: { name: basename(sourcePath), sizeBytes: source.sizeBytes, sha256: source.sha256 },
        ...(templatePath && template ? { template: { name: basename(templatePath), sizeBytes: template.sizeBytes, sha256: template.sha256 } } : {}),
      },
      summary: { inputRows: 4_651, matchedRows: 293, totalOccurrences: 293, totalMinutes: 231.77731666666662, core: "560/560", report: "660/660", mismatchCount: 0, browserMode },
      ui: {
        kpis: result.kpis,
        initialFocusInside,
        defaultSingleFile: defaultState.fileInputs === 1 && !defaultState.hasVisibleAcceptancePicker,
        versionVisible: defaultState.templateVersionVisible && defaultState.ruleVersionVisible,
        chartSections: result.chartSections,
        chartRows: result.chartRows,
        ...(workspaceState ? { workspace: workspaceState } : {
          resetClearedBothFiles: !resetState.sourceRetained && !resetState.templateRetained,
          resetDisabledRun: resetState.runDisabled,
          focusRestored,
          reopenFocusInside,
        }),
        ...(responsiveLayout ? { responsiveLayout } : {}),
        ...(aiChartState ? { aiChart: aiChartState } : {}),
        ...(originalWorkbookState ? { originalWorkbook: originalWorkbookState } : {}),
        ...(sidebarState ? { sidebar: sidebarState } : {}),
        ...(interfaceSwitcherState ? { interfaceSwitcher: interfaceSwitcherState } : {}),
        ...(assistantResizeState ? { assistantResize: assistantResizeState } : {}),
        ...(conversationScrollState ? { conversationScroll: conversationScrollState } : {}),
      },
      download: {
        status: download.status,
        contentType: download.contentType,
        contentLength: download.contentLength === null ? null : Number(download.contentLength),
        disposition: download.disposition,
        sizeBytes: downloadedBytes.byteLength,
        sha256: createHash("sha256").update(downloadedBytes).digest("hex").toUpperCase(),
        artifact: basename(downloadedPath),
      },
      independentComparison,
      screenshot: {
        artifact: basename(screenshotPath),
        sizeBytes: screenshotBytes.byteLength,
        sha256: createHash("sha256").update(screenshotBytes).digest("hex").toUpperCase(),
      },
    };
    assertPortableEvidence(evidence);
    await publishEvidenceAtomically({ evidenceDir, downloadedBytes, screenshotBytes, evidence });
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    client.close();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) await main();
