import type { OwnershipScope } from "@/core/identity/ownership";
import { ownershipNamespace } from "@/core/identity/ownership";
import { wecomOwnershipNamespace } from "@/core/wecom/server/session";

/** Shared by execution and clearing: an entry point cannot erase another one's history. */
export function harnessConversationNamespace(
  request: Request,
  identity: OwnershipScope,
  projectHandle: string | null,
  options: { visualizationLab?: boolean; dshConversation?: boolean } = {},
) {
  return `${wecomOwnershipNamespace(request, ownershipNamespace(identity))}${projectHandle ? `:project:${projectHandle}` : ""}`
    + (options.dshConversation ? ":dsh-conversation-v1" : options.visualizationLab ? ":visualization-lab" : "");
}
