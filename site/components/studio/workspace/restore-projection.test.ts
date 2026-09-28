import { describe, expect, it } from "vitest";
import { createAssistantSessions } from "@/core/harness/assistant-sessions";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import { createHarnessTask } from "@/core/harness/task-state";
import { loadStudioStateSafely } from "@/core/repository";
import { INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { prepareWorkspaceRestoration } from "./restore-projection";

function fixtureState() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return loadStudioStateSafely(null, demoFixtureResult.data.dataProduct);
}

describe("prepareWorkspaceRestoration", () => {
  it("restores the blank entry and selected source without mutating the saved product", () => {
    const restored = fixtureState();
    const before = structuredClone(restored.dataProduct);
    const projection = prepareWorkspaceRestoration(restored, "dsh-conversation");
    expect(projection.pageId).toBe(INITIAL_WORKSPACE_PAGE_ID);
    expect(projection.execution.present.pages.some((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)).toBe(true);
    expect(projection.dataProduct.appSpec).toBe(projection.execution.present);
    expect(projection.latestTurn).toBeUndefined();
    expect(projection.turnState).toEqual({ requestStatus: "idle", requestError: null });
    expect(restored.dataProduct).toEqual(before);
  });

  it("recovers the active conversation's response and CSV source IDs for both restore paths", () => {
    const restored = fixtureState();
    const turn: AssistantConversationTurn = {
      id: "synthetic_turn", instruction: "检查合成数据", response: "测试失败说明",
      createdAt: "2026-09-26T00:00:00.000Z", state: "failed", pageId: INITIAL_WORKSPACE_PAGE_ID,
    };
    restored.assistantSessions = createAssistantSessions([turn], INITIAL_WORKSPACE_PAGE_ID, "dsh-conversation");
    const source = restored.execution.present.dataSources[0];
    if (!source) throw new Error("fixture must contain a source");
    restored.execution.present.dataSources.push({ ...source, id: "synthetic_csv", sourceType: "csv" });
    const projection = prepareWorkspaceRestoration(restored, "dsh-conversation");
    expect(projection.latestTurn).toEqual(turn);
    expect(projection.turnState).toEqual({ requestStatus: "error", requestError: "测试失败说明" });
    expect(projection.uploadedDatasetIds).toEqual(["synthetic_csv"]);
  });

  it("keeps a pending confirmation paired with its restored conversation", () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const restored = fixtureState();
    const task = createHarnessTask("synthetic_pending", "预览合成变更", INITIAL_WORKSPACE_PAGE_ID, "editor", {
      now: () => new Date("2026-09-26T00:00:00.000Z"), id: () => "synthetic_event",
    });
    const pending = { ...task, state: "awaitingConfirmation" as const,
      pendingChangeSet: demoFixtureResult.data.repurchaseChangeSet };
    const turn: AssistantConversationTurn = {
      id: "synthetic_pending_turn", instruction: task.instruction, response: "待确认",
      createdAt: "2026-09-26T00:00:00.000Z", state: "success", taskId: task.id,
      pageId: INITIAL_WORKSPACE_PAGE_ID,
    };
    restored.harnessTasks = [pending];
    restored.assistantSessions = createAssistantSessions([turn], INITIAL_WORKSPACE_PAGE_ID, "dsh-conversation");
    const projection = prepareWorkspaceRestoration(restored, "dsh-conversation");
    expect(projection.pendingHarnessTask).toEqual(pending);
    expect(projection.latestTurn?.taskId).toBe(task.id);
  });
});
