import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("architecture guard detects drift and ignores tests and line ending changes", async () => {
  const temporaryRoot = resolve(tmpdir());
  const fixture = await mkdtemp(join(temporaryRoot, "agent-architecture-check-"));
  try {
    for (const scope of ["scripts", "docs/architecture", "core/harness", "app/api/ai/harness", "core/notebook", "core/semantic", "core/wecom", "core/projects", "app/api/projects", "core/connections", "app/api/connections", "app/api/notebook", "core/visualization-lab", "app/api/ai/visualization-lab"]) {
      await mkdir(join(fixture, scope), { recursive: true });
    }
    const script = join(fixture, "scripts/check-agent-architecture.mjs");
    await writeFile(script, await readFile(join(dirname(fileURLToPath(import.meta.url)), "check-agent-architecture.mjs")));
    const document = join(fixture, "docs/architecture/agent-architecture.md");
    await writeFile(document, `# Architecture\n<!-- agent-architecture-source-sha256: ${"0".repeat(64)} -->\n`);
    const source = join(fixture, "core/harness/runtime.ts");
    await writeFile(source, "export const version = 1;\n");
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    assert.equal(run().status, 0);
    await writeFile(join(fixture, "core/harness/runtime.test.ts"), "test-only change");
    await writeFile(source, "export const version = 1;\r\n");
    assert.equal(run().status, 0);
    await writeFile(source, "export const version = 2;\n");
    assert.equal(run().status, 1);
    await writeFile(document, "# Missing fingerprint\n");
    assert.equal(run("--sync").status, 1);
  } finally {
    if (dirname(resolve(fixture)) !== temporaryRoot || !fixture.startsWith(join(temporaryRoot, "agent-architecture-check-"))) {
      throw new Error("Temporary fixture path escaped its intended directory");
    }
    await rm(fixture, { recursive: true, force: true });
  }
});
