import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { BUNDLED_OMITTED_PACKAGES } from "../runtime/dsh/installation.mjs";

// The complete, unpruned SDK has a measured 199-character archive path.
// Keep a finite Windows-compatible ceiling; extract under a short directory.
export const MAX_ARCHIVE_PATH = 210;
export const MAX_UNCOMPRESSED_BYTES = 1536 * 1024 * 1024;
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024 - 1;
export const DSH_CARRIER_FILES = Object.freeze([
  "controlled-plugin.mjs", "driver.mjs", "installation.mjs", "policy.mjs",
  "tool-diagnostics.mjs", "wire-policy.mjs",
]);
export const COMPLETE_REQUIRED_FILES = Object.freeze([
  "Start-AgentCanvas.cmd", "launcher.mjs", "launcher-config.mjs", "portable-manifest.json", "runtime/node.exe", "app/server.js",
  "runtime/browser/chrome-headless-shell.exe", "runtime/browser/LICENSE.headless_shell", "runtime/browser/ABOUT",
  "licenses/Node-LICENSE.txt", "licenses/dependency-sources.json", "licenses/third-party-index.json",
  "licenses/CPython-LICENSE.txt", "licenses/Python-SOURCES.txt", "app/vendor/python/pyodide-LICENSE",
  "app/.runtime/dsh-runtime-active.json", "app/.runtime/dsh-bundled/package.json",
  "app/.runtime/dsh-bundled/package-lock.json", "app/vendor/python/runtime-lock.json",
  "app/.runtime/dsh-bundled/bundle-profile.json",
  "app/vendor/python/pyodide.js", "app/vendor/python/pyodide.asm.mjs", "app/vendor/python/pyodide.asm.wasm",
  "app/vendor/python/python_stdlib.zip", "app/vendor/notebook/query-worker.cjs", "app/vendor/notebook/duckdb-eh.wasm",
  ...DSH_CARRIER_FILES.map((name) => `app/runtime/dsh/${name}`),
]);

export function assertBuildRuntime(runtime = process) {
  if (runtime.platform !== "win32" || runtime.arch !== "x64" || !/^v24\./u.test(runtime.version)) {
    throw new Error("完整便携包必须使用 Windows x64 / Node.js 24 构建。");
  }
}

export async function verifyPinnedBrowser(root, descriptor) {
  // This reviewed binary came from the existing Playwright lock's official
  // download. A caller-supplied folder must not silently claim another version.
  if (descriptor?.browserVersion !== "151.0.7922.34" || String(descriptor?.revision) !== "1234") {
    throw new Error("Chromium 锁定版本变化，需要重新审核浏览器分发资源。");
  }
  if (await fileSha256(join(root, "chrome-headless-shell.exe")) !== "ce4635cd0e5dc0e21494542a701f347e91c1f1d821970578d97ed8df4ced50ef") {
    throw new Error("Chromium 可执行文件与已审核的锁定资源不一致。");
  }
}

export function validateArchiveName(name) {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!path.startsWith("AgentCanvas/") && path !== "AgentCanvas") throw new Error(`ZIP 路径必须位于 AgentCanvas 内：${name}`);
  if (name.length > MAX_ARCHIVE_PATH) throw new Error(`ZIP 路径过长：${name}`);
  for (const part of path.split("/")) {
    if (!part || /[\\<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      throw new Error(`ZIP 包含不兼容的 Windows 路径：${name}`);
    }
    if (/^(\.env(?:\..*)?|\.git|\.studio-data|\.npmrc|\.netrc|\.aws|\.ssh)$/iu.test(part)
      || /^(credentials|secrets)\.(json|ya?ml)$/iu.test(part)) {
      throw new Error(`不能打包私有配置或状态目录：${name}`);
    }
  }
  if (/^AgentCanvas\/data(?:\/|$)/iu.test(path)) throw new Error("不能打包已经运行产生的 data 目录，请使用未运行的发布目录。");
  if (/^AgentCanvas\/app\/\.runtime(?:\/|$)/iu.test(path)
    && !/^AgentCanvas\/app\/\.runtime(?:\/?$|\/dsh-bundled(?:\/|$)|\/dsh-runtime-active\.json$)/u.test(path)) {
    throw new Error(`不能打包 DSH 会话、安装历史或其他本机运行状态：${name}`);
  }
  return name;
}

export async function inspectDistributionTree(root, archivePrefix = "AgentCanvas") {
  const entries = [];
  const seen = new Set();
  let totalBytes = 0;
  let longestPath = "";
  async function walk(diskPath, archivePath) {
    const info = await lstat(diskPath);
    if (info.isSymbolicLink()) throw new Error(`便携包不能包含符号链接：${archivePath}`);
    const directory = info.isDirectory();
    if (!directory && !info.isFile()) throw new Error(`便携包包含非普通文件：${archivePath}`);
    const name = validateArchiveName(archivePath + (directory ? "/" : ""));
    const key = archivePath.toLowerCase();
    if (seen.has(key)) throw new Error(`ZIP 路径大小写冲突：${archivePath}`);
    seen.add(key);
    if (seen.size >= 65_535) throw new Error("便携包文件数超出普通 ZIP 范围。");
    if (name.length > longestPath.length) longestPath = name;
    if (!directory) totalBytes += info.size;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("完整便携包超过 1.5 GiB，请检查发布目录内容。");
    entries.push({ diskPath, name, directory, size: info.size, mtime: info.mtime });
    if (directory) for (const child of (await readdir(diskPath)).sort()) await walk(join(diskPath, child), `${archivePath}/${child}`);
  }
  await walk(root, archivePrefix);
  return { entries, totalBytes, longestPath, maxArchiveRelativePathChars: longestPath.length };
}

export async function copyPlainTree(source, target, archivePrefix) {
  // Inspect before copying; cp must never dereference an untrusted nested link.
  await inspectDistributionTree(source, archivePrefix);
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
}

export async function copyControlledDshDependencies(source, target) {
  // Audit the complete source before applying the exact, reviewed omissions.
  // No generic pruning (tests/maps/platforms/nested versions) is permitted.
  await inspectDistributionTree(source, "AgentCanvas/app/.runtime/dsh-bundled/node_modules");
  const omitted = new Set(BUNDLED_OMITTED_PACKAGES);
  await cp(source, target, {
    recursive: true, force: false, errorOnExist: true,
    filter: (path) => !omitted.has(relative(source, path).replaceAll("\\", "/")),
  });
}

export async function fetchLicenseText(url, { sha256, startsWith, minimumLength = 0 }, fetcher = fetch) {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("无法取得匹配版本的第三方许可证。");
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  if (bytes.length < minimumLength || (startsWith && !text.startsWith(startsWith))
    || (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256)) {
    throw new Error("第三方许可证内容校验失败。");
  }
  return text;
}

export async function copyPlainDirectoryContents(source, target, archivePrefix) {
  // Merge only distinct top-level entries into an existing distribution root.
  // cp(source, existingRoot, errorOnExist:true) rejects the root itself on Windows.
  await inspectDistributionTree(source, archivePrefix);
  const destination = await lstat(target);
  if (destination.isSymbolicLink() || !destination.isDirectory()) throw new Error("模板目标必须为普通目录。");
  const children = (await readdir(source)).sort();
  for (const child of children) {
    try {
      await lstat(join(target, child));
      throw new Error(`模板目标文件已存在，为避免覆盖已停止：${child}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const child of children) await copyPlainTree(join(source, child), join(target, child), `${archivePrefix}/${child}`);
}

export async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function directoryFingerprint(root, archivePrefix) {
  const tree = await inspectDistributionTree(root, archivePrefix);
  const hash = createHash("sha256");
  for (const entry of tree.entries.filter((item) => !item.directory)) {
    hash.update(`${relative(root, entry.diskPath).replaceAll("\\", "/")}\0${entry.size}\0${await fileSha256(entry.diskPath)}\n`);
  }
  return { sha256: hash.digest("hex"), bytes: tree.totalBytes, files: tree.entries.filter((entry) => !entry.directory).length };
}

export function assertCompleteContents(tree) {
  const files = new Set(tree.entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  for (const required of COMPLETE_REQUIRED_FILES) {
    if (!files.has(`AgentCanvas/${required}`)) throw new Error(`完整便携包缺少必要文件：${required}`);
  }
  if (![...files].some((name) => name.startsWith("AgentCanvas/app/.runtime/dsh-bundled/node_modules/"))) {
    throw new Error("完整便携包缺少 DSH 运行依赖。");
  }
}

export async function dependencyLicenseIndex(root, tree) {
  const licenses = [];
  const packages = [];
  for (const entry of tree.entries) {
    if (entry.directory) continue;
    const name = relative(root, entry.diskPath).replaceAll("\\", "/");
    if (/^(?:licen[cs]e|notice|copying|copyright)(?:[._-]|$)/iu.test(basename(name))) licenses.push(name);
    if (basename(name) === "package.json" && name.includes("/node_modules/")) {
      const item = JSON.parse(await readFile(entry.diskPath, "utf8"));
      if (typeof item.name === "string" && typeof item.version === "string") {
        packages.push({ name: item.name, version: item.version, license: typeof item.license === "string" ? item.license : null, manifest: name });
      }
    }
  }
  return { schemaVersion: 1, notice: "Original license and notice files remain alongside the unmodified dependency files; paths are relative to this package.", packages, licenseFiles: licenses };
}
