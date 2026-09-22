import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSession } from "../contracts";
import { ProjectStateRepository, type ProjectStateReader, type ProjectStateWriter } from "../state-repository";
import { projectState, projectUpload } from "../test-fixture";
import { LocalProjectStore } from "./store";

const fixturePrefix = "agentcanvas-project-recovery-test-";
let testRoot: string;
let store: LocalProjectStore;

beforeEach(() => {
  vi.useFakeTimers();
  testRoot = mkdtempSync(join(tmpdir(), fixturePrefix));
  store = LocalProjectStore.create(join(testRoot, "project"), "保存恢复合成项目");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (dirname(resolve(testRoot)) !== resolve(tmpdir()) || !testRoot.startsWith(join(tmpdir(), fixturePrefix))) {
    throw new Error("Unsafe fixture cleanup");
  }
  rmSync(testRoot, { recursive: true, force: true });
});

function openSession(): ProjectSession {
  return { handle: randomUUID(), path: store.root, manifest: store.read() };
}

function diskReader(session: ProjectSession) {
  return vi.fn<ProjectStateReader>(async (handle) => {
    expect(handle).toBe(session.handle);
    return { ...session, manifest: new LocalProjectStore(session.path).read() };
  });
}

function diskWriter(session: ProjectSession) {
  return vi.fn<ProjectStateWriter>(async ({ handle, state, stateRevision }) => {
    expect(handle).toBe(session.handle);
    return { stateRevision: store.saveState(state, stateRevision) };
  });
}

function edit(repository: ProjectStateRepository, name: string) {
  const state = repository.load()!;
  state.dataProduct.name = name;
  repository.save(state);
}

function manifestBytes() {
  return readFileSync(join(store.root, "agentcanvas.project.json"));
}

describe("project save recovery against real local storage", () => {
  it("retries an unwritten failure explicitly and reopens the saved definitions from disk", async () => {
    store.saveState(projectState(), 0);
    const session = openSession(), before = manifestBytes(), report = vi.fn();
    const read = diskReader(session), write = diskWriter(session).mockRejectedValueOnce(new Error("合成传输故障，尚未写入"));
    const repository = new ProjectStateRepository(session, report, write, read);

    edit(repository, "重试后保存的修改");
    await expect(repository.flush()).rejects.toThrow("尚未写入");
    expect(manifestBytes()).toEqual(before);
    expect(repository.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);

    await repository.retry();
    expect(read).toHaveBeenCalledExactlyOnceWith(session.handle);
    expect(write.mock.calls.map(([input]) => input.stateRevision)).toEqual([1, 1]);
    expect(repository.revision).toBe(2);
    expect(repository.dirty).toBe(false);
    const reopened = new LocalProjectStore(session.path).read();
    expect(reopened.stateRevision).toBe(2);
    expect(reopened.state?.dataProduct.name).toBe("重试后保存的修改");
    expect(report).toHaveBeenLastCalledWith({ state: "saved", message: "已保存到本地项目" });
  });

  it("recognizes a committed save with a lost acknowledgement without writing or advancing its revision twice", async () => {
    store.saveState(projectState(), 0);
    const session = openSession(), report = vi.fn(), read = diskReader(session);
    const write = vi.fn<ProjectStateWriter>(async ({ handle, state, stateRevision }) => {
      expect(handle).toBe(session.handle);
      store.saveState(state, stateRevision);
      throw new Error("合成保存响应丢失");
    });
    const repository = new ProjectStateRepository(session, report, write, read);

    edit(repository, "实际已写入磁盘");
    await expect(repository.flush()).rejects.toThrow("保存响应丢失");
    const committed = manifestBytes();
    expect(new LocalProjectStore(session.path).read().stateRevision).toBe(2);
    expect(repository.revision).toBe(1);
    expect(repository.dirty).toBe(true);

    await repository.retry();
    expect(read).toHaveBeenCalledExactlyOnceWith(session.handle);
    expect(write).toHaveBeenCalledTimes(1);
    expect(manifestBytes()).toEqual(committed);
    expect(repository.revision).toBe(2);
    expect(repository.dirty).toBe(false);
    expect(new LocalProjectStore(session.path).read().state?.dataProduct.name).toBe("实际已写入磁盘");
    expect(report).toHaveBeenLastCalledWith({ state: "saved", message: "已确认上次修改保存到本地项目" });
  });

  it.each([false, true])("recognizes canonical table metadata after a lost acknowledgement and preserves later edits: %s", async (hasLaterEdit) => {
    const upload = store.putTable(await projectUpload("email,amount\nsynthetic@example.invalid,10"));
    const datasetId = upload.dataset.datasetId;
    store.saveState(projectState(upload), 0);
    const session = openSession(), read = diskReader(session), report = vi.fn();
    const tableBefore = readFileSync(join(store.root, "tables", session.manifest.tables[0].file));
    let rejectAcknowledgement!: (reason: Error) => void;
    const acknowledgement = new Promise<void>((_resolve, reject) => { rejectAcknowledgement = reject; });
    let firstWrite = true;
    const write = vi.fn<ProjectStateWriter>(async ({ handle, state, stateRevision }) => {
      expect(handle).toBe(session.handle);
      const savedRevision = store.saveState(state, stateRevision);
      if (firstWrite) { firstWrite = false; await acknowledgement; }
      return { stateRevision: savedRevision };
    });
    const repository = new ProjectStateRepository(session, report, write, read);

    store.renameTable(datasetId, "磁盘上的最新表名");
    store.consent(datasetId, "masked");
    expect(repository.load()?.appSpec.dataSources[0]).toMatchObject({ name: upload.dataset.source.name, aiAccessPolicy: "pending" });
    edit(repository, "首次发送的定义");
    const saving = repository.flush();
    const rejected = expect(saving).rejects.toThrow("保存响应丢失");
    const committed = new LocalProjectStore(session.path).read();
    expect(committed.state?.appSpec.dataSources[0]).toMatchObject({ name: "磁盘上的最新表名", aiAccessPolicy: "masked" });
    expect(committed.state?.dataProduct.datasets[0]).toMatchObject({ name: "磁盘上的最新表名", ephemeral: false, shared: true });
    expect(committed.stateRevision).toBe(2);
    if (hasLaterEdit) edit(repository, "响应未返回时继续编辑的定义");
    rejectAcknowledgement(new Error("合成保存响应丢失"));
    await rejected;
    expect(repository.dirty).toBe(true);

    await repository.retry();
    const expectedName = hasLaterEdit ? "响应未返回时继续编辑的定义" : "首次发送的定义";
    const reopenedStore = new LocalProjectStore(session.path), reopened = reopenedStore.read();
    expect(write.mock.calls.map(([input]) => input.stateRevision)).toEqual(hasLaterEdit ? [1, 2] : [1]);
    expect(repository.revision).toBe(hasLaterEdit ? 3 : 2);
    expect(repository.dirty).toBe(false);
    expect(repository.load()?.dataProduct.name).toBe(expectedName);
    expect(reopened.stateRevision).toBe(repository.revision);
    expect(reopened.state?.dataProduct.name).toBe(expectedName);
    expect(reopened.state?.appSpec.dataSources[0]).toMatchObject({ name: "磁盘上的最新表名", aiAccessPolicy: "masked" });
    expect(reopened.state?.dataProduct.datasets[0]).toMatchObject({ name: "磁盘上的最新表名", ephemeral: false, shared: true });
    expect(reopenedStore.getTable(datasetId)?.rows).toEqual(upload.rows);
    expect(readFileSync(join(store.root, "tables", reopened.tables[0].file))).toEqual(tableBefore);
    expect(read).toHaveBeenCalledExactlyOnceWith(session.handle);
  });

  it("keeps another window's real save intact when the stale repository retries a revision conflict", async () => {
    store.saveState(projectState(), 0);
    const session = openSession(), read = diskReader(session), write = diskWriter(session), report = vi.fn();
    const repository = new ProjectStateRepository(session, report, write, read);
    const otherWindow = new LocalProjectStore(session.path), external = otherWindow.read().state!;
    external.dataProduct.name = "另一窗口已保存的版本";
    expect(otherWindow.saveState(external, session.manifest.stateRevision)).toBe(2);
    const committed = manifestBytes();

    edit(repository, "当前窗口未保存的修改");
    await expect(repository.flush()).rejects.toThrow("另一窗口");
    await expect(repository.retry()).rejects.toThrow("重试未覆盖磁盘内容");
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledExactlyOnceWith(session.handle);
    expect(repository.revision).toBe(1);
    expect(repository.dirty).toBe(true);
    expect(repository.load()?.dataProduct.name).toBe("当前窗口未保存的修改");
    expect(manifestBytes()).toEqual(committed);

    edit(repository, "冲突后继续保留的修改");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(repository.retry()).rejects.toThrow("重试未覆盖磁盘内容");
    expect(write).toHaveBeenCalledTimes(1);
    expect(repository.load()?.dataProduct.name).toBe("冲突后继续保留的修改");
    expect(repository.dirty).toBe(true);
    expect(manifestBytes()).toEqual(committed);
    expect(new LocalProjectStore(session.path).read().state?.dataProduct.name).toBe("另一窗口已保存的版本");
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
  });
});
