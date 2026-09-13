import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessModel, HarnessRequest } from "../contracts";
import { buildHarnessContextSelection } from "../context-selector";
import { DeepSeekHarness } from "../deepseek-harness";
import { executeHarnessTool, harnessToolCatalog } from "../tool-registry";
import { harnessMcpServerConfigSchema, type HarnessMcpRuntime, type HarnessMcpToolSummary } from "./contracts";
import { AgentCanvasMcpRuntime, loadHarnessMcpConfig, resolveHarnessMcpToolPolicy, validateHarnessMcpHttpUrl } from "./runtime";

const readTool: HarnessMcpToolSummary = {
  serverId: "inventory",
  name: "records/list",
  description: "列出库存记录",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
  },
  annotations: { readOnlyHint: true },
  policy: "readOnly",
};

function request(): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_mcp_integration",
    instruction: "请通过库存连接器查询最新记录",
    pageId: "page_home",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes),
    role: "editor",
    mcpTools: [readTool],
  };
}

function server(overrides: Record<string, unknown> = {}) {
  return harnessMcpServerConfigSchema.parse({
    id: "inventory",
    transport: { type: "http", url: "https://mcp.example.com/mcp" },
    ...overrides,
  });
}

describe("Harness MCP 集成", () => {
  it("只在启用后读取受限配置，且不会要求配置内保存密钥", async () => {
    expect(await loadHarnessMcpConfig({ NODE_ENV: "test" })).toBeUndefined();
    const config = await loadHarnessMcpConfig({
      NODE_ENV: "test",
      HARNESS_MCP_ENABLED: "1",
      HARNESS_MCP_CONFIG_JSON: JSON.stringify({
        version: 1,
        servers: [{
          id: "inventory",
          transport: { type: "http", url: "https://mcp.example.com/mcp", bearerTokenEnvVar: "INVENTORY_TOKEN" },
          enabledTools: ["records/list"],
        }],
      }),
    });
    expect(config?.servers[0]).toMatchObject({ id: "inventory", defaultPolicy: "readOnly", allowDestructive: false });
  });

  it("拒绝非回环 HTTP 和 URL 内嵌凭据", () => {
    expect(() => validateHarnessMcpHttpUrl("http://mcp.example.com/mcp")).toThrow(/HTTPS/);
    expect(() => validateHarnessMcpHttpUrl("https://user:pass@mcp.example.com/mcp")).toThrow(/账号或密码/);
    expect(validateHarnessMcpHttpUrl("http://127.0.0.1:3100/mcp").hostname).toBe("127.0.0.1");
  });

  it("默认只开放明确标记为只读的工具，破坏性和开放世界能力需要额外授权", () => {
    const readonly = { name: "records/list", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } } as Tool;
    const unlabelled = { name: "records/write", inputSchema: { type: "object" } } as Tool;
    const destructive = { name: "records/delete", inputSchema: { type: "object" }, annotations: { destructiveHint: true } } as Tool;
    const openWorld = { name: "web/fetch", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: true } } as Tool;
    expect(resolveHarnessMcpToolPolicy(server(), readonly)).toBe("readOnly");
    expect(resolveHarnessMcpToolPolicy(server(), unlabelled)).toBe("disabled");
    expect(resolveHarnessMcpToolPolicy(server({ defaultPolicy: "trusted" }), destructive)).toBe("disabled");
    expect(resolveHarnessMcpToolPolicy(server({
      defaultPolicy: "trusted",
      allowDestructive: true,
    }), destructive)).toBe("trusted");
    expect(resolveHarnessMcpToolPolicy(server(), openWorld)).toBe("disabled");
  });

  it("将获准 MCP 能力纳入 Planner，并只向模型展开已发现工具的参数 Schema", () => {
    const input = request();
    const semanticIntent = {
      mode: "readOnlyTask" as const,
      requiresVisualVerification: false,
      wantsData: false,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: false,
      wantsExcel: false,
      wantsMcpTool: true,
      changeAction: "none" as const,
      changeTarget: "none" as const,
      componentKind: "none" as const,
      chartType: "auto" as const,
      skillIds: [],
      confidence: 0.98,
      rationale: "用户目标需要库存连接器。",
    };
    const selection = buildHarnessContextSelection(input, [], 1, false, undefined, undefined, [], [], semanticIntent);
    const [tool] = harnessToolCatalog({ names: selection.toolNames, mcpTools: input.mcpTools });
    expect(selection.toolNames).toEqual(["callMcpTool"]);
    expect(tool).toMatchObject({ name: "callMcpTool", mode: "external" });
    expect(JSON.stringify(tool.parameters)).toContain('"const":"records/list"');
    expect(JSON.stringify(tool.parameters)).not.toContain("mcp.example.com");
  });

  it("通过受控 Runtime 执行 MCP 调用并把结果交给统一工具压缩链", async () => {
    const call = vi.fn(async () => ({
      summary: "库存查询完成",
      data: { serverId: "inventory", toolName: "records/list", content: [{ type: "text", text: "共 3 条" }] },
    }));
    const runtime: HarnessMcpRuntime = {
      catalog: () => [readTool],
      call,
      diagnostics: () => [{ serverId: "inventory", status: "connected", message: "1 个工具可用" }],
      close: async () => undefined,
    };
    const input = request();
    const result = await executeHarnessTool("callMcpTool", {
      serverId: "inventory",
      toolName: "records/list",
      arguments: { limit: 3 },
    }, {
      request: input,
      dataRuntime: { rowsByDataSourceId: {} },
      now: () => 1,
      id: () => "mcp_call",
      mcpRuntime: runtime,
    });
    expect(call).toHaveBeenCalledWith({ serverId: "inventory", toolName: "records/list", arguments: { limit: 3 } }, undefined);
    expect(result.summary).toBe("库存查询完成");
  });

  it("通过官方 SDK 完成真实 STDIO 握手、工具发现和调用", async () => {
    const config = {
      version: 1 as const,
      servers: [server({
        required: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/readonly-server.mjs", import.meta.url))],
        },
      })],
    };
    const runtime = await AgentCanvasMcpRuntime.connect(config, {
      ...process.env,
      HARNESS_MCP_ALLOW_STDIO: "1",
    });
    try {
      expect(runtime.catalog()).toEqual([expect.objectContaining({
        serverId: "inventory",
        name: "records/list",
        policy: "readOnly",
      })]);
      const result = await runtime.call({
        serverId: "inventory",
        toolName: "records/list",
        arguments: { limit: 3 },
      });
      expect(result.data).toMatchObject({
        structuredContent: { returned: 3 },
        content: [{ type: "text", text: "returned:3" }],
      });
    } finally {
      await runtime.close();
    }
  });

  it("在完整 Harness 中由语义路由选择 MCP，并经 Executor、Evidence Bus 和 Verifier 后完成", async () => {
    const input = request();
    const call = vi.fn(async () => ({
      summary: "库存查询完成",
      data: { serverId: "inventory", toolName: "records/list", content: [{ type: "text", text: "共 3 条" }] },
    }));
    const runtime: HarnessMcpRuntime = {
      catalog: () => [readTool],
      call,
      diagnostics: () => [{ serverId: "inventory", status: "connected", message: "1 个工具可用" }],
      close: async () => undefined,
    };
    const model: HarnessModel = {
      classifyIntent: async ({ mcpTools }) => ({
        decision: {
          mode: "readOnlyTask",
          requiresVisualVerification: false,
          wantsData: false,
          wantsEdsAnalysis: false,
          wantsRawWorkbook: false,
          wantsFields: false,
          wantsRecipe: false,
          wantsAppInspection: false,
          wantsExcel: false,
          wantsMcpTool: true,
          changeAction: "none",
          changeTarget: "none",
          componentKind: "none",
          chartType: "auto",
          skillIds: [],
          confidence: 0.99,
          rationale: `发现 ${mcpTools?.length ?? 0} 个匹配工具。`,
        },
        model: "mock-model",
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        inputChars: 100,
      }),
      next: async ({ iteration }) => iteration === 1
        ? {
            turn: {
              type: "callTool",
              message: "查询库存记录",
              toolCallId: "mcp_inventory",
              name: "callMcpTool",
              arguments: { serverId: "inventory", toolName: "records/list", arguments: { limit: 3 } },
            },
            model: "mock-model",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          }
        : {
            turn: { type: "complete", message: "库存连接器返回 3 条记录。" },
            model: "mock-model",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          },
    };
    const task = await new DeepSeekHarness().run(input, {
      dataRuntime: { rowsByDataSourceId: {} },
      modelClient: model,
      mcpRuntime: runtime,
    });
    expect(task).toMatchObject({ state: "completed", terminationCode: "completed" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(task.events.some((event) => event.toolCall?.name === "callMcpTool" && event.toolCall.status === "success")).toBe(true);
    expect(task.evidence?.records.some((record) => record.kind === "toolObservation" && record.source === "callMcpTool")).toBe(true);
  });
});
