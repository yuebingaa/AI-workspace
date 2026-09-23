import { describe, expect, it } from "vitest";
import { activeAssistantSession, assistantSessionsForPage, assistantSessionsSchema, createAssistantSessions, newAssistantSession, restoreAssistantSessions, selectAssistantPage, selectAssistantSession, updateActiveAssistantSession } from "./assistant-sessions";
import { createStudioSnapshot, exportStudioBackup, importStudioBackup, loadStudioStateSafely, parseStudioPersistedState } from "@/core/repository";
import { projectState } from "@/core/projects/test-fixture";
import { createHarnessTask } from "./task-state";

const turn = (id: string, pageId?: string) => ({ id, pageId, instruction: `问题 ${id}`, response: `回复 ${id}`, createdAt: "2026-09-23T00:00:00.000Z", state: "success" as const });

describe("assistant interface isolation", () => {
  it("keeps separate drafts, context IDs, histories and each interface's selected thread", () => {
    let sessions = createAssistantSessions([turn("a1", "page_a")], "page_a");
    const first = activeAssistantSession(sessions);
    const second = { ...newAssistantSession([turn("a2", "page_a")], "page_a"), draft: "A 草稿" };
    sessions = selectAssistantSession({ ...sessions, items: [...sessions.items, second] }, second.id);
    sessions = selectAssistantPage(sessions, "page_b");
    const other = activeAssistantSession(sessions);
    expect(other).toMatchObject({ pageId: "page_b", turns: [], draft: "" });
    expect(other.contextId).not.toBe(first.contextId);
    sessions = updateActiveAssistantSession(sessions, { turns: [turn("b", "page_b")], draft: "B 草稿" });
    expect(activeAssistantSession(selectAssistantPage(sessions, "page_a"))).toEqual(second);
    expect(assistantSessionsForPage(sessions, "page_b")).toHaveLength(1);
    expect(activeAssistantSession(selectAssistantPage(selectAssistantPage(sessions, "page_a"), "page_b")).draft).toBe("B 草稿");
    expect(assistantSessionsSchema.safeParse(sessions).success).toBe(true);
  });

  it("migrates mixed-page legacy turns once, preserving ambiguous turns and the draft only on the last known page", () => {
    const old = createAssistantSessions([turn("a", "page_a"), turn("unknown"), turn("b", "page_b")]);
    old.items[0].draft = "旧未发送文字";
    const before = structuredClone(old);
    const restored = restoreAssistantSessions(old, [], "page_blank");
    expect(old).toEqual(before);
    expect(assistantSessionsForPage(restored, "page_a")[0].turns.map((item) => item.id)).toEqual(["a"]);
    expect(assistantSessionsForPage(restored, "page_a")[0].draft).toBe("");
    expect(activeAssistantSession(restored)).toMatchObject({ id: old.activeId, pageId: "page_b", draft: "旧未发送文字" });
    expect(activeAssistantSession(restored).turns.map((item) => item.id)).toEqual(["unknown", "b"]);
    expect(restoreAssistantSessions(restored, [], "page_blank")).toBe(restored);
    expect(assistantSessionsSchema.safeParse(restored).success).toBe(true);
  });

  it("uses task page evidence and keeps interrupted first replies with their original interface", () => {
    const task = createHarnessTask("pending_page_request", "中断问题", "page_b", "editor", { now: () => new Date(), id: () => "pending_event" });
    const sessions = createAssistantSessions([turn("a", "page_a")]);
    sessions.items[0].pendingTaskId = task.id;
    const state = { ...projectState(), assistantSessions: sessions, harnessTasks: [task] };
    const loaded = loadStudioStateSafely({ load: () => state, save() {}, clear() {} }, state.dataProduct);
    const restored = restoreAssistantSessions(loaded.assistantSessions, loaded.assistantConversation, "page_blank", loaded.harnessTasks);
    expect(activeAssistantSession(restored)).toMatchObject({ pageId: "page_b" });
    expect(activeAssistantSession(restored).turns[0]).toMatchObject({ state: "cancelled", taskId: task.id });
    expect(assistantSessionsForPage(restored, "page_a")[0].turns).toHaveLength(1);
    const withoutPage = createAssistantSessions([{ ...turn("task-only"), taskId: task.id }]);
    expect(activeAssistantSession(restoreAssistantSessions(withoutPage, [], "page_blank", [task])).pageId).toBe("page_b");
  });

  it("assigns truly unscoped history to the fallback once, not to every interface", () => {
    const sessions = restoreAssistantSessions(null, [turn("unknown")], "page_blank");
    expect(activeAssistantSession(sessions).pageId).toBe("page_blank");
    expect(activeAssistantSession(selectAssistantPage(sessions, "page_new")).turns).toEqual([]);
    expect(sessions.items[0].turns).toHaveLength(1);
  });

  it("retains deleted-page history without showing it on a different page", () => {
    const sessions = createAssistantSessions([turn("old", "deleted_page")], "deleted_page");
    const switched = selectAssistantPage(sessions, "page_blank");
    expect(activeAssistantSession(switched).turns).toEqual([]);
    expect(switched.items[0]).toEqual(sessions.items[0]);
  });

  it("rejects cross-interface selection maps and mixed-page owned messages", () => {
    const sessions = createAssistantSessions([turn("a", "page_a")], "page_a");
    expect(assistantSessionsSchema.safeParse({ ...sessions, activeByPage: { page_b: sessions.activeId } }).success).toBe(false);
    expect(assistantSessionsSchema.safeParse({ ...sessions, items: [{ ...sessions.items[0], turns: [turn("b", "page_b")] }] }).success).toBe(false);
  });

  it("migrates the legacy worst-case turn partition without dropping any history", () => {
    const items = Array.from({ length: 50 }, (_, index) => newAssistantSession(Array.from({ length: 20 }, (_, page) => turn(`${index}_${page}`, `page_${page}`))));
    const restored = restoreAssistantSessions({ activeId: items[0].id, items }, [], "page_blank");
    expect(restored.items).toHaveLength(1000);
    expect(restored.items.reduce((sum, item) => sum + item.turns.length, 0)).toBe(1000);
    expect(assistantSessionsSchema.safeParse(restored).success).toBe(true);
  });

  it("upgrades v6 and round-trips page ownership and last selections through snapshots and backup", () => {
    const old = { ...projectState(), version: 6, assistantSessions: createAssistantSessions([turn("a", "page_a")]) };
    const migrated = parseStudioPersistedState(old);
    expect(migrated.version).toBe(7);
    const sessions = selectAssistantPage(restoreAssistantSessions(migrated.assistantSessions, [], "page_blank"), "page_b");
    const loaded = loadStudioStateSafely({ load: () => migrated, save() {}, clear() {} }, migrated.dataProduct);
    const snapshot = createStudioSnapshot(loaded.dataProduct, loaded.execution, [], [], [], null, activeAssistantSession(sessions).turns, sessions);
    expect(importStudioBackup(exportStudioBackup(snapshot)).assistantSessions).toEqual(sessions);
    expect(activeAssistantSession(sessions).pageId).toBe("page_b");
  });
});
