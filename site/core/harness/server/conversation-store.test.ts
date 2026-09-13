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

describe("server conversation continuity", () => {
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
