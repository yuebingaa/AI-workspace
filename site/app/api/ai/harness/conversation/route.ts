import { z } from "zod";
import { harnessConversationStore } from "@/core/harness/server/conversation-store";
import { ownershipNamespace } from "@/core/identity/ownership";
import { wecomOwnershipNamespace } from "@/core/wecom/server/session";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { requestProjectHandle } from "@/core/projects/server/request";

export const runtime = "nodejs";
const inputSchema = z.object({
  conversation_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
  pageId: z.string().min(1).max(120),
}).strict();
export async function DELETE(request: Request) {
  const headers = { "cache-control": "private, no-store" };
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "需要 JSON 请求。" }, { status: 415, headers });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "禁止跨站清除会话。" }, { status: 403, headers });
  try {
    const input = inputSchema.parse(JSON.parse(await readBoundedUtf8Body(request, 2_048)));
    const project = requestProjectHandle(request);
    const namespace = `${wecomOwnershipNamespace(request, ownershipNamespace(resolveDemoRequestIdentity()))}${project ? `:project:${project}` : ""}`;
    harnessConversationStore.clear(namespace, input.conversation_id, input.pageId);
    return Response.json({ cleared: true }, { headers });
  } catch {
    return Response.json({ error: "会话未能清除，请停止在途任务后重试。" }, { status: 409, headers });
  }
}
