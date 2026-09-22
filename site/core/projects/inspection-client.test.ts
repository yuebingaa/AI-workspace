import { afterEach, describe, expect, it, vi } from "vitest";
import { activeProjectHandle, setActiveProjectHandle } from "./client";
import { requestProjectInspection } from "./inspection-client";
import { PROJECT_INSPECTION_LIMITS, type ProjectInspection } from "./inspection";

const fixture: ProjectInspection = { mode: "read-only", project: { name: "合成项目", updatedAt: "2026-09-21T00:00:00.000Z", stateRevision: 1 },
  notebooks: [], unknownCellCount: 0, omittedSourceCount: 0 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setActiveProjectHandle(null); });

describe("independent project inspection transport", () => {
  it("uses only the read-only endpoint without forwarding or replacing the active handle", async () => {
    setActiveProjectHandle("current-project");
    const fetch = vi.fn().mockResolvedValue(Response.json(fixture)); vi.stubGlobal("fetch", fetch);
    expect(await requestProjectInspection("C:\\synthetic\\inspect")).toEqual(fixture);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects/inspect", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "C:\\synthetic\\inspect" }), signal: expect.any(AbortSignal),
    });
    expect(activeProjectHandle()).toBe("current-project");
  });
  it.each([null, { ...fixture, handle: "unexpected-session" }, { ...fixture, notebooks: [{ cells: [] }] },
    { ...fixture, mode: "editable" }])("rejects malformed or session-shaped responses", async (value) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("当前工作区未改变");
  });
  it("rejects malformed JSON without exposing its content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>private upstream content</html>")));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("当前工作区未改变");
  });
  it("does not accept a declared oversized success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(fixture,
      { headers: { "content-length": String(PROJECT_INSPECTION_LIMITS.responseBytes + 1) } })));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("无法读取");
  });
  it("bounds streamed bytes and cancels an oversized body without a declared length", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(PROJECT_INSPECTION_LIMITS.responseBytes + 1)); }, cancel,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("无法读取");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves readable server errors but never accepts a body as a successful preview on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "项目格式无效" } }, { status: 409 })));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("项目格式无效");
  });
  it("bounds error bodies separately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "must not leak" }, raw: "x".repeat(16384) }, { status: 500 })));
    await expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow("当前工作区未改变");
  });
  it("propagates cancellation while reading a pending body", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }))));
    const promise = requestProjectInspection("C:\\synthetic", controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); controller.abort(); await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not return a late response after cancellation", async () => {
    const controller = new AbortController();
    let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; })));
    const promise = requestProjectInspection("C:\\synthetic", controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); resolve(Response.json(fixture)); await assertion;
  });
  it("stops a stalled body after the request deadline", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }))));
    const assertion = expect(requestProjectInspection("C:\\synthetic")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000); await assertion; expect(cancel).toHaveBeenCalledOnce();
  });
});
