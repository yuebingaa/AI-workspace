import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { DeepSeekHarness } from "@/core/harness/deepseek-harness";
import { createHarnessTask } from "@/core/harness/task-state";
import { readHarnessStream } from "@/core/harness/stream";
import { type HarnessTraceEvent, harnessRequestSchema } from "@/core/harness/contracts";
import { POST } from "./route";

function payload() {
  if (!demoFixtureResult.success) throw new Error("fixtures unavailable");
  return { idempotencyKey: "route_stream_" + crypto.randomUUID().replaceAll("-", ""), instruction: "你好，介绍你能做的工作", pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: demoFixtureResult.data.dataProduct.recipes };
}
function request(body: unknown) { return new Request("http://localhost/api/ai/harness/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("POST /api/ai/harness/stream", () => {
  it("keeps public schema and uploaded-data privacy checks before opening the stream", async () => {
    const spy = vi.spyOn(DeepSeekHarness.prototype, "run");
    expect((await POST(request({ ...payload(), role: "admin" }))).status).toBe(400);
    const input = payload();
    input.appSpec = structuredClone(input.appSpec);
    input.appSpec.dataSources[0] = { ...input.appSpec.dataSources[0], id: "dataset_upload_unavailable_stream", sourceType: "csv" };
    const response = await POST(request(input));
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(spy).not.toHaveBeenCalled();
  });
  it("returns an open SSE response before completion and replays the same request without reexecution", async () => {
    vi.stubEnv("HARNESS_MCP_ENABLED", "false");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(DeepSeekHarness.prototype, "run").mockImplementation(async (raw, options) => {
      const input = harnessRequestSchema.parse(raw);
      const task = createHarnessTask(input.idempotencyKey, input.instruction, input.pageId, input.role, { now: () => new Date(), id: () => "route_event" });
      const event: HarnessTraceEvent = { id: `${task.id}:1`, sequence: 1, taskId: task.id, timestamp: task.createdAt, type: "task_started", message: "任务已开始" };
      options.onEvent?.(event);
      await gate;
      return { ...task, state: "completed", resultMessage: "已完成", trace: [event] };
    });
    const input = payload();
    const response = await POST(request(input));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const events: HarnessTraceEvent[] = [];
    const result = readHarnessStream(response, new AbortController().signal, (event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const duplicate = await POST(request(input));
    release();
    expect((await result).task.state).toBe("completed");
    expect((await readHarnessStream(duplicate, new AbortController().signal)).task.resultMessage).toBe("已完成");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
