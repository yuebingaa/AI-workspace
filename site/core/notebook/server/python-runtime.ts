import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Browser } from "playwright-core";
import { z } from "zod";
import { notebookSqlTableSchema, notebookTableSchema } from "../contracts";
import type { NotebookPythonSession } from "../execution-contracts";
import { PYTHON_CELL_PROGRAM } from "./python-program";

const ORIGIN = "https://notebook-python.invalid";
const MAX_BYTES = 16 * 1024 * 1024;
const resultSchema = z.object({ table: notebookTableSchema.extend({ rows: notebookSqlTableSchema.shape.rows }),
  stdout: z.string().max(2000), stderr: z.string().max(2000) }).strict();
const manifestSchema = z.object({ version: z.string(), pythonVersion: z.string(), pureWheels: z.array(z.string()),
  packages: z.record(z.string(), z.string()), files: z.record(z.string(), z.object({ sha256: z.string(), bytes: z.number(), url: z.string() })) });
type RuntimeManifest = z.infer<typeof manifestSchema>;
// Browser globals exist only in the isolated page, and contain no host callbacks.
interface PythonVm {
  loadPackage(names: string | string[]): Promise<void>;
  runPython(code: string): unknown;
  globals: { set(name: string, value: string): void };
  FS: { mkdirTree(path: string): void; writeFile(path: string, bytes: Uint8Array): void };
}
type VmPage = { loadPyodide(options: { indexURL: string }): Promise<PythonVm>; __python: PythonVm };
const PLAYWRIGHT_MODULE = "playwright-core";
async function loadChromium() {
  // The Node runtime is copied separately; bundling pulls optional browser backends into the worker build.
  return (await import(/* @vite-ignore */ PLAYWRIGHT_MODULE) as typeof import("playwright-core")).chromium;
}

function browserPath(chromium: Awaited<ReturnType<typeof loadChromium>>) {
  const choices = [process.env.NOTEBOOK_PYTHON_BROWSER, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    chromium.executablePath()];
  return choices.find((path) => path && existsSync(path));
}
async function manifest(): Promise<RuntimeManifest> {
  try { return manifestSchema.parse(JSON.parse(await readFile(resolve("vendor/python/runtime-lock.json"), "utf8"))); }
  catch { throw new Error("Python 运行环境尚未安装，请在网站目录执行 npm run python:setup 后重试"); }
}
export async function notebookPythonRuntimeInfo() {
  const configuration = await manifest().catch(() => null);
  const chromium = await loadChromium().catch(() => null);
  const executablePath = chromium ? browserPath(chromium) : undefined;
  const intact = configuration && (await Promise.all(Object.entries(configuration.files).map(async ([name, entry]) => {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name)) return false;
    const bytes = await readFile(join(resolve("vendor/python"), name)).catch(() => null);
    return bytes?.length === entry.bytes && createHash("sha256").update(bytes).digest("hex") === entry.sha256;
  }))).every(Boolean);
  return { engine: "pyodide", available: Boolean(intact && executablePath),
    pythonVersion: configuration?.pythonVersion ?? null, packages: configuration?.packages ?? {},
    limits: { cellTimeoutMs: 10_000, inputBytes: MAX_BYTES, resultRows: 50_000, resultColumns: 30 },
    execution: "每次 Notebook 运行独立；只共享显式输入 / 输出 DataFrame；无网络或主机文件挂载",
    ...(!intact ? { reason: "Python 资源缺失或校验失败，请在网站目录运行 npm run python:setup" }
      : !chromium ? { reason: "缺少 playwright-core 执行依赖，请重新安装网站依赖或重新构建完整产物" }
      : !executablePath ? { reason: "需要 Microsoft Edge / Chromium，可用 NOTEBOOK_PYTHON_BROWSER 指定路径" } : {}) };
}

let activeSessions = 0;
export async function createNotebookPythonSession(signal: AbortSignal): Promise<NotebookPythonSession> {
  signal.throwIfAborted();
  if (activeSessions >= 2) throw new Error("已有两个 Python 分析运行中，请稍后重试");
  activeSessions += 1;
  let browser: Browser | undefined;
  let released = false;
  const close = async () => {
    if (released) return;
    released = true; activeSessions -= 1;
    signal.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  };
  const onAbort = () => { void close(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const config = await manifest();
    const chromium = await loadChromium();
    const executablePath = browserPath(chromium);
    if (!executablePath) throw new Error("Python 执行需要 Microsoft Edge / Chromium；请安装浏览器或设置 NOTEBOOK_PYTHON_BROWSER");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
      && /^(?:SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/iu.test(key))) as Record<string, string>;
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15_000, env,
      args: ["--disable-background-networking", "--disable-extensions", "--disable-breakpad", "--disable-component-update",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--host-resolver-rules=MAP * ~NOTFOUND",
        "--js-flags=--max-old-space-size=256 --wasm-max-mem-pages=8192"] });
    if (released || signal.aborted) { await browser.close(); signal.throwIfAborted(); throw new Error("Python 会话已关闭"); }
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    let sealed = false;
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (sealed || url.origin !== ORIGIN || route.request().method() !== "GET") return route.abort("blockedbyclient");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Python</title>", headers: {
        "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
      } });
      const name = url.pathname.slice(1);
      const entry = config.files[name];
      if (!entry || !/^[A-Za-z0-9_.-]+$/u.test(name)) return route.abort("blockedbyclient");
      const bytes = await readFile(join(resolve("vendor/python"), name)).catch(() => null);
      if (!bytes || bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return route.abort("failed");
      await route.fulfill({ body: bytes, contentType: name.endsWith(".js") || name.endsWith(".mjs") ? "text/javascript"
        : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream" });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(ORIGIN);
    await page.addScriptTag({ url: `${ORIGIN}/pyodide.js` });
    await page.evaluate(async ({ origin, wheels, program }) => {
      const host = globalThis as unknown as VmPage;
      const vm = host.__python = await host.loadPyodide({ indexURL: origin + "/" });
      await vm.loadPackage(["numpy", "pandas"]);
      for (const wheel of wheels) await vm.loadPackage(`${origin}/${wheel}`);
      vm.runPython(program);
    }, { origin: ORIGIN, wheels: config.pureWheels, program: PYTHON_CELL_PROGRAM });
    sealed = true;
    await context.setOffline(true);
    signal.throwIfAborted();
    return {
      close,
      async execute(input, executionSignal) {
        executionSignal.throwIfAborted();
        if (released) throw new Error("Python 会话已结束，请重新运行 Notebook");
        const tables = input.tables.map((table) => notebookSqlTableSchema.parse(table));
        if (new Set(tables.map((table) => table.name)).size !== tables.length) throw new Error("Python 输入变量名不能重复");
        if (tables.some((table) => ["pd", "np", "files"].includes(table.name)) || ["pd", "np", "files"].includes(input.outputName)) {
          throw new Error("pd、np、files 是 Python 预置变量，请换一个输入或输出表名");
        }
        const names = new Set<string>();
        const files = input.files.map((file) => {
          if (!/^[^\\/\u0000-\u001f]+\.(xlsx|csv)$/iu.test(file.name) || file.name.length > 180 || names.has(file.name)) throw new Error("Python 输入文件名无效或重复");
          names.add(file.name); return { name: file.name, base64: Buffer.from(file.bytes).toString("base64") };
        });
        const payload = JSON.stringify({ code: input.code, outputName: input.outputName, tables, files });
        if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Python 输入超过 16 MiB，请先筛选数据");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { void close(); };
        executionSignal.addEventListener("abort", abort, { once: true });
        try {
          const computation = page.evaluate(({ code, outputName, tables, files }) => {
            const vm = (globalThis as unknown as VmPage).__python;
            vm.FS.mkdirTree("/inputs");
            const mounted: Record<string, string> = {};
            for (const file of files) {
              const path = "/inputs/" + file.name;
              vm.FS.writeFile(path, Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)));
              mounted[file.name] = path;
            }
            vm.globals.set("_ac_payload", JSON.stringify({ code, outputName, tables, files: mounted }));
            return vm.runPython("_ac_run_cell(_ac_payload)") as string;
          }, { code: input.code, outputName: input.outputName, tables, files });
          const serialized = await Promise.race([computation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => { void close(); reject(new Error("Python 单元运行超过 10 秒，已终止本次执行；请简化计算后重跑")); }, 10_000);
          })]);
          executionSignal.throwIfAborted();
          if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Python 返回结果超过 16 MiB");
          const result = JSON.parse(serialized);
          if (typeof result.error === "string") throw Object.assign(new Error(result.error.slice(0, 900)),
            { stdout: String(result.stdout ?? "").slice(0, 2000), stderr: String(result.stderr ?? "").slice(0, 2000) });
          return resultSchema.parse(result);
        } finally {
          if (timer) clearTimeout(timer);
          executionSignal.removeEventListener("abort", abort);
        }
      },
    };
  } catch (error) {
    await close();
    if (signal.aborted) throw new Error("Python 运行已取消或超时");
    throw error;
  }
}
