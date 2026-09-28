import { describe, expect, it } from "vitest";
import { appendHarnessEvent, createHarnessTask, recoverHarnessTasksAfterRefresh } from "./task-state";
import { isDshConversationTaskIdentity, newAssistantRequestIdempotencyKey } from "./assistant-request-identity";

const clock = { now: () => new Date("2026-09-26T10:00:00.000Z"), id: () => "recovery_test_event" };
function task(key = "request_classic") {
  return appendHarnessEvent(createHarnessTask(key, "先不要分析数据，先介绍你自己。", "page_home", "editor", clock),
    { type: "state", state: "completed", message: "对话已完成" }, clock,
    { terminationCode: "completed", resultMessage: "我是数据分析助手。" });
}

describe("conversation-aware task refresh recovery", () => {
  it("preserves an explicitly owned DSH conversation receipt without reclassifying its wording", () => {
    const receipt = task();
    expect(recoverHarnessTasksAfterRefresh([receipt], clock, new Set([receipt.id]))).toEqual([receipt]);
  });
  it("keeps the classic missing-tool migration unchanged", () => {
    expect(recoverHarnessTasksAfterRefresh([task()], clock)[0]).toMatchObject({ state: "blocked", terminationCode: "missingContext" });
    expect(recoverHarnessTasksAfterRefresh([task()], clock, new Set(["different_task"]))[0].state).toBe("blocked");
  });
  it("recognizes exact tagged receipt identities after visible turns are trimmed", () => {
    const key = newAssistantRequestIdempotencyKey("dsh-conversation"), receipt = task(key);
    expect(isDshConversationTaskIdentity(receipt)).toBe(true);
    expect(recoverHarnessTasksAfterRefresh([receipt], clock)).toEqual([receipt]);
    expect(isDshConversationTaskIdentity(task(newAssistantRequestIdempotencyKey()))).toBe(false);
  });
  it("does not infer the new mode from a partial prefix, instruction, answer or mismatched task id", () => {
    const tagged = task(newAssistantRequestIdempotencyKey("dsh-conversation"));
    for (const receipt of [task("dshconversation_request_unknown"), { ...tagged, id: "harness_another_request" },
      { ...task(), resultMessage: "我是 DSH 原生对话" }]) {
      expect(isDshConversationTaskIdentity(receipt)).toBe(false);
      expect(recoverHarnessTasksAfterRefresh([receipt], clock)[0].state).toBe("blocked");
    }
  });
  it.each(["planning", "executingTool", "observing"] as const)("still cancels %s instead of resuming it", state => {
    const receipt = { ...task(newAssistantRequestIdempotencyKey("dsh-conversation")), state };
    expect(recoverHarnessTasksAfterRefresh([receipt], clock, new Set([receipt.id]))[0]).toMatchObject({ state: "cancelled", terminationCode: "cancelled" });
  });
  it("does not promote existing failure, blockage or unconfirmed writes to successful conversations", () => {
    for (const state of ["failed", "blocked", "cancelled", "awaitingConfirmation"] as const) {
      const receipt = { ...task(newAssistantRequestIdempotencyKey("dsh-conversation")), state };
      expect(recoverHarnessTasksAfterRefresh([receipt], clock, new Set([receipt.id]))).toEqual([receipt]);
    }
  });
});
