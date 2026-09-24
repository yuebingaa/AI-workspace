import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portableEnvironment, verifyPortableRuntime } from "./launcher-config.mjs";

const portableRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = join(portableRoot, "app");
const serverEntry = join(appRoot, "server.js");
const dataRoot = join(portableRoot, "data", "state");
const preferredPort = 3210;
const shouldOpenBrowser = !process.argv.includes("--no-browser");

async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function choosePort() {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`端口 ${preferredPort}–${preferredPort + 19} 均被占用。`);
}

function openBrowser(url) {
  const browser = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.once("error", () => console.log(`无法自动打开浏览器，请手动访问 ${url}`));
  browser.unref();
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error("本地服务提前退出，请查看启动错误。");
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("本地服务在 45 秒内未能启动。");
}

try { await verifyPortableRuntime(portableRoot); }
catch (error) {
  console.error(error instanceof Error ? error.message : "完整包运行环境检查失败。");
  if (process.connected) process.disconnect();
  process.exit(1);
}
await mkdir(dataRoot, { recursive: true });
const port = await choosePort();
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [serverEntry], {
  cwd: appRoot,
  env: portableEnvironment(portableRoot, port),
  stdio: "inherit",
  windowsHide: false,
});
// Register before health probing: an early exit must never leave the launcher waiting.
const childResult = new Promise((resolve) => {
  child.once("exit", (code) => resolve(code ?? 1));
  child.once("error", () => resolve(1));
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  // Windows SIGTERM force-kills only one process. Target the child we created,
  // including its task-owned SDK/browser descendants; never kill by process name.
  if (process.platform === "win32") {
    const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    if (result.status !== 0) {
      console.error("停止进程树未得到成功回执，尝试结束本次网站进程；请检查是否有未退出的本包任务。");
      child.kill("SIGTERM");
    }
  } else child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
if (process.platform === "win32") process.once("SIGBREAK", stop);
// Optional parent IPC is for the isolated acceptance runner, never an HTTP API.
process.on("message", (message) => { if (message?.type === "shutdown") stop(); });
process.once("disconnect", stop);
process.once("exit", stop);

try {
  await waitUntilReady(url, child);
  console.log(`\nAgentCanvas 已启动：${url}`);
  console.log("完整包已启用 DSH；请在设置中的 AI 接口配置中填写自己的 DeepSeek 密钥。");
  console.log("请保留此窗口；关闭窗口即可停止本地服务。\n");
  process.send?.({ type: "ready", url, serverPid: child.pid });
  if (shouldOpenBrowser) openBrowser(url);
  const code = await childResult;
  process.exitCode = stopping ? 0 : code;
} catch (error) {
  stop();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stop();
  await childResult;
  if (process.connected) process.disconnect();
}
