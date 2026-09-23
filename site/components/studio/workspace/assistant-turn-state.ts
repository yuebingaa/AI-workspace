import type { AssistantConversationTurn } from "@/core/harness/conversation";

/** Rebuild transient UI state from the selected conversation, not task history.
 * Restoring a retry button never starts a request or restores file access. */
export function assistantTurnState(turn?: AssistantConversationTurn): {
  requestStatus: "idle" | "success" | "error" | "blocked" | "cancelled";
  requestError: string | null;
} {
  if (!turn) return { requestStatus: "idle", requestError: null };
  return {
    requestStatus: turn.state === "failed" ? "error" : turn.state,
    requestError: turn.state === "success" ? null : turn.response,
  };
}
