import { describe, expect, it } from "vitest";
import { excelExportArtifactSchema } from "../contracts";
import { EXCEL_EXPORT_LIMITS } from "./recipe-excel-export";
import { ExcelExportStore, MAX_EXPORT_ID_ATTEMPTS } from "./excel-export-store";

const owner = { tenantId: "tenant_test", ownerId: "owner_test" };

function generated() {
  const buffer = Buffer.from("PK synthetic workbook");
  return {
    buffer,
    fileName: "synthetic.xlsx",
    rowCount: 1,
    fieldCount: 1,
    sizeBytes: buffer.length,
    generatedAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("ExcelExportStore 持久化与容量", () => {
  it("进程重建后恢复下载，TTL 到期后清理快照并给出容量预警", () => {
    let snapshot: unknown = null;
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(snapshot) as never,
      save: (value: unknown) => { snapshot = structuredClone(value); },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: snapshot !== null }),
    };
    let currentTime = Date.parse("2026-09-04T00:00:00.000Z");
    const clock = () => currentTime;
    const firstProcess = new ExcelExportStore({ persistence, maxExports: 1, clock });
    const artifact = firstProcess.put(generated(), owner);
    expect(firstProcess.health()).toMatchObject({ mode: "json-file", count: 1, utilization: 1 });
    expect(firstProcess.health().warning).toContain("100%");

    const secondProcess = new ExcelExportStore({ persistence, maxExports: 1, clock });
    currentTime = Date.parse("2026-09-04T00:05:00.000Z");
    expect(secondProcess.get(artifact.id, owner)?.buffer.toString()).toBe("PK synthetic workbook");
    currentTime = Date.parse("2026-09-04T00:11:00.000Z");
    expect(secondProcess.get(artifact.id, owner)).toBeUndefined();
    expect(secondProcess.health().count).toBe(0);
  });

  it("拒绝无效或超出 Date 范围的时间，显式调用时间仍优先", () => {
    expect(() => new ExcelExportStore({ clock: () => Number.NaN })).toThrow(/时钟.*有效 Date 范围/);
    expect(() => new ExcelExportStore({ clock: () => Number.MAX_SAFE_INTEGER })).toThrow(/时钟.*有效 Date 范围/);
    const store = new ExcelExportStore({ clock: () => Date.parse("2099-09-04T00:11:00.000Z") });
    const createdAt = new Date("2026-09-04T00:00:00.000Z");
    const artifact = store.put(generated(), owner, createdAt);
    expect(store.get(artifact.id, owner, new Date("2026-09-04T00:05:00.000Z"))).toBeDefined();
    expect(() => store.health(new Date(Number.MAX_SAFE_INTEGER))).toThrow(/操作时间.*有效 Date 范围/);
  });

  it("持久化失败保留原始错误，不被随后失效的注入时钟覆盖", () => {
    let clockCalls = 0;
    const persistence = {
      mode: "json-file" as const,
      load: () => null,
      save: () => { throw new Error("synthetic disk failure"); },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: false }),
    };
    const operationTime = new Date("2026-09-04T00:00:00.000Z");
    const store = new ExcelExportStore({
      persistence,
      clock: () => (clockCalls++ === 0 ? operationTime.getTime() : Number.NaN),
    });

    expect(() => store.put(generated(), owner, operationTime)).toThrow(/synthetic disk failure/);
    expect(clockCalls).toBe(1);
    expect(store.health(operationTime)).toMatchObject({
      persistenceHealthy: false,
      lastPersistenceErrorAt: operationTime.toISOString(),
      count: 0,
    });
  });

  it("持久化失败时不会留下调用方认为失败的内存下载", () => {
    let failWrites = true;
    const persistence = {
      mode: "json-file" as const,
      load: () => null,
      save: () => {
        if (failWrites) throw new Error("synthetic disk failure");
      },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: false }),
    };
    const store = new ExcelExportStore({ persistence, maxExports: 1 });
    expect(() => store.put(generated(), owner, new Date("2026-09-04T00:00:00.000Z"))).toThrow(/disk failure/);
    expect(store.health(new Date("2026-09-04T00:00:00.000Z")).count).toBe(0);

    failWrites = false;
    const persistedArtifact = store.put(generated(), owner, new Date("2026-09-04T00:00:00.000Z"));
    failWrites = true;
    expect(() => store.revoke(persistedArtifact.id, owner)).toThrow(/disk failure/);
    expect(store.health(new Date("2026-09-04T00:00:00.000Z"))).toMatchObject({ count: 1, persistenceHealthy: false });
    expect(store.health(new Date("2026-09-04T00:11:00.000Z")))
      .toMatchObject({ count: 0, persistenceHealthy: false });
    expect(() => store.clear()).toThrow(/disk failure/);
    expect(store.health(new Date("2026-09-04T00:00:00.000Z"))).toMatchObject({ count: 1, persistenceHealthy: false });

    failWrites = false;
    store.clear();
    expect(store.health(new Date("2026-09-04T00:00:00.000Z")))
      .toMatchObject({ count: 0, persistenceHealthy: true, lastPersistenceErrorAt: null });
  });

  it("存入和取出都复制 Buffer 与元数据，外部修改不污染下载", () => {
    const store = new ExcelExportStore();
    expect(() => store.put({ ...generated(), fileName: "safe.xlsx\r\nX-Injected: yes.xlsx" }, owner))
      .toThrow();
    const input = generated();
    const expected = Buffer.from(input.buffer);
    const artifact = store.put(input, owner, new Date("2026-09-04T00:00:00.000Z"));
    input.buffer.fill(0);

    const firstRead = store.get(artifact.id, owner, new Date("2026-09-04T00:01:00.000Z"));
    expect(firstRead?.buffer).toEqual(expected);
    firstRead!.buffer.fill(1);
    firstRead!.artifact.fileName = "mutated.xlsx";

    const secondRead = store.get(artifact.id, owner, new Date("2026-09-04T00:02:00.000Z"));
    expect(secondRead?.buffer).toEqual(expected);
    expect(secondRead?.artifact.fileName).toBe("synthetic.xlsx");
  });

  it("只有同一所有者能撤销工件", () => {
    const store = new ExcelExportStore();
    const artifact = store.put(generated(), owner, new Date("2026-09-04T00:00:00.000Z"));
    const otherOwner = { tenantId: "tenant_other", ownerId: "owner_other" };

    expect(store.revoke(artifact.id, otherOwner)).toBe(false);
    expect(store.get(artifact.id, owner, new Date("2026-09-04T00:01:00.000Z"))).toBeDefined();
    expect(store.revoke(artifact.id, owner)).toBe(true);
    expect(store.get(artifact.id, owner, new Date("2026-09-04T00:01:00.000Z"))).toBeUndefined();
    expect(store.revoke(artifact.id, owner)).toBe(false);
  });

  it("新文件和恢复快照都执行只能收紧的文件大小上限", () => {
    const oversized = Buffer.alloc(17, 1);
    const snapshot = {
      version: 1 as const,
      entries: [{
        ownership: owner,
        artifact: {
          id: "1234567890abcdef",
          status: "ready" as const,
          fileName: "snapshot.xlsx",
          downloadUrl: "/api/exports/1234567890abcdef",
          rowCount: 1,
          fieldCount: 1,
          sizeBytes: oversized.length,
          createdAt: "2099-09-04T00:00:00.000Z",
          expiresAt: "2099-09-04T00:10:00.000Z",
        },
        bufferBase64: oversized.toString("base64"),
      }],
    };
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(snapshot),
      save: () => undefined,
      backup: () => null,
      restore: () => structuredClone(snapshot),
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: true }),
    };

    expect(() => new ExcelExportStore({ persistence, maxFileBytes: 16 })).toThrow(/快照超过文件大小限制/);
    const store = new ExcelExportStore({ maxFileBytes: 16 });
    expect(() => store.put({ ...generated(), buffer: oversized, sizeBytes: oversized.length }, owner)).toThrow(/内容与元数据不一致/);
    expect(() => new ExcelExportStore({ maxFileBytes: EXCEL_EXPORT_LIMITS.maxFileBytes + 1 })).toThrow(/文件上限必须是/);
  });

  it("固定次数令牌碰撞后拒绝覆盖已有下载", () => {
    const id = "collision_token_001";
    let calls = 0;
    const store = new ExcelExportStore({ idFactory: () => { calls += 1; return id; } });
    const first = store.put(generated(), owner, new Date("2026-09-04T00:00:00.000Z"));

    expect(() => store.put(generated(), { tenantId: "tenant_other", ownerId: "owner_other" }, new Date("2026-09-04T00:01:00.000Z")))
      .toThrow(/连续碰撞/);
    expect(calls).toBe(1 + MAX_EXPORT_ID_ATTEMPTS);
    expect(store.get(first.id, owner, new Date("2026-09-04T00:02:00.000Z"))?.buffer.toString()).toBe("PK synthetic workbook");
    expect(store.get(first.id, { tenantId: "tenant_other", ownerId: "owner_other" }, new Date("2026-09-04T00:02:00.000Z"))).toBeUndefined();
  });

  it("拒绝重复快照令牌以及与标识不一致的下载地址", () => {
    const buffer = Buffer.from("PK snapshot");
    const artifact = {
      id: "snapshot_token_001",
      status: "ready" as const,
      fileName: "snapshot.xlsx",
      downloadUrl: "/api/exports/snapshot_token_001",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: buffer.length,
      createdAt: "2099-09-04T00:00:00.000Z",
      expiresAt: "2099-09-04T00:10:00.000Z",
    };
    const snapshot = {
      version: 1 as const,
      entries: [
        { ownership: owner, artifact, bufferBase64: buffer.toString("base64") },
        { ownership: { tenantId: "tenant_other", ownerId: "owner_other" }, artifact, bufferBase64: buffer.toString("base64") },
      ],
    };
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(snapshot),
      save: () => undefined,
      backup: () => null,
      restore: () => structuredClone(snapshot),
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: true }),
    };

    expect(() => new ExcelExportStore({ persistence })).toThrow(/重复标识/);
    expect(excelExportArtifactSchema.safeParse({ ...artifact, downloadUrl: "/api/exports/different_token_001" }).success).toBe(false);
  });
});
