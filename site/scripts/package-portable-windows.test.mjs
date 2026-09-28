import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { packagePortableWindows, validateArchiveName } from "./package-portable-windows.mjs";
import {
  assertBuildRuntime, COMPLETE_REQUIRED_FILES, copyControlledDshDependencies, copyPlainDirectoryContents, copyPlainTree, directoryFingerprint,
  DSH_CARRIER_FILES, fetchLicenseText, inspectDistributionTree, MAX_ARCHIVE_PATH, MAX_UNCOMPRESSED_BYTES, verifyPinnedBrowser,
} from "./portable-build-utils.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("便携启动器不覆盖应用内置的 DeepSeek 模型", async () => {
  const launcher = await readFile(join(projectRoot, "portable", "windows", "launcher.mjs"), "utf8");
  assert.doesNotMatch(launcher, /DEEPSEEK_MODEL\s*:/u);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentcanvas-zip-test-"));
  t.after(async () => {
    // Only remove this test's independently created, validated temporary tree.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("agentcanvas-zip-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "AgentCanvas");
  await mkdir(join(source, "runtime"), { recursive: true });
  await mkdir(join(source, "app", "node_modules"), { recursive: true });
  const contents = {
    ...Object.fromEntries(COMPLETE_REQUIRED_FILES.map((name) => [name, "synthetic fixture; not executable"])),
    "Start-AgentCanvas.cmd": "@echo off\r\n",
    "launcher.mjs": "// launcher\n",
    "portable-manifest.json": '{"schemaVersion":2,"profile":"windows-x64-complete","name":"AgentCanvas Portable"}',
    "runtime/node.exe": "test fixture, not executable",
    "app/server.js": "// server\n",
    "README-使用说明.txt": "请完整解压。\r\n",
    "app/.runtime/dsh-bundled/node_modules/synthetic/index.js": "// synthetic SDK marker\n",
  };
  for (const [name, text] of Object.entries(contents)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), text);
  }
  return { root, source, output: join(root, "compatible.zip"), contents };
}

function centralEntries(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const length = zip.readUInt16LE(offset + 28);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + length).toString("utf8");
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(zip.subarray(localOffset + 30, localOffset + 30 + zip.readUInt16LE(localOffset + 26)).toString("utf8"), name);
    entries.push({ name, host: zip[offset + 5], flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10), attrs: zip.readUInt32LE(offset + 38) });
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return entries;
}

test("ZIP 使用正斜杠、真实目录标记和正确 UTF-8，文件内容保持不变", async (t) => {
  const fixtureData = await fixture(t);
  const { source, output, contents } = fixtureData;
  const report = await packagePortableWindows(source, output);
  const zip = await readFile(output);
  const entries = centralEntries(zip);
  assert.equal(report.fileCount, Object.keys(contents).length);
  assert.equal(report.directoryCount, (await inspectDistributionTree(source)).entries.filter((entry) => entry.directory).length);
  assert.equal(report.sha256.length, 64);
  assert.ok(entries.every((entry) => !entry.name.includes("\\") && entry.host === 0));
  for (const entry of entries) {
    assert.equal(entry.attrs, entry.name.endsWith("/") ? 0x10 : 0x20);
    assert.equal(entry.method, entry.name.endsWith("/") ? 0 : 8);
  }
  assert.ok(entries.some((entry) => entry.name === "AgentCanvas/app/node_modules/"));
  assert.ok(entries.find((entry) => entry.name.includes("使用说明")).flags & 0x800);
  const extracted = unzipSync(zip);
  for (const [name, text] of Object.entries(contents)) {
    assert.equal(Buffer.from(extracted[`AgentCanvas/${name}`]).toString("utf8"), text);
  }
});

test("不会覆盖原包，也不能把输出放进源目录", async (t) => {
  const { source, output } = await fixture(t);
  await writeFile(output, "existing archive");
  await assert.rejects(packagePortableWindows(source, output), /输出文件已存在/u);
  assert.equal(await readFile(output, "utf8"), "existing archive");
  await assert.rejects(packagePortableWindows(source, join(source, "self.zip")), /源目录之外/u);
});

test("拒绝 Windows 非法名称、越界、长路径和私有配置", () => {
  for (const name of ["/AgentCanvas/file", "C:/AgentCanvas/file", "AgentCanvas/../file", "AgentCanvas/a\\b",
    "AgentCanvas/CON.txt", "AgentCanvas/file.", "AgentCanvas/file ", "AgentCanvas/file:stream", "AgentCanvas//file",
    "AgentCanvas/.env.local", "AgentCanvas/.git/config", "AgentCanvas/data/state/file.json", `AgentCanvas/${"a".repeat(211)}`,
    "AgentCanvas/app/.runtime/dsh-runtime-sessions/a/config.json", "AgentCanvas/app/.runtime/.links/install",
    "AgentCanvas/app/node_modules/.npmrc", "AgentCanvas/app/credentials.json", "AgentCanvas/app/secrets.yaml"]) {
    assert.throws(() => validateArchiveName(name), Error, name);
  }
  assert.equal(validateArchiveName("AgentCanvas/README-使用说明.txt"), "AgentCanvas/README-使用说明.txt");
});

test("完整依赖路径上限为 210，体积上限为 1.5 GiB，不无限放宽", () => {
  assert.equal(MAX_ARCHIVE_PATH, 210);
  assert.equal(MAX_UNCOMPRESSED_BYTES, 1536 * 1024 * 1024);
  const valid = `AgentCanvas/${"a".repeat(198)}`;
  assert.equal(valid.length, 210);
  assert.equal(validateArchiveName(valid), valid);
  assert.throws(() => validateArchiveName(valid + "b"), /路径过长/u);
  assert.equal(validateArchiveName("AgentCanvas/app/.runtime/dsh-bundled/node_modules/tool/LICENSE"),
    "AgentCanvas/app/.runtime/dsh-bundled/node_modules/tool/LICENSE");
});

test("打包前检查完整 DSH、浏览器、Python、许可证与新版清单", async (t) => {
  for (const absent of ["runtime/browser/chrome-headless-shell.exe", "app/runtime/dsh/driver.mjs",
    "app/.runtime/dsh-bundled/package-lock.json", "licenses/Node-LICENSE.txt", "app/vendor/python/runtime-lock.json"]) {
    const { source, output } = await fixture(t);
    await rm(join(source, absent));
    await assert.rejects(packagePortableWindows(source, output), /缺少必要文件/u);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  const { source, output } = await fixture(t);
  await writeFile(join(source, "portable-manifest.json"), '{"name":"old incomplete package"}');
  await assert.rejects(packagePortableWindows(source, output), /schemaVersion 2/u);
});

test("构建主机必须为 Node 24 / Windows x64", () => {
  assert.doesNotThrow(() => assertBuildRuntime({ platform: "win32", arch: "x64", version: "v24.19.0" }));
  for (const invalid of [{ platform: "linux", arch: "x64", version: "v24.19.0" },
    { platform: "win32", arch: "arm64", version: "v24.19.0" }, { platform: "win32", arch: "x64", version: "v22.0.0" }]) {
    assert.throws(() => assertBuildRuntime(invalid), /Windows x64.*24/u);
  }
});

test("浏览器资源拒绝冒用锁定版本及替换后的可执行文件", async (t) => {
  const { source } = await fixture(t);
  const browser = join(source, "runtime/browser");
  await assert.rejects(verifyPinnedBrowser(browser, { browserVersion: "999", revision: "999" }), /锁定版本变化/u);
  await assert.rejects(verifyPinnedBrowser(browser, { browserVersion: "151.0.7922.34", revision: "1234" }), /锁定资源不一致/u);
});

test("生产载体白名单包含所有生产 mjs/cjs，但不包含测试", async () => {
  const { readdir } = await import("node:fs/promises");
  const production = (await readdir(join(projectRoot, "runtime/dsh"))).filter((name) => /\.[mc]js$/u.test(name) && !/\.test\.[mc]js$/u.test(name));
  assert.deepEqual([...DSH_CARRIER_FILES].sort(), production.sort());
});

test("目录指纹仅使用相对路径并检测文件变化", async (t) => {
  const { root } = await fixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await writeFile(join(first, "index.js"), "unchanged");
  await copyPlainTree(first, second, "AgentCanvas/app/example");
  const digest = await directoryFingerprint(first, "AgentCanvas/app/example");
  assert.deepEqual(await directoryFingerprint(second, "AgentCanvas/app/example"), digest);
  await writeFile(join(second, "index.js"), "different");
  assert.notEqual((await directoryFingerprint(second, "AgentCanvas/app/example")).sha256, digest.sha256);
  assert.equal(digest.bytes, 9);
  assert.equal(digest.files, 1);
});

test("模板逐项合并到已有目录，保留 app 并在同名项存在时拒绝覆盖", async (t) => {
  const { root } = await fixture(t);
  const template = join(root, "template");
  const target = join(root, "assembled");
  await mkdir(template);
  await mkdir(target);
  await writeFile(join(template, "launcher.mjs"), "new launcher");
  await copyPlainDirectoryContents(template, target, "AgentCanvas");
  assert.equal(await readFile(join(target, "launcher.mjs"), "utf8"), "new launcher");
  const second = join(root, "with-app");
  await mkdir(join(second, "app"), { recursive: true });
  await writeFile(join(second, "app/server.js"), "existing app");
  await copyPlainDirectoryContents(template, second, "AgentCanvas");
  assert.equal(await readFile(join(second, "app/server.js"), "utf8"), "existing app");
  await writeFile(join(template, "launcher.mjs"), "must not replace");
  await writeFile(join(template, "additional.mjs"), "must not partially merge");
  await assert.rejects(copyPlainDirectoryContents(template, second, "AgentCanvas"), /避免覆盖/u);
  assert.equal(await readFile(join(second, "launcher.mjs"), "utf8"), "new launcher");
  assert.equal(await readFile(join(second, "app/server.js"), "utf8"), "existing app");
  await assert.rejects(readFile(join(second, "additional.mjs")), { code: "ENOENT" });
});

test("受控 DSH 分发仅省略四个精确顶层未开放能力包，不裁剪其他或嵌套依赖", async (t) => {
  const { root } = await fixture(t);
  const source = join(root, "dependencies");
  const target = join(root, "copied-dependencies");
  const omitted = ["@deepseek-ai/libreoffice-kit/index.js", "@deepseek-ai/libreoffice-kit-win32-x64/index.js",
    "sharp/index.js", "@img/sharp-win32-x64/index.js"];
  const kept = ["@deepseek-ai/libreoffice-kit-extra/index.js", "@deepseek-ai/dsh/index.js", "fflate/index.js",
    "nested/node_modules/@deepseek-ai/libreoffice-kit/index.js", "nested/node_modules/sharp/index.js", "sharp-extra/index.js",
    "package/tests/fixture.js", "package/types.d.ts", "package/index.js.map"];
  for (const name of [...omitted, ...kept]) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), `synthetic ${name}`);
  }
  await copyControlledDshDependencies(source, target);
  for (const name of omitted) {
    await assert.rejects(readFile(join(target, name)), { code: "ENOENT" });
    assert.equal(await readFile(join(source, name), "utf8"), `synthetic ${name}`);
  }
  for (const name of kept) assert.equal(await readFile(join(target, name), "utf8"), `synthetic ${name}`);
});

test("许可证下载拒绝HTTP失败、内容更换和错误标题，不自动跟随重定向", async () => {
  const payload = "Synthetic license text\n";
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const successful = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(payload);
  };
  assert.equal(await fetchLicenseText("https://example.invalid/LICENSE", { sha256 }, successful), payload);
  await assert.rejects(fetchLicenseText("https://example.invalid/LICENSE", { sha256: "0".repeat(64) }, successful), /内容校验失败/u);
  await assert.rejects(fetchLicenseText("https://example.invalid/LICENSE", { startsWith: "wrong" }, successful), /内容校验失败/u);
  await assert.rejects(fetchLicenseText("https://example.invalid/LICENSE", {}, async () => new Response("error", { status: 403 })), /无法取得/u);
});

test("拒绝带持久化用户数据的运行目录", async (t) => {
  const { source, output } = await fixture(t);
  await mkdir(join(source, "data"));
  await assert.rejects(packagePortableWindows(source, output), /data 目录/u);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("拒绝目录链接，防止引入构建电脑的文件", async (t) => {
  const { source, output, root } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(source, "app", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(packagePortableWindows(source, output), /符号链接/u);
});
