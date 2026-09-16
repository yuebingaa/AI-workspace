import { z } from "zod";
import { appendAssistantConversationTurn, assistantConversationFromHarnessTasks, assistantConversationTurnSchema, MAX_ASSISTANT_CONVERSATION_TURNS, type AssistantConversationTurn } from "./conversation";
import type { HarnessTaskSummary } from "./contracts";

export const MAX_ASSISTANT_SESSIONS = 50;
const sessionIdSchema = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const assistantSessionSchema = z.object({
  id: sessionIdSchema,
  contextId: sessionIdSchema,
  title: z.string().min(1).max(80),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  draft: z.string().max(1_000),
  pageIds: z.array(z.string().min(1).max(120)).max(100),
  pendingTaskId: z.string().min(1).max(160).optional(),
  turns: z.array(assistantConversationTurnSchema).max(MAX_ASSISTANT_CONVERSATION_TURNS),
}).strict();
export const assistantSessionsSchema = z.object({
  activeId: sessionIdSchema,
  items: z.array(assistantSessionSchema).min(1).max(MAX_ASSISTANT_SESSIONS),
}).strict().superRefine((value, context) => {
  if (!value.items.some((item) => item.id === value.activeId)) context.addIssue({ code: "custom", message: "当前会话不在项目会话列表中" });
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length
    || new Set(value.items.map((item) => item.contextId)).size !== value.items.length) {
    context.addIssue({ code: "custom", message: "项目会话标识不能重复" });
  }
});
export type AssistantSession = z.infer<typeof assistantSessionSchema>;
export type AssistantSessions = z.infer<typeof assistantSessionsSchema>;

export function newAssistantSession(turns: AssistantConversationTurn[] = []): AssistantSession {
  const id = `conversation_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  return { id, contextId: id, title: turns[0]?.instruction.replace(/\s+/gu, " ").slice(0, 48) || "新会话",
    createdAt: turns[0]?.createdAt ?? now, updatedAt: turns.at(-1)?.createdAt ?? now,
    draft: "", pageIds: [...new Set(turns.flatMap((turn) => turn.pageId ? [turn.pageId] : []))], turns };
}
export function createAssistantSessions(turns: AssistantConversationTurn[] = []): AssistantSessions {
  const session = newAssistantSession(turns);
  return { activeId: session.id, items: [session] };
}
export function activeAssistantSession(sessions: AssistantSessions): AssistantSession {
  return sessions.items.find((item) => item.id === sessions.activeId)!;
}
export function updateActiveAssistantSession(sessions: AssistantSessions, patch: Partial<Omit<AssistantSession, "id" | "createdAt">>): AssistantSessions {
  const current = activeAssistantSession(sessions);
  const title = !current.turns.length && patch.turns?.length
    ? patch.turns[0].instruction.replace(/\s+/gu, " ").slice(0, 48) : current.title;
  const next = { ...current, title, ...(patch.turns ? { pendingTaskId: undefined } : {}), ...patch, updatedAt: new Date().toISOString() };
  return { ...sessions, items: sessions.items.map((item) => item.id === current.id ? next : item) };
}
/** Old single-conversation snapshots become one thread; no project-global list is consulted. */
export function restoreAssistantSessions(sessions: AssistantSessions | null | undefined, turns: AssistantConversationTurn[]): AssistantSessions {
  return sessions ?? createAssistantSessions(turns);
}

/** A refreshed in-flight task belongs to its original thread, even before its first reply. */
export function recoverAssistantSessions(sessions: AssistantSessions | null, tasks: HarnessTaskSummary[]): AssistantSessions | null {
  if (!sessions) return null;
  return { ...sessions, items: sessions.items.map((item) => {
    if (!item.pendingTaskId) return item;
    const task = tasks.find((candidate) => candidate.id === item.pendingTaskId);
    const [turn] = assistantConversationFromHarnessTasks(task ? [task] : []);
    return { ...item, pendingTaskId: undefined,
      ...(turn ? { title: item.turns.length ? item.title : turn.instruction.replace(/\s+/gu, " ").slice(0, 48),
        turns: appendAssistantConversationTurn(item.turns, turn), updatedAt: turn.createdAt } : {}) };
  }) };
}
export function rotateAssistantSessionContexts(sessions: AssistantSessions | null): AssistantSessions | null {
  return sessions && { ...sessions, items: sessions.items.map((item) => ({ ...item, contextId: newAssistantSession().contextId })) };
}
