import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const port = Number(process.env.HARNESS_PLAYWRIGHT_CAPTURE_PORT || 3198);
const maxRequestBytes = 32 * 1024;
const maxScreenshotBytes = 8 * 1024 * 1024;

function localUrl(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label}地址无效。`); }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol)
    || !(host === "localhost" || host === "::1" || host.startsWith("127."))
    || url.username || url.password) {
    throw new Error(`${label}只允许本机 loopback 地址。`);
  }
  url.hash = "";
  return url;
}

function requestOptions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("截图请求格式无效。");
  const baseUrl = localUrl(raw.baseUrl, "截图页面");
  const timeoutMs = Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) throw new Error("截图超时范围无效。");
  if (!Array.isArray(raw.viewports) || raw.viewports.length < 1 || raw.viewports.length > 3) throw new Error("截图视口数量无效。");
  const viewports = raw.viewports.map((viewport) => {
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (!Number.isInteger(width) || width < 320 || width > 3_840
      || !Number.isInteger(height) || height < 480 || height > 2_160) throw new Error("截图视口尺寸无效。");
    return { width, height };
  });
  const executablePath = typeof raw.executablePath === "string" && raw.executablePath.length <= 500
    && /(?:msedge|chrome)\.exe$/iu.test(raw.executablePath)
    ? raw.executablePath
    : undefined;
  return { baseUrl, timeoutMs, viewports, executablePath };
}

function unique(values, limit = 12) {
  return [...new Set(values)].slice(0, limit);
}

async function captureScreenshots(options, signal) {
  const browser = await chromium.launch({
    headless: true,
    ...(options.executablePath ? { executablePath: options.executablePath } : { channel: "msedge" }),
  });
  const abortBrowser = () => { void browser.close().catch(() => undefined); };
  signal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const captures = [];
    for (const viewport of options.viewports) {
      if (signal.aborted) throw new Error("截图请求已取消。");
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "light" });
      try {
        await context.route("**/*", async (route) => {
          const target = new URL(route.request().url());
          if (["data:", "blob:"].includes(target.protocol) || target.origin === options.baseUrl.origin) await route.continue();
          else await route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        const consoleErrors = [];
        const consoleWarnings = [];
        const failedRequests = [];
        page.on("console", (message) => {
          const text = message.text().replace(/\s+/gu, " ").trim().slice(0, 360);
          if (message.type() === "error") consoleErrors.push(text);
          else if (message.type() === "warning") consoleWarnings.push(text);
        });
        page.on("pageerror", (error) => consoleErrors.push(error.message.replace(/\s+/gu, " ").trim().slice(0, 360)));
        page.on("requestfailed", (request) => {
          try {
            const target = new URL(request.url());
            if (target.origin === options.baseUrl.origin) failedRequests.push(`${target.pathname}: ${request.failure()?.errorText ?? "请求失败"}`.slice(0, 360));
          } catch { /* malformed browser diagnostics are ignored */ }
        });
        await page.goto(options.baseUrl.href, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
        await page.locator(".workspace").first().waitFor({ state: "visible", timeout: Math.min(options.timeoutMs, 12_000) });
        await page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs, 12_000) }).catch(() => undefined);
        await page.evaluate(async () => { await document.fonts?.ready; });
        const observedPage = await page.evaluate((currentViewport) => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
              && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
              && rect.top < innerHeight && rect.left < innerWidth;
          };
          const label = (element) => (element.getAttribute("aria-label")
            || element.getAttribute("title")
            || element.getAttribute("placeholder")
            || element.innerText
            || element.textContent
            || element.tagName).replace(/\s+/gu, " ").trim().slice(0, 160);
          const landmarks = [...document.querySelectorAll("header,nav,main,aside,footer,[role]")]
            .filter(visible).slice(0, 40).map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                ...(element.getAttribute("role") ? { role: element.getAttribute("role") } : {}),
                label: label(element),
                left: Math.round(rect.left), top: Math.round(rect.top),
                width: Math.round(rect.width), height: Math.round(rect.height),
              };
            });
          const controls = [...document.querySelectorAll("button,a[href],input,textarea,select,[role='button'],[tabindex]")]
            .filter(visible).slice(0, 80).map((element) => {
              const rect = element.getBoundingClientRect();
              const disabled = element.disabled === true || element.getAttribute("aria-disabled") === "true";
              const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
              const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
              const hit = document.elementFromPoint(x, y);
              const reachable = Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
              return { label: label(element), tag: element.tagName.toLowerCase(), status: disabled ? "disabled" : reachable ? "reachable" : "occluded" };
            });
          return {
            viewport: currentViewport,
            pageTitle: document.title.slice(0, 200),
            pageUrl: location.href,
            dom: { visibleText: (document.body.innerText || "").replace(/\s+/gu, " ").trim().slice(0, 4_000), landmarkCount: landmarks.length, landmarks },
            interactions: {
              checked: controls.length,
              reachable: controls.filter((control) => control.status === "reachable").length,
              disabled: controls.filter((control) => control.status === "disabled").length,
              occluded: controls.filter((control) => control.status === "occluded").length,
              samples: controls.slice(0, 30),
            },
          };
        }, viewport);
        const browserObservation = {
          ...observedPage,
          console: { errors: unique(consoleErrors), warnings: unique(consoleWarnings), failedRequests: unique(failedRequests) },
        };
        const capturePosition = async (position) => {
          const layout = await page.evaluate((captureAt) => {
            const root = document.documentElement;
            const canvas = document.querySelector(".canvas-design-viewport");
            const assistant = document.querySelector(".assistant-panel-slot");
            if (canvas && captureAt === "horizontalEnd") canvas.scrollLeft = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
            const canvasRect = canvas?.getBoundingClientRect();
            const assistantRect = assistant?.getBoundingClientRect();
            const assistantStyle = assistant ? getComputedStyle(assistant) : undefined;
            const assistantVisible = Boolean(assistantRect && assistantStyle?.display !== "none" && assistantStyle?.visibility !== "hidden"
              && assistantRect.right > 0 && assistantRect.left < innerWidth && assistantRect.bottom > 0 && assistantRect.top < innerHeight);
            const overlapWidth = canvasRect && assistantRect
              ? Math.max(0, Math.min(canvasRect.right, assistantRect.right) - Math.max(canvasRect.left, assistantRect.left)) : 0;
            return {
              documentClientWidth: root.clientWidth,
              documentScrollWidth: root.scrollWidth,
              canvasClientWidth: canvas?.clientWidth ?? 0,
              canvasScrollWidth: canvas?.scrollWidth ?? 0,
              canvasScrollLeft: Math.round(canvas?.scrollLeft ?? 0),
              ...(canvasRect ? { canvasViewportLeft: Math.round(canvasRect.left), canvasViewportRight: Math.round(canvasRect.right) } : {}),
              ...(assistantRect ? {
                assistantPanelLeft: Math.round(assistantRect.left), assistantPanelRight: Math.round(assistantRect.right),
                assistantOverlapsCanvas: assistantVisible && overlapWidth > 1,
              } : {}),
            };
          }, position);
          if (position === "horizontalEnd") await page.waitForTimeout(100);
          const bytes = await page.screenshot({ type: "jpeg", quality: 84, fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
          if (bytes.byteLength < 1 || bytes.byteLength > maxScreenshotBytes) throw new Error("Playwright 截图为空或超过 8 MiB 限制。");
          captures.push({
            imageBase64: bytes.toString("base64"),
            ...(position === "initial" ? { browserObservation } : {}),
            evidence: {
              viewport, capturePosition: position, layout, pageUrl: options.baseUrl.href,
              mimeType: "image/jpeg", byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          });
          return layout;
        };
        const initialLayout = await capturePosition("initial");
        if (initialLayout.canvasScrollWidth > initialLayout.canvasClientWidth + 1) await capturePosition("horizontalEnd");
      } finally {
        await context.close();
      }
    }
    return captures;
  } finally {
    signal.removeEventListener("abort", abortBrowser);
    await browser.close().catch(() => undefined);
  }
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

const server = createServer((request, response) => {
  if (request.headers.origin) return send(response, 403, { error: "浏览器跨域请求不允许访问截图服务。" });
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok" });
  if (request.method !== "POST" || request.url !== "/capture") return send(response, 404, { error: "not_found" });
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size <= maxRequestBytes) chunks.push(chunk);
    else request.destroy(new Error("request_too_large"));
  });
  request.on("end", async () => {
    const controller = new AbortController();
    let timer;
    try {
      const options = requestOptions(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      timer = setTimeout(() => controller.abort(), options.timeoutMs);
      const captures = await captureScreenshots(options, controller.signal);
      send(response, 200, { captures });
    } catch (error) {
      send(response, 503, { error: error instanceof Error ? error.message.slice(0, 300) : "截图服务失败。" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`Playwright capture service: http://127.0.0.1:${port}/capture`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
