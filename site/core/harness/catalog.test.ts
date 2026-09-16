import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessRequest } from "./contracts";
import { executeHarnessTool } from "./tool-registry";

describe("Agent catalog discovery", () => {
  it("searches before paging and keeps incomplete directory/version information", async () => {
    const { product } = semanticFixture();
    const request: HarnessRequest = { idempotencyKey: "catalog_test", instruction: "查找销售字段", pageId: "page_home", role: "editor",
      appSpec: product.appSpec, recipes: product.recipes,
      notebookContext: { document: { name: "catalog", revision: 0, cells: [] }, sourceIds: [],
        connections: [{ id: "sales", name: "销售", kind: "postgresql", allowAi: true }] } };
    const catalog = { id: "catalog_sales", connectionId: "sales", revision: 2, schemaFingerprint: "a".repeat(64),
      syncedAt: "2026-09-14T00:00:00.000Z", complete: false, freshness: "fresh" as const, storage: "memory" as const, tableCount: 2 };
    const inspector = vi.fn(async () => ({ catalog, truncated: true, columns: [
      ...Array.from({ length: 20 }, (_, index) => ({ table_schema: "public", table_name: "inventory", column_name: `item_${index}`, data_type: "text" })),
      ...Array.from({ length: 18 }, (_, index) => ({ table_schema: "public", table_name: "orders", column_name: `sale_${index}`, data_type: "numeric" })),
    ] }));
    const context = { request, dataRuntime: { rowsByDataSourceId: {} }, now: Date.now, id: () => "catalog_test", connectionInspector: inspector };
    const first = await executeHarnessTool("inspectConnectionSchema", { connectionId: "sales", search: "ORDERS", offset: 0 }, context);
    expect(first.data).toMatchObject({ offset: 0, nextOffset: 15, truncated: true, catalog });
    expect((first.data as { columns: unknown[] }).columns).toHaveLength(15);
    const next = await executeHarnessTool("inspectConnectionSchema", { connectionId: "sales", search: "orders", offset: 15 }, context);
    expect((next.data as { columns: unknown[] }).columns).toHaveLength(3);
    expect(next.data).toMatchObject({ nextOffset: null, truncated: true });
    request.notebookContext!.connections![0].allowAi = false;
    await expect(executeHarnessTool("inspectConnectionSchema", { connectionId: "sales" }, context)).rejects.toThrow();
    expect(inspector).toHaveBeenCalledTimes(2);
  });
});
