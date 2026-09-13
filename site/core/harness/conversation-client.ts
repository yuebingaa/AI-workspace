import { activeProjectHandle, projectHeaders } from "@/core/projects/client";
const storageKey = () => `agentcanvas.harness.conversations.v1${activeProjectHandle() ? `:project:${activeProjectHandle()}` : ""}`;
const idsByScope = new Map<string, Record<string, string>>();
function readIds() {
  const key = storageKey();
  let sessionIds = idsByScope.get(key) ?? {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      sessionIds = Object.fromEntries(Object.entries(value).filter(([page, id]) => page.length <= 120
        && typeof id === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(id)).slice(-100));
    }
  } catch { /* Private browsing still has in-tab continuity. */ }
  idsByScope.set(key, sessionIds);
  return sessionIds;
}
export function harnessConversationId(pageId: string) {
  const ids = readIds();
  ids[pageId] ??= `conversation_${crypto.randomUUID().replaceAll("-", "")}`;
  try { localStorage.setItem(storageKey(), JSON.stringify(ids)); } catch { /* Session only. */ }
  return ids[pageId];
}
export async function clearHarnessConversations() {
  const key = storageKey();
  const headers = projectHeaders({ "content-type": "application/json" });
  const entries = Object.entries(readIds());
  for (const [pageId, conversation_id] of entries) {
    const response = await fetch("/api/ai/harness/conversation", {
      method: "DELETE", headers,
      body: JSON.stringify({ pageId, conversation_id }), cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("服务端会话尚未清除，请稍后重试。");
  }
  idsByScope.delete(key);
  try { localStorage.removeItem(key); } catch { /* Session only. */ }
}
