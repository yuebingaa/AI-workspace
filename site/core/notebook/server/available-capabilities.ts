import { closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { NotebookCapabilities } from "../capabilities";
import { notebookCapabilitiesFromEnvironment, type NotebookCapabilityEnvironment } from "./capabilities";

function unavailable(reason: string): NotebookCapabilities {
  return Object.freeze({ python: Object.freeze({ enabled: false, reason }) });
}
function inspectMarker(path: string): "valid" | "not-file" | "changed" {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) return "not-file";
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    return opened.isFile() && opened.dev === before.dev && opened.ino === before.ino ? "valid" : "changed";
  } finally { closeSync(descriptor); }
}

/**
 * Deployment composition, not a request override. Presence of this readable
 * marker only enables further runtime checks; it does not verify asset hashes,
 * SDK installation or a usable browser. No Python asset content is read here.
 */
export function getNotebookCapabilities(options: {
  environment?: NotebookCapabilityEnvironment;
  rootDirectory?: string;
} = {}): NotebookCapabilities {
  const configured = notebookCapabilitiesFromEnvironment(options.environment);
  if (!configured.python.enabled) return configured;
  const path = resolve(options.rootDirectory ?? process.cwd(), "vendor/python/runtime-lock.json");
  try {
    const status = inspectMarker(path);
    if (status === "not-file") {
      return unavailable("Python 资源标记不是普通文件，能力暂不可用；请检查安装或重新构建包含 Python 的产物。原 Python 定义已保留。");
    }
    if (status === "changed") {
      return unavailable("Python 资源标记在检查时发生变化，能力暂不可用；请完成安装后重试。原 Python 定义已保留。");
    }
    return configured;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return unavailable(code === "ENOENT" || code === "ENOTDIR"
      ? "当前安装未包含 Python 资源，Python 能力暂不可用；请安装 Python 资源或使用包含 Python 的完整产物。原 Python 定义已保留。"
      : "Python 资源标记无法读取，能力暂不可用；请检查文件权限或安装状态后重试。原 Python 定义已保留。");
  }
}
