import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = resolve(projectRoot, "..", "portable-release", "AgentCanvas");
const defaultOutput = resolve(projectRoot, "..", "AgentCanvas-Windows-compatible.zip");
const maxArchivePath = 180;
const maxUncompressedBytes = 768 * 1024 * 1024;

export function validateArchiveName(name) {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!path.startsWith("AgentCanvas/") && path !== "AgentCanvas") throw new Error(`ZIP 路径必须位于 AgentCanvas 内：${name}`);
  if (name.length > maxArchivePath) throw new Error(`ZIP 路径过长：${name}`);
  for (const part of path.split("/")) {
    if (!part || /[\\<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      throw new Error(`ZIP 包含不兼容的 Windows 路径：${name}`);
    }
    if (/^(\.env(?:\..*)?|\.git|\.studio-data)$/iu.test(part)) throw new Error(`不能打包私有配置或状态目录：${name}`);
  }
  if (/^AgentCanvas\/data(?:\/|$)/iu.test(path)) throw new Error("不能打包已经运行产生的 data 目录，请使用未运行的发布目录。");
  return name;
}

export async function packagePortableWindows(source = defaultSource, output = defaultOutput) {
  const sourceRoot = resolve(source);
  const outputPath = resolve(output);
  const outputRelative = relative(sourceRoot, outputPath);
  if (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`)) {
    throw new Error("ZIP 输出必须位于便携包源目录之外。");
  }
  try {
    await access(outputPath);
    throw new Error(`输出文件已存在，为避免覆盖已停止：${outputPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const files = Object.create(null);
  const seen = new Set();
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  let longestPath = "";
  async function collect(diskPath, archivePath) {
    const info = await lstat(diskPath);
    if (info.isSymbolicLink()) throw new Error(`便携包不能包含符号链接：${archivePath}`);
    const directory = info.isDirectory();
    if (!directory && !info.isFile()) throw new Error(`便携包包含非普通文件：${archivePath}`);
    const name = validateArchiveName(archivePath + (directory ? "/" : ""));
    const key = archivePath.toLowerCase();
    if (seen.has(key)) throw new Error(`ZIP 路径大小写冲突：${archivePath}`);
    seen.add(key);
    if (name.length > longestPath.length) longestPath = name;
    if (seen.size >= 65_535) throw new Error("便携包文件数超出普通 ZIP 范围。");
    if (directory) {
      // ZIP APPNOTE 4.4.17.1 requires forward slashes. Also set the DOS
      // directory bit: some extractors otherwise treat empty entries as files.
      files[name] = [new Uint8Array(), { os: 0, attrs: 0x10, level: 0, mtime: info.mtime }];
      directoryCount++;
      for (const child of (await readdir(diskPath)).sort()) {
        await collect(resolve(diskPath, child), `${archivePath}/${child}`);
      }
    } else {
      totalBytes += info.size;
      if (totalBytes > maxUncompressedBytes) throw new Error("便携包超过 768 MiB，请先检查发布目录是否混入本机数据。");
      files[name] = [await readFile(diskPath), { os: 0, attrs: 0x20, mtime: info.mtime }];
      fileCount++;
    }
  }
  await collect(sourceRoot, "AgentCanvas");
  for (const required of ["Start-AgentCanvas.cmd", "launcher.mjs", "portable-manifest.json", "runtime/node.exe", "app/server.js"]) {
    if (!files[`AgentCanvas/${required}`]) throw new Error(`便携包缺少必要文件：${required}`);
  }
  // Standard STORE/DEFLATE, UTF-8 names where needed, no encryption or ZIP64.
  const zip = zipSync(files, { level: 6 });
  await writeFile(outputPath, zip, { flag: "wx" });
  return { output: outputPath, fileCount, directoryCount, totalBytes, zipBytes: zip.length,
    longestPath, maxArchiveRelativePathChars: longestPath.length,
    sha256: createHash("sha256").update(zip).digest("hex") };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await packagePortableWindows(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
