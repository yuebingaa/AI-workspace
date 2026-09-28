import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessRequestSchema, type HarnessTaskSummary } from "@/core/harness/contracts";
import { createHarnessTask } from "@/core/harness/task-state";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { dshNativeScopeFingerprint, runDshNativeConversation } from "./native-conversation";

const configured = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("./native-session-store", () => ({ configuredDshNativeSessionStore: configured }));
afterEach(() => { vi.clearAllMocks(); });

function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture missing");
  const request = harnessRequestSchema.parse({ idempotencyKey: "native_test_request", conversation_id: "native_test_context",
    instruction: "合成问题", role: "editor", pageId: "page_home", recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] },
    notebookContext: { sourceIds: [], document: { name: "合成Notebook", revision: 0, cells: [] } },
    conversationContext: { recentMessages: [{ instruction: "旧网页问题", response: "旧网页答复" }], summary: "旧摘要" } });
  const task = { ...createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, "editor",
    { now: () => new Date("2026-09-26T00:00:00Z"), id: () => "synthetic-event" }), state: "completed" as const };
  const lease = { sessionId: "native-fixed-session", root: "private-stage", mode: "resume" as const, continuity: "resumed" as const,
    commit: vi.fn(async (check?: () => void) => { check?.(); }), release: vi.fn(async () => {}) };
  const store = { begin: vi.fn(async () => lease) };
  const run = vi.fn(async () => structuredClone(task) as HarnessTaskSummary);
  const controller = new AbortController();
  return { request, task, lease, store, run, controller, options: { namespace: "test-owner:project-one", request,
    capabilities: { python: { enabled: false, reason: "synthetic" } }, signal: controller.signal, authorizeCurrentAccess: vi.fn(), run, store } };
}

describe("native DSH conversation transaction", () => {
  it.each(["completed", "awaitingConfirmation"] as const)("commits only accepted %s after dropping website history", async state => {
    const value = fixture(); value.run.mockResolvedValue({ ...value.task, state });
    const result = await runDshNativeConversation(value.options);
    expect(value.store.begin).toHaveBeenCalledWith({ namespace: value.options.namespace, conversationId: value.request.conversation_id,
      pageId: value.request.pageId, scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(value.run).toHaveBeenCalledWith(expect.not.objectContaining({ conversationContext: expect.anything() }), {
      sessionId: value.lease.sessionId, root: value.lease.root, mode: "resume" });
    expect(value.request.conversationContext?.summary).toBe("旧摘要");
    expect(result.nativeConversation).toBe("resumed");
    expect(value.lease.commit).toHaveBeenCalledOnce(); expect(value.lease.release).toHaveBeenCalledOnce();
  });
  it.each(["failed", "blocked", "cancelled"] as const)("keeps %s candidates out of future history", async state => {
    const value = fixture(); value.run.mockResolvedValue({ ...value.task, state });
    expect((await runDshNativeConversation(value.options)).nativeConversation).toBeUndefined();
    expect(value.lease.commit).not.toHaveBeenCalled(); expect(value.lease.release).toHaveBeenCalledOnce();
  });
  it("retains the existing path when private persistence is not configured", async () => {
    const value = fixture();
    await runDshNativeConversation({ ...value.options, store: undefined });
    expect(value.run).toHaveBeenCalledExactlyOnceWith(value.request);
    expect(value.store.begin).not.toHaveBeenCalled();
  });
  it.each(["cancel", "revoke", "throw"])("releases without commit when execution ends with %s", async kind => {
    const value = fixture();
    value.run.mockImplementation(async () => {
      if (kind === "cancel") value.controller.abort();
      if (kind === "revoke") value.options.authorizeCurrentAccess.mockImplementation(() => { throw new Error("Revoked"); });
      if (kind === "throw") throw new Error("Synthetic transport failure");
      return value.task;
    });
    await expect(runDshNativeConversation(value.options)).rejects.toThrow();
    expect(value.lease.commit).not.toHaveBeenCalled(); expect(value.lease.release).toHaveBeenCalledOnce();
  });
  it("checks authorization again at the storage commit boundary", async () => {
    const value = fixture();
    value.lease.commit.mockImplementation(async check => { value.controller.abort(); check?.(); });
    await expect(runDshNativeConversation(value.options)).rejects.toThrow();
    expect(value.lease.release).toHaveBeenCalledOnce();
  });
  it("does not open storage for a pre-aborted request", async () => {
    const value = fixture(); value.controller.abort();
    await expect(runDshNativeConversation(value.options)).rejects.toThrow();
    expect(value.store.begin).not.toHaveBeenCalled(); expect(value.run).not.toHaveBeenCalled();
  });
  it("does not claim native persistence when commit fails", async () => {
    const value = fixture(); value.lease.commit.mockRejectedValue(new Error("Synthetic persistence failure"));
    await expect(runDshNativeConversation(value.options)).rejects.toThrow("Synthetic persistence failure");
    expect(value.lease.release).toHaveBeenCalledOnce();
  });
  it("changes scope for permissions, capabilities, attachments and selected connections, not prompt/history", () => {
    const value = fixture(), capabilities = value.options.capabilities;
    const fingerprint = dshNativeScopeFingerprint(value.request, capabilities);
    expect(dshNativeScopeFingerprint(value.request, capabilities, 0)).toBe(fingerprint);
    expect(dshNativeScopeFingerprint(value.request, capabilities, 1)).not.toBe(fingerprint);
    expect(dshNativeScopeFingerprint(value.request, capabilities, 2)).not.toBe(dshNativeScopeFingerprint(value.request, capabilities, 1));
    expect(dshNativeScopeFingerprint({ ...value.request, instruction: "第二轮", conversationContext: {} }, capabilities)).toBe(fingerprint);
    expect(dshNativeScopeFingerprint({ ...value.request, role: "viewer" }, capabilities)).not.toBe(fingerprint);
    expect(dshNativeScopeFingerprint(value.request, { python: { enabled: true } })).not.toBe(fingerprint);
    expect(dshNativeScopeFingerprint({ ...value.request, rawWorkbookManifest: { fileName: "synthetic.xlsx", contentHash: "a".repeat(64), sheets: [] } }, capabilities)).not.toBe(fingerprint);
    expect(dshNativeScopeFingerprint({ ...value.request, notebookContext: { ...value.request.notebookContext!, connections: [
      { id: "connection_one", name: "合成只读连接", kind: "postgresql", allowAi: true },
    ] } }, capabilities)).not.toBe(fingerprint);
  });
});
