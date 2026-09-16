import { z } from "zod";
import { CATALOG_LIMITS, catalogSnapshotSchema, type CatalogRepository, type CatalogSnapshot } from "../contracts";
import type { SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";

export const catalogStoreSchema = z.object({ version: z.literal(1), entries: z.array(z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/u), snapshot: catalogSnapshotSchema,
}).strict()).max(CATALOG_LIMITS.snapshots) }).strict();
export type CatalogStore = z.infer<typeof catalogStoreSchema>;

export function createCatalogRepository(adapter?: Pick<SnapshotAdapter<CatalogStore>, "load" | "save">): CatalogRepository {
  let memory: CatalogStore = { version: 1, entries: [] };
  function load() {
    try { return adapter ? adapter.load() ?? { version: 1 as const, entries: [] } : memory; }
    catch { throw new Error("数据目录存储读取失败，请检查本地持久化状态"); }
  }
  return {
    storage: adapter ? "persistent" : "memory",
    get(key) { return structuredClone(load().entries.find((entry) => entry.key === key)?.snapshot ?? null); },
    save(key: string, snapshot: CatalogSnapshot, expectedRevision: number | null) {
      const store = load();
      const previous = store.entries.find((entry) => entry.key === key);
      if ((previous?.snapshot.reference.revision ?? null) !== expectedRevision) throw new Error("目录已被其他同步更新，请重新读取");
      const entries = store.entries.filter((entry) => entry.key !== key);
      // Catalogs are replaceable discovery snapshots; saved Dataset receipts carry their own references.
      if (entries.length >= CATALOG_LIMITS.snapshots) entries.sort((a, b) => a.snapshot.reference.syncedAt.localeCompare(b.snapshot.reference.syncedAt)).shift();
      const next = catalogStoreSchema.parse({ version: 1, entries: [...entries, { key, snapshot }] });
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > CATALOG_LIMITS.bytes) throw new Error("数据目录超过存储容量，未覆盖上次同步结果");
      try { if (adapter) adapter.save(next); else memory = structuredClone(next); }
      catch { throw new Error("数据目录保存失败，上次同步结果仍保留，请稍后重试"); }
    },
  };
}
