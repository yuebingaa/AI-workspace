import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { clearHarnessConversations, harnessConversationId } from "./conversation-client";
import { setActiveProjectHandle } from "@/core/projects/client";
import { PROJECT_HEADER } from "@/core/projects/contracts";

afterEach(() => { setActiveProjectHandle(null); vi.unstubAllGlobals(); });
it("isolates in-tab conversation IDs even when browser storage is disabled", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); } });
  const a = randomUUID(), b = randomUUID();
  setActiveProjectHandle(a); const first = harnessConversationId("same_page");
  setActiveProjectHandle(b); expect(harnessConversationId("same_page")).not.toBe(first);
  setActiveProjectHandle(a); expect(harnessConversationId("same_page")).toBe(first);
});
it("clears only the captured project when selection changes during a request", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const a = randomUUID(), b = randomUUID(); setActiveProjectHandle(a);
  harnessConversationId("page_one"); harnessConversationId("page_two");
  let release!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; })).mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetch);
  const clearing = clearHarnessConversations(); setActiveProjectHandle(b); const second = harnessConversationId("page_one");
  release(new Response(null, { status: 204 })); await clearing;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every((call) => call[1].headers[PROJECT_HEADER] === a)).toBe(true);
  expect(harnessConversationId("page_one")).toBe(second);
  expect([...storage.keys()].every((key) => !key.endsWith(a))).toBe(true);
});

it("uses the selected thread identity and clears only its pages", async () => {
  const project = randomUUID(); setActiveProjectHandle(project);
  const first = `conversation_${randomUUID().replaceAll("-", "")}`, second = `conversation_${randomUUID().replaceAll("-", "")}`;
  expect(harnessConversationId("same_page", first)).toBe(first);
  expect(harnessConversationId("same_page", second)).toBe(second);
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetch);
  await clearHarnessConversations({ contextId: first, pageIds: ["page_one", "page_two", "page_one"] });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
    { conversation_id: first, pageId: "page_one" }, { conversation_id: first, pageId: "page_two" },
  ]);
  expect(fetch.mock.calls.every((call) => call[1].headers[PROJECT_HEADER] === project)).toBe(true);
  expect(harnessConversationId("same_page", second)).toBe(second);
});
