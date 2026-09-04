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
    selector: 'input[type="file"]',
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
  assert(browserMode === "standard" || browserMode === "acceptance", "EDS_BROWSER_MODE 只能是 standard 或 acceptance");
  const templatePath = browserMode === "acceptance" ? requiredEnvironmentPath("EDS_REAL_TEMPLATE_PATH") : null;
  const evidenceDir = requiredEnvironmentPath("EDS_BROWSER_EVIDENCE_DIR");
  if (existsSync(evidenceDir)) throw new Error("EDS_BROWSER_EVIDENCE_DIR 已存在，拒绝覆盖");
  const evidenceParent = dirname(evidenceDir);
  const parentMetadata = await stat(evidenceParent);
  if (!parentMetadata.isDirectory()) throw new Error("EDS_BROWSER_EVIDENCE_DIR 的父路径不是目录");
  await access(evidenceParent);
  const baseUrl = loopbackUrl("EDS_BROWSER_BASE_URL", process.env.EDS_BROWSER_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const cdpUrl = loopbackUrl("EDS_BROWSER_CDP_URL", process.env.EDS_BROWSER_CDP_URL?.trim() || DEFAULT_CDP_URL);
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
        width: 1440,
        height: 1100,
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
    const opened = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "EDS 分析"); button?.click(); return Boolean(button); })()`);
    assert(opened, "无法点击 EDS 分析入口");
    await waitFor(client, `Boolean(document.querySelector(".eds-dialog"))`, "EDS 对话框打开");
    const initialFocusInside = await evaluate(client, `document.querySelector(".eds-dialog").contains(document.activeElement)`);
    assert(initialFocusInside, "EDS 对话框打开后焦点未进入模态框");
    const defaultState = await evaluate(client, `({
      fileInputs: document.querySelectorAll('input[type="file"]').length,
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
      await waitFor(client, `document.querySelectorAll('input[type="file"]').length === 2 && document.body.innerText.includes("验收基准（可选）")`, "高级验收入口展开");
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
    if (createWorkspace) {
      const created = await evaluate(client, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "生成 EDS 演示看板"); button?.click(); return Boolean(button); })()`);
      assert(created, "结果页缺少生成 EDS 演示看板动作");
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
          storedPage: stored?.appSpec?.pages?.some((page) => page.id === "page_eds_analysis"),
          storedSources: stored?.appSpec?.dataSources?.filter((source) => source.id === "dataset_eds_overview" || source.id === "dataset_eds_breakdown").length,
          auditHasSummary: auditText.includes("派生汇总（不含原始行）") && auditText.includes("异常293次") && auditText.includes("EDS-REPORT-2026.09"),
          containsRawFileName: serialized.includes("input.xlsx") || serialized.includes("output.xlsx"),
          containsDownloadToken: serialized.includes("/api/exports/") || serialized.includes("exportArtifact") || serialized.includes("sourceSheets"),
        };
      })()`);
      assert(workspaceState.mainText.includes("4,651") && workspaceState.mainText.includes("293") && workspaceState.mainText.includes("231.78"), "主看板缺少真实 EDS KPI");
      assert(workspaceState.metricCards === 4 && workspaceState.charts === 2 && workspaceState.tableRows === 24, "主看板组件或汇总行数量不正确");
      assert(workspaceState.storedVersion === 3 && workspaceState.storedInputRows === 4_651 && workspaceState.storedOccurrences === 293, "localStorage 未保存受控 EDS 汇总");
      assert(workspaceState.storedBreakdowns === 24 && workspaceState.storedPage && workspaceState.storedSources === 2, "localStorage 缺少 EDS 页面或数据源");
      assert(workspaceState.auditHasSummary, "审计正文缺少 EDS 派生汇总或版本");
      assert(!workspaceState.containsRawFileName && !workspaceState.containsDownloadToken, "localStorage 泄漏了原始文件名、下载令牌或原始表目录");

      await client.send("Page.reload", { ignoreCache: true });
      await waitFor(client, `document.readyState === "complete" && document.body.innerText.includes("飞达异常分析看板") && document.querySelectorAll(".dashboard .table-card tbody tr").length === 24`, "刷新恢复 EDS 看板");
      const restored = await evaluate(client, `({
        mainText: document.querySelector(".dashboard")?.innerText || "",
        navVisible: document.body.innerText.includes("EDS 异常分析"),
        datasetContext: document.querySelector(".context-pill")?.innerText || "",
      })`);
      assert(restored.mainText.includes("4,651") && restored.mainText.includes("231.78"), "刷新后 EDS KPI 未恢复");
      assert(restored.navVisible && restored.datasetContext.includes("EDS 分析总览"), "刷新后 EDS 页面或 AI 数据上下文未恢复");
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
