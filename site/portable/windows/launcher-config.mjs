import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Portable-only deployment configuration. No host SDK, browser or npm fallback. */
export function portableEnvironment(root, port, inherited = process.env) {
  const clean = { ...inherited };
  // Environment names are case-insensitive on Windows.
  for (const key of Object.keys(clean)) if (["NODE_PATH", "NODE_OPTIONS"].includes(key.toUpperCase())) delete clean[key];
  return { ...clean,
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
    STUDIO_LOCAL_STATE_DIR: join(root, "data", "state"),
    HARNESS_VISUAL_VERIFICATION_ENABLED: "0",
    AGENTCANVAS_DEFAULT_ENGINE: "dsh",
    NOTEBOOK_PYTHON_ENABLED: "true",
    NOTEBOOK_PYTHON_BROWSER: join(root, "runtime", "browser", "chrome-headless-shell.exe"),
  };
}

export async function verifyPortableRuntime(root) {
  if (process.platform !== "win32" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("本完整包需要 Windows x64 和随包提供的 Node.js 24，请使用 Start-AgentCanvas.cmd 启动。");
  }
  for (const path of [join(root, "app", "server.js"),
    join(root, "runtime", "browser", "chrome-headless-shell.exe"),
    join(root, "app", "vendor", "python", "pyodide.js")]) {
    try { await access(path); } catch { throw new Error("完整包缺少网站或 Python 运行资源，请重新完整解压，不要单独移动文件。"); }
  }
  const driver = await import(pathToFileURL(join(root, "app", "runtime", "dsh", "driver.mjs")).href);
  const readiness = await driver.inspectDshRuntime();
  if (!readiness.available) throw new Error(`DSH 随包依赖检查失败（${readiness.phase}/${readiness.code}），请重新完整解压。`);
}
