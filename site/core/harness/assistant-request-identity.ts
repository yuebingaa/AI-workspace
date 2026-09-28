import type { AssistantExperience } from "./assistant-sessions";
import type { HarnessTaskSummary } from "./contracts";

const requestPrefixes: Record<AssistantExperience, string> = {
  classic: "request_",
  "dsh-conversation": "dshconversation_request_",
};

/** Client recovery identity only: never an execution-mode or authorization input. */
export function newAssistantRequestIdempotencyKey(experience: AssistantExperience = "classic"): string {
  return `${requestPrefixes[experience]}${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Preserve tagged receipts even after their visible conversation turns are trimmed. */
export function isDshConversationTaskIdentity(task: Pick<HarnessTaskSummary, "id" | "idempotencyKey">): boolean {
  const prefix = requestPrefixes["dsh-conversation"];
  return task.idempotencyKey.startsWith(prefix)
    && /^\d{10,16}_[a-f0-9]{32}$/.test(task.idempotencyKey.slice(prefix.length))
    && task.id === `harness_${task.idempotencyKey}`;
}
