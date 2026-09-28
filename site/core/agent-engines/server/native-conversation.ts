import { createHash } from "node:crypto";
import type { HarnessRequest, HarnessTaskSummary } from "@/core/harness/contracts";
import type { NotebookCapabilities } from "@/core/notebook/capabilities";
import type { DshNativeSessionBinding } from "./dsh-engine";
import { configuredDshNativeSessionStore, type DshNativeSessionStore } from "./native-session-store";
import { configuredDshPluginSettings } from "./plugin-settings";

/** Hash only the authorized scope. Current notebook edits do not turn old results
 * into evidence, but a removed source/connection/policy must end native continuity. */
export function dshNativeScopeFingerprint(request: HarnessRequest, capabilities: NotebookCapabilities, pluginRevision = 0): string {
  const ids = new Set(request.notebookContext?.sourceIds ?? (request.dataSourceId ? [request.dataSourceId] : []));
  const sources = request.appSpec.dataSources.filter(source => ids.has(source.id))
    .map(source => ({ ...source })).sort((a, b) => a.id.localeCompare(b.id));
  const connections = [...(request.notebookContext?.connections ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ format: "dsh-0.1.7-rc.2-native-v1", role: request.role,
    sources, sourceIds: [...ids].sort(), connections, capabilities,
    ...(pluginRevision > 0 ? { pluginRevision } : {}), selectedSource: request.dataSourceId, semanticModel: request.semanticModel,
    rawWorkbook: request.rawWorkbookManifest, images: request.imageAttachmentManifest })).digest("hex");
}

interface NativeConversationOptions {
  namespace: string;
  request: HarnessRequest;
  capabilities: NotebookCapabilities;
  signal: AbortSignal;
  authorizeCurrentAccess(): void;
  run(request: HarnessRequest, session?: DshNativeSessionBinding): Promise<HarnessTaskSummary>;
  store?: Pick<DshNativeSessionStore, "begin">;
}

/** The SDK can only write a candidate. Business verification and final access
 * checks must finish before that candidate becomes the next turn's history. */
export async function runDshNativeConversation(options: NativeConversationOptions): Promise<HarnessTaskSummary> {
  const store = options.store ?? configuredDshNativeSessionStore();
  if (!store) return options.run(options.request);
  if (!options.request.conversation_id) throw new Error("原生 DSH 会话缺少会话标识。");
  const check = () => { options.signal.throwIfAborted(); options.authorizeCurrentAccess(); };
  check();
  const lease = await store.begin({ namespace: options.namespace, conversationId: options.request.conversation_id,
    pageId: options.request.pageId, scopeFingerprint: dshNativeScopeFingerprint(options.request, options.capabilities,
      configuredDshPluginSettings().read().revision) });
  try {
    check();
    const request = structuredClone(options.request);
    delete request.conversationContext;
    const task = await options.run(request, { sessionId: lease.sessionId, root: lease.root, mode: lease.mode });
    if (task.state === "completed" || task.state === "awaitingConfirmation") {
      check();
      await lease.commit(check);
      task.nativeConversation = lease.continuity;
    }
    return task;
  } finally { await lease.release(); }
}
