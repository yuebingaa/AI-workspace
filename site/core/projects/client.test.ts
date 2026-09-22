import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FORMAT, PROJECT_HEADER, type ProjectSession } from "./contracts";
import { downloadProjectFile, ProjectStudioRepository, projectHeaders, setActiveProjectHandle, setProjectFileArchived } from "./client";
import { projectState } from "./test-fixture";

function session(): ProjectSession {
  return { handle: randomUUID(), path: "C:\\synthetic-project", manifest: { format: PROJECT_FORMAT, id: randomUUID(), name: "测试", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", stateRevision: 0, state: projectState(), tables: [], files: [] } };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setActiveProjectHandle(null); });
describe("project save queue", () => {
  it("pins recovery reads and writes to the repository project after the active selection changes", async () => {
    const selected = session();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "短暂不可用" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(selected))
      .mockResolvedValueOnce(Response.json({ stateRevision: 1 }));
    vi.stubGlobal("fetch", fetch);
    const repo = new ProjectStudioRepository(selected, vi.fn());
    const state = repo.load()!; state.dataProduct.name = "可恢复的编辑"; repo.save(state);
    await expect(repo.flush()).rejects.toThrow("短暂不可用");
    setActiveProjectHandle(randomUUID());
    await repo.retry();
    expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET", "POST"]);
    expect(fetch.mock.calls.every(([, init]) => init.headers[PROJECT_HEADER] === selected.handle)).toBe(true);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ action: "save", stateRevision: 0, state: { dataProduct: { name: "可恢复的编辑" } } });
    expect(repo.dirty).toBe(false);
  });

  it("pins file mutations to their project and reports failures without a success receipt", async () => {
    const selected = session(), fileId = randomUUID();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(selected))
      .mockResolvedValueOnce(Response.json({ error: { message: "项目写入被占用" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch); setActiveProjectHandle(randomUUID());
    expect(await setProjectFileArchived(selected.handle, fileId, true)).toEqual(selected);
    expect(fetch.mock.calls[0][1].headers[PROJECT_HEADER]).toBe(selected.handle);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "archiveFile", fileId });
    await expect(setProjectFileArchived(selected.handle, fileId, false)).rejects.toThrow(/写入被占用/);
  });
  it("does not rewrite an unchanged opened project", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const repo = new ProjectStudioRepository(session(), vi.fn());
    const state = repo.load()!; state.savedAt = new Date().toISOString(); repo.save(state); await repo.flush();
    expect(fetch).not.toHaveBeenCalled(); expect(repo.dirty).toBe(false);
  });
  it("coalesces edits and saves to its own handle, not a later tab selection", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ stateRevision: 1 })); vi.stubGlobal("fetch", fetch);
    const selected = session(); const repo = new ProjectStudioRepository(selected, vi.fn());
    const state = repo.load()!; state.dataProduct.name = "第一版"; repo.save(state); state.dataProduct.name = "最终版"; repo.save(state);
    setActiveProjectHandle(randomUUID()); await repo.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0][1];
    expect(init.headers[PROJECT_HEADER]).toBe(selected.handle);
    expect(JSON.parse(init.body).state.dataProduct.name).toBe("最终版"); expect(repo.dirty).toBe(false);
  });
  it("retains unsaved changes and freezes on conflict, until explicit discard", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: "项目版本冲突" } }, { status: 409 })); vi.stubGlobal("fetch", fetch);
    const report = vi.fn(), repo = new ProjectStudioRepository(session(), report);
    const state = repo.load()!; state.dataProduct.name = "需要备份的修改"; repo.save(state);
    await expect(repo.flush()).rejects.toThrow(/冲突/); expect(repo.load()?.dataProduct.name).toBe("需要备份的修改");
    expect(repo.dirty).toBe(true); await expect(repo.flush()).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({ state: "error", message: "项目版本冲突" });
    await repo.discardPending(); expect(repo.dirty).toBe(false);
  });
  it("attaches the header only in project mode", () => {
    expect(projectHeaders({ accept: "test" })).toEqual({ accept: "test" });
    const handle = randomUUID(); setActiveProjectHandle(handle); expect(projectHeaders()[PROJECT_HEADER]).toBe(handle);
  });
});

describe("project original-file downloads", () => {
  const fallback = "原始文件读取失败，请检查项目文件夹";
  function downloadEffects() {
    const anchor = { href: "", download: "", click: vi.fn() };
    const createElement = vi.fn().mockReturnValue(anchor);
    vi.stubGlobal("document", { createElement });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-original");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    return { anchor, createElement, createUrl, revokeUrl };
  }
  async function expectFailedDownload(response: Response, message = fallback) {
    const effects = downloadEffects(), blob = vi.spyOn(response, "blob");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(downloadProjectFile("synthetic-id", "synthetic.csv")).rejects.toThrow(message);
    expect(blob).not.toHaveBeenCalled();
    expect(effects.createUrl).not.toHaveBeenCalled();
    expect(effects.createElement).not.toHaveBeenCalled();
    expect(effects.anchor.click).not.toHaveBeenCalled();
  }

  it.each([
    { status: 409, message: "原始文件内容校验失败，请从完整项目备份恢复。" },
    { status: 404, message: "原始文件不存在，请检查文件是否被移走。" },
  ])("retains the scoped request and readable server error for HTTP $status", async ({ status, message }) => {
    const selected = randomUUID(), fileId = "file/name?other=synthetic&value=1";
    setActiveProjectHandle(selected);
    const effects = downloadEffects();
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const downloading = downloadProjectFile(fileId, "synthetic.csv");
    const assertion = expect(downloading).rejects.toThrow(message);
    setActiveProjectHandle(randomUUID());
    resolveResponse(Response.json({ error: { message }, debug: "must not be shown" }, { status }));
    await assertion;
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/projects/files?id=${encodeURIComponent(fileId)}`, {
      headers: { [PROJECT_HEADER]: selected }, cache: "no-store",
    });
    expect(effects.createUrl).not.toHaveBeenCalled();
    expect(effects.createElement).not.toHaveBeenCalled();
  });

  it.each([
    "<html>synthetic proxy error</html>", "null", '{"message":"not the error envelope"}',
    '{"error":{"message":123}}', '{"error":{"message":"   "}}',
  ])("uses the generic message for an invalid error response: %s", async (body) => {
    await expectFailedDownload(new Response(body, { status: 500 }));
  });

  it("rejects an oversized declared error body without using its message or downloading it", async () => {
    await expectFailedDownload(Response.json({ error: { message: "Do not use the oversized response" } }, {
      status: 409, headers: { "content-length": String(16 * 1024 + 1) },
    }));
  });

  it("bounds streamed error bytes even without a content-length header and cancels the reader", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify({ error: { message: "Do not use the oversized response" }, detail: "x".repeat(16 * 1024) }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, 100)); controller.enqueue(bytes.slice(100)); }, cancel,
    });
    await expectFailedDownload(new Response(body, { status: 409 }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses the generic message when the error body stream fails", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic stream failure")); } });
    await expectFailedDownload(new Response(body, { status: 500 }));
  });

  it("stops waiting for a stalled error body after 30 seconds without creating a download", async () => {
    const cancel = vi.fn();
    const checking = expectFailedDownload(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 }));
    await vi.advanceTimersByTimeAsync(30_000);
    await checking;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves a successful original download, its filename, bytes and delayed URL cleanup", async () => {
    const effects = downloadEffects(), bytes = "category,amount\nAlpha,10";
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    await downloadProjectFile("synthetic-id", "合成原件.csv");
    expect(effects.createUrl).toHaveBeenCalledOnce();
    const downloaded = effects.createUrl.mock.calls[0][0];
    expect(downloaded).toBeInstanceOf(Blob);
    if (!(downloaded instanceof Blob)) throw new Error("Expected original-file bytes as a Blob");
    expect(await downloaded.text()).toBe(bytes);
    expect(effects.createElement).toHaveBeenCalledExactlyOnceWith("a");
    expect(effects.anchor).toMatchObject({ href: "blob:synthetic-original", download: "合成原件.csv" });
    expect(effects.anchor.click).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(effects.revokeUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(effects.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:synthetic-original");
  });
});
