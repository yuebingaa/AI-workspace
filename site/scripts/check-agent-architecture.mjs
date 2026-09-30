import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const document = join(root, "docs/architecture/agent-architecture.md");
const scopes = ["core/harness", "core/ai/server", "app/api/ai/harness", "app/api/ai/dsh", "app/dsh", "core/notebook", "core/semantic", "core/wecom", "core/projects", "app/api/projects", "core/connections", "app/api/connections", "app/api/notebook", "core/metadata", "core/datasets", "core/sql", "core/changesets", "core/visualization-lab", "app/api/ai/visualization-lab", "core/agent-engines", "app/api/settings/agent-engine"];
const marker = /<!-- agent-architecture-source-sha256: [a-f0-9]{64} -->/;
// Runtime dependencies are an explicit source contract, never a recursive scan
// of the isolated install, generated sessions or third-party node_modules.
const runtimeFiles = ["scripts/notebook-query-worker.cjs", "scripts/python-runtime-lock.json", "scripts/setup-python-runtime.mjs", "scripts/copy-notebook-runtime.mjs", "scripts/runtime/site-runtime.mjs",
  "scripts/setup-dsh-runtime.mjs", "runtime/dsh/driver.mjs", "runtime/dsh/driver.d.mts", "runtime/dsh/controlled-plugin.mjs",
  "runtime/dsh/chat-adapter.mjs", "runtime/dsh/native-loader.cjs", "runtime/dsh/session-server.mjs", "runtime/dsh/builtin-skills.mjs", "runtime/dsh/package-inventory.mjs", "runtime/dsh/package-inventory.d.mts",
  "runtime/dsh/web-assets.mjs", "runtime/dsh/web-assets.d.mts", "runtime/dsh/web-client.mjs", "runtime/dsh/web-settings.mjs",
  "runtime/dsh/wire-policy.mjs", "runtime/dsh/policy.mjs", "runtime/dsh/policy.d.mts", "runtime/dsh/installation.mjs", "runtime/dsh/tool-diagnostics.mjs",
  "runtime/dsh/tool-diagnostics.d.mts", "runtime/dsh/package.json", "runtime/dsh/package-lock.json",
  "runtime/dsh/notebook-plugin/index.mjs", "runtime/dsh/notebook-plugin/index.d.mts", "runtime/dsh/notebook-plugin/package.json",
  "patches/@kanaries__graphic-walker@0.5.2.patch"];

scopes.push("core/dsh-web", "components/studio/dsh-web", "app/api/settings/dsh-plugins", "components/studio/dsh-settings", "core/chart-editor", "core/visualization");

async function sourceFiles(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (["fixtures", "node_modules"].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...await sourceFiles(path));
    else if (item.isFile() && /\.(?:ts|tsx|md)$/.test(item.name)
      && !/\.(?:test|spec)\./.test(item.name) && item.name !== "test-fixture.ts") files.push(path);
  }
  return files;
}

try {
  const files = [...(await Promise.all(scopes.map((scope) => sourceFiles(join(root, scope))))).flat(), ...runtimeFiles.map((name) => join(root, name))]
    .map((path) => ({ path, name: relative(root, path).replaceAll("\\", "/") }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.name}\0`);
    digest.update((await readFile(file.path, "utf8")).replaceAll("\r\n", "\n"));
    digest.update("\0");
  }
  const expected = `<!-- agent-architecture-source-sha256: ${digest.digest("hex")} -->`;
  const content = await readFile(document, "utf8");
  if (process.argv.includes("--sync")) {
    if (!marker.test(content)) throw new Error("Agent 架构文档缺少源码指纹标记。");
    await writeFile(document, content.replace(marker, expected), "utf8");
    console.log(`Agent 架构源码指纹已同步（${files.length} 个文件）。请确保正文和变更记录已更新。`);
  } else if (!content.includes(expected)) {
    throw new Error("Agent 架构文档与源码不同步。请更新 docs/architecture/agent-architecture.md 的正文与变更记录，再运行 npm run docs:agent:sync。");
  } else {
    console.log(`Agent 架构文档与源码指纹一致（${files.length} 个文件）。`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Agent 架构文档检查失败。");
  process.exitCode = 1;
}
