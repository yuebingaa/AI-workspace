import { access, cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const defaultOutputRoot = resolve(projectRoot, "..", "portable-release", "AgentCanvas");
const outputRoot = process.argv[2] ? resolve(process.argv[2]) : defaultOutputRoot;
const outputParent = dirname(outputRoot);
const standaloneRoot = resolve(projectRoot, "dist", "standalone");
const templateRoot = resolve(projectRoot, "portable", "windows");
const archiveRootName = basename(outputRoot);
const maxArchiveRelativePathChars = 180;

const outputRelativeToProject = relative(projectRoot, outputRoot);
if (basename(outputRoot) !== "AgentCanvas") throw new Error("便携目录必须以 AgentCanvas 命名。");
if (outputRelativeToProject === "" || (outputRelativeToProject !== ".." && !outputRelativeToProject.startsWith(`..${sep}`))) {
  throw new Error("便携目录必须位于网站源码目录之外。");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

if (!await exists(standaloneRoot)) throw new Error("缺少 dist/standalone，请先运行 npm run build。");
if (await exists(outputRoot)) throw new Error(`输出目录已存在，为避免覆盖已停止：${outputRoot}`);

await mkdir(outputParent, { recursive: true });
await mkdir(outputRoot, { recursive: false });
await cp(standaloneRoot, resolve(outputRoot, "app"), { recursive: true });
// vinext 1.0.0-beta.3 omits its React peer dependencies from standalone output.
// Copy the exact installed runtime peers so the portable server is genuinely self-contained.
for (const packageName of ["react", "react-dom", "react-server-dom-webpack"]) {
  await cp(
    resolve(projectRoot, "node_modules", packageName),
    resolve(outputRoot, "app", "node_modules", packageName),
    // pnpm exposes direct dependencies as symlinks into node_modules/.pnpm.
    // A portable archive must contain the target files instead of links back
    // to the build machine, otherwise React disappears after extraction.
    { recursive: true, dereference: true },
  );
}
await mkdir(resolve(outputRoot, "runtime"));
await cp(process.execPath, resolve(outputRoot, "runtime", "node.exe"));
await cp(templateRoot, outputRoot, { recursive: true });

// cmd.exe is unreliable with LF-only batch files, especially when the path
// contains non-ASCII characters. Always emit a native Windows CRLF launcher.
const startScriptPath = resolve(outputRoot, "Start-AgentCanvas.cmd");
const startScript = await readFile(startScriptPath, "utf8");
await writeFile(startScriptPath, startScript.replace(/\r?\n/g, "\r\n"), "utf8");

async function inspectPortableTree(directory, root = directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`便携包不能包含指向构建电脑的符号链接：${relative(root, entryPath)}`);
    }
    if (entry.isDirectory()) paths.push(...await inspectPortableTree(entryPath, root));
    else paths.push(relative(root, entryPath));
  }
  return paths;
}

const portablePaths = await inspectPortableTree(outputRoot);
const longestArchivePath = portablePaths
  .map((path) => `${archiveRootName}\\${path}`)
  .sort((left, right) => right.length - left.length)[0] ?? archiveRootName;
if (longestArchivePath.length > maxArchiveRelativePathChars) {
  throw new Error(`便携包内部路径过长（${longestArchivePath.length} 字符）：${longestArchivePath}`);
}

const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
await writeFile(resolve(outputRoot, "portable-manifest.json"), `${JSON.stringify({
  name: "AgentCanvas Portable",
  version: packageJson.version,
  platform: "win32-x64",
  node: process.version,
  entrypoint: "Start-AgentCanvas.cmd",
  build: "vinext-standalone",
  includesSecrets: false,
  archiveRoot: archiveRootName,
  recommendedArchiveName: "AgentCanvas-Windows.zip",
  maxArchiveRelativePathChars: longestArchivePath.length,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output: outputRoot,
  runtime: basename(process.execPath),
  node: process.version,
}, null, 2));
