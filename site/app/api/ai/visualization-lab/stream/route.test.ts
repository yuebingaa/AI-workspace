import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatedHarness } from "@/core/harness/agents/coordinator";
import { harnessRequestSchema } from "@/core/harness/contracts";
import * as mcp from "@/core/wecom/server/runtime";
import { createLabAppSpec, createLabRequest, LAB_PAGE_ID } from "@/core/visualization-lab/cases";
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const url = "http://127.0.0.1:3001/api/ai/visualization-lab/stream";

describe("visualization lab server isolation", () => {
  it("rebuilds the synthetic context, excludes history, MCP and unrelated screenshot evidence", async () => {
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "data");
    vi.stubEnv("HARNESS_VISUAL_VERIFICATION_ENABLED", "1");
    vi.stubEnv("HARNESS_VISION_API_KEY", "test-only");
    vi.stubEnv("HARNESS_VISION_MODEL", "test-only");
    vi.stubEnv("HARNESS_VISION_API_URL", "invalid-capture-must-not-be-instantiated");
    const external = vi.spyOn(mcp, "createRequestMcpRuntime");
    const run = vi.spyOn(CoordinatedHarness.prototype, "run").mockImplementation(async (raw) => {
      const request = harnessRequestSchema.parse(raw);
      return {
      id: `harness_${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey, instruction: request.instruction,
      pageId: request.pageId, role: request.role, state: "blocked", events: [],
      createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
      counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 }, resultMessage: "受控测试结束。",
    }; });
    const payload = { ...createLabRequest("生成一张图表", "lab_api_isolation"), conversation_id: "workbench_history" };
    payload.appSpec.pages[0].title = "client-defined page";
    payload.appSpec.pages[0].id = "private_workbench_page";
    payload.appSpec.navigation[0].pageId = "private_workbench_page";
    payload.pageId = "private_workbench_page";
    const response = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"pageId":"page_visualization_lab"');
    expect(run).toHaveBeenCalledOnce();
    const [raw, options] = run.mock.calls[0];
    const request = harnessRequestSchema.parse(raw);
    expect(request.appSpec).toEqual(createLabAppSpec());
    expect(request.pageId).toBe(LAB_PAGE_ID);
    expect(request.conversation_id).toBeUndefined();
    expect(request.conversationContext).toBeUndefined();
    expect(request.notebookContext).toBeUndefined();
    expect(options.agentMode).toBe("single");
    expect(options.visualVerifier).toBeUndefined();
    expect(options.mcpRuntime).toBeUndefined();
    expect(Object.keys(options.dataRuntime.rowsByDataSourceId)).toEqual(["dataset_retail_orders"]);
    expect(external).not.toHaveBeenCalled();
  });

  it("rejects project-bearing and upload requests before any model execution", async () => {
    const run = vi.spyOn(CoordinatedHarness.prototype, "run");
    const project = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-agentcanvas-project": "private-project" }, body: "{}" }));
    expect(project.status).toBe(400);
    const upload = await POST(new Request(url, { method: "POST", body: new FormData() }));
    expect(upload.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
});
