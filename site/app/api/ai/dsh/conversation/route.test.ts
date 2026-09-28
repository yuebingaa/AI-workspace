import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { harnessPublicRequestSchema, harnessResponseSchema, type HarnessRequest } from "@/core/harness/contracts";
import { createHarnessTask } from "@/core/harness/task-state";
import { harnessConversationStore } from "@/core/harness/server/conversation-store";
import { readHarnessStream } from "@/core/harness/stream";
import { agentEngineSelection } from "@/core/agent-engines/server/selection";
import type { DshAgentExecutionOptions } from "@/core/agent-engines/server/executor";
import { LIVE_EVALUATION_SESSION_HEADER } from "@/core/evaluation/live/protocol";
import { harnessConversationNamespace } from "../../harness/conversation/namespace";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";
import { DELETE as clear } from "./clear/route";
import { POST as classicPOST } from "../../harness/route";
import { DELETE as classicClear } from "../../harness/conversation/route";

const mock = vi.hoisted(() => ({ execute: vi.fn(), inspect: vi.fn(), mcp: vi.fn(), nativeStore: vi.fn(),
  nativeBegin: vi.fn(), nativeClear: vi.fn(), nativeCommit: vi.fn(), nativeRelease: vi.fn() }));
vi.mock("@/core/agent-engines/server/executor", () => ({ executeAgent: mock.execute }));
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ inspectOfficialDshRuntime: mock.inspect }));
vi.mock("@/core/wecom/server/runtime", () => ({ createRequestMcpRuntime: mock.mcp }));
vi.mock("@/core/agent-engines/server/native-session-store", () => ({ configuredDshNativeSessionStore: mock.nativeStore }));
vi.mock("@/core/agent-engines/server/selection", async importOriginal => {
  const original = await importOriginal<typeof import("@/core/agent-engines/server/selection")>();
  return { ...original, agentEngineSelection: new original.AgentEngineSelection() };
});
vi.mock("@/core/harness/server/conversation-store", async importOriginal => {
  const original = await importOriginal<typeof import("@/core/harness/server/conversation-store")>();
  return { ...original, harnessConversationStore: new original.HarnessConversationStore() };
});
vi.mock("@/core/datasets/server/dataset-repository", async importOriginal => {
  const original = await importOriginal<typeof import("@/core/datasets/server/dataset-repository")>();
  return { ...original, datasetRepository: new original.MemoryDatasetRepository() };
});
vi.mock("@/core/connections/server/config", async importOriginal => {
  const original = await importOriginal<typeof import("@/core/connections/server/config")>();
  return { ...original, listConnections: () => [] };
});

const available = { available: true, version: "0.1.7-rc.2" };
const unique = () => crypto.randomUUID().replaceAll("-", "");
const status = () => agentEngineSelection.status(available);
type Payload = ReturnType<typeof harnessPublicRequestSchema.parse>;

function payload(): Payload {
  if (!demoFixtureResult.success) throw new Error("Synthetic product unavailable");
  return harnessPublicRequestSchema.parse({
    idempotencyKey: `dsh_conversation_${unique()}`, conversation_id: `dsh_thread_${unique()}`,
    instruction: "你是 DS 吗？", pageId: "page_home",
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
  });
}

function request(body: unknown, extra: RequestInit = {}) {
  return new Request("http://127.0.0.1:3001/api/ai/dsh/conversation", {
    method: "POST", body: JSON.stringify(body), ...extra,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001", ...extra.headers },
  });
}

function completed(input: HarnessRequest, message = "我是通过 DSH 为你服务的数据分析助手。") {
  return { ...createHarnessTask(input.idempotencyKey, input.instruction, input.pageId, input.role,
    { now: () => new Date(), id: () => "conversation_test_event" }), state: "completed", resultMessage: message };
}

function enableNative(continuity: "new" | "resumed" | "reset" = "new") {
  const lease = { sessionId: "agentcanvas-server-owned-session", root: "C:\\synthetic-private-native-stage",
    mode: continuity === "resumed" ? "resume" as const : "create" as const, continuity,
    commit: mock.nativeCommit, release: mock.nativeRelease };
  mock.nativeBegin.mockResolvedValue(lease);
  mock.nativeStore.mockReturnValue({ begin: mock.nativeBegin, clear: mock.nativeClear });
  return lease;
}

const answer = async (response: Response, transport: string) => transport === "sse"
  ? readHarnessStream(response, new AbortController().signal)
  : harnessResponseSchema.parse(await response.json());

async function uploaded(sensitive: boolean) {
  const csv = sensitive ? "region,amount,email\nEast,100,person@example.invalid\n" : "region,amount\nEast,100\n";
  const parsed = await parseCsvUpload({ originalFileName: "dsh-conversation-synthetic.csv", mimeType: "text/csv",
    stream: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(csv)); controller.close(); } }),
  });
  const stored = await datasetRepository.put(resolveDemoRequestIdentity(), parsed);
  const input = payload();
  input.appSpec.dataSources = [stored.descriptor.source];
  input.dataSourceId = stored.descriptor.datasetId;
  return { input, stored };
}

beforeEach(() => {
  expect(status().activeTasks).toBe(0);
  mock.execute.mockReset().mockImplementation(async (_engine: string, input: HarnessRequest) => completed(input));
  mock.inspect.mockReset().mockResolvedValue(available);
  mock.mcp.mockReset().mockResolvedValue(undefined);
  mock.nativeStore.mockReset().mockReturnValue(undefined);
  mock.nativeBegin.mockReset();
  mock.nativeClear.mockReset().mockResolvedValue(undefined);
  mock.nativeCommit.mockReset().mockImplementation(async (check?: () => void) => { check?.(); });
  mock.nativeRelease.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
  vi.stubEnv("HARNESS_VISUAL_VERIFICATION_ENABLED", "0");
  for (const key of ["DSH_MAX_TOOL_CALLS", "DSH_TOTAL_EXECUTION_TIMEOUT_MS", "DSH_TOOL_CALL_TIMEOUT_MS"]) vi.stubEnv(key, undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network in route acceptance"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("独立 DSH 对话 API", () => {
  it.each(["json", "sse"])("%s rejects client-provided native session bindings before opening storage", async transport => {
    enableNative();
    for (const extra of [{ nativeSession: { sessionId: "forged-native-id", root: "C:\\forged", mode: "resume" } },
      { nativeConversation: "resumed" }]) {
      const response = await (transport === "sse" ? streamPOST : POST)(request({ ...payload(), ...extra }));
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect(mock.nativeBegin).not.toHaveBeenCalled();
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it.each(["new", "resumed", "reset"] as const)("commits server-owned %s continuity without importing webpage history or exposing its storage binding", async continuity => {
    const lease = enableNative(continuity), input = payload();
    input.conversationContext = { summary: "OLD_WEBPAGE_HISTORY_MUST_NOT_ENTER_NATIVE",
      recentMessages: [{ instruction: "旧网页问题", response: "旧网页答复" }] };
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    const result = await answer(response, "json");
    expect(mock.nativeBegin).toHaveBeenCalledExactlyOnceWith({
      namespace: harnessConversationNamespace(request(input), resolveDemoRequestIdentity(), null, { dshConversation: true }),
      conversationId: input.conversation_id, pageId: input.pageId, scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(mock.execute).toHaveBeenCalledWith("dsh", expect.not.objectContaining({ conversationContext: expect.anything() }),
      expect.any(Object), { dshConversation: true, nativeSession: { sessionId: lease.sessionId, root: lease.root, mode: lease.mode } });
    expect(result.task).toMatchObject({ state: "completed", nativeConversation: continuity });
    expect(mock.nativeCommit).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(lease.sessionId);
    expect(serialized).not.toContain("synthetic-private-native-stage");
    const replay = await answer(await POST(request(input)), "json");
    expect(replay.task).toEqual(result.task);
    expect(mock.nativeBegin).toHaveBeenCalledOnce();
    expect(mock.nativeCommit).toHaveBeenCalledOnce();
    expect(mock.execute).toHaveBeenCalledOnce();
  });

  it("includes committed native continuity in the SSE terminal receipt", async () => {
    enableNative("resumed");
    const result = await answer(await streamPOST(request(payload())), "sse");
    expect(result.task).toMatchObject({ state: "completed", nativeConversation: "resumed" });
    expect(mock.nativeCommit).toHaveBeenCalledOnce();
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled", "blocked"] as const)("does not commit a %s candidate or claim native continuity", async state => {
    enableNative("resumed");
    mock.execute.mockImplementationOnce(async (_engine: string, input: HarnessRequest) => ({ ...completed(input), state }));
    const response = await POST(request(payload()));
    expect(response.status).toBe(200);
    const result = await answer(response, "json");
    expect(result.task).toMatchObject({ state });
    expect(result.task.nativeConversation).toBeUndefined();
    expect(mock.nativeCommit).not.toHaveBeenCalled();
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
  });

  it.each(["json", "sse"])("%s withholds successful task receipts when native commit fails", async transport => {
    enableNative("resumed");
    mock.nativeCommit.mockRejectedValueOnce(new Error("PRIVATE_NATIVE_PATH_SHOULD_NOT_LEAK"));
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload()));
    expect(response.status).toBe(transport === "sse" ? 200 : 503);
    const text = await response.text();
    expect(text).toContain("服务暂时不可用");
    expect(text).not.toContain("PRIVATE_NATIVE_PATH_SHOULD_NOT_LEAK");
    expect(text).not.toContain('"nativeConversation"');
    expect(text).not.toContain('"state":"completed"');
    if (transport === "sse") {
      expect(text).toContain("event: stream_error");
      expect(text).not.toContain("event: completed");
    }
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
    expect(status().activeTasks).toBe(0);
  });

  it("rechecks source authorization before committing a successfully executed native candidate", async () => {
    enableNative("resumed");
    const { input } = await uploaded(false);
    mock.execute.mockImplementationOnce(async (_engine: string, requestToRun: HarnessRequest) => {
      await datasetRepository.delete(resolveDemoRequestIdentity(), input.dataSourceId!);
      return completed(requestToRun, "A candidate that must not be committed.");
    });
    const response = await POST(request(input));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("A candidate that must not be committed.");
    expect(mock.nativeBegin).toHaveBeenCalledOnce();
    expect(mock.nativeCommit).not.toHaveBeenCalled();
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
    expect(status().activeTasks).toBe(0);
  });

  it("clears native and webpage history under the same server-owned DSH namespace", async () => {
    enableNative();
    const input = payload(), coordinatedClear = vi.spyOn(harnessConversationStore, "clearWith");
    await POST(request(input));
    const req = request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" });
    const response = await clear(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: true });
    const namespace = harnessConversationNamespace(req, resolveDemoRequestIdentity(), null, { dshConversation: true });
    expect(mock.nativeClear).toHaveBeenCalledExactlyOnceWith(namespace, input.conversation_id, input.pageId);
    expect(coordinatedClear).toHaveBeenCalledExactlyOnceWith(namespace, input.conversation_id, input.pageId, expect.any(Function));
    expect(coordinatedClear.mock.invocationCallOrder[0]).toBeLessThan(mock.nativeClear.mock.invocationCallOrder[0]);
    const lease = harnessConversationStore.begin({ ...input, role: "editor" }, namespace);
    try { expect(lease.context?.recentMessages).toBeUndefined(); }
    finally { lease.release(); }
  });

  it("refuses busy native clear without erasing webpage history or reporting success", async () => {
    enableNative();
    mock.nativeClear.mockRejectedValueOnce(new Error("PRIVATE_NATIVE_BUSY_DETAILS"));
    const input = payload(), legacyClear = vi.spyOn(harnessConversationStore, "clear");
    const response = await clear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }));
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).not.toHaveProperty("cleared");
    expect(result).toEqual({ error: expect.stringContaining("停止在途任务") });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_BUSY_DETAILS");
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("does not touch native history when the shared webpage conversation lease is already busy", async () => {
    enableNative();
    const gate = Promise.withResolvers<void>();
    mock.execute.mockImplementationOnce(async (_engine: string, input: HarnessRequest) => {
      await gate.promise;
      return completed(input);
    });
    const input = payload();
    const running = POST(request(input));
    try {
      await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledOnce());
      const response = await clear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }));
      expect(response.status).toBe(409);
      expect(mock.nativeClear).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await running;
    }
  });

  it("holds the shared conversation lease across native clear so a new run cannot enter between both clears", async () => {
    enableNative();
    const input = payload();
    // Preserve an existing completed message before the deliberately slow clear.
    await POST(request(input));
    mock.execute.mockClear();
    const gate = Promise.withResolvers<void>();
    mock.nativeClear.mockImplementationOnce(() => gate.promise);
    const clearing = clear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }));
    try {
      await vi.waitFor(() => expect(mock.nativeClear).toHaveBeenCalledOnce());
      const denied = await POST(request({ ...input, idempotencyKey: `during_clear_${unique()}` }));
      expect(denied.status).toBe(503);
      expect(mock.execute).not.toHaveBeenCalled();
    } finally { gate.resolve(); await clearing; }
    expect((await clearing).status).toBe(200);
    expect((await POST(request({ ...input, idempotencyKey: `after_clear_${unique()}` }))).status).toBe(200);
    expect(mock.execute).toHaveBeenCalledOnce();
    // Native mode intentionally omits webpage history from the model request.
    // Check the website store directly, through its original public begin lease.
    const namespace = harnessConversationNamespace(request(input), resolveDemoRequestIdentity(), null, { dshConversation: true });
    const lease = harnessConversationStore.begin({ ...input, role: "editor" }, namespace);
    try { expect(lease.context?.recentMessages).toHaveLength(1); }
    finally { lease.release(); }
  });

  it("does not touch native storage from classic execution or classic clear", async () => {
    enableNative("resumed");
    const input = payload();
    const result = await answer(await classicPOST(request(input)), "json");
    expect(result.task.nativeConversation).toBeUndefined();
    expect((await classicClear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }))).status).toBe(200);
    expect(mock.nativeStore).not.toHaveBeenCalled();
    expect(mock.nativeBegin).not.toHaveBeenCalled();
    expect(mock.nativeClear).not.toHaveBeenCalled();
    expect(mock.nativeCommit).not.toHaveBeenCalled();
    expect(mock.execute.mock.calls[0][3]).toBeUndefined();
    expect(mock.execute.mock.calls[0][2]).toMatchObject({ createModelClient: expect.any(Function),
      authorizeModelCall: expect.any(Function), bounds: { maxToolCalls: 6, totalExecutionTimeoutMs: 90_000 } });
    expect(mock.execute.mock.calls[0][2]).not.toHaveProperty("executionPolicy");
  });

  it.each(["json", "sse"])("%s forces DSH without changing selection and preserves bounded response contracts", async transport => {
    const before = status(), input = payload();
    const response = await (transport === "sse" ? streamPOST : POST)(request(input));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await answer(response, transport);
    expect(result.task).toMatchObject({ state: "completed", resultMessage: expect.stringContaining("DSH") });
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(mock.execute).toHaveBeenCalledWith("dsh", expect.objectContaining({ role: "editor" }), expect.any(Object), { dshConversation: true });
    const executionOptions = mock.execute.mock.calls[0][2] as DshAgentExecutionOptions;
    expect(executionOptions).toMatchObject({ dataRuntime: expect.any(Object), notebookRunner: expect.any(Function),
      authorizeCurrentAccess: expect.any(Function), executionPolicy: {
        maxToolCalls: null, toolCallTimeoutMs: null, totalExecutionTimeoutMs: null,
      } });
    for (const legacy of ["createModelClient", "modelClient", "agentMode", "bounds", "excelExporter", "mcpRuntime"]) {
      expect(executionOptions).not.toHaveProperty(legacy);
    }
    expect(mock.mcp).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(status()).toEqual(before);
    const replay = await answer(await (transport === "sse" ? streamPOST : POST)(request(input)), transport);
    expect(replay.task).toEqual(result.task);
    expect(mock.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["json", "sse"])("%s refuses missing/failed DSH readiness before opening a stream and never falls back", async transport => {
    const route = transport === "sse" ? streamPOST : POST;
    for (const fails of [false, true]) {
      if (fails) mock.inspect.mockRejectedValueOnce(new Error("PRIVATE_RUNTIME_PATH"));
      else mock.inspect.mockResolvedValueOnce({ available: false, version: "0.1.7-rc.2" });
      const response = await route(request(payload()));
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      const text = await response.text();
      expect(text).toContain("不会切换到旧执行器");
      expect(text).not.toContain("PRIVATE_RUNTIME_PATH");
    }
    expect(mock.execute).not.toHaveBeenCalled();
    expect(status().activeTasks).toBe(0);
  });

  it("requires a conversation id and rejects browser-owned role/mode or live-evaluation overrides", async () => {
    const { conversation_id: omitted, ...withoutId } = payload();
    expect(omitted).toBeDefined();
    for (const input of [withoutId, { ...payload(), role: "admin" }, { ...payload(), dshConversation: true }]) {
      expect((await POST(request(input))).status).toBe(400);
    }
    expect((await POST(request(payload(), { headers: { [LIVE_EVALUATION_SESSION_HEADER]: "attempt" } }))).status).toBe(400);
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it.each(["https://attacker.invalid", "http://localhost:3001"])("refuses mismatched origin %s for execution and clearing", async origin => {
    expect((await POST(request(payload(), { headers: { origin } }))).status).toBe(403);
    expect((await clear(request({ conversation_id: "dsh_thread_test", pageId: "page_home" }, { method: "DELETE", headers: { origin } }))).status).toBe(403);
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("retains uploaded-data permission and expiry checks, even for old UI-only instruction patterns", async () => {
    const { input: pending, stored } = await uploaded(true);
    expect(stored.descriptor.aiAccessPolicy).toBe("pending");
    pending.instruction = "把页面背景改成白色";
    expect((await POST(request(pending))).status).toBe(403);
    const { input: missing } = await uploaded(false);
    await datasetRepository.delete(resolveDemoRequestIdentity(), missing.dataSourceId!);
    expect((await streamPOST(request(missing))).status).toBe(410);
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("separates old/new history and idempotency and clears only the targeted entry point", async () => {
    const input = payload(), conversationId = input.conversation_id;
    await classicPOST(request(input));
    await POST(request(input));
    expect(mock.execute).toHaveBeenCalledTimes(2);
    expect(mock.execute.mock.calls[0][0]).toBe("harness");
    expect(mock.execute.mock.calls[1][0]).toBe("dsh");
    expect(mock.execute.mock.calls[1][1].conversationContext.recentMessages).toBeUndefined();
    await POST(request({ ...input, idempotencyKey: `next_${unique()}`, instruction: "承接上一句话" }));
    expect(mock.execute.mock.calls[2][1].conversationContext.recentMessages).toHaveLength(1);
    expect((await clear(request({ conversation_id: conversationId, pageId: input.pageId }, { method: "DELETE" }))).status).toBe(200);
    await POST(request({ ...input, idempotencyKey: `after_clear_${unique()}` }));
    expect(mock.execute.mock.calls[3][1].conversationContext.recentMessages).toBeUndefined();
    await classicPOST(request({ ...input, idempotencyKey: `classic_after_${unique()}` }));
    expect(mock.execute.mock.calls[4][1].conversationContext.recentMessages).toHaveLength(1);
    expect((await classicClear(request({ conversation_id: conversationId, pageId: input.pageId }, { method: "DELETE" }))).status).toBe(200);
    await POST(request({ ...input, idempotencyKey: `new_after_old_clear_${unique()}` }));
    expect(mock.execute.mock.calls[5][1].conversationContext.recentMessages).toHaveLength(1);
  });

  it("keeps project and entry-point namespace keys distinct", () => {
    const req = request(payload()), identity = resolveDemoRequestIdentity();
    const values = [null, "project_aaaaaaaa", "project_bbbbbbbb"].flatMap(project => [
      harnessConversationNamespace(req, identity, project),
      harnessConversationNamespace(req, identity, project, { dshConversation: true }),
      harnessConversationNamespace(req, identity, project, { visualizationLab: true }),
    ]);
    expect(new Set(values).size).toBe(9);
  });

  it("withholds cached results if access changes after canonical source loading", async () => {
    const { input } = await uploaded(false);
    expect((await POST(request(input))).status).toBe(200);
    const get = datasetRepository.get.bind(datasetRepository);
    vi.spyOn(datasetRepository, "get").mockImplementationOnce(async (identity, id) => {
      const stored = await get(identity, id);
      await datasetRepository.delete(identity, id);
      return stored;
    });
    const denied = await POST(request(input));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("本次结果未交付");
    expect(mock.execute).toHaveBeenCalledTimes(1);
  });

  it("forwards cancellation and releases the active lease without invoking another engine", async () => {
    enableNative("resumed");
    const controller = new AbortController();
    mock.execute.mockImplementationOnce(async (_engine: string, input: HarnessRequest, options: DshAgentExecutionOptions) => {
      await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ...completed(input), state: "cancelled", resultMessage: "已取消" };
    });
    const response = await streamPOST(request(payload(), { signal: controller.signal }));
    const result = answer(response, "sse");
    const settled = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await settled;
    await vi.waitFor(() => expect(status().activeTasks).toBe(0));
    expect(mock.execute.mock.calls[0][2].signal.aborted).toBe(true);
    expect(mock.execute.mock.calls[0][0]).toBe("dsh");
    expect(mock.nativeCommit).not.toHaveBeenCalled();
    expect(mock.nativeRelease).toHaveBeenCalledOnce();
  });

  it("refuses clearing a running conversation and releases its engine lease after completion", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    mock.execute.mockImplementationOnce(async (_engine: string, input: HarnessRequest, options: DshAgentExecutionOptions) => {
      expect(options.signal?.aborted).toBe(false);
      await gate;
      return completed(input);
    });
    const input = payload(), response = await streamPOST(request(input));
    const result = answer(response, "sse");
    await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1));
    expect(status().activeTasks).toBe(1);
    expect((await clear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }))).status).toBe(409);
    finish();
    expect((await result).task.state).toBe("completed");
    expect(status().activeTasks).toBe(0);
    expect((await clear(request({ conversation_id: input.conversation_id, pageId: input.pageId }, { method: "DELETE" }))).status).toBe(200);
  });
});
