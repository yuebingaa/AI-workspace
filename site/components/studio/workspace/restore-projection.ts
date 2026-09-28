import { activeAssistantSession, restoreAssistantSessions, selectAssistantPage, type AssistantExperience } from "@/core/harness/assistant-sessions";
import type { SafeStudioState } from "@/core/repository";
import { selectedSemanticModel } from "@/core/semantic/model";
import { datasetsForWorkspace, ensureInitialBlankWorkspaceInExecution, ensureInitialBlankWorkspaceInProduct, INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import { assistantTurnState } from "./assistant-turn-state";
import { selectablePageId } from "./pages";

/** Derive the shared, persisted part of a workspace restore before changing UI state. */
export function prepareWorkspaceRestoration(restored: SafeStudioState, experience: AssistantExperience) {
  const dataProduct = ensureInitialBlankWorkspaceInProduct(restored.dataProduct);
  const execution = ensureInitialBlankWorkspaceInExecution(restored.execution);
  const migratedSessions = restoreAssistantSessions(restored.assistantSessions, restored.assistantConversation, INITIAL_WORKSPACE_PAGE_ID, restored.harnessTasks);
  const pageId = selectablePageId(execution.present, activeAssistantSession(migratedSessions).pageId);
  // Capacity errors must be raised before callers replace any saved workspace state.
  const sessions = selectAssistantPage(migratedSessions, pageId, experience);
  const latestTurn = activeAssistantSession(sessions).turns.at(-1);
  return {
    dataProduct: { ...dataProduct, appSpec: execution.present },
    execution,
    sessions,
    pageId,
    activeDataSourceId: selectedSemanticModel(dataProduct, pageId)?.sourceDatasetId
      ?? datasetsForWorkspace(dataProduct.datasets, pageId)[0]?.id ?? "",
    latestTurn,
    turnState: assistantTurnState(latestTurn),
    pendingHarnessTask: restored.harnessTasks.find((task) => task.id === latestTurn?.taskId && task.state === "awaitingConfirmation" && task.pendingChangeSet),
    uploadedDatasetIds: execution.present.dataSources.filter((source) => source.sourceType === "csv").map((source) => source.id),
  };
}
