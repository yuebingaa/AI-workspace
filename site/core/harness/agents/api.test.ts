import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { POST } from "@/app/api/ai/harness/route";
import { harnessResponseSchema } from "../contracts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("multi-agent API integration", () => {
  it("uses the server switch and real provider adapter, returning one valid public receipt", async () => {
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "data");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    vi.stubEnv("HARNESS_MCP_ENABLED", "0");
    vi.stubEnv("WECOM_ENABLED", "0");
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const { dataProduct } = structuredClone(demoFixtureResult.data);
    const inputs: Array<Record<string, unknown>> = [];
    const turns = [
      { type: "callTool", name: "delegateDataTask", arguments: {}, toolCallId: "delegate_1", message: "委派数据检查" },
      { type: "callTool", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" }, toolCallId: "read_1", message: "读取数据" },
      { type: "callTool", name: "inspectFields", arguments: { dataSourceId: "dataset_retail_orders" }, toolCallId: "read_2", message: "检查字段" },
      { type: "complete", message: "已经检查零售数据概况与字段，建议先复核空值再汇总。" },
      { type: "complete", message: "根据本轮数据与字段检查，建议优先复核空值并确认分析口径。" },
    ];
    const provider = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      inputs.push(JSON.parse(body.messages[1].content));
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(turns[inputs.length - 1]) } }],
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } });
    });
    vi.stubGlobal("fetch", provider);
    const response = await POST(new Request("http://127.0.0.1:3001/api/ai/harness", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "multi_agent_api_first", conversation_id: "multi_agent_api_conversation",
        instruction: "检查零售数据，进行字段分析并核对空值，给出具体结论。", pageId: "page_home",
        appSpec: dataProduct.appSpec, recipes: dataProduct.recipes }) }));
    expect(response.status).toBe(200);
    const { task } = harnessResponseSchema.parse(await response.json());
    expect(task.state, task.error).toBe("completed");
    expect(task.delegation?.children[0].verification).toBe("passed");
    expect(inputs.map((input) => input.agentRole)).toEqual(["coordinator", "data", "data", "data", "coordinator"]);
    expect(task.trace?.every((event, index) => event.sequence === index + 1)).toBe(true);
  });
});
