import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  browser.unref();
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地服务提前退出，代码 ${child.exitCode}。`);
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

await mkdir(dataRoot, { recursive: true });
const port = await choosePort();
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [serverEntry], {
  cwd: appRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    STUDIO_LOCAL_STATE_DIR: dataRoot,
    HARNESS_VISUAL_VERIFICATION_ENABLED: "0",
  },
  stdio: "inherit",
  windowsHide: false,
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", () => { if (child.exitCode === null) child.kill("SIGTERM"); });

try {
  await waitUntilReady(url, child);
  console.log(`\nAgentCanvas 已启动：${url}`);
  console.log("请在右侧 AI 助手标题栏点击“API”配置密钥。");
  console.log("请保留此窗口；关闭窗口即可停止本地服务。\n");
  if (shouldOpenBrowser) openBrowser(url);
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
  process.exitCode = exitCode;
} catch (error) {
  stop();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
