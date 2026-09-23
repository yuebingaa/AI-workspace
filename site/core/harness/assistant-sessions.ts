import { z } from "zod";
import { appendAssistantConversationTurn, assistantConversationFromHarnessTasks, assistantConversationTurnSchema, MAX_ASSISTANT_CONVERSATION_TURNS, type AssistantConversationTurn } from "./conversation";
import type { HarnessTaskSummary } from "./contracts";

export const MAX_ASSISTANT_SESSIONS = 50;
// Enough room to split all 50 legacy threads (20 turns + a pending page each)
// without dropping history. New threads remain limited to 50 per interface.
export const MAX_PROJECT_ASSISTANT_SESSIONS = 1050;
const sessionIdSchema = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const pageIdSchema = z.string().min(1).max(120);
export const assistantSessionSchema = z.object({
  id: sessionIdSchema,
  contextId: sessionIdSchema,
  title: z.string().min(1).max(80),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  draft: z.string().max(1_000),
  pageId: pageIdSchema.optional(),
  pageIds: z.array(z.string().min(1).max(120)).max(100),
  pendingTaskId: z.string().min(1).max(160).optional(),
  turns: z.array(assistantConversationTurnSchema).max(MAX_ASSISTANT_CONVERSATION_TURNS),
}).strict();
export const assistantSessionsSchema = z.object({
  activeId: sessionIdSchema,
  items: z.array(assistantSessionSchema).min(1).max(MAX_PROJECT_ASSISTANT_SESSIONS),
  activeByPage: z.record(pageIdSchema, sessionIdSchema).optional(),
}).strict().superRefine((value, context) => {
  if (!value.items.some((item) => item.id === value.activeId)) context.addIssue({ code: "custom", message: "当前会话不在项目会话列表中" });
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length
    || new Set(value.items.map((item) => item.contextId)).size !== value.items.length) {
    context.addIssue({ code: "custom", message: "项目会话标识不能重复" });
  }
  for (const [pageId, id] of Object.entries(value.activeByPage ?? {})) {
    if (!value.items.some((item) => item.id === id && item.pageId === pageId)) {
      context.addIssue({ code: "custom", message: "界面所选会话必须属于该界面" });
    }
  }
  for (const item of value.items) {
    if (item.pageId && (item.pageIds.some((id) => id !== item.pageId) || item.turns.some((turn) => turn.pageId && turn.pageId !== item.pageId))) {
      context.addIssue({ code: "custom", message: "会话不能混入其他界面的聊天" });
    }
  }
});
export type AssistantSession = z.infer<typeof assistantSessionSchema>;
export type AssistantSessions = z.infer<typeof assistantSessionsSchema>;

export function newAssistantSession(turns: AssistantConversationTurn[] = [], pageId?: string): AssistantSession {
  const id = `conversation_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  return { id, contextId: id, title: turns[0]?.instruction.replace(/\s+/gu, " ").slice(0, 48) || "新会话",
    createdAt: turns[0]?.createdAt ?? now, updatedAt: turns.at(-1)?.createdAt ?? now,
    draft: "", ...(pageId ? { pageId } : {}), pageIds: pageId ? [pageId] : [...new Set(turns.flatMap((turn) => turn.pageId ? [turn.pageId] : []))], turns };
}
export function createAssistantSessions(turns: AssistantConversationTurn[] = [], pageId?: string): AssistantSessions {
  const session = newAssistantSession(turns, pageId);
  return { activeId: session.id, items: [session], ...(pageId ? { activeByPage: { [pageId]: session.id } } : {}) };
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
export function restoreAssistantSessions(sessions: AssistantSessions | null | undefined, turns: AssistantConversationTurn[], fallbackPageId?: string, tasks: HarnessTaskSummary[] = []): AssistantSessions {
  const restored = sessions ?? createAssistantSessions(turns);
  if (!fallbackPageId || restored.items.every((item) => item.pageId)) return restored;
  let activeId = restored.activeId;
  const items = restored.items.flatMap((item) => {
    if (item.pageId) return [item];
    const pendingPage = tasks.find((task) => task.id === item.pendingTaskId)?.pageId;
    const turnPage = (turn: AssistantConversationTurn) => turn.pageId ?? tasks.find((task) => task.id === turn.taskId)?.pageId;
    // Unknown old turns / the one old draft stay with the last known page, once.
    const owner = pendingPage ?? item.turns.map(turnPage).filter(Boolean).at(-1) ?? item.pageIds.at(-1) ?? fallbackPageId;
    const pages = [...new Set([owner, ...item.turns.map((turn) => turnPage(turn) ?? owner)])];
    return pages.map((pageId) => {
      const pageTurns = item.turns.filter((turn) => (turnPage(turn) ?? owner) === pageId).map((turn) => ({ ...turn, pageId }));
      const primary = pageId === owner;
      const identity = primary ? item : newAssistantSession(pageTurns, pageId);
      const scoped = { ...item, id: identity.id, contextId: identity.contextId, pageId, pageIds: [pageId],
        turns: pageTurns, draft: primary ? item.draft : "",
        title: pages.length === 1 ? item.title : pageTurns[0]?.instruction.replace(/\s+/gu, " ").slice(0, 48) || "新会话",
        pendingTaskId: primary ? item.pendingTaskId : undefined };
      if (item.id === restored.activeId && primary) activeId = scoped.id;
      return scoped;
    });
  });
  return { ...restored, activeId, items };
}

export function assistantSessionsForPage(sessions: AssistantSessions, pageId: string): AssistantSession[] {
  return sessions.items.filter((item) => item.pageId === pageId);
}

export function selectAssistantSession(sessions: AssistantSessions, id: string): AssistantSessions {
  const target = sessions.items.find((item) => item.id === id);
  if (!target) return sessions;
  return { ...sessions, activeId: id, ...(target.pageId ? { activeByPage: { ...sessions.activeByPage, [target.pageId]: id } } : {}) };
}

/** Interface identity is the stable page ID, never its editable / duplicate title. */
export function selectAssistantPage(sessions: AssistantSessions, pageId: string): AssistantSessions {
  const current = activeAssistantSession(sessions);
  if (current.pageId === pageId) return sessions;
  sessions = selectAssistantSession(sessions, current.id);
  const remembered = Object.hasOwn(sessions.activeByPage ?? {}, pageId) ? sessions.activeByPage?.[pageId] : undefined;
  const candidates = assistantSessionsForPage(sessions, pageId);
  const target = candidates.find((item) => item.id === remembered)
    ?? [...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (target) return selectAssistantSession(sessions, target.id);
  if (sessions.items.length >= MAX_PROJECT_ASSISTANT_SESSIONS) throw new Error("项目会话容量已满，请先备份并整理项目。");
  const created = newAssistantSession([], pageId);
  return selectAssistantSession({ ...sessions, items: [...sessions.items, created] }, created.id);
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
