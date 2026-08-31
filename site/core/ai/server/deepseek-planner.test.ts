import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createChangeSetAuditRecord } from "@/core/audit";
import { applyChangeSet, createExecutionState, previewChangeSet, undoLastChange } from "@/core/changesets";
import { redactedSchemaFailureFixture } from "@/core/ai/fixtures/redacted-schema-failure";
import type { ModelPlanDraft } from "@/core/ai/operation-output";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { AiPlanRequest } from "../contracts";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  planChangeSetWithDeepSeek,
} from "./deepseek-planner";

function fixtureRequest(role: AiPlanRequest["role"] = "editor"): AiPlanRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    instruction: "将本月收入指标标题改为月度总收入，不要应用。",
    pageId: "page_home",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    role,
  };
}

function validDraft(): ModelPlanDraft {
  return {
    message: "已生成标题调整计划，请先预览确认。",
    operations: [{
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_revenue",
      props: { label: "月度总收入" },
    }],
  };
}

function jsonObjectResult(content: string, model = "deepseek-v4-flash") {
  return new Response(JSON.stringify({
    model,
    choices: [{ message: { content, reasoning_content: "不得进入应用或审计" } }],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sequenceFetch(...responses: Response[]) {
  return vi.fn<typeof fetch>(async () => responses.shift() ?? jsonObjectResult("{}"));
}

function deterministicOptions(fetchImpl: typeof fetch) {
  return {
    apiKey: "test-only-api-key",
    fetchImpl,
    idFactory: () => "fixedtoken",
    clock: (() => { let value = 1_000; return () => (value += 25); })(),
  };
}

async function expectPlannerCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("DeepSeek 结构化 ChangeSet 规划器", () => {
  it("缺少 API 密钥时不发起请求", async () => {
    const fetchImpl = sequenceFetch(jsonObjectResult(JSON.stringify(validDraft())));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest(), { fetchImpl }), "not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("正常成功只调用一次 Chat Completions json_object，并由服务端生成可信 ChangeSet 字段", async () => {
    const fetchImpl = sequenceFetch(jsonObjectResult(JSON.stringify(validDraft())));
    const result = await planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl));

    expect(result.message).toContain("预览");
    expect(result.changeSet).toMatchObject({
      id: "changeset_ai_1025_fixedtoken",
      status: "ready",
      operations: [{
        id: "operation_ai_1_fixedtoken",
        type: "updateNodeProps",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    });
    expect(result.metadata).toMatchObject({
      model: "deepseek-v4-flash",
      durationMs: 25,
      repairAttempted: false,
      transport: "chat_json_object",
    });
    expect(result.metadata.usage.totalTokens).toBe(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    const sent = JSON.parse(String(init?.body));
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.tools).toBeUndefined();
    expect(sent.text).toBeUndefined();
    expect(sent.messages[0].content).toContain("只返回");
    expect(sent.messages[0].content).toContain("message");
    expect(sent.messages[0].content).toContain("operations");
    expect(sent.messages[0].content).toContain("Markdown");
    expect(String(init?.body)).not.toContain("test-only-api-key");
    expect(JSON.stringify(result)).not.toContain("reasoning_content");
  });

  it("无法解析的 JSON 不触发修复或接口切换", async () => {
    const secretRaw = "raw-output-must-not-be-replayed";
    const fetchImpl = sequenceFetch(jsonObjectResult(`{${secretRaw}`));
    await expect(planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl))).rejects.toMatchObject({
      code: "invalid_output",
      metadata: { repairAttempted: false, validationIssues: [{ code: "invalid_json" }] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("真实失败类别的脱敏 fixture 会被拒绝且只暴露字段路径和错误类别", async () => {
    expect(redactedSchemaFailureFixture.observed).toMatchObject({
      httpStatus: 422,
      errorCode: "invalid_output",
      attempts: 2,
      persistedFieldIssues: false,
    });
    const candidate = JSON.stringify(redactedSchemaFailureFixture.representativeCandidate);
    const fetchImpl = sequenceFetch(jsonObjectResult(candidate), jsonObjectResult(candidate));
    const promise = planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl));
    await expect(promise).rejects.toMatchObject({
      code: "invalid_output",
      status: 422,
      metadata: {
        validationIssues: expect.arrayContaining([expect.objectContaining({
          stage: "draft_schema",
          path: expect.stringMatching(/changeSet|operations/),
        })]),
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("不存在的组件目标会在正式执行器校验中被拒绝", async () => {
    const draft = validDraft();
    if (draft.operations[0].type !== "updateNodeProps") throw new Error("测试操作类型错误");
    draft.operations[0].nodeId = "missing_component";
    const content = JSON.stringify(draft);
    const fetchImpl = sequenceFetch(jsonObjectResult(content), jsonObjectResult(content));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl)), "invalid_output");
  });

  it("不存在的数据字段会在组件属性和绑定校验中被拒绝", async () => {
    const request = fixtureRequest();
    const metric = request.appSpec.pages[0].root.children?.find((node) => node.id === "page_home_metrics")?.children?.[0];
    if (!metric || metric.type !== "MetricCard") throw new Error("缺少指标 fixture");
    const draft = validDraft();
    if (draft.operations[0].type !== "updateNodeProps") throw new Error("测试操作类型错误");
    draft.operations[0].props = { binding: { ...structuredClone(metric.props.binding), field: "missing_field" } };
    const content = JSON.stringify(draft);
    const fetchImpl = sequenceFetch(jsonObjectResult(content), jsonObjectResult(content));
    await expectPlannerCode(planChangeSetWithDeepSeek(request, deterministicOptions(fetchImpl)), "invalid_output");
  });

  it("viewer 在调用模型前被拒绝", async () => {
    const fetchImpl = sequenceFetch(jsonObjectResult(JSON.stringify(validDraft())));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest("viewer"), deterministicOptions(fetchImpl)), "permission_denied");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("editor 的删除操作在底层权限校验中被拒绝", async () => {
    const draft = {
      message: "请求删除指标。",
      operations: [{ type: "removeNode", pageId: "page_home", nodeId: "page_home_revenue" }],
    };
    const content = JSON.stringify(draft);
    const fetchImpl = sequenceFetch(jsonObjectResult(content), jsonObjectResult(content));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest("editor"), deterministicOptions(fetchImpl)), "invalid_output");
  });

  it.each([
    [400, "service_unavailable"],
    [401, "authentication_failed"],
    [402, "insufficient_balance"],
    [404, "service_unavailable"],
    [422, "service_unavailable"],
    [429, "rate_limited"],
    [500, "service_unavailable"],
  ])("将 DeepSeek %s 转换为中文服务错误，不切换接口且只调用一次", async (status, code) => {
    const fetchImpl = sequenceFetch(new Response("upstream detail must stay private", { status }));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl)), code);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("服务端超时会中止请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expectPlannerCode(planChangeSetWithDeepSeek(fixtureRequest(), { apiKey: "mock", fetchImpl, timeoutMs: 1 }), "timeout");
  });

  it("调用方取消时中止请求", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const promise = planChangeSetWithDeepSeek(fixtureRequest(), { apiKey: "mock", fetchImpl, signal: controller.signal });
    controller.abort();
    await expectPlannerCode(promise, "cancelled");
  });

  it("已解析但 Schema 不合法时最多进行一次受控修复", async () => {
    const firstCandidate = JSON.stringify({ message: "暂未生成操作。", operations: [] });
    const fetchImpl = sequenceFetch(jsonObjectResult(firstCandidate), jsonObjectResult(JSON.stringify(validDraft())));
    const result = await planChangeSetWithDeepSeek(fixtureRequest(), deterministicOptions(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.metadata.repairAttempted).toBe(true);
    expect(result.metadata.usage).toEqual({ promptTokens: 160, completionTokens: 40, totalTokens: 200 });
    expect(result.metadata.validationIssues).toEqual([expect.objectContaining({ stage: "draft_schema", path: "operations" })]);
    const repairBody = String(fetchImpl.mock.calls[1][1]?.body);
    expect(repairBody).not.toContain(firstCandidate);
    expect(repairBody).toContain("validationIssueSummary");
    expect(repairBody).toContain("allowedStructure");
  });

  it("生成后、预览前不修改正式 AppSpec 或 localStorage，应用后仍可撤销", async () => {
    const request = fixtureRequest();
    const formalBefore = structuredClone(request.appSpec);
    const storageSetItem = vi.fn();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => "unchanged", setItem: storageSetItem },
    });
    const fetchImpl = sequenceFetch(jsonObjectResult(JSON.stringify(validDraft())));
    const result = await planChangeSetWithDeepSeek(request, deterministicOptions(fetchImpl));
    expect(result.changeSet.operations).toHaveLength(1);
    expect(result.changeSet.operations[0]).toMatchObject({
      type: "updateNodeProps",
      nodeId: "page_home_revenue",
      props: { label: "月度总收入" },
    });
    expect(request.appSpec).toEqual(formalBefore);
    expect(storageSetItem).not.toHaveBeenCalled();
    const initial = createExecutionState(request.appSpec);
    const previewed = previewChangeSet(initial, result.changeSet, "editor");
    expect(previewed.present).toEqual(initial.present);
    const applied = applyChangeSet(previewed, result.changeSet, "editor");
    expect(applied.present).not.toEqual(initial.present);
    expect(undoLastChange(applied, "editor").present).toEqual(initial.present);
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("审计与客户端代码不包含密钥、Authorization 或推理内容", () => {
    const changeSet = {
      id: "changeset_ai_safe",
      title: "安全审计",
      status: "ready" as const,
      operations: [{
        id: "operation_ai_safe",
        type: "updateNodeProps" as const,
        label: "修改组件属性",
        description: "修改收入指标",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    };
    const audit = createChangeSetAuditRecord(
      changeSet,
      "editor",
      "ai",
      "previewed",
      undefined,
      () => new Date("2026-08-31T00:00:00.000Z"),
      {
        model: "deepseek-v4-flash",
        durationMs: 123,
        transport: "responses_json_schema",
        repairAttempted: true,
        validationIssues: [{ stage: "draft_schema", path: "operations.0.props", code: "invalid_type", operationType: "updateNodeProps" }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    );
    const workspace = readFileSync(fileURLToPath(new URL("../../../components/studio/StudioWorkspace.tsx", import.meta.url)), "utf8");
    const assistant = readFileSync(fileURLToPath(new URL("../../../components/studio/AiBuilderAssistant.tsx", import.meta.url)), "utf8");
    const serialized = JSON.stringify(audit);
    expect(serialized).toContain("operations.0.props");
    expect(serialized).toContain("updateNodeProps");
    expect(serialized).not.toContain("test-only-api-key");
    expect(serialized).not.toContain("reasoning_content");
    expect(`${workspace}\n${assistant}`).not.toContain("DEEPSEEK_API_KEY");
    expect(`${workspace}\n${assistant}`).not.toContain("NEXT_PUBLIC_DEEPSEEK_API_KEY");
  });
});
