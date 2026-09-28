import { describe, expect, it } from "vitest";
import {
  activeAssistantSession, assistantSessionExperience, assistantSessionsForPage, assistantSessionsSchema,
  createAssistantSessions, MAX_ASSISTANT_SESSIONS, MAX_PROJECT_ASSISTANT_SESSIONS,
  newAssistantContextId, newAssistantSession, restoreAssistantSessions, rotateAssistantSessionContexts,
  selectAssistantPage, selectAssistantSession, updateActiveAssistantSession, type AssistantExperience,
} from "./assistant-sessions";
import { exportStudioBackup, importStudioBackup, parseStudioPersistedState, restoreStudioBackup } from "@/core/repository";
import { projectState } from "@/core/projects/test-fixture";

const turn = (id: string, pageId = "page_one") => ({
  id, pageId, instruction: `问题 ${id}`, response: `回复 ${id}`,
  createdAt: "2026-09-26T00:00:00.000Z", state: "success" as const,
});
const experiences: AssistantExperience[] = ["classic", "dsh-conversation"];

describe("assistant entry experience isolation", () => {
  it("keeps legacy identities classic and gives DSH distinct session and context identities", () => {
    const classic = newAssistantSession([], "page_one");
    const dsh = activeAssistantSession(createAssistantSessions([], "page_one", "dsh-conversation"));
    expect(classic.id).toMatch(/^conversation_[a-f0-9]{32}$/u);
    expect(dsh.id).toMatch(/^dshconversation_[a-f0-9]{32}$/u);
    expect(classic.contextId).toBe(classic.id);
    expect(dsh.contextId).toBe(dsh.id);
    expect(assistantSessionExperience(classic)).toBe("classic");
    expect(assistantSessionExperience(dsh)).toBe("dsh-conversation");
    expect(assistantSessionExperience({ id: "legacy_thread_123" })).toBe("classic");
    expect(assistantSessionExperience({ id: "dshconversationwithoutdelimiter" })).toBe("classic");
  });

  it("lists only the requested page and experience, defaulting to classic", () => {
    const classic = newAssistantSession([turn("classic")], "page_one");
    const dsh = newAssistantSession([turn("dsh")], "page_one", "dsh-conversation");
    const otherPage = newAssistantSession([turn("other", "page_two")], "page_two", "dsh-conversation");
    const sessions = { activeId: dsh.id, items: [classic, dsh, otherPage] };
    expect(assistantSessionsForPage(sessions, "page_one")).toEqual([classic]);
    expect(assistantSessionsForPage(sessions, "page_one", "dsh-conversation")).toEqual([dsh]);
    expect(assistantSessionsForPage(sessions, "page_two")).toEqual([]);
    expect(assistantSessionsForPage(sessions, "page_two", "dsh-conversation")).toEqual([otherPage]);
  });

  it("ensures a same-page DSH thread and switches back without deleting classic history or drafts", () => {
    const original = updateActiveAssistantSession(createAssistantSessions([turn("classic")], "page_one"), { draft: "原入口草稿" });
    const before = structuredClone(original);
    const dshSessions = selectAssistantPage(original, "page_one", "dsh-conversation");
    const dsh = activeAssistantSession(dshSessions);
    expect(original).toEqual(before);
    expect(dshSessions.items).toHaveLength(2);
    expect(dshSessions.items[0]).toEqual(before.items[0]);
    expect(dsh).toMatchObject({ pageId: "page_one", draft: "", turns: [] });
    expect(assistantSessionExperience(dsh)).toBe("dsh-conversation");
    expect(dsh.contextId).not.toBe(original.items[0].contextId);
    expect(selectAssistantPage(dshSessions, "page_one", "dsh-conversation")).toBe(dshSessions);
    const returned = selectAssistantPage(dshSessions, "page_one");
    expect(returned.activeId).toBe(original.activeId);
    expect(returned.items).toBe(dshSessions.items);
    expect(activeAssistantSession(returned)).toEqual(before.items[0]);
  });

  it("treats another experience's page selection as a hint and chooses within the requested experience", () => {
    const classic = newAssistantSession([turn("classic")], "page_one");
    const dshOlder = { ...newAssistantSession([turn("older")], "page_one", "dsh-conversation"), updatedAt: "2026-09-25T00:00:00.000Z" };
    const dshLatest = { ...newAssistantSession([turn("latest")], "page_one", "dsh-conversation"), updatedAt: "2026-09-26T00:00:00.000Z" };
    const other = newAssistantSession([], "page_two");
    const sessions = { activeId: other.id, items: [classic, dshOlder, dshLatest, other], activeByPage: { page_one: classic.id } };
    const selected = selectAssistantPage(sessions, "page_one", "dsh-conversation");
    expect(selected.activeId).toBe(dshLatest.id);
    expect(selected.items).toBe(sessions.items);
    expect(assistantSessionsSchema.safeParse(selected).success).toBe(true);
    const remembered = selectAssistantSession(selected, dshOlder.id);
    const otherPage = selectAssistantPage(remembered, "page_two", "dsh-conversation");
    expect(selectAssistantPage(otherPage, "page_one", "dsh-conversation").activeId).toBe(dshOlder.id);
    expect(selectAssistantPage(selected, "page_one").activeId).toBe(classic.id);
  });

  it("preserves legacy migration and never assigns old messages to the new DSH entrance", () => {
    const legacy = createAssistantSessions([turn("old_one"), turn("old_two", "page_two")]);
    legacy.items[0].draft = "保留旧草稿";
    const migrated = restoreAssistantSessions(legacy, [], "page_one");
    expect(migrated.items.every((item) => assistantSessionExperience(item) === "classic")).toBe(true);
    expect(activeAssistantSession(migrated)).toMatchObject({ id: legacy.activeId, pageId: "page_two", draft: "保留旧草稿" });
    const selected = selectAssistantPage(migrated, "page_two", "dsh-conversation");
    expect(selected.items.slice(0, migrated.items.length)).toEqual(migrated.items);
    expect(activeAssistantSession(selected).turns).toEqual([]);
    expect(selected.items.flatMap((item) => item.turns).map((item) => item.id).sort()).toEqual(["old_one", "old_two"]);
    expect(restoreAssistantSessions(selected, [], "page_one")).toBe(selected);
  });

  it("preserves experience when splitting an unscoped DSH session across pages", () => {
    const sessions = createAssistantSessions([turn("dsh_one"), turn("dsh_two", "page_two")], undefined, "dsh-conversation");
    const restored = restoreAssistantSessions(sessions, [], "page_one");
    expect(restored.items).toHaveLength(2);
    expect(restored.items.every((item) => assistantSessionExperience(item) === "dsh-conversation")).toBe(true);
    expect(assistantSessionsForPage(restored, "page_one")).toEqual([]);
    expect(assistantSessionsForPage(restored, "page_one", "dsh-conversation")[0].turns).toEqual([turn("dsh_one")]);
    expect(activeAssistantSession(restored).id).toBe(sessions.activeId);
    expect(assistantSessionsSchema.safeParse(restored).success).toBe(true);
  });

  it.each(experiences)("clears only the selected %s history and rotates a context in the same experience", (experience) => {
    const classic = newAssistantSession([turn("classic")], "page_one");
    const dsh = newAssistantSession([turn("dsh")], "page_one", "dsh-conversation");
    const sessions = selectAssistantPage({ activeId: classic.id, items: [classic, dsh] }, "page_one", experience);
    const selected = activeAssistantSession(sessions);
    const newContextId = newAssistantContextId(assistantSessionExperience(selected));
    const cleared = updateActiveAssistantSession(sessions, { turns: [], draft: "", title: "新会话", contextId: newContextId });
    const current = activeAssistantSession(cleared);
    expect(current.id).toBe(selected.id);
    expect(current.turns).toEqual([]);
    expect(current.contextId).not.toBe(selected.contextId);
    expect(assistantSessionExperience({ id: current.contextId })).toBe(experience);
    expect(cleared.items.find((item) => item.id !== selected.id)).toEqual(sessions.items.find((item) => item.id !== selected.id));
  });

  it("counts the 50-thread limit separately for each page and experience", () => {
    const classic = Array.from({ length: MAX_ASSISTANT_SESSIONS }, () => newAssistantSession([], "page_one"));
    const sessions = selectAssistantPage({ activeId: classic[0].id, items: classic }, "page_one", "dsh-conversation");
    expect(assistantSessionsForPage(sessions, "page_one")).toHaveLength(MAX_ASSISTANT_SESSIONS);
    expect(assistantSessionsForPage(sessions, "page_one", "dsh-conversation")).toHaveLength(1);
    expect(sessions.items.slice(0, MAX_ASSISTANT_SESSIONS)).toEqual(classic);
    const otherDsh = Array.from({ length: MAX_ASSISTANT_SESSIONS - 1 }, () => newAssistantSession([], "page_one", "dsh-conversation"));
    const full = { ...sessions, items: [...sessions.items, ...otherDsh] };
    expect(assistantSessionsForPage(full, "page_one", "dsh-conversation")).toHaveLength(MAX_ASSISTANT_SESSIONS);
    expect(full.items).toHaveLength(MAX_ASSISTANT_SESSIONS * 2);
    expect(assistantSessionsSchema.safeParse(full).success).toBe(true);
  });

  it("keeps the global 1050-session limit without evicting another experience", () => {
    const items = Array.from({ length: MAX_PROJECT_ASSISTANT_SESSIONS }, (_, index) => newAssistantSession([], `page_${index}`));
    const sessions = { activeId: items[0].id, items };
    const before = structuredClone(sessions);
    expect(selectAssistantPage(sessions, "page_0")).toBe(sessions);
    expect(() => selectAssistantPage(sessions, "page_0", "dsh-conversation")).toThrow("项目会话容量已满");
    expect(sessions).toEqual(before);
    expect(assistantSessionsSchema.safeParse(sessions).success).toBe(true);
  });

  it("round-trips both experiences in the unchanged snapshot schema and rotates contexts on backup restore", () => {
    const classic = updateActiveAssistantSession(createAssistantSessions([turn("classic")], "page_one"), { draft: "原入口草稿" });
    const sessions = updateActiveAssistantSession(selectAssistantPage(classic, "page_one", "dsh-conversation"), { turns: [turn("dsh")], draft: "DSH 草稿" });
    const state = { ...projectState(), assistantSessions: sessions, assistantConversation: activeAssistantSession(sessions).turns };
    const backup = exportStudioBackup(state);
    const imported = importStudioBackup(backup);
    expect(imported.version).toBe(7);
    expect(imported.assistantSessions).toEqual(sessions);
    expect(parseStudioPersistedState(JSON.parse(JSON.stringify(state))).assistantSessions).toEqual(sessions);
    expect(Object.keys(JSON.parse(JSON.stringify(sessions.items[1]))).sort()).toEqual(Object.keys(classic.items[0]).sort());
    const restored = restoreStudioBackup({ load: () => null, save() {}, clear() {} }, backup);
    expect(restored.assistantSessions?.activeId).toBe(sessions.activeId);
    expect(restored.assistantSessions?.activeByPage).toEqual(sessions.activeByPage);
    for (const [index, item] of restored.assistantSessions!.items.entries()) {
      expect(item).toEqual({ ...sessions.items[index], contextId: item.contextId });
      expect(item.contextId).not.toBe(sessions.items[index].contextId);
      expect(assistantSessionExperience({ id: item.contextId })).toBe(assistantSessionExperience(item));
    }
    expect(rotateAssistantSessionContexts(null)).toBeNull();
  });
});
