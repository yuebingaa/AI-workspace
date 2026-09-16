import { describe, expect, it } from "vitest";
import { activeAssistantSession, assistantSessionsSchema, createAssistantSessions, newAssistantSession, restoreAssistantSessions, updateActiveAssistantSession } from "./assistant-sessions";
import { createStudioSnapshot, exportStudioBackup, importStudioBackup, loadStudioStateSafely, parseStudioPersistedState, restoreStudioBackup } from "@/core/repository";
import { createHarnessTask } from "./task-state";
import { projectState } from "@/core/projects/test-fixture";

const turn = { id: "turn-one", pageId: "page-one", instruction: "销售情况", response: "已回答", state: "success" as const, createdAt: "2026-09-16T00:00:00.000Z" };
describe("project conversation snapshots", () => {
  it("migrates v5 without losing old messages, including an explicitly cleared conversation", () => {
    const old: Record<string, unknown> = { ...projectState(), version: 5, assistantConversation: [turn] };
    delete old.assistantSessions;
    const legacy = parseStudioPersistedState(old);
    const sessions = restoreAssistantSessions(legacy.assistantSessions, legacy.assistantConversation);
    expect(activeAssistantSession(sessions)).toMatchObject({ title: "销售情况", turns: [turn], pageIds: ["page-one"] });
    expect(restoreAssistantSessions(null, []).items[0].turns).toEqual([]);
  });
  it("changes only the active thread, preserving other drafts and identities", () => {
    const first = createAssistantSessions([turn]), second = { ...newAssistantSession(), draft: "未发送的问题" };
    const sessions = { activeId: second.id, items: [...first.items, second] };
    const updated = updateActiveAssistantSession(sessions, { turns: [{ ...turn, id: "turn-two", instruction: "库存情况" }], draft: "" });
    expect(updated.items[0]).toEqual(first.items[0]);
    expect(activeAssistantSession(updated)).toMatchObject({ title: "库存情况", contextId: second.contextId });
    expect(second.draft).toBe("未发送的问题");
  });
  it("round-trips all threads and selection through project state and backup", () => {
    const state = projectState(), first = createAssistantSessions([turn]), second = { ...newAssistantSession(), draft: "还没发送" };
    const sessions = { activeId: second.id, items: [...first.items, second] };
    const loaded = loadStudioStateSafely({ load: () => ({ ...state, assistantSessions: sessions }), save() {}, clear() {} }, state.dataProduct);
    expect(loaded.assistantConversation).toEqual([]);
    const snapshot = createStudioSnapshot(loaded.dataProduct, loaded.execution, [], [], [], null, [], sessions);
    const restored = importStudioBackup(exportStudioBackup(snapshot));
    expect(restored.assistantSessions).toEqual(sessions);
    expect(restored.assistantConversation).toEqual([]);
  });
  it("rejects selection outside the project and duplicate session/context IDs", () => {
    const sessions = createAssistantSessions([turn]);
    expect(assistantSessionsSchema.safeParse({ ...sessions, activeId: newAssistantSession().id }).success).toBe(false);
    expect(assistantSessionsSchema.safeParse({ ...sessions, items: [...sessions.items, sessions.items[0]] }).success).toBe(false);
    expect(assistantSessionsSchema.safeParse({ ...sessions, items: [...sessions.items, { ...newAssistantSession(), contextId: sessions.items[0].contextId }] }).success).toBe(false);
  });
  it("recovers a first in-flight reply into its own thread after refresh", () => {
    const state = projectState(), sessions = createAssistantSessions();
    const task = createHarnessTask("interrupted_request", "检查中断任务", "page-one", "editor", { now: () => new Date(), id: () => "interrupted_event" });
    sessions.items[0].pendingTaskId = task.id;
    const other = newAssistantSession([turn]); sessions.items.push(other);
    const saved = { ...state, assistantSessions: sessions, harnessTasks: [task] };
    const restored = loadStudioStateSafely({ load: () => saved, save() {}, clear() {} }, state.dataProduct);
    expect(restored.assistantConversation).toHaveLength(1);
    expect(restored.assistantConversation[0]).toMatchObject({ instruction: "检查中断任务", state: "cancelled", taskId: task.id });
    expect(restored.assistantSessions?.items[0].pendingTaskId).toBeUndefined();
    expect(restored.assistantSessions?.items[1]).toEqual(other);
  });
  it("rotates server context on backup restore so newer server messages cannot leak into older backups", () => {
    const state = projectState(), sessions = createAssistantSessions([turn]);
    const restored = restoreStudioBackup({ load: () => null, save() {}, clear() {} }, exportStudioBackup({ ...state, assistantSessions: sessions }));
    expect(restored.assistantSessions?.activeId).toBe(sessions.activeId);
    expect(restored.assistantSessions?.items[0].turns).toEqual([turn]);
    expect(restored.assistantSessions?.items[0].contextId).not.toBe(sessions.items[0].contextId);
  });
});
