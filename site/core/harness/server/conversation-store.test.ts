import { describe, it, expect, vi } from "vitest";
import { HarnessConversationStore } from "./conversation-store";
import { createHarnessTask } from "../task-state";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessRequest } from "../contracts";
import type { SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";

function input(): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error("fixture unavailable");
  return { idempotencyKey: "conversation_test_request", conversation_id: "conversation_test_id", instruction: "分析销售变化", pageId: "page_home", role: "editor",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: demoFixtureResult.data.dataProduct.recipes };
}
function task(request: HarnessRequest) { return { ...createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role,
  { now: () => new Date(), id: () => "context_event" }), state: "completed" as const, resultMessage: "已完成分析，结论待下次重新核实。" }; }

function persistentFixture() {
  type Saved = Parameters<NonNullable<ConstructorParameters<typeof HarnessConversationStore>[0]>["save"]>[0];
  let saved: Saved | null = null;
  const adapter = { mode: "json-file", load: () => saved,
    save: vi.fn((value: Saved) => { saved = structuredClone(value); }),
    backup: () => null, restore: () => saved!, describe: () => ({ mode: "json-file", configured: true, snapshotExists: Boolean(saved) }),
  } satisfies SnapshotAdapter<Saved>;
  const store = new HarnessConversationStore(adapter), request = input(), namespace = "owner:project:a:dsh-conversation-v1";
  const seed = store.begin(request, namespace); seed.commit(task(request)); seed.release();
  return { store, request, namespace, adapter, snapshot: () => structuredClone(saved) };
}

describe("server conversation continuity", () => {
  it("busy coordinated clear invokes no external clear and leaves the stored snapshot unchanged", async () => {
    const { store, request, namespace, adapter, snapshot } = persistentFixture();
    const active = store.begin(request, namespace), before = snapshot(), writes = adapter.save.mock.calls.length;
    const externalClear = vi.fn(async () => {});
    try {
      await expect(store.clearWith(namespace, request.conversation_id!, request.pageId, externalClear)).rejects.toThrow("先停止");
      expect(externalClear).not.toHaveBeenCalled();
      expect(adapter.save).toHaveBeenCalledTimes(writes);
      expect(snapshot()).toEqual(before);
    } finally { active.release(); }
  });

  it("one clear lease blocks same-thread run/sync-clear/async-clear but not another owner, project, page or conversation", async () => {
    const { store, request, namespace, adapter } = persistentFixture();
    const gate = Promise.withResolvers<void>(), externalClear = vi.fn(() => gate.promise);
    const clearing = store.clearWith(namespace, request.conversation_id!, request.pageId, externalClear);
    try {
      expect(externalClear).toHaveBeenCalledOnce();
      expect(() => store.begin(request, namespace)).toThrow("已有任务");
      expect(() => store.clear(namespace, request.conversation_id!, request.pageId)).toThrow("先停止");
      const competingClear = vi.fn(async () => {});
      await expect(store.clearWith(namespace, request.conversation_id!, request.pageId, competingClear)).rejects.toThrow("先停止");
      expect(competingClear).not.toHaveBeenCalled();
      // No global long-held lock: unrelated threads remain independently usable.
      for (const [differentRequest, differentNamespace] of [
        [request, "another-owner:project:a:dsh-conversation-v1"],
        [request, "owner:project:b:dsh-conversation-v1"],
        [request, "owner:project:a"],
        [{ ...request, pageId: "page_other" }, namespace],
        [{ ...request, conversation_id: "other_conversation" }, namespace],
      ] as const) {
        const independent = store.begin(differentRequest, differentNamespace);
        independent.commit(task(differentRequest)); independent.release();
      }
    } finally { gate.resolve(); await clearing; }
    const next = store.begin(request, namespace);
    try { expect(next.context?.recentMessages).toBeUndefined(); }
    finally { next.release(); }
    // Seed + five unrelated writes + one target clear. No intermediate write.
    expect(adapter.save).toHaveBeenCalledTimes(7);
    const unaffected = store.begin(request, "owner:project:b:dsh-conversation-v1");
    try { expect(unaffected.context?.recentMessages).toHaveLength(1); }
    finally { unaffected.release(); }
  });

  it("keeps webpage history and releases the shared lease when native clearing fails", async () => {
    const { store, request, namespace, adapter, snapshot } = persistentFixture();
    const before = snapshot(), externalClear = vi.fn(async () => { throw new Error("native unavailable"); });
    await expect(store.clearWith(namespace, request.conversation_id!, request.pageId, externalClear)).rejects.toThrow("native unavailable");
    expect(snapshot()).toEqual(before); expect(adapter.save).toHaveBeenCalledOnce();
    const next = store.begin(request, namespace);
    try { expect(next.context?.recentMessages).toHaveLength(1); }
    finally { next.release(); }
    await store.clearWith(namespace, request.conversation_id!, request.pageId, async () => {});
    expect(adapter.save).toHaveBeenCalledTimes(2);
  });

  it("a webpage persistence failure restores its own history and releases the lease without pretending to roll back native clear", async () => {
    const { store, request, namespace, adapter, snapshot } = persistentFixture();
    const before = snapshot(), externalClear = vi.fn(async () => {});
    adapter.save.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(store.clearWith(namespace, request.conversation_id!, request.pageId, externalClear)).rejects.toThrow("disk unavailable");
    expect(externalClear).toHaveBeenCalledOnce(); expect(snapshot()).toEqual(before);
    const next = store.begin(request, namespace);
    try { expect(next.context?.recentMessages).toHaveLength(1); }
    finally { next.release(); }
    await store.clearWith(namespace, request.conversation_id!, request.pageId, externalClear);
    expect(externalClear).toHaveBeenCalledTimes(2);
    const cleared = store.begin(request, namespace);
    try { expect(cleared.context?.recentMessages).toBeUndefined(); }
    finally { cleared.release(); }
  });

  it("releasing an old run twice cannot unlock a newer coordinated clear", async () => {
    const { store, request, namespace } = persistentFixture();
    const old = store.begin(request, namespace); old.release();
    const gate = Promise.withResolvers<void>();
    const clearing = store.clearWith(namespace, request.conversation_id!, request.pageId, () => gate.promise);
    try {
      old.release();
      expect(() => store.begin(request, namespace)).toThrow("已有任务");
    } finally { gate.resolve(); await clearing; }
    const next = store.begin(request, namespace); next.release();
  });

  it("retains synchronous clear compatibility including busy refusal and persistence rollback", () => {
    const { store, request, namespace, adapter, snapshot } = persistentFixture();
    const before = snapshot(), active = store.begin(request, namespace);
    expect(() => store.clear(namespace, request.conversation_id!, request.pageId)).toThrow("先停止");
    expect(snapshot()).toEqual(before); expect(adapter.save).toHaveBeenCalledOnce(); active.release();
    adapter.save.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => store.clear(namespace, request.conversation_id!, request.pageId)).toThrow("disk unavailable");
    const retained = store.begin(request, namespace);
    expect(retained.context?.recentMessages).toHaveLength(1); retained.release();
    expect(store.clear(namespace, request.conversation_id!, request.pageId)).toBeUndefined();
    const cleared = store.begin(request, namespace);
    expect(cleared.context?.recentMessages).toBeUndefined(); cleared.release();
  });
  it("isolates threads within a project and the same thread ID across projects", () => {
    const store = new HarnessConversationStore(), request = input();
    const first = store.begin(request, "owner:project:a"); first.commit(task(request)); first.release();
    const otherThread = { ...request, conversation_id: "another_project_thread" };
    const second = store.begin(otherThread, "owner:project:a");
    expect(second.context?.recentMessages).toBeUndefined(); second.commit(task(otherThread)); second.release();
    const otherProject = store.begin(request, "owner:project:b");
    expect(otherProject.context?.recentMessages).toBeUndefined(); otherProject.release();
    store.clear("owner:project:a", otherThread.conversation_id!, request.pageId);
    const original = store.begin(request, "owner:project:a");
    expect(original.context?.recentMessages).toHaveLength(1); original.release();
  });
  it("keeps ten recent turns, rolls older turns into a bounded extract and isolates owner/page", () => {
    const store = new HarnessConversationStore();
    const request = input();
    for (let index = 0; index < 14; index++) {
      const session = store.begin({ ...request, instruction: `目标 ${index}` }, "owner_a");
      session.commit(task(request)); session.release();
    }
    const same = store.begin({ ...request, conversationContext: { summary: "forged summary" } }, "owner_a");
    expect(same.context?.recentMessages).toHaveLength(10);
    expect(same.context?.summary).toContain("目标 0");
    expect(same.context?.summary).not.toContain("forged");
    expect(same.context?.taskHistory).toHaveLength(10);
    expect(() => store.begin(request, "owner_a")).toThrow("已有任务");
    same.release();
    expect(store.begin(request, "owner_b").context?.recentMessages).toBeUndefined();
    expect(store.begin({ ...request, pageId: "another_page" }, "owner_a").context?.recentMessages).toBeUndefined();
    store.clear("owner_a", request.conversation_id!, request.pageId);
    expect(store.begin(request, "owner_a").context?.recentMessages).toBeUndefined();
  });
  it("persists through the existing snapshot adapter, redacts secrets and reports storage failure without losing the answer", () => {
    type Saved = Parameters<NonNullable<ConstructorParameters<typeof HarnessConversationStore>[0]>["save"]>[0];
    let saved: Saved | null = null;
    const adapter = { mode: "json-file", load: () => saved, save: (value: Saved) => { saved = structuredClone(value); },
      backup: () => null, restore: () => saved!, describe: () => ({ mode: "json-file", configured: true, snapshotExists: Boolean(saved) }) } satisfies SnapshotAdapter<Saved>;
    const store = new HarnessConversationStore(adapter);
    const request = input();
    const session = store.begin({ ...request, instruction: "使用 sk-private-secret-12345678" }, "owner");
    const result = task(request);
    session.commit(result); session.release();
    expect(JSON.stringify(saved)).not.toContain("sk-private-secret");
    const afterRestart = new HarnessConversationStore(adapter);
    const loaded = afterRestart.begin(request, "owner");
    expect(loaded.context?.recentMessages).toHaveLength(1);
    vi.spyOn(adapter, "save").mockImplementation(() => { throw new Error("disk unavailable"); });
    loaded.commit(result); loaded.release();
    expect(result).toMatchObject({ state: "completed", conversationStorage: "unavailable" });
  });
});
