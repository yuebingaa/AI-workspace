import { beforeEach, describe, expect, it } from "vitest";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { GET } from "./route";

describe("Excel 下载 API", () => {
  beforeEach(() => excelExportStore.clear());

  it("按随机标识返回 XLSX Buffer 和安全下载响应头", async () => {
    const buffer = Buffer.from("PK test xlsx bytes");
    const artifact = excelExportStore.put({
      buffer,
      fileName: "华东异常订单.xlsx",
      rowCount: 4,
      fieldCount: 6,
      sizeBytes: buffer.length,
      generatedAt: new Date().toISOString(),
    }, resolveDemoRequestIdentity());
    const response = await GET(new Request(`http://localhost${artifact.downloadUrl}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);
  });

  it("不向其他所有者返回导出文件", async () => {
    const buffer = Buffer.from("PK private xlsx bytes");
    const artifact = excelExportStore.put({
      buffer,
      fileName: "其他所有者.xlsx",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: buffer.length,
      generatedAt: new Date().toISOString(),
    }, { tenantId: "tenant_demo_local", ownerId: "owner_other" });

    expect((await GET(new Request(`http://localhost${artifact.downloadUrl}`))).status).toBe(404);
  });

  it("拒绝非法或不存在的下载标识", async () => {
    expect((await GET(new Request("http://localhost/api/exports/..%2Fsecret"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/exports/not_existing_token_001"))).status).toBe(404);
  });
});
