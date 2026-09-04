import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  LIVE_EVALUATION_CASE_HEADER,
  LIVE_EVALUATION_NONCE_ENV,
  LIVE_EVALUATION_NONCE_HEADER,
  LIVE_EVALUATION_RUN_HEADER,
  LIVE_EVALUATION_RUNNER_FLAG,
  LIVE_EVALUATION_SERVER_FLAG,
  LIVE_EVALUATION_SESSION_HEADER,
  LIVE_EVALUATION_SESSION_VALUE,
} from "@/core/evaluation/live/protocol";
import { findLiveHarnessCase } from "@/core/evaluation/live/manifest";
import { runLiveHarnessEvaluation } from "@/core/evaluation/live/harness-live-runner";
import {
  EDS_OVERVIEW_DATA_SOURCE_ID,
  EDS_RULE_VERSION,
  EDS_TEMPLATE_VERSION,
  EDS_WORKSPACE_PAGE_ID,
  installEdsWorkspaceInDataProduct,
  type EdsWorkspaceSnapshot,
} from "@/core/eds";
import { POST } from "./route";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe("Harness 上传数据隐私门", () => {
  beforeEach(() => {
    datasetRepository.clear();
    aiPlannerRateLimiter.clear();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_MODEL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 408, cancels a stalled request body once, and skips the model", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    const cancel = vi.fn();
    const controller = new AbortController();
    vi.stubGlobal("fetch", modelFetch);
    const request = new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });

    const responsePromise = POST(request);
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("拒绝可绕过跨源预检的非 JSON 请求", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }));

    expect(response.status).toBe(415);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });

  function liveRequest(
    caseId = "dataset-summary",
    options: { nonce?: string; omitNonce?: boolean; url?: string } = {},
  ) {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const evaluationCase = findLiveHarnessCase(caseId);
    if (!evaluationCase) throw new Error("缺少 Live 评测 fixture");
    const nonce = options.nonce ?? "a".repeat(64);
    const headers = new Headers({
      "content-type": "application/json",
      [LIVE_EVALUATION_SESSION_HEADER]: LIVE_EVALUATION_SESSION_VALUE,
      [LIVE_EVALUATION_CASE_HEADER]: evaluationCase.id,
      [LIVE_EVALUATION_RUN_HEADER]: "b".repeat(32),
    });
    if (!options.omitNonce) headers.set(LIVE_EVALUATION_NONCE_HEADER, nonce);
    return new Request(options.url ?? "http://127.0.0.1/api/ai/harness", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: `live_${"b".repeat(32)}_${evaluationCase.id.replaceAll("-", "_")}`,
        ...evaluationCase.request,
        appSpec: demoFixtureResult.data.dataProduct.appSpec,
        recipes: demoFixtureResult.data.dataProduct.recipes,
      }),
    });
  }

  it("Live 请求缺少服务端开关、nonce 或密钥配置时不会调用模型", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);

    expect((await POST(liveRequest())).status).toBe(403);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    expect((await POST(liveRequest("dataset-summary", { omitNonce: true }))).status).toBe(403);
    expect((await POST(liveRequest("dataset-summary", { nonce: "c".repeat(64) }))).status).toBe(403);
    expect((await POST(liveRequest())).status).toBe(503);
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    expect((await POST(liveRequest())).status).toBe(503);
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["空值", ""],
    ["过短", "short"],
    ["过长", "a".repeat(65)],
    ["长度不一致", "b".repeat(63)],
  ])("Live nonce %s 时安全拒绝且不调用模型", async (_label, nonce) => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");

    const response = await POST(liveRequest("dataset-summary", { nonce }));
    expect(response.status).toBe(403);
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });

  it.each([
    "deepseek-v4-flash\nINJECTED",
    "deepseek-v4-flash`injected",
    "deepseek-v4-flash<script>",
    "deepseek v4 flash",
  ])("Live 服务端拒绝不安全的可信 model 配置且模型 fetch 为 0", async (configuredModel) => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", configuredModel);

    const response = await POST(liveRequest());
    expect(response.status).toBe(503);
    expect(modelFetch).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(await response.json())).not.toContain(configuredModel);
  });

  it("Live provider model 与可信配置不一致时安全失败且不回显原值", async () => {
    const providerModelCanary = "FAKE_LIVE_SECRET_CANARY_7D2C";
    const modelFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: providerModelCanary,
      choices: [{ message: { content: JSON.stringify({ type: "complete", message: "完成。" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");

    const response = await POST(liveRequest());
    const body = await response.json() as { task: { state: string; terminationCode?: string } };
    expect(response.status).toBe(200);
    expect(body.task).toMatchObject({ state: "failed", terminationCode: "protocolViolation" });
    expect(JSON.stringify(body)).not.toContain(providerModelCanary);
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("Live 请求拒绝非 loopback 地址且不跟随到模型", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", "mock-deepseek-chat");

    const response = await POST(liveRequest("dataset-summary", { url: "http://192.168.1.8/api/ai/harness" }));
    expect(response.status).toBe(403);
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });

  it("Live 路由使用服务端模型配置和单用例上限，不把完整数据行发送给模型", async () => {
    const turns = [
      { type: "callTool", message: "检查数据集。", toolCallId: "live_dataset_call", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" } },
      { type: "complete", message: "数据集摘要完成。" },
    ];
    let call = 0;
    const modelFetch = vi.fn<typeof fetch>(async () => {
      const turn = turns[call++];
      return new Response(JSON.stringify({
        model: "mock-deepseek-chat",
        choices: [{ message: { content: JSON.stringify(turn) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", "mock-deepseek-chat");

    const response = await POST(liveRequest());
    const body = await response.json() as { task: { state: string; model?: string; counters: { modelCallCount: number; toolCallCount: number } } };
    expect(response.status).toBe(200);
    expect(body.task).toMatchObject({
      state: "completed",
      model: "mock-deepseek-chat",
      counters: { modelCallCount: 2, toolCallCount: 1 },
    });
    expect(modelFetch).toHaveBeenCalledTimes(2);
    for (const invocation of modelFetch.mock.calls) {
      const outbound = JSON.parse(String(invocation[1]?.body)) as { max_tokens: number; model: string; messages: Array<{ content: string }> };
      expect(outbound.max_tokens).toBe(400);
      expect(outbound.model).toBe("mock-deepseek-chat");
      expect(JSON.stringify(outbound.messages)).not.toContain("rowsByDataSourceId");
      expect(JSON.stringify(outbound.messages)).not.toContain("2026-01-06");
    }
  });

  it("Mock HTTP Runner 通过现有 API 与服务端模型适配器完成固定三用例", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const formalBefore = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
    const turns = [
      { type: "callTool", message: "检查数据集。", toolCallId: "live_summary_dataset", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" } },
      { type: "complete", message: "数据集摘要检查完成。" },
      { type: "callTool", message: "检查数据集。", toolCallId: "live_recipe_dataset", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" } },
      {
        type: "callTool",
        message: "检查配方字段。",
        toolCallId: "live_recipe_fields",
        name: "inspectFields",
        arguments: {
          dataSourceId: "dataset_retail_orders",
          fields: ["region", "category", "revenue", "repurchase_rate", "anomaly_count"],
        },
      },
      { type: "callTool", message: "预览配方。", toolCallId: "live_recipe_preview", name: "previewDataRecipe", arguments: { recipeId: "recipe_east_anomalies" } },
      { type: "complete", message: "华东异常订单配方预览完成。" },
      {
        type: "callTool",
        message: "生成待确认标题变更。",
        toolCallId: "live_title_preview",
        name: "createChangeSetPreview",
        arguments: {
          message: "建议将指标标题改为月度总收入。",
          operations: [{
            type: "updateNodeProps",
            pageId: "page_home",
            nodeId: "page_home_revenue",
            props: { label: "月度总收入" },
          }],
        },
      },
    ];
    let modelCall = 0;
    const modelFetch = vi.fn<typeof fetch>(async () => {
      const turn = turns[modelCall++];
      return new Response(JSON.stringify({
        model: "mock-deepseek-chat",
        choices: [{ message: { content: JSON.stringify(turn) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", modelFetch);
    vi.stubEnv(LIVE_EVALUATION_SERVER_FLAG, "1");
    vi.stubEnv(LIVE_EVALUATION_NONCE_ENV, "a".repeat(64));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-live-route-test");
    vi.stubEnv("DEEPSEEK_MODEL", "mock-deepseek-chat");
    const stop = vi.fn(async () => undefined);
    const localHttpFetch = vi.fn<typeof fetch>(async (input, init) => POST(new Request(input, init)));

    const report = await runLiveHarnessEvaluation({
      environment: { NODE_ENV: "test", [LIVE_EVALUATION_RUNNER_FLAG]: "1" },
      nonceFactory: () => "a".repeat(64),
      runIdFactory: () => "d".repeat(32),
      gitCommit: "e".repeat(40),
      fetchImpl: localHttpFetch,
      serverFactory: async () => ({ baseUrl: "http://127.0.0.1", stop }),
    });

    expect(report.passed).toBe(true);
    expect(report.cases.map((item) => [item.terminalState, item.toolSequence])).toEqual([
      ["completed", ["inspectDataset"]],
      ["completed", ["inspectDataset", "inspectFields", "previewDataRecipe"]],
      ["awaitingConfirmation", ["createChangeSetPreview"]],
    ]);
    expect(report.budget.used).toMatchObject({ modelCalls: 7, promptTokens: 700, completionTokens: 140 });
    expect(modelFetch).toHaveBeenCalledTimes(7);
    expect(localHttpFetch).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(demoFixtureResult.data.dataProduct.appSpec).toEqual(formalBefore);
    for (const invocation of modelFetch.mock.calls) {
      expect(String(invocation[1]?.body)).not.toContain("rowsByDataSourceId");
      expect(String(invocation[1]?.body)).not.toContain("2026-01-06");
    }
  });

  it("拒绝客户端身份字段，并为合法公共请求注入服务端 editor 角色", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const fixture = demoFixtureResult.data.dataProduct;
    const publicRequest = {
      idempotencyKey: "request_server_identity_001",
      instruction: "检查零售数据。",
      pageId: "page_home",
      appSpec: fixture.appSpec,
      recipes: fixture.recipes,
    };
    const rejected = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...publicRequest,
        role: "admin",
        tenantId: "fake_tenant",
        ownerId: "fake_owner",
        userId: "fake_user",
      }),
    }));
    expect(rejected.status).toBe(400);

    const accepted = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicRequest),
    }));
    const body = await accepted.json() as { task: { role: string } };
    expect(accepted.status).toBe(200);
    expect(body.task.role).toBe("editor");
  });

  it("敏感字段未确认时拒绝把上传数据摘要交给模型", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("email,value\nsynthetic-private@example.invalid,1"),
      originalFileName: "synthetic-private.csv",
      mimeType: "text/csv",
      id: () => `a${String(++sequence).padStart(31, "0")}`,
    });
    await datasetRepository.put(resolveDemoRequestIdentity(), uploaded);
    const fixture = demoFixtureResult.data.dataProduct;
    const body = {
      idempotencyKey: "request_pending_sensitive_001",
      instruction: "检查 private 数据集字段。",
      pageId: "page_home",
      dataSourceId: uploaded.dataset.datasetId,
      appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
      recipes: [...fixture.recipes, uploaded.dataset.recipe],
    };
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("敏感字段");
  });

  it("拒绝读取其他所有者的数据集", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("region,value\n区域甲,1"),
      originalFileName: "other-owner.csv",
      mimeType: "text/csv",
      id: () => `b${String(++sequence).padStart(31, "0")}`,
    });
    await datasetRepository.put({ tenantId: "tenant_demo_local", ownerId: "owner_other" }, uploaded);
    const fixture = demoFixtureResult.data.dataProduct;
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "request_other_owner_001",
        instruction: "检查数据集。",
        pageId: "page_home",
        dataSourceId: uploaded.dataset.datasetId,
        appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
        recipes: [...fixture.recipes, uploaded.dataset.recipe],
      }),
    }));

    expect(response.status).toBe(410);
  });

  it("服务端仅凭受控 EDS 汇总重建 AI 运行数据，并拒绝缺少汇总的保留数据源", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const edsWorkspace: EdsWorkspaceSnapshot = {
      version: 1,
      generatedAt: "2026-09-04T03:30:00.000Z",
      summary: {
        date: "2026-08-25",
        shift: "白班",
        inputRows: 100,
        matchedRows: 5,
        issueCount: 14,
        channelCount: 20,
        totalOccurrences: 5,
        totalMinutes: 8,
      },
      issueSummary: Array.from({ length: 14 }, (_, index) => ({
        label: index === 0 ? "飞达工位飞达报警中" : `合成异常 ${index + 1}`,
        count: index === 0 ? 5 : 0,
        minutes: index === 0 ? 8 : 0,
      })),
      lineSummary: [{ label: "A5FNL01", count: 5, minutes: 8 }],
      configuration: { templateVersion: EDS_TEMPLATE_VERSION, ruleVersion: EDS_RULE_VERSION },
    };
    const product = installEdsWorkspaceInDataProduct(demoFixtureResult.data.dataProduct, edsWorkspace);
    const publicRequest = {
      idempotencyKey: "request_eds_server_context_001",
      instruction: "检查 EDS 分析字段和示例值，不要修改页面。",
      pageId: EDS_WORKSPACE_PAGE_ID,
      dataSourceId: EDS_OVERVIEW_DATA_SOURCE_ID,
      appSpec: product.appSpec,
      recipes: product.recipes,
    };
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);

    const rejected = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicRequest),
    }));
    expect(rejected.status).toBe(400);
    expect(modelFetch).not.toHaveBeenCalled();

    const turns = [
      { type: "callTool", message: "读取 EDS 派生报告。", toolCallId: "eds_reports", name: "analyzeEdsReports", arguments: {} },
      { type: "callTool", message: "检查最高异常字段。", toolCallId: "eds_fields", name: "inspectFields", arguments: { dataSourceId: EDS_OVERVIEW_DATA_SOURCE_ID, fields: ["top_line", "top_line_occurrences", "top_issue", "top_issue_minutes"] } },
      { type: "complete", message: "EDS 派生汇总检查完成。" },
    ];
    let call = 0;
    modelFetch.mockImplementation(async () => new Response(JSON.stringify({
      model: "deepseek-chat",
      choices: [{ message: { content: JSON.stringify(turns[call++]) } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-eds-context-test");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-chat");

    const accepted = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...publicRequest, idempotencyKey: "request_eds_server_context_002", edsWorkspace }),
    }));
    const body = await accepted.json() as { task: { state: string; counters: { toolCallCount: number } } };

    expect(accepted.status).toBe(200);
    expect(body.task, JSON.stringify(body)).toMatchObject({ state: "completed", counters: { toolCallCount: 2 } });
    expect(modelFetch).toHaveBeenCalledTimes(3);
    const outbound = modelFetch.mock.calls.map((invocation) => String(invocation[1]?.body)).join("\n");
    expect(outbound).toContain("A5FNL01");
    expect(outbound).toContain("飞达工位飞达报警中");
    expect(outbound).toContain("deltaFromFirst");
    expect(outbound).not.toContain("rowsByDataSourceId");
  });

  it("数据集在初次加载后被删除时，模型调用边界会再次拒绝", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    vi.stubEnv("DEEPSEEK_API_KEY", "fixed-fake-key-for-revocation-test");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-chat");
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("region,value\n区域甲,1"),
      originalFileName: "revoked-before-model.csv",
      mimeType: "text/csv",
      id: () => `c${String(++sequence).padStart(31, "0")}`,
    });
    const identity = resolveDemoRequestIdentity();
    await datasetRepository.put(identity, uploaded);
    const originalAssert = datasetRepository.assertAiAccessPolicies.bind(datasetRepository);
    vi.spyOn(datasetRepository, "assertAiAccessPolicies").mockImplementationOnce((ownership, expected) => {
      void datasetRepository.delete(ownership, uploaded.dataset.datasetId);
      originalAssert(ownership, expected);
    });
    const fixture = demoFixtureResult.data.dataProduct;
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "request_revoked_before_model_001",
        instruction: "检查上传数据集是否可用。",
        pageId: "page_home",
        dataSourceId: uploaded.dataset.datasetId,
        appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
        recipes: [...fixture.recipes, uploaded.dataset.recipe],
      }),
    }));
    const payload = await response.json() as { task: { state: string; error?: string } };

    expect(response.status).toBe(200);
    expect(payload.task.state).toBe("failed");
    expect(payload.task.error).toContain("已被删除、过期或更改");
    expect(modelFetch).not.toHaveBeenCalled();
  });
});
