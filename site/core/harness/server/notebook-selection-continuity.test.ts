import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { harnessRequestSchema, type HarnessRequest } from "../contracts";
import { createHarnessTask } from "../task-state";
import { HarnessConversationStore } from "./conversation-store";

function request(selectedCellIds?: string[]): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  return harnessRequestSchema.parse({
    idempotencyKey: "context_selection_continuity", conversation_id: "context_selection_thread",
    instruction: "解释所选定义，不运行。", pageId: "page_home", role: "viewer",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [],
    notebookContext: {
      document: { name: "Synthetic focus only", revision: 0, cells: [
        { id: "focus_marker_a", kind: "parameter", title: "Private marker title", outputName: "factor",
          parameter: { type: "text", value: "synthetic_parameter_not_for_history" } },
        { id: "focus_marker_b", kind: "text", title: "Another definition", markdown: "synthetic_source_not_for_history" },
      ] }, sourceIds: [], ...(selectedCellIds ? { selectedCellIds } : {}),
    },
  });
}

function receipt(input: HarnessRequest) {
  return { ...createHarnessTask(input.idempotencyKey, input.instruction, input.pageId, input.role,
    { now: () => new Date("2026-09-17T00:00:00Z"), id: () => "selection_continuity_event" }),
    state: "completed" as const, resultMessage: "已读取声明；未运行。" };
}

describe("Notebook selection stays separate from conversation continuity", () => {
  it("does not copy focus IDs, parameter values, source or the Notebook into the history snapshot", () => {
    type Saved = Parameters<NonNullable<ConstructorParameters<typeof HarnessConversationStore>[0]>["save"]>[0];
    let saved: Saved | null = null;
    const adapter = { mode: "json-file", load: () => saved, save: (value: Saved) => { saved = structuredClone(value); },
      backup: () => null, restore: () => { if (!saved) throw new Error("No synthetic snapshot"); return saved; },
      describe: () => ({ mode: "json-file", configured: true, snapshotExists: Boolean(saved) }),
    } satisfies SnapshotAdapter<Saved>;
    const store = new HarnessConversationStore(adapter);
    const input = request(["focus_marker_a", "focus_marker_b"]);
    const first = store.begin(input, "synthetic-owner:project:a");
    expect(first.context?.selectedContext).toEqual(["page_home"]);
    first.commit(receipt(input)); first.release();
    const serialized = JSON.stringify(saved);
    for (const marker of ["selectedCellIds", "notebookContext", "focus_marker_a", "Private marker title",
      "synthetic_parameter_not_for_history", "synthetic_source_not_for_history"]) expect(serialized).not.toContain(marker);
    const reopened = new HarnessConversationStore(adapter).begin(request(), "synthetic-owner:project:a");
    expect(reopened.context?.recentMessages).toHaveLength(1);
    expect(reopened.context?.selectedContext).toEqual(["page_home"]);
    reopened.release();
  });

  it("neither remembered nor client-claimed historic selection replaces the current request focus", () => {
    const store = new HarnessConversationStore();
    const old = request(["focus_marker_a"]), first = store.begin(old, "owner");
    first.commit(receipt(old)); first.release();
    const next = { ...request(["focus_marker_b"]), conversationContext: { selectedContext: ["focus_marker_a"] } };
    const copy = structuredClone(next), second = store.begin(next, "owner");
    expect(second.context?.selectedContext).toEqual(["page_home"]);
    expect(next).toEqual(copy);
    expect(next.notebookContext?.selectedCellIds).toEqual(["focus_marker_b"]);
    second.commit(receipt(next)); second.release();
    const cleared = request(), third = store.begin(cleared, "owner");
    expect(cleared.notebookContext?.selectedCellIds).toBeUndefined();
    expect(third.context?.selectedContext).toEqual(["page_home"]);
    third.release();
  });

  it("does not use focus to weaken project, owner or page isolation", () => {
    const store = new HarnessConversationStore(), input = request(["focus_marker_a"]);
    const first = store.begin(input, "owner:a:project:a"); first.commit(receipt(input)); first.release();
    for (const [namespace, pageId] of [["owner:a:project:b", "page_home"], ["owner:b:project:a", "page_home"],
      ["owner:a:project:a", "page_other"]]) {
      const isolated = store.begin({ ...input, pageId }, namespace);
      expect(isolated.context?.recentMessages).toBeUndefined();
      expect(isolated.context?.selectedContext).toEqual([pageId]);
      isolated.release();
    }
  });
});
