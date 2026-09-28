// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEngineSettings as EngineStatus } from "@/core/agent-engines/contracts";
import { defaultDshPluginDocument, type DshPluginSettings } from "@/core/agent-engines/plugin-settings";
import { buildDshPluginCatalog } from "@/core/agent-engines/server/plugin-catalog";
import { DSH_SETTINGS_CHANNEL } from "@/core/dsh-web/settings-projection";
import { AgentEngineSettings, readAgentEngineSettingsResponse, readDshPluginSettingsResponse } from "./AgentEngineSettings";

const engine: EngineStatus = { engine: "harness", revision: 0, activeTasks: 0, persistence: "process-memory",
  dsh: { available: true, version: "0.1.7-rc.2" }, plugins: [] };
const settings: DshPluginSettings = { document: defaultDshPluginDocument(), persistence: "json-file", activeTasks: 0,
  plugins: buildDshPluginCatalog(defaultDshPluginDocument(), { "dsh-skill": { installed: true }, "dsh-tool-skill": { installed: true } }) };
const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers();
  // An isolated iframe peer tests the parent protocol without requesting any
  // running website. Actual same-origin loading is covered in Edge.
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (tag === "iframe") {
      element.setAttribute("srcdoc", "<!doctype html><body></body>");
      Object.defineProperty(element, "contentWindow", { value: { postMessage: vi.fn() } });
    }
    return element;
  });
});
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function network() {
  const mock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
    url.endsWith("/agent-engine") ? engine : init?.method === "PATCH"
      ? { ...settings, document: { schemaVersion: 1, revision: 1, config: { skills: true } } } : settings)));
  vi.stubGlobal("fetch", mock); return mock;
}
function mount(onOpenModels?: () => void) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push(root);
  act(() => root.render(<AgentEngineSettings onOpenModels={onOpenModels} />));
  return { root, container };
}
async function open(container: HTMLElement) {
  act(() => container.querySelector<HTMLButtonElement>("button")!.click()); await settle();
  const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
  expect(frame.title).toBe("官方 DSH 设置");
  const spy = vi.spyOn(frame.contentWindow!, "postMessage");
  const command = (value: object, overrides: MessageEventInit = {}) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: location.origin,
      data: { channel: DSH_SETTINGS_CHANNEL, nonce: frame.getAttribute("src")!.split("#")[1], ...value }, ...overrides }));
  });
  command({ type: "ready" }); command({ type: "mounted" });
  const snapshot = () => {
    const message = spy.mock.calls.map(call => call[0]).filter(message => message.type === "snapshot").at(-1);
    return message.snapshot;
  };
  return { frame, command, snapshot };
}
describe("official settings bridge preserves website configuration lifecycle", () => {
  it("loads only after opening and read refresh preserves an edited draft", async () => {
    const fetcher = network(), { container } = mount(); expect(fetcher).not.toHaveBeenCalled();
    const ui = await open(container); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ui.frame.getAttribute("src")).toContain("?surface=settings#");
    for (const [, init] of fetcher.mock.calls) { expect(init?.body).toBeUndefined(); expect(init?.signal).toBeInstanceOf(AbortSignal); }
    ui.command({ type: "skills", skills: true }); expect(ui.snapshot().skills).toBe(true);
    ui.command({ type: "refresh" }); await settle(); expect(ui.snapshot().skills).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
  });
  it("saves only plugin revision/config, never the engine; suppresses duplicate saves", async () => {
    const fetcher = network(), { container } = mount(), ui = await open(container);
    ui.command({ type: "skills", skills: true }); ui.command({ type: "save" }); ui.command({ type: "save" }); await settle();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1); expect(writes[0][0]).toBe("/api/settings/dsh-plugins");
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ revision: 0, config: { skills: true } });
    expect(ui.snapshot().notice).toContain("下一轮任务生效"); expect(ui.snapshot().dirty).toBe(false);
  });
  it("refresh adopts a newer server configuration only when no unsaved edit exists", async () => {
    const fetcher = network(), { container } = mount(), ui = await open(container);
    fetcher.mockImplementation(async url => Response.json(url.endsWith("/agent-engine") ? engine
      : { ...settings, document: { ...settings.document, revision: 1, config: { skills: true } } }));
    ui.command({ type: "refresh" }); await settle();
    expect(ui.snapshot().skills).toBe(true); expect(ui.snapshot().dirty).toBe(false);
    ui.command({ type: "close" }); expect(container.querySelector("dialog")).toBeNull();
  });
  it("failed save retains the draft, locks until refresh and never auto-retries", async () => {
    const fetcher = network(), { container } = mount(), ui = await open(container);
    fetcher.mockImplementation(async (url, init) => init?.method === "PATCH"
      ? Response.json({ error: { message: "版本冲突" } }, { status: 409 }) : Response.json(url.endsWith("/agent-engine") ? engine : settings));
    ui.command({ type: "skills", skills: true }); ui.command({ type: "save" }); await settle();
    expect(ui.snapshot()).toMatchObject({ skills: true, needsRefresh: true, locked: true });
    expect(ui.snapshot().error).toContain("版本冲突");
    ui.command({ type: "save" }); expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    ui.command({ type: "refresh" }); await settle();
    expect(ui.snapshot()).toMatchObject({ skills: true, needsRefresh: false, locked: false });
  });
  it("requires explicit discard, keeps edits on cancel and reopens from saved server state", async () => {
    network(); const { container } = mount(), ui = await open(container);
    ui.command({ type: "skills", skills: true }); ui.command({ type: "close" }); expect(ui.snapshot().discard).toBe(true);
    ui.command({ type: "keep" }); expect(ui.snapshot()).toMatchObject({ skills: true, discard: false });
    ui.command({ type: "discard" }); expect(container.querySelector("dialog")).not.toBeNull();
    ui.command({ type: "close" }); ui.command({ type: "discard" }); expect(container.querySelector("dialog")).toBeNull();
    const next = await open(container); expect(next.snapshot().skills).toBe(false);
  });
  it("aborts pending reads and ignores late response after reopen", async () => {
    const fetcher = network(); let finish!: (value: Response) => void;
    fetcher.mockImplementation(url => url.endsWith("/agent-engine") ? Promise.resolve(Response.json(engine)) : new Promise(resolve => { finish = resolve; }));
    const { container } = mount(), ui = await open(container), signal = fetcher.mock.calls[1][1]!.signal!;
    ui.command({ type: "close" }); expect(signal.aborted).toBe(true);
    fetcher.mockImplementation(async url => Response.json(url.endsWith("/agent-engine") ? engine : settings));
    const next = await open(container);
    await act(async () => finish(Response.json({ ...settings, document: { ...settings.document, config: { skills: true } } })));
    expect(next.snapshot().skills).toBe(false);
  });
  it("delegates model configuration without allowing dirty navigation or forged frame actions", async () => {
    network(); const onModels = vi.fn(), { container } = mount(onModels), ui = await open(container);
    ui.command({ type: "models" }); expect(onModels).toHaveBeenCalledOnce();
    ui.command({ type: "skills", skills: true }, { source: window }); expect(ui.snapshot().skills).toBe(false);
    ui.command({ type: "skills", skills: true }, { origin: "https://outside.invalid" }); expect(ui.snapshot().skills).toBe(false);
    ui.command({ type: "skills", skills: true, unexpected: true }); expect(ui.snapshot().skills).toBe(false);
    ui.command({ type: "skills", skills: true }); ui.command({ type: "models" }); expect(onModels).toHaveBeenCalledOnce();
  });
  it.each([{ activeTasks: 1 }, { persistence: "unconfigured" }])("enforces mutation locks in parent for %j", async override => {
    const fetcher = network(); fetcher.mockImplementation(async url => Response.json(url.endsWith("/agent-engine") ? engine : { ...settings, ...override }));
    const { container } = mount(), ui = await open(container);
    expect(ui.snapshot()).toMatchObject({ locked: true, canConfigure: false });
    ui.command({ type: "skills", skills: true }); ui.command({ type: "save" }); await settle();
    expect(ui.snapshot().skills).toBe(false); expect(fetcher.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
  });
});
describe("settings response validation", () => {
  it.each([readAgentEngineSettingsResponse, readDshPluginSettingsResponse])("rejects invalid JSON/DTO and bounds errors", async read => {
    await expect(read(new Response("not json"))).rejects.toThrow("格式");
    await expect(read(Response.json({ invalid: true }))).rejects.toThrow("格式");
    await expect(read(Response.json({ error: { message: "x".repeat(800) } }, { status: 503 }))).rejects.toThrow("x".repeat(500));
    await expect(read(Response.json({ error: {} }, { status: 500 }))).rejects.toThrow("无法");
  });
});
