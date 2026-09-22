import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { HarnessRuntime } from "@/core/harness/runtime";
import { harnessRequestSchema, harnessResponseSchema, type HarnessTaskSummary } from "@/core/harness/contracts";
import { harnessToolCatalog } from "@/core/harness/tool-registry";
import { createHarnessTask } from "@/core/harness/task-state";
import { readHarnessStream } from "@/core/harness/stream";
import * as capabilityComposition from "@/core/notebook/server/available-capabilities";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-python-harness-presence-"));
  vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "true");
  vi.stubEnv("HARNESS_MCP_ENABLED", "false"); vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
  vi.stubEnv("DEEPSEEK_API_KEY", ""); vi.stubEnv("DEEPSEEK_MODEL", "");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-python-harness-presence-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
describe("Harness resource capability composition", () => {
  it.each(["json", "sse"] as const)("%s passes the real missing-resource gate to Agent tools and recognizes later installation", async (transport) => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const resolveCapabilities = capabilityComposition.getNotebookCapabilities;
    // Only the deployment root is injected; the presence checks are real filesystem calls.
    vi.spyOn(capabilityComposition, "getNotebookCapabilities").mockImplementation((options) => resolveCapabilities({ ...options, rootDirectory: root }));
    const catalogues: string[][] = [];
    const run = vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(async (raw, options): Promise<HarnessTaskSummary> => {
      const request = harnessRequestSchema.parse(raw);
      catalogues.push(harnessToolCatalog({ request, names: ["cellSearch", "createPythonCell", "getKernelPackagesInfo"], notebookCapabilities: options.notebookCapabilities }).map((tool) => tool.name));
      return {
        ...createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role, {
          now: () => new Date("2026-09-21T00:00:00.000Z"),
          id: () => "resource_capability_fixture_event",
        }),
        state: "failed",
        error: "synthetic no-model fixture",
        resultMessage: "No model call or execution",
      };
    });
    const fetchSpy = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", fetchSpy);
    const route = transport === "json" ? POST : streamPOST;
    async function call(suffix: string) {
      if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
      const response = await route(new Request(`http://127.0.0.1:3001/api/ai/harness${transport === "sse" ? "/stream" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey: `resource_gate_${transport}_${suffix}`, instruction: "检查 Python 单元", pageId: "page_home", appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [],
        notebookContext: { sourceIds: [], document: { name: "Preserved notebook", revision: 0, cells: [] } },
      }) }));
      expect(response.status).toBe(200);
      return transport === "json" ? harnessResponseSchema.parse(await response.json()) : readHarnessStream(response, new AbortController().signal);
    }
    await call("missing");
    expect(run.mock.calls[0][1].notebookCapabilities).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("未包含 Python 资源") } });
    expect(catalogues[0]).toEqual(["cellSearch"]);
    mkdirSync(join(root, "vendor", "python"), { recursive: true }); writeFileSync(join(root, "vendor", "python", "runtime-lock.json"), "presence only; no runtime executed");
    await call("restored");
    expect(run.mock.calls[1][1].notebookCapabilities).toMatchObject({ python: { enabled: true } });
    expect(catalogues[1]).toEqual(expect.arrayContaining(["cellSearch", "createPythonCell", "getKernelPackagesInfo"]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
