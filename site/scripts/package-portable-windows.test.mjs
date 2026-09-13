import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { packagePortableWindows, validateArchiveName } from "./package-portable-windows.mjs";

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
    "Start-AgentCanvas.cmd": "@echo off\r\n",
    "launcher.mjs": "// launcher\n",
    "portable-manifest.json": '{"name":"AgentCanvas Portable"}',
    "runtime/node.exe": "test fixture, not executable",
    "app/server.js": "// server\n",
    "README-使用说明.txt": "请完整解压。\r\n",
  };
  for (const [name, text] of Object.entries(contents)) await writeFile(join(source, name), text);
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
  assert.equal(report.directoryCount, 4);
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
    "AgentCanvas/.env.local", "AgentCanvas/.git/config", "AgentCanvas/data/state/file.json", `AgentCanvas/${"a".repeat(181)}`]) {
    assert.throws(() => validateArchiveName(name), Error, name);
  }
  assert.equal(validateArchiveName("AgentCanvas/README-使用说明.txt"), "AgentCanvas/README-使用说明.txt");
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
