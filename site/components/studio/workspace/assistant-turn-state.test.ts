import { describe, expect, it } from "vitest";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import { assistantTurnState } from "./assistant-turn-state";

describe("assistantTurnState", () => {
  it.each([
    ["success", "success", null],
    ["failed", "error", "保留原失败说明。"],
    ["blocked", "blocked", "保留原失败说明。"],
    ["cancelled", "cancelled", "保留原失败说明。"],
  ] as const)("maps persisted %s to the existing request UI without mutating the turn", (state, requestStatus, requestError) => {
    const turn: AssistantConversationTurn = { id: "synthetic_turn", instruction: "检查测试数据",
      response: "保留原失败说明。", createdAt: "2026-09-23T00:00:00.000Z", state,
      taskId: "synthetic_task", pageId: "synthetic_page" };
    const original = structuredClone(turn);
    Object.freeze(turn);
    expect(assistantTurnState(turn)).toEqual({ requestStatus, requestError });
    expect(turn).toEqual(original);
  });

  it("returns idle with no error for an empty session", () => {
    expect(assistantTurnState()).toEqual({ requestStatus: "idle", requestError: null });
  });

  it("retains the exact saved error without interpreting markup or requiring a task summary", () => {
    const response = "**错误**\n`原说明` <img src=\"https://invalid.example/test.png\">";
    const turn: AssistantConversationTurn = { id: "legacy_turn", instruction: "检查测试数据", response,
      createdAt: "2026-09-23T00:00:00.000Z", state: "failed" };
    expect(assistantTurnState(turn)).toEqual({ requestStatus: "error", requestError: response });
    expect(turn).not.toHaveProperty("taskId");
  });
});
