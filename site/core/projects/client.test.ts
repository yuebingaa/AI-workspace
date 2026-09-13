import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FORMAT, PROJECT_HEADER, type ProjectSession } from "./contracts";
import { ProjectStudioRepository, projectHeaders, setActiveProjectHandle } from "./client";
import { projectState } from "./test-fixture";

function session(): ProjectSession {
  return { handle: randomUUID(), path: "C:\\synthetic-project", manifest: { format: PROJECT_FORMAT, id: randomUUID(), name: "测试", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z", stateRevision: 0, state: projectState(), tables: [], files: [] } };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setActiveProjectHandle(null); });
describe("project save queue", () => {
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
