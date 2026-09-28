// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialSettingsFrame } from "./OfficialSettingsFrame";
import type { PluginSettingsContentProps } from "./settings-contract";
import { defaultDshPluginDocument, type DshPluginSettings } from "@/core/agent-engines/plugin-settings";
import { DSH_SETTINGS_CHANNEL } from "@/core/dsh-web/settings-projection";

const plugins: DshPluginSettings = { document: defaultDshPluginDocument(), persistence: "json-file", activeTasks: 0, plugins: [] };
const inventory = { source: "managed-installation", complete: true, issues: [], packages: [
  { id: "@deepseek-ai/dsh-example", version: "0.1.7-rc.2", description: "Example", category: "runtime", dependencies: [] },
] };
const props: PluginSettingsContentProps = { plugins, status: null, skills: false, loading: false, saving: false, needsRefresh: false,
  dirty: false, discard: false, error: "", notice: "", onSkills() {}, onClose() {}, onSave() {}, onRefresh() {}, onDiscard() {}, onKeepEditing() {} };
const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers();
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
afterEach(() => { while (roots.length) act(() => roots.pop()!.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
async function mount(override: Partial<PluginSettingsContentProps> = {}) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push(root);
  const render = (next: Partial<PluginSettingsContentProps>) => act(() => root.render(<OfficialSettingsFrame {...props} {...override} {...next} />));
  render({}); await settle();
  const frame = container.querySelector("iframe")!, messages = vi.spyOn(frame.contentWindow!, "postMessage");
  const request = (requestId = crypto.randomUUID()) => {
    act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: location.origin,
      data: { channel: DSH_SETTINGS_CHANNEL, nonce: frame.getAttribute("src")!.split("#")[1], type: "inventory", requestId } })));
    return requestId;
  };
  const results = () => messages.mock.calls.map(call => call[0]).filter(message => message.type === "result");
  return { container, render, request, results, unmount() { act(() => root.unmount()); roots.splice(roots.indexOf(root), 1); } };
}
describe("official inventory bridge lifecycle", () => {
  it("lazily reads only the bounded endpoint, with install truth and no configuration writes", async () => {
    const fetcher = vi.fn(async () => Response.json(inventory)); vi.stubGlobal("fetch", fetcher);
    const onSkills = vi.fn(), ui = await mount({ dirty: true, skills: true, onSkills });
    expect(fetcher).not.toHaveBeenCalled(); ui.request(); await settle();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/settings/dsh-plugins/inventory", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(ui.results()[0].result.value.entries[0]).toMatchObject({ enabled: false, fiberPhase: null });
    expect(ui.results()[0].result.value.entries[0].meta.description).toContain("仅确认安装");
    expect(onSkills).not.toHaveBeenCalled();
  });
  it.each(["error", "hidden", "duplicate", "inconsistent"])("rejects %s responses without exposing upstream contents, and can retry", async kind => {
    const bad = kind === "error" ? new Response("private-path", { status: 503 }) : Response.json(kind === "hidden"
      ? { ...inventory, privatePath: "secret" } : kind === "duplicate" ? { ...inventory, packages: [...inventory.packages, ...inventory.packages] }
        : { ...inventory, complete: false });
    const fetcher = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(Response.json(inventory)); vi.stubGlobal("fetch", fetcher);
    const ui = await mount(); ui.request(); await settle();
    expect(ui.results()[0].result.ok).toBe(false); expect(JSON.stringify(ui.results())).not.toMatch(/private-path|secret/);
    ui.request(); await settle(); expect(ui.results()[1].result.ok).toBe(true);
  });
  it("rejects stale config and replayed requests without unconfirmed badges", async () => {
    let finish: (response: Response) => void = () => { throw new Error("read not started"); };
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetcher);
    const ui = await mount(), id = ui.request(); ui.request(id); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ui.results()[0].result.ok).toBe(false);
    ui.render({ needsRefresh: true }); await act(async () => finish(Response.json(inventory))); await settle();
    expect(ui.results().every(message => !message.result.ok)).toBe(true);
    ui.request(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("aborts inventory on close and ignores late reads", async () => {
    let finish: (response: Response) => void = () => { throw new Error("read not started"); };
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetcher);
    const ui = await mount(); ui.request(); ui.unmount();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => finish(Response.json(inventory))); await settle(); expect(ui.results()).toHaveLength(0);
  });
  it("preserves partial metadata as a string projection, never inserts HTML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...inventory, complete: false,
      issues: [{ id: "@deepseek-ai/dsh-broken", code: "metadata-unavailable" }],
      packages: [{ ...inventory.packages[0], description: '<img src=x onerror=alert(1)>' }] })));
    const ui = await mount(); ui.request(); await settle();
    expect(ui.results()[0].result.value.agentPresets[0].broken).toContain("1 项");
    expect(ui.results()[0].result.value.entries[0].meta.description).toContain("<img");
    expect(ui.container.querySelector("img")).toBeNull();
  });
});
