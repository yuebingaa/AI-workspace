import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCatalogService, type CatalogDependencies } from "./catalog-service";
import { CATALOG_LIMITS, type CatalogAccess } from "./contracts";
import { createCatalogRepository } from "./server/catalog-repository";

const access: CatalogAccess = { connectionId: "sales", project: null };
const columns = [
  { catalog: "sales", schema: "public", table: "orders", name: "id", dataType: "integer" },
  { catalog: "sales", schema: "public", table: "orders", name: "amount", dataType: "numeric" },
];
function fixture() {
  let now = new Date("2026-09-14T00:00:00.000Z");
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
  const repository = createCatalogRepository();
  const authorize = vi.fn((scope: CatalogAccess) => ({ connectionId: scope.connectionId, key: fingerprint(JSON.stringify(scope)) }));
  const inspect = vi.fn<CatalogDependencies["inspect"]>().mockResolvedValue({ columns, complete: true });
  const service = createCatalogService({ repository, authorize, inspect, fingerprint, now: () => now });
  return { service, repository, authorize, inspect, advance: () => { now = new Date(now.getTime() + CATALOG_LIMITS.freshMs); } };
}

describe("versioned metadata catalog", () => {
  it("reuses fresh discovery, refreshes after TTL and preserves object identity across type changes", async () => {
    const f = fixture();
    const first = await f.service.inspect(access);
    expect(first.reference).toMatchObject({ revision: 1, complete: true });
    expect(f.service.summary(first)).toMatchObject({ tableCount: 1, freshness: "fresh", storage: "memory" });
    expect(await f.service.inspect(access)).toEqual(first);
    expect(f.inspect).toHaveBeenCalledTimes(1);
    f.advance(); expect(f.service.summary(first).freshness).toBe("stale");
    f.inspect.mockResolvedValueOnce({ columns: [...columns].reverse(), complete: true });
    const second = await f.service.inspect(access);
    expect(second.reference.revision).toBe(2);
    expect(second.reference.schemaFingerprint).toBe(first.reference.schemaFingerprint);
    f.inspect.mockResolvedValueOnce({ columns: columns.map((column) => ({ ...column, dataType: "text" })), complete: true });
    const third = await f.service.refresh(access);
    expect(third.columns.map((column) => column.columnId)).toEqual(first.columns.map((column) => column.columnId));
    expect(third.reference.schemaFingerprint).not.toBe(first.reference.schemaFingerprint);
  });

  it("keeps projects and access modes isolated and reauthorizes cached reads", async () => {
    const f = fixture(); await f.service.refresh(access);
    expect(f.service.read({ ...access, project: "another" })).toBeNull();
    expect(f.service.read({ ...access, forAi: true })).toBeNull();
    f.authorize.mockImplementation(() => { throw new Error("revoked"); });
    expect(() => f.service.read(access)).toThrow("revoked");
    await expect(f.service.inspect(access)).rejects.toThrow("revoked");
    expect(f.inspect).toHaveBeenCalledTimes(1);
  });

  it("preserves the last snapshot on failed or invalid refresh and explicitly records partial catalogs", async () => {
    const f = fixture(); const first = await f.service.refresh(access);
    f.inspect.mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.refresh(access)).rejects.toThrow("offline");
    expect(f.service.read(access)).toEqual(first);
    f.inspect.mockResolvedValueOnce({ columns: [columns[0], columns[0]], complete: true });
    await expect(f.service.refresh(access)).rejects.toThrow("重复字段");
    expect(f.service.read(access)).toEqual(first);
    f.inspect.mockResolvedValueOnce({ columns: [columns[0]], complete: false });
    expect((await f.service.refresh(access)).reference.complete).toBe(false);
    f.inspect.mockResolvedValueOnce({ columns: [], complete: true });
    expect((await f.service.refresh(access)).columns).toEqual([]);
  });

  it("does not let a slower refresh overwrite a more recent completion", async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<CatalogDependencies["inspect"]>>) => void;
    f.inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const slow = f.service.refresh(access);
    const fast = await f.service.refresh(access);
    release({ columns: [], complete: true });
    await expect(slow).rejects.toThrow("其他同步更新");
    expect(f.service.read(access)).toEqual(fast);
  });

  it("rejects cancellation and scope changes while discovery is in flight", async () => {
    const f = fixture(); const controller = new AbortController();
    f.inspect.mockImplementationOnce(async () => { controller.abort(); return { columns, complete: true }; });
    await expect(f.service.refresh(access, controller.signal)).rejects.toThrow();
    expect(f.service.read(access)).toBeNull();
    f.inspect.mockImplementationOnce(async () => {
      f.authorize.mockReturnValue({ connectionId: access.connectionId, key: "a".repeat(64) });
      return { columns, complete: true };
    });
    await expect(f.service.refresh(access)).rejects.toThrow("连接配置已变化");
    expect(f.service.read(access)).toBeNull();
  });
});
