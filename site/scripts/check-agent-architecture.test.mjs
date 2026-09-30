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
    await mkdir(join(fixture, "core/chart-editor"), { recursive: true });
    await mkdir(join(fixture, "core/visualization"), { recursive: true });
    await mkdir(join(fixture, "patches"), { recursive: true });
    await writeFile(join(fixture, "patches/@kanaries__graphic-walker@0.5.2.patch"), "initial component patch\n");
    await mkdir(join(fixture, "scripts"), { recursive: true });
    await writeFile(join(fixture, "scripts/notebook-query-worker.cjs"), "// SQL worker fixture\n");
    for (const scope of ["scripts", "docs/architecture", "core/harness", "core/ai/server", "app/api/ai/harness", "app/api/ai/dsh", "app/dsh", "core/notebook", "core/semantic", "core/wecom", "core/projects", "app/api/projects", "core/connections", "app/api/connections", "app/api/notebook", "core/metadata", "core/datasets", "core/sql", "core/changesets", "core/visualization-lab", "app/api/ai/visualization-lab", "core/agent-engines", "app/api/settings/agent-engine", "runtime/dsh"]) {
      await mkdir(join(fixture, scope), { recursive: true });
    }
    for (const scope of ["core/dsh-web", "components/studio/dsh-web", "app/api/settings/dsh-plugins", "components/studio/dsh-settings", "runtime/dsh/notebook-plugin"]) await mkdir(join(fixture, scope), { recursive: true });
    const script = join(fixture, "scripts/check-agent-architecture.mjs");
    await writeFile(script, await readFile(join(dirname(fileURLToPath(import.meta.url)), "check-agent-architecture.mjs")));
    const document = join(fixture, "docs/architecture/agent-architecture.md");
    await writeFile(document, `# Architecture\n<!-- agent-architecture-source-sha256: ${"0".repeat(64)} -->\n`);
    const source = join(fixture, "core/harness/runtime.ts");
    await writeFile(source, "export const version = 1;\n");
    await mkdir(join(fixture, "scripts/runtime"), { recursive: true });
    for (const name of ["python-runtime-lock.json", "setup-python-runtime.mjs", "copy-notebook-runtime.mjs", "runtime/site-runtime.mjs", "setup-dsh-runtime.mjs"]) {
      await writeFile(join(fixture, "scripts", name), "initial runtime asset contract\n");
    }
    const dshFiles = ["driver.mjs", "driver.d.mts", "controlled-plugin.mjs", "chat-adapter.mjs", "native-loader.cjs", "session-server.mjs", "wire-policy.mjs", "policy.mjs", "policy.d.mts", "installation.mjs",
      "tool-diagnostics.mjs", "tool-diagnostics.d.mts", "web-assets.mjs", "web-assets.d.mts", "web-client.mjs", "web-settings.mjs",
      "builtin-skills.mjs", "package-inventory.mjs", "package-inventory.d.mts", "package.json", "package-lock.json",
      "notebook-plugin/index.mjs", "notebook-plugin/index.d.mts", "notebook-plugin/package.json"];
    for (const name of dshFiles) await writeFile(join(fixture, "runtime/dsh", name), "initial DSH runtime contract\n");
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    assert.equal(run().status, 0);
    await writeFile(join(fixture, "core/harness/runtime.test.ts"), "test-only change");
    await writeFile(source, "export const version = 1;\r\n");
    assert.equal(run().status, 0);
    await writeFile(source, "export const version = 2;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/ai/server/deepseek-harness-model.ts"), "export const modelVersion = 1;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/metadata/catalog-service.ts"), "export const catalogVersion = 1;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/sql/read-only-query.ts"), "export const policyVersion = 1;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/sql/read-only-query.test.ts"), "test-only change");
    assert.equal(run().status, 0);
    await writeFile(join(fixture, "core/sql/read-only-query.ts"), "export const policyVersion = 2;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "scripts/python-runtime-lock.json"), "changed runtime asset contract\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "scripts/runtime/site-runtime.mjs"), "changed release capability composition\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/changesets/confirmation.ts"), "export const confirmationVersion = 1;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    await writeFile(join(fixture, "core/changesets/confirmation.test.ts"), "test-only confirmation change");
    assert.equal(run().status, 0);
    await writeFile(join(fixture, "core/changesets/confirmation.ts"), "export const confirmationVersion = 2;\n");
    assert.equal(run().status, 1);
    assert.equal(run("--sync").status, 0);
    for (const source of ["patches/@kanaries__graphic-walker@0.5.2.patch", "core/visualization/definition.ts", "core/dsh-web/protocol.ts", "components/studio/dsh-web/Frame.tsx", "core/agent-engines/contracts.ts", "app/api/settings/agent-engine/route.ts", "app/api/ai/dsh/route.ts", "app/dsh/page.tsx", "scripts/setup-dsh-runtime.mjs",
      ...dshFiles.map((name) => `runtime/dsh/${name}`)]) {
      await writeFile(join(fixture, source), "changed DSH source contract\n");
      assert.equal(run().status, 1, `DSH source drift must fail: ${source}`);
      assert.equal(run("--sync").status, 0);
      assert.equal(run().status, 0);
    }
    await mkdir(join(fixture, "runtime/dsh/node_modules/vendor"), { recursive: true });
    await writeFile(join(fixture, "runtime/dsh/node_modules/vendor/index.ts"), "untracked dependency source\n");
    await writeFile(join(fixture, "runtime/dsh/driver.test.mjs"), "test-only DSH source\n");
    await writeFile(join(fixture, "core/agent-engines/driver.test.ts"), "test-only engine source\n");
    assert.equal(run().status, 0, "DSH installs and tests are outside the architectural source fingerprint");
    await writeFile(document, "# Missing fingerprint\n");
    assert.equal(run("--sync").status, 1);
  } finally {
    if (dirname(resolve(fixture)) !== temporaryRoot || !fixture.startsWith(join(temporaryRoot, "agent-architecture-check-"))) {
      throw new Error("Temporary fixture path escaped its intended directory");
    }
    await rm(fixture, { recursive: true, force: true });
  }
});
