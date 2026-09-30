import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUNDLED_OMITTED_PACKAGES, BUNDLED_PROFILE, BUNDLED_PROFILE_FILE,
  installationId, resolveDshInstallation, verifyBundledTree, verifyInstalledTree,
} from "../runtime/dsh/installation.mjs";
import { VERSION as DSH_VERSION } from "../runtime/dsh/policy.mjs";
import {
  assertBuildRuntime, assertCompleteContents, copyControlledDshDependencies, copyPlainDirectoryContents, copyPlainTree, copyWebsiteRuntimeTree, dependencyLicenseIndex,
  directoryFingerprint, DSH_CARRIER_FILES, fetchLicenseText, fileSha256, inspectDistributionTree,
  MAX_ARCHIVE_PATH, MAX_UNCOMPRESSED_BYTES, verifyPinnedBrowser,
} from "./portable-build-utils.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(projectRoot, "..", "portable-release", "AgentCanvas");

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function buildPortableWindows(output = defaultOutput, browser) {
  assertBuildRuntime();
  if (!browser) throw new Error("请通过第三个命令行参数指定已下载的固定版本 Chromium Headless Shell 目录。");
  const outputRoot = resolve(output);
  const suffix = relative(projectRoot, outputRoot);
  if (basename(outputRoot) !== "AgentCanvas") throw new Error("便携目录必须以 AgentCanvas 命名。");
  if (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) throw new Error("便携目录必须位于网站源码目录之外。");
  if (await exists(outputRoot)) throw new Error(`输出目录已存在，为避免覆盖已停止：${outputRoot}`);

  const standaloneRoot = join(projectRoot, "dist/standalone");
  if (!await exists(standaloneRoot)) throw new Error("缺少 dist/standalone，请先运行 npm run build。");
  const installation = await resolveDshInstallation();
  if (installation.selection.kind !== "slot") throw new Error("构建要求完整且经过 ZIP 补丁验证的 DSH slot 安装，不能重打包 legacy 或已裁剪的 bundled。");
  const dshManifest = await readFile(join(installation.root, "package.json"));
  const dshLock = await readFile(join(installation.root, "package-lock.json"));
  const bundledId = installationId(dshManifest, dshLock);
  const dshSpecification = JSON.parse(dshManifest.toString("utf8"));
  if (dshSpecification.overrides?.["@deepseek-ai/libreoffice-kit"]?.fflate !== "0.8.3") throw new Error("DSH ZIP 补丁配置缺失。");
  await verifyInstalledTree(installation.root, { patched: true });

  const browserRoot = resolve(browser);
  const playwrightRoot = await realpath(join(projectRoot, "node_modules/playwright-core"));
  const browserRegistry = JSON.parse(await readFile(join(playwrightRoot, "browsers.json"), "utf8"));
  const browserVersion = browserRegistry.browsers.find((item) => item.name === "chromium-headless-shell");
  if (!browserVersion?.browserVersion || !browserVersion.revision) throw new Error("缺少锁定的 Chromium Headless Shell 元数据。");
  for (const name of ["chrome-headless-shell.exe", "LICENSE.headless_shell", "ABOUT"]) await access(join(browserRoot, name));
  await verifyPinnedBrowser(browserRoot, browserVersion);
  const browserSource = `https://cdn.playwright.dev/builds/cft/${browserVersion.browserVersion}/win64/chrome-headless-shell-win64.zip`;
  const browserFingerprint = await directoryFingerprint(browserRoot, "AgentCanvas/runtime/browser");
  const templateRoot = join(projectRoot, "portable/windows");
  await inspectDistributionTree(standaloneRoot, "AgentCanvas/app");
  await inspectDistributionTree(templateRoot, "AgentCanvas");
  const nodeLicenseSource = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  // Fetch only the exact-version public license, never a binary or a package install.
  const nodeLicense = await fetchLicenseText(nodeLicenseSource, { startsWith: "Node.js is licensed for use as follows:", minimumLength: 10_000 });
  const pythonLicenseSource = "https://raw.githubusercontent.com/python/cpython/v3.14.2/LICENSE";
  const pythonLicense = await fetchLicenseText(pythonLicenseSource, {
    sha256: "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
  });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("无法确认构建源码提交。");
  const sourceHasUncommittedChanges = Boolean(execFileSync("git", ["diff", "HEAD", "--name-only", "--", "."], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true,
  }).trim());

  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot);
  await copyWebsiteRuntimeTree(standaloneRoot, join(outputRoot, "app"), "AgentCanvas/app");
  // vinext omits these React peers. Resolve only each declared package root;
  // reject all nested links, then copy ordinary files without dereferencing.
  for (const packageName of ["react", "react-dom", "react-server-dom-webpack"]) {
    const source = await realpath(join(projectRoot, "node_modules", packageName));
    await copyWebsiteRuntimeTree(source, join(outputRoot, "app/node_modules", packageName), `AgentCanvas/app/node_modules/${packageName}`);
  }
  await mkdir(join(outputRoot, "runtime"));
  await cp(process.execPath, join(outputRoot, "runtime/node.exe"), { force: false, errorOnExist: true });
  await copyPlainTree(browserRoot, join(outputRoot, "runtime/browser"), "AgentCanvas/runtime/browser");
  // The distribution carries no installation history, fallback slot or sessions.
  const dshTarget = join(outputRoot, "app/.runtime/dsh-bundled");
  await mkdir(dshTarget, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await copyPlainTree(join(installation.root, name), join(dshTarget, name), `AgentCanvas/app/.runtime/dsh-bundled/${name}`);
  }
  await copyControlledDshDependencies(join(installation.root, "node_modules"), join(dshTarget, "node_modules"));
  await writeJson(join(dshTarget, BUNDLED_PROFILE_FILE), {
    schemaVersion: 1, profile: BUNDLED_PROFILE, omittedPackages: [...BUNDLED_OMITTED_PACKAGES],
  });
  await verifyBundledTree(dshTarget);
  await writeJson(join(outputRoot, "app/.runtime/dsh-runtime-active.json"), {
    schemaVersion: 1, active: { kind: "bundled", id: bundledId }, previous: null,
  });
  await mkdir(join(outputRoot, "app/runtime/dsh"), { recursive: true });
  for (const name of DSH_CARRIER_FILES) {
    await mkdir(dirname(join(outputRoot, "app/runtime/dsh", name)), { recursive: true });
    await copyPlainTree(join(projectRoot, "runtime/dsh", name), join(outputRoot, "app/runtime/dsh", name), `AgentCanvas/app/runtime/dsh/${name}`);
  }
  await copyPlainDirectoryContents(templateRoot, outputRoot, "AgentCanvas");
  const startScriptPath = join(outputRoot, "Start-AgentCanvas.cmd");
  await writeFile(startScriptPath, (await readFile(startScriptPath, "utf8")).replace(/\r?\n/gu, "\r\n"), "utf8");

  await mkdir(join(outputRoot, "licenses"));
  await writeFile(join(outputRoot, "licenses/Node-LICENSE.txt"), nodeLicense, { encoding: "utf8", flag: "wx" });
  await writeFile(join(outputRoot, "licenses/CPython-LICENSE.txt"), pythonLicense, { encoding: "utf8", flag: "wx" });
  await cp(join(browserRoot, "LICENSE.headless_shell"), join(outputRoot, "licenses/Chromium-LICENSE.txt"), { force: false, errorOnExist: true });
  await cp(join(playwrightRoot, "LICENSE"), join(outputRoot, "licenses/Playwright-LICENSE.txt"), { force: false, errorOnExist: true });
  await cp(join(playwrightRoot, "NOTICE"), join(outputRoot, "licenses/Playwright-NOTICE.txt"), { force: false, errorOnExist: true });
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const python = JSON.parse(await readFile(join(outputRoot, "app/vendor/python/runtime-lock.json"), "utf8"));
  if (python.pythonVersion !== "3.14.2" || python.version !== "314.0.7") throw new Error("Python 固定版本已变化，请重新核对对应许可证与源代码说明。");
  for (const [name, entry] of Object.entries(python.files)) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name) || await fileSha256(join(outputRoot, "app/vendor/python", name)) !== entry.sha256) {
      throw new Error("Python 固定资源校验失败。");
    }
  }
  const dshFingerprint = await directoryFingerprint(dshTarget, "AgentCanvas/app/.runtime/dsh-bundled");
  const components = {
    node: { version: process.version, executable: "runtime/node.exe", sha256: await fileSha256(join(outputRoot, "runtime/node.exe")), licenseSource: nodeLicenseSource },
    browser: { version: browserVersion.browserVersion, revision: browserVersion.revision, source: browserSource,
      executable: "runtime/browser/chrome-headless-shell.exe", ...browserFingerprint },
    dsh: { version: DSH_VERSION, installationId: bundledId, directory: "app/.runtime/dsh-bundled", profile: BUNDLED_PROFILE,
      omittedPackages: [...BUNDLED_OMITTED_PACKAGES],
      omissionReason: "The website controlled Notebook profile exposes neither native Office conversion nor native DSH attachment/image processing. Their four unused packages are excluded after load-graph review; corresponding-source redistribution for those optional binaries was not verified. All other runtime dependencies and the original manifest/lock are retained. This is not a general-purpose DSH CLI distribution.",
      packageLockSha256: await fileSha256(join(dshTarget, "package-lock.json")), ...dshFingerprint },
    python: { version: python.pythonVersion, pyodide: python.version, manifest: "app/vendor/python/runtime-lock.json", packages: python.packages,
      pyodideSource: "https://github.com/pyodide/pyodide/tree/314.0.7", cpythonSource: "https://github.com/python/cpython/tree/v3.14.2",
      cpythonLicenseSource: pythonLicenseSource },
  };
  await writeFile(join(outputRoot, "licenses/Python-SOURCES.txt"), [
    "Notebook Python resources are copied without modification from the fixed Pyodide distribution.",
    "Pyodide 314.0.7 source: https://github.com/pyodide/pyodide/tree/314.0.7",
    "Pyodide exact source archive: https://codeload.github.com/pyodide/pyodide/tar.gz/b1e4fcc2488962f6360a97f19b9982d6fdb5d16f",
    "CPython 3.14.2 source: https://github.com/python/cpython/tree/v3.14.2",
    "CPython source archive: https://www.python.org/ftp/python/3.14.2/Python-3.14.2.tgz",
    "The full CPython license is included in CPython-LICENSE.txt; Pyodide's original license is retained at app/vendor/python/pyodide-LICENSE.",
    "Exact resource URLs, hashes and wheel versions are preserved in app/vendor/python/runtime-lock.json.",
    "Package wheels retain their own upstream license and notice files. This notice adds no restrictions to those licenses.",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });
  await writeJson(join(outputRoot, "licenses/dependency-sources.json"), {
    schemaVersion: 1, sourceCommit, sourceHasUncommittedChanges, components,
    websiteLockSha256: await fileSha256(join(projectRoot, "pnpm-lock.yaml")),
    npmRegistry: "https://registry.npmjs.org/", pythonResourceSources: Object.values(python.files).map((item) => item.url),
  });
  await writeJson(join(outputRoot, "licenses/third-party-index.json"), await dependencyLicenseIndex(outputRoot, await inspectDistributionTree(outputRoot)));
  const manifest = {
    schemaVersion: 2, profile: "windows-x64-complete", name: "AgentCanvas Portable", version: packageJson.version,
    platform: "win32-x64", node: process.version, entrypoint: "Start-AgentCanvas.cmd", build: "vinext-standalone",
    includesSecrets: false, archiveRoot: "AgentCanvas", recommendedArchiveName: "AC-Win64.zip",
    sourceCommit, sourceHasUncommittedChanges, components, generatedAt: new Date().toISOString(),
    archivePathLimit: MAX_ARCHIVE_PATH, uncompressedBytesLimit: MAX_UNCOMPRESSED_BYTES,
    extractionNote: "Extract under a short directory such as D:\\AC; 360 compatibility has not been certified.",
  };
  const beforeManifest = await inspectDistributionTree(outputRoot);
  manifest.maxArchiveRelativePathChars = beforeManifest.maxArchiveRelativePathChars;
  manifest.payloadBytesBeforeManifest = beforeManifest.totalBytes;
  await writeJson(join(outputRoot, "portable-manifest.json"), manifest);
  const tree = await inspectDistributionTree(outputRoot);
  assertCompleteContents(tree);
  return { output: outputRoot, node: process.version, sourceCommit, sourceHasUncommittedChanges,
    totalBytes: tree.totalBytes, fileCount: tree.entries.filter((entry) => !entry.directory).length,
    longestPath: tree.longestPath, maxArchiveRelativePathChars: tree.maxArchiveRelativePathChars, components };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await buildPortableWindows(process.argv[2], process.argv[3]), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
