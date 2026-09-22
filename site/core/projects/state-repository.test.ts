import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FORMAT, type ProjectSession } from "./contracts";
import { ProjectStateRepository, type ProjectStateReader, type ProjectStateWriter } from "./state-repository";
import { projectState } from "./test-fixture";

function session(): ProjectSession {
  return { handle: randomUUID(), path: "C:\\synthetic-project", manifest: {
    format: PROJECT_FORMAT, id: randomUUID(), name: "测试", createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z", stateRevision: 0, state: projectState(), tables: [], files: [],
  } };
}
function edit(repository: ProjectStateRepository, name: string) {
  const state = repository.load()!;
  state.dataProduct.name = name;
  repository.save(state);
}
function deferred() {
  let resolve!: (value: { stateRevision: number }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ stateRevision: number }>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("transport-independent project state repository", () => {
  it("rechecks the pinned project and saves the latest local edit after a transient failure", async () => {
    const selected = session(), report = vi.fn();
    const read = vi.fn<ProjectStateReader>().mockResolvedValue(selected);
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ stateRevision: 1 });
    const repo = new ProjectStateRepository(selected, report, write, read);
    edit(repo, "失败的请求"); await expect(repo.flush()).rejects.toThrow("network unavailable");
    edit(repo, "恢复前继续编辑"); await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);
    await repo.retry();
    expect(read).toHaveBeenCalledExactlyOnceWith(selected.handle);
    expect(write.mock.calls[1][0]).toMatchObject({ handle: selected.handle, stateRevision: 0, state: { dataProduct: { name: "恢复前继续编辑" } } });
    expect(repo.dirty).toBe(false); expect(repo.revision).toBe(1);
    expect(report).toHaveBeenLastCalledWith({ state: "saved", message: "已保存到本地项目" });
  });

  it("recognizes a persisted write with a lost acknowledgement without repeating it", async () => {
    const selected = session();
    const write = vi.fn<ProjectStateWriter>().mockRejectedValue(new Error("response lost"));
    const read = vi.fn<ProjectStateReader>();
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "已在磁盘"); await expect(repo.flush()).rejects.toThrow("response lost");
    const disk = structuredClone(selected);
    disk.manifest.state = repo.load(); disk.manifest.stateRevision = 1;
    disk.manifest.state!.savedAt = "2026-09-21T00:00:00.000Z";
    read.mockResolvedValue(disk);
    await repo.retry();
    expect(write).toHaveBeenCalledTimes(1); expect(repo.revision).toBe(1); expect(repo.dirty).toBe(false);
    expect(repo.load()?.dataProduct.name).toBe("已在磁盘");
  });

  it("compares the failed request rather than newer pending edits when acknowledging a lost response", async () => {
    const selected = session();
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ stateRevision: 2 });
    const read = vi.fn<ProjectStateReader>();
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "已提交但未确认"); await expect(repo.flush()).rejects.toThrow("response lost");
    const disk = structuredClone(selected); disk.manifest.state = repo.load(); disk.manifest.stateRevision = 1;
    read.mockResolvedValue(disk);
    edit(repo, "后续编辑"); await repo.retry();
    expect(write.mock.calls[1][0]).toMatchObject({ stateRevision: 1, state: { dataProduct: { name: "后续编辑" } } });
    expect(repo.revision).toBe(2); expect(repo.dirty).toBe(false);
  });

  it("coalesces concurrent retries and preserves edits made while the disk check is pending", async () => {
    const selected = session();
    let resolveRead!: (value: ProjectSession) => void;
    const read = vi.fn<ProjectStateReader>().mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ stateRevision: 1 });
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "未保存"); await expect(repo.flush()).rejects.toThrow("unavailable");
    const retry = repo.retry(), duplicate = repo.retry();
    edit(repo, "检查期间的更改"); await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(repo.dirty).toBe(true);
    resolveRead(selected); await Promise.all([retry, duplicate]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].state.dataProduct.name).toBe("检查期间的更改");
    expect(repo.dirty).toBe(false);
  });

  it.each(["different-content", "later-revision", "other-handle", "other-project"] as const)("refuses recovery for %s and retains the editable local snapshot", async (scenario) => {
    const selected = session();
    const write = vi.fn<ProjectStateWriter>().mockRejectedValue(new Error("save failed"));
    const read = vi.fn<ProjectStateReader>();
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "需要保留"); await expect(repo.flush()).rejects.toThrow("save failed");
    const disk = structuredClone(selected); disk.manifest.stateRevision = 1;
    if (scenario === "later-revision") { disk.manifest.stateRevision = 2; disk.manifest.state = repo.load(); }
    if (scenario === "other-handle") disk.handle = randomUUID();
    if (scenario === "other-project") disk.manifest.id = randomUUID();
    read.mockResolvedValue(disk);
    await expect(repo.retry()).rejects.toThrow(/未覆盖/);
    edit(repo, "仍然可以本地编辑"); await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1); expect(repo.revision).toBe(0); expect(repo.dirty).toBe(true);
    expect(repo.load()?.dataProduct.name).toBe("仍然可以本地编辑");
  });

  it("retains recovery evidence when the disk check fails, then allows another explicit retry", async () => {
    const selected = session();
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(new Error("write offline")).mockResolvedValueOnce({ stateRevision: 1 });
    const read = vi.fn<ProjectStateReader>().mockRejectedValueOnce(new Error("read offline")).mockResolvedValueOnce(selected);
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "待恢复"); await expect(repo.flush()).rejects.toThrow("write offline");
    await expect(repo.retry()).rejects.toThrow("read offline");
    expect(repo.load()?.dataProduct.name).toBe("待恢复"); expect(repo.dirty).toBe(true); expect(write).toHaveBeenCalledTimes(1);
    await repo.retry(); expect(repo.dirty).toBe(false); expect(repo.revision).toBe(1);
  });

  it("keeps writes frozen if another writer changes the revision after the recovery read", async () => {
    const selected = session();
    const write = vi.fn<ProjectStateWriter>().mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("项目版本冲突"));
    const read = vi.fn<ProjectStateReader>().mockResolvedValue(selected);
    const repo = new ProjectStateRepository(selected, vi.fn(), write, read);
    edit(repo, "最新编辑"); await expect(repo.flush()).rejects.toThrow("offline");
    await expect(repo.retry()).rejects.toThrow("项目版本冲突");
    expect(repo.dirty).toBe(true); expect(repo.revision).toBe(0);
    await expect(repo.flush()).rejects.toThrow("项目版本冲突"); expect(write).toHaveBeenCalledTimes(2);
    expect(repo.load()?.dataProduct.name).toBe("最新编辑");
  });

  it("coalesces the latest edit after 400 ms, ignoring savedAt-only changes", async () => {
    const write = vi.fn<ProjectStateWriter>().mockResolvedValue({ stateRevision: 1 });
    const report = vi.fn(), selected = session(), repo = new ProjectStateRepository(selected, report, write);
    const unchanged = repo.load()!; unchanged.savedAt = "2026-09-14T01:00:00.000Z";
    repo.save(unchanged);
    await vi.advanceTimersByTimeAsync(400);
    expect(write).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
    edit(repo, "第一版"); await vi.advanceTimersByTimeAsync(399);
    edit(repo, "第二版"); await vi.advanceTimersByTimeAsync(399);
    expect(write).not.toHaveBeenCalled(); expect(repo.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledExactlyOnceWith({ handle: selected.handle, state: repo.load(), stateRevision: 0 });
    expect(repo.revision).toBe(1); expect(repo.dirty).toBe(false);
    expect(report.mock.calls.map(([value]) => value.state)).toEqual(["pending", "pending", "saving", "saved"]);
  });

  it("serializes in-flight edits and concurrent flush calls with increasing revisions", async () => {
    const first = deferred(), second = deferred();
    const write = vi.fn<ProjectStateWriter>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const repo = new ProjectStateRepository(session(), vi.fn(), write);
    edit(repo, "已发送"); const flush = repo.flush();
    edit(repo, "被合并"); edit(repo, "后续最终版"); const anotherFlush = repo.flush();
    expect(write).toHaveBeenCalledTimes(1); expect(repo.revision).toBe(0);
    first.resolve({ stateRevision: 1 }); await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([input]) => [input.stateRevision, input.state.dataProduct.name]))
      .toEqual([[0, "已发送"], [1, "后续最终版"]]);
    expect(repo.dirty).toBe(true);
    second.resolve({ stateRevision: 2 }); await Promise.all([flush, anotherFlush]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(2); expect(repo.revision).toBe(2); expect(repo.dirty).toBe(false);
  });

  it("retains edits made during a failed write and freezes further writes until explicit discard", async () => {
    const first = deferred();
    const write = vi.fn<ProjectStateWriter>().mockReturnValue(first.promise);
    const report = vi.fn(), repo = new ProjectStateRepository(session(), report, write);
    edit(repo, "发送中"); const flush = repo.flush();
    edit(repo, "发送后编辑"); const rejection = expect(flush).rejects.toThrow("项目版本冲突");
    first.reject(new Error("项目版本冲突")); await rejection;
    expect(repo.load()?.dataProduct.name).toBe("发送后编辑");
    edit(repo, "冲突后仍可编辑"); await vi.advanceTimersByTimeAsync(1_000);
    await expect(repo.flush()).rejects.toThrow("项目版本冲突");
    expect(repo.load()?.dataProduct.name).toBe("冲突后仍可编辑");
    expect(repo.dirty).toBe(true); expect(repo.revision).toBe(0); expect(write).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({ state: "error", message: "项目版本冲突" });
    await repo.discardPending(); expect(repo.dirty).toBe(false);
    await repo.flush(); expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not treat invalid revision acknowledgements as a saved project", async () => {
    const write = vi.fn<ProjectStateWriter>().mockResolvedValue({ stateRevision: 3 });
    const report = vi.fn(), repo = new ProjectStateRepository(session(), report, write);
    edit(repo, "保留本地副本");
    await expect(repo.flush()).rejects.toThrow("项目保存响应无效");
    expect(repo.revision).toBe(0); expect(repo.dirty).toBe(true);
    expect(repo.load()?.dataProduct.name).toBe("保留本地副本");
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "saved" }));
    await repo.discardPending();
  });

  it("waits for an existing write before completing explicit discard", async () => {
    const pending = deferred(), write = vi.fn<ProjectStateWriter>().mockReturnValue(pending.promise);
    const repo = new ProjectStateRepository(session(), vi.fn(), write);
    edit(repo, "写入中的快照"); const flush = repo.flush();
    let discarded = false;
    const discard = repo.discardPending().then(() => { discarded = true; });
    await Promise.resolve(); expect(discarded).toBe(false); expect(repo.dirty).toBe(true);
    pending.resolve({ stateRevision: 1 }); await Promise.all([flush, discard]);
    expect(discarded).toBe(true); expect(repo.dirty).toBe(false); expect(repo.revision).toBe(1);
  });

  it("isolates the accepted snapshot from later caller and load-result mutations", async () => {
    const write = vi.fn<ProjectStateWriter>().mockResolvedValue({ stateRevision: 1 });
    const repo = new ProjectStateRepository(session(), vi.fn(), write);
    const next = repo.load()!; next.dataProduct.name = "接受的更改"; repo.save(next);
    next.dataProduct.name = "调用者后续修改";
    const copy = repo.load()!; copy.dataProduct.name = "读取副本后续修改";
    await repo.flush();
    expect(write.mock.calls[0][0].state.dataProduct.name).toBe("接受的更改");
    expect(repo.load()?.dataProduct.name).toBe("接受的更改");
  });

  it("only cancels queued work on explicit discard and does not delete project files", async () => {
    const write = vi.fn<ProjectStateWriter>();
    const repo = new ProjectStateRepository(session(), vi.fn(), write);
    edit(repo, "排队中的更改");
    expect(() => repo.clear()).toThrow("项目文件不能通过清空浏览器存储删除");
    expect(repo.dirty).toBe(true);
    await repo.discardPending(); await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled(); expect(repo.dirty).toBe(false);
  });
});
