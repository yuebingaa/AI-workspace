import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import * as connections from "@/core/connections/server/config";
import { HarnessRuntime } from "@/core/harness/runtime";
import { harnessRequestSchema, harnessResponseSchema, type HarnessPublicRequest, type HarnessRequest } from "@/core/harness/contracts";
import { readHarnessStream } from "@/core/harness/stream";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";

function payload(): HarnessPublicRequest {
  return { idempotencyKey: `selection_api_${crypto.randomUUID()}`, instruction: "解释这些", pageId: "page_home",
    appSpec: semanticFixture().product.appSpec, recipes: [], notebookContext: { sourceIds: [], selectedCellIds: ["threshold"], document: {
      name: "合成选择", revision: 2, cells: [{ id: "threshold", kind: "parameter", title: "阈值", outputName: "thresholds", parameter: { type: "number", value: 7 } }],
    } } };
}
function post(body: unknown, transport: "json" | "sse") {
  return (transport === "sse" ? streamPOST : POST)(new Request(`http://127.0.0.1/api/ai/harness${transport === "sse" ? "/stream" : ""}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

beforeEach(() => {
  datasetRepository.clear();
  vi.stubEnv("DEEPSEEK_API_KEY", ""); vi.stubEnv("DEEPSEEK_MODEL", "");
  vi.stubEnv("HARNESS_MCP_ENABLED", "false"); vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
  vi.spyOn(connections, "listConnections").mockReturnValue([]);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("真实网络在选择验收中被禁止"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("JSON / SSE 当前 Notebook 焦点边界", () => {
  it.each(["json", "sse"] as const)("%s 在模型前拒绝错误 ID 和伪造的运行上下文", async (transport) => {
    const run = vi.spyOn(HarnessRuntime.prototype, "run");
    for (const extra of [
      { selectedCellIds: ["old_cell"] }, { selectedCellIds: ["threshold", "threshold"] }, { selectedCellIds: ["../outside"] },
      { selectedCellIds: Array.from({ length: 11 }, (_, index) => `cell_${index}`) },
      { selectedCellIds: ["threshold"], results: { threshold: { rows: [{ value: 999 }], runId: "fake" } } },
    ]) {
      const request = payload();
      const response = await post({ ...request, notebookContext: { ...request.notebookContext, ...extra } }, transport);
      expect(response.status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["json", "sse"] as const)("%s 保留真实选择，并用服务端连接目录替换客户端权限", async (transport) => {
    const request = payload(); request.notebookContext!.connections = [{ id: "client_claim", name: "伪造连接", kind: "postgresql", allowAi: true }];
    const received: HarnessRequest[] = [], originalRun = HarnessRuntime.prototype.run;
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(async (raw, options) => {
      const checked = harnessRequestSchema.parse(raw); received.push(checked);
      return originalRun.call(new HarnessRuntime(), checked, { ...options, notebookRunner: async () => { throw new Error("选择不能运行"); }, modelClient: {
        next: async ({ iteration, tools }) => {
          expect(tools.map((tool) => tool.name)).toEqual(["cellSearch"]);
          return { model: "synthetic-api-selection", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            turn: iteration === 1 ? { type: "callTool", name: "cellSearch", arguments: { cellId: "threshold", view: "source" }, toolCallId: "selected_source", message: "读取当前定义" }
              : { type: "complete", message: "该参数定义为 7，本次未运行 Notebook。" } };
        },
      } });
    });
    const response = await post(request, transport); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal) : harnessResponseSchema.parse(await response.json());
    expect(result.task.state, result.task.error).toBe("completed"); expect(result.task.counters.toolCallCount).toBe(1);
    expect(result.task.notebookArtifact).toBeUndefined(); expect(received).toHaveLength(1);
    expect(received[0].notebookContext).toEqual({ ...request.notebookContext, connections: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["pending", "other-owner", "missing"] as const)("选中参数不能绕过 Notebook 来源的 %s 边界", async (state) => {
    const bytes = new TextEncoder().encode("email,value\nsynthetic@example.invalid,1");
    const uploaded = await parseCsvUpload({ stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      originalFileName: "synthetic-selection.csv", mimeType: "text/csv" });
    expect(uploaded.dataset.aiAccessPolicy).toBe("pending");
    if (state !== "missing") await datasetRepository.put(state === "other-owner"
      ? { tenantId: "tenant_demo_local", ownerId: "owner_other" } : resolveDemoRequestIdentity(), uploaded);
    const request = payload(); request.notebookContext!.sourceIds = [uploaded.dataset.datasetId];
    request.appSpec.dataSources.push(uploaded.dataset.source);
    const run = vi.spyOn(HarnessRuntime.prototype, "run");
    for (const transport of ["json", "sse"] as const) {
      const response = await post(request, transport);
      expect(response.status).toBe(state === "pending" ? 403 : 410);
    }
    expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
