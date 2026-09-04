import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonFileSnapshotAdapter, renameSnapshotWithRetry } from "./json-file-snapshot";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function adapter() {
  const rootDirectory = mkdtempSync(join(tmpdir(), "datacanvas-persistence-"));
  temporaryDirectories.push(rootDirectory);
  return {
    rootDirectory,
    store: new JsonFileSnapshotAdapter({
      rootDirectory,
      fileName: "state.json",
      schema: z.object({ version: z.literal(1), value: z.string() }).strict(),
    }),
  };
}

describe("JsonFileSnapshotAdapter", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("Windows 瞬时 %s 重命名错误按小预算恢复", (code) => {
    const delays: number[] = [];
    let attempts = 0;
    renameSnapshotWithRetry("source.tmp", "state.json", {
      platform: "win32",
      rename() {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("transient"), { code });
      },
      wait(delayMs) {
        delays.push(delayMs);
      },
    });
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 25]);
  });

  it("Windows 瞬时重命名错误耗尽后停止，其他错误立即失败", () => {
    const transientAttempts: number[] = [];
    expect(() => renameSnapshotWithRetry("source.tmp", "state.json", {
      platform: "win32",
      rename() {
        transientAttempts.push(1);
        throw Object.assign(new Error("still busy"), { code: "EPERM" });
      },
      wait() {},
    })).toThrow(/still busy/);
    expect(transientAttempts).toHaveLength(4);

    let permanentAttempts = 0;
    expect(() => renameSnapshotWithRetry("source.tmp", "state.json", {
      platform: "win32",
      rename() {
        permanentAttempts += 1;
        throw Object.assign(new Error("permanent"), { code: "EIO" });
      },
      wait() {
        throw new Error("不应等待");
      },
    })).toThrow(/permanent/);
    expect(permanentAttempts).toBe(1);
  });

  it("原子保存、重新加载、备份并恢复已校验的快照", () => {
    const { store } = adapter();
    expect(store.load()).toBeNull();
    store.save({ version: 1, value: "first" });
    const backup = store.backup(new Date("2026-09-04T00:00:00.000Z"));
    store.save({ version: 1, value: "second" });
    expect(store.load()).toEqual({ version: 1, value: "second" });
    expect(backup).not.toBeNull();
    const secondBackup = store.backup(new Date("2026-09-04T00:00:00.000Z"));
    expect(secondBackup).not.toBe(backup);
    expect(existsSync(secondBackup!)).toBe(true);
    expect(store.restore(backup!)).toEqual({ version: 1, value: "first" });
    expect(store.load()).toEqual({ version: 1, value: "first" });
  });

  it("损坏快照、目录外备份和超大快照安全失败", () => {
    const { rootDirectory, store } = adapter();
    writeFileSync(join(rootDirectory, "state.json"), "{bad", "utf8");
    expect(() => store.load()).toThrow(/校验失败/);
    expect(() => store.restore(join(tmpdir(), "outside.json"))).toThrow(/当前持久化文件.*同目录生成/);
    const small = new JsonFileSnapshotAdapter({
      rootDirectory,
      fileName: "small.json",
      schema: z.object({ version: z.literal(1), value: z.string() }).strict(),
      maxBytes: 10,
    });
    expect(() => small.save({ version: 1, value: "too-large" })).toThrow(/大小限制/);
    writeFileSync(join(rootDirectory, "small.json"), "x".repeat(11), "utf8");
    expect(() => small.load()).toThrow(/大小限制/);
  });

  it("在 JSON 或 Schema 解析前拒绝超限的主快照与备份", () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "datacanvas-persistence-bounds-"));
    temporaryDirectories.push(rootDirectory);
    let parseCalls = 0;
    const schema = {
      parse(value: unknown) {
        parseCalls += 1;
        return z.object({ version: z.literal(1), value: z.string() }).strict().parse(value);
      },
    };
    const store = new JsonFileSnapshotAdapter({ rootDirectory, fileName: "bounded.json", schema, maxBytes: 32 });

    writeFileSync(join(rootDirectory, "bounded.json"), "x".repeat(33), "utf8");
    expect(() => store.load()).toThrow(/大小限制/);
    expect(parseCalls).toBe(0);

    writeFileSync(join(rootDirectory, "bounded.json"), JSON.stringify({ version: 1, value: "ok" }), "utf8");
    expect(store.load()).toEqual({ version: 1, value: "ok" });
    const backup = store.backup(new Date("2026-09-04T00:00:00.000Z"));
    expect(backup).not.toBeNull();
    writeFileSync(backup!, "x".repeat(33), "utf8");
    parseCalls = 0;
    expect(() => store.restore(backup!)).toThrow(/大小限制/);
    expect(parseCalls).toBe(0);
    expect(store.load()).toEqual({ version: 1, value: "ok" });
  });

  it("新实例可用受信备份原子恢复损坏主快照", () => {
    const { rootDirectory, store } = adapter();
    expect(store.load()).toBeNull();
    store.save({ version: 1, value: "recoverable" });
    const backup = store.backup(new Date("2026-09-04T00:00:00.000Z"));
    expect(backup).not.toBeNull();
    writeFileSync(join(rootDirectory, "state.json"), "{broken", "utf8");

    const recoveryProcess = new JsonFileSnapshotAdapter({
      rootDirectory,
      fileName: "state.json",
      schema: z.object({ version: z.literal(1), value: z.string() }).strict(),
    });
    expect(recoveryProcess.restore(backup!)).toEqual({ version: 1, value: "recoverable" });
    expect(recoveryProcess.load()).toEqual({ version: 1, value: "recoverable" });
  });

  it("拒绝把同目录任意文件冒充为当前快照的备份", () => {
    const { rootDirectory, store } = adapter();
    const unrelated = join(rootDirectory, "unrelated.json");
    writeFileSync(unrelated, JSON.stringify({ version: 1, value: "unsafe" }), "utf8");
    expect(() => store.restore(unrelated)).toThrow(/当前持久化文件.*同目录生成/);
  });

  it("新实例备份现有快照后可继续安全保存", () => {
    const { rootDirectory, store } = adapter();
    expect(store.load()).toBeNull();
    store.save({ version: 1, value: "first" });
    const maintenanceProcess = new JsonFileSnapshotAdapter({
      rootDirectory,
      fileName: "state.json",
      schema: z.object({ version: z.literal(1), value: z.string() }).strict(),
    });
    expect(maintenanceProcess.backup()).not.toBeNull();
    maintenanceProcess.save({ version: 1, value: "second" });
    expect(maintenanceProcess.load()).toEqual({ version: 1, value: "second" });
  });

  it("拒绝并发覆盖较新快照，重新加载后才允许继续", () => {
    const { rootDirectory, store: firstProcess } = adapter();
    const secondProcess = new JsonFileSnapshotAdapter({
      rootDirectory,
      fileName: "state.json",
      schema: z.object({ version: z.literal(1), value: z.string() }).strict(),
    });
    expect(firstProcess.load()).toBeNull();
    expect(secondProcess.load()).toBeNull();
    firstProcess.save({ version: 1, value: "first" });
    expect(() => secondProcess.save({ version: 1, value: "stale" })).toThrow(/其他进程修改/);
    expect(secondProcess.load()).toEqual({ version: 1, value: "first" });
    secondProcess.save({ version: 1, value: "second" });
    expect(secondProcess.load()).toEqual({ version: 1, value: "second" });
  });

  it("存在写锁时安全失败且不破坏既有快照", () => {
    const { rootDirectory, store } = adapter();
    expect(store.load()).toBeNull();
    store.save({ version: 1, value: "safe" });
    writeFileSync(join(rootDirectory, "state.json.lock"), "busy", "utf8");
    expect(() => store.save({ version: 1, value: "unsafe" })).toThrow(/另一个进程写入/);
    rmSync(join(rootDirectory, "state.json.lock"));
    expect(store.load()).toEqual({ version: 1, value: "safe" });
  });
});
