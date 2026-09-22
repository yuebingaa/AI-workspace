import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FORMAT, PROJECT_HEADER, type ProjectSession } from "./contracts";
import { ProjectRequestError, activeProjectHandle, projectRequest, setActiveProjectHandle } from "./client";
import { projectCompatibilityFromError, type ProjectCompatibility } from "./compatibility";
import { ProjectStateRepository, type ProjectStateReader, type ProjectStateWriter } from "./state-repository";
import { projectState } from "./test-fixture";

const compatibility: ProjectCompatibility = {
  code: "project_incompatible", reason: "notebook-cells",
  cells: [{ notebookIndex: 1, cellIndex: 2, kind: "futurePlot" }], total: 1, omitted: 0,
};
beforeEach(() => { vi.useFakeTimers(); setActiveProjectHandle(null); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setActiveProjectHandle(null); });

describe("project compatibility transport", () => {
  it("carries only validated 409 diagnostics without changing the selected project", async () => {
    const handle = randomUUID(); setActiveProjectHandle(handle);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: "raw source must not be rendered", compatibility } }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await projectRequest().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectRequestError);
    expect(projectCompatibilityFromError(error)).toEqual(compatibility);
    expect(String(error)).not.toContain("raw source");
    expect(activeProjectHandle()).toBe(handle);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ [PROJECT_HEADER]: handle });
  });

  it.each([
    { ...compatibility, cells: [{ notebookIndex: 1, cellIndex: 2, kind: "<script>bad</script>" }] },
    { ...compatibility, cells: Array.from({ length: 6 }, (_, index) => ({ notebookIndex: 1, cellIndex: index + 1 })) },
    { ...compatibility, secret: "unexpected metadata" },
    { ...compatibility, cells: [{ notebookIndex: 0, cellIndex: 1 }] },
  ])("does not promote malformed metadata to a compatibility issue", async (invalid) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "普通错误", compatibility: invalid } }, { status: 409 })));
    const error = await projectRequest().catch((caught: unknown) => caught);
    expect(projectCompatibilityFromError(error)).toBeNull();
    expect(String(error)).toContain("普通错误");
  });

  it("does not interpret a generic server failure as compatibility", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "普通失败", compatibility } }, { status: 500 })));
    const error = await projectRequest().catch((caught: unknown) => caught);
    expect(projectCompatibilityFromError(error)).toBeNull();
    expect(String(error)).toContain("普通失败");
  });

  it.each(["<html>proxy failure</html>", "null", '{"error":{"message":123}}'])
    ("keeps malformed error responses understandable: %s", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 500 })));
      await expect(projectRequest()).rejects.toThrow(/项目/);
    });

  it("bounds error bodies and does not switch projects on failure", async () => {
    const handle = randomUUID(); setActiveProjectHandle(handle);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(16 * 1024 + 1), { status: 409 })));
    await expect(projectRequest({ action: "open", path: "synthetic" }, null)).rejects.toThrow();
    expect(activeProjectHandle()).toBe(handle);
  });
});

describe("compatibility failures in the transport-independent save queue", () => {
  it("keeps edits and metadata while paused, rechecks on retry, and clears the issue only after success", async () => {
    const session: ProjectSession = { handle: randomUUID(), path: "C:\\synthetic-project", manifest: {
      format: PROJECT_FORMAT, id: randomUUID(), name: "合成测试", createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z", stateRevision: 0, state: projectState(), tables: [], files: [],
    } };
    // A port error, not a client class: the queue must remain transport independent.
    const failure = Object.assign(new Error("项目不兼容"), { compatibility });
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(failure).mockResolvedValue({ stateRevision: 1 });
    const read = vi.fn<ProjectStateReader>().mockRejectedValueOnce(failure).mockResolvedValue(session);
    const report = vi.fn(), repo = new ProjectStateRepository(session, report, write, read);
    const first = repo.load()!; first.dataProduct.name = "未保存编辑";
    repo.save(first); await expect(repo.flush()).rejects.toThrow("项目不兼容");
    expect(report).toHaveBeenLastCalledWith({ state: "error", message: "项目不兼容", compatibility });
    const later = repo.load()!; later.dataProduct.name = "失败后继续编辑"; repo.save(later);
    expect(report).toHaveBeenLastCalledWith({ state: "error", message: "项目不兼容", compatibility });
    await vi.advanceTimersByTimeAsync(1_000); expect(write).toHaveBeenCalledTimes(1);
    await expect(repo.retry()).rejects.toThrow("项目不兼容");
    expect(write).toHaveBeenCalledTimes(1); expect(repo.dirty).toBe(true);
    expect(repo.load()?.dataProduct.name).toBe("失败后继续编辑");
    await repo.retry(); expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toMatchObject({ handle: session.handle, stateRevision: 0, state: { dataProduct: { name: "失败后继续编辑" } } });
    expect(read).toHaveBeenNthCalledWith(1, session.handle);
    expect(read).toHaveBeenNthCalledWith(2, session.handle);
    expect(repo.dirty).toBe(false); expect(repo.revision).toBe(1);
    expect(report).toHaveBeenLastCalledWith({ state: "saved", message: "已保存到本地项目" });
  });
});
