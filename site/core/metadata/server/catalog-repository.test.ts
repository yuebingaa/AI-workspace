import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { catalogStoreSchema, createCatalogRepository } from "./catalog-repository";
import type { CatalogSnapshot } from "../contracts";

const directories: string[] = [];
const key = "a".repeat(64);
const snapshot: CatalogSnapshot = { reference: { id: "catalog_test", connectionId: "sales", revision: 1,
  schemaFingerprint: "b".repeat(64), syncedAt: "2026-09-14T00:00:00.000Z", complete: true }, columns: [] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catalog-foundation-")); directories.push(root);
  const create = () => createCatalogRepository(new JsonFileSnapshotAdapter({ rootDirectory: root, fileName: "catalog.json", schema: catalogStoreSchema }));
  return { root, create };
}
afterEach(() => {
  for (const root of directories.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("catalog-foundation-")) throw new Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
describe("catalog snapshot persistence", () => {
  it("survives repository recreation and rejects stale revision writes", () => {
    const f = fixture(); const first = f.create(); first.save(key, snapshot, null);
    const reopened = f.create(); expect(reopened.storage).toBe("persistent"); expect(reopened.get(key)).toEqual(snapshot);
    reopened.save(key, { ...snapshot, reference: { ...snapshot.reference, revision: 2 } }, 1);
    expect(() => first.save(key, snapshot, 1)).toThrow("其他同步更新");
    expect(f.create().get(key)?.reference.revision).toBe(2);
  });
  it("reports corruption without leaking file content or overwriting it", () => {
    const f = fixture(); const file = join(f.root, "catalog.json");
    writeFileSync(file, "PRIVATE_SYNTHETIC_CORRUPTION", "utf8");
    expect(() => f.create().get(key)).toThrow("数据目录存储读取失败");
    expect(readFileSync(file, "utf8")).toBe("PRIVATE_SYNTHETIC_CORRUPTION");
  });
  it("returns independent snapshots so readers cannot mutate stored versions", () => {
    const repository = createCatalogRepository(); repository.save(key, snapshot, null);
    repository.get(key)!.reference.revision = 99;
    expect(repository.get(key)?.reference.revision).toBe(1);
  });
});
