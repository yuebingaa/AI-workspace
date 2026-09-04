import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { encodeDownloadFileName, GET } from "./route";

describe("Excel 下载 API", () => {
  beforeEach(() => excelExportStore.clear());
  afterEach(() => vi.restoreAllMocks());

  it("按随机标识返回 XLSX Buffer 和安全下载响应头", async () => {
    const buffer = Buffer.from("PK test xlsx bytes");
    const artifact = excelExportStore.put({
      buffer,
      fileName: "华东 O'Brien（异常）*.xlsx",
      rowCount: 4,
      fieldCount: 6,
      sizeBytes: buffer.length,
      generatedAt: new Date().toISOString(),
    }, resolveDemoRequestIdentity());
    const response = await GET(new Request(`http://localhost${artifact.downloadUrl}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(Number(response.headers.get("content-length"))).toBe(buffer.length);
    expect(Number(response.headers.get("content-length"))).toBe(artifact.sizeBytes);
    expect(response.headers.get("accept-ranges")).toBe("none");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("%27");
    expect(disposition).toContain("%2A");
    expect(disposition).not.toContain("O'Brien");
    const encodedName = /filename\*=UTF-8''([^;]+)/u.exec(disposition)?.[1];
    expect(encodedName).toBeTruthy();
    expect(decodeURIComponent(encodedName!)).toBe(artifact.fileName);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);

    const rangeResponse = await GET(new Request(`http://localhost${artifact.downloadUrl}`, {
      headers: { range: "bytes=0-1" },
    }));
    expect(rangeResponse.status).toBe(200);
    expect(rangeResponse.headers.get("accept-ranges")).toBe("none");
    expect(Number(rangeResponse.headers.get("content-length"))).toBe(artifact.sizeBytes);
    expect(Buffer.from(await rangeResponse.arrayBuffer())).toEqual(buffer);
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

  it("同一所有者可在 TTL 内重试下载，撤销后立即失效", async () => {
    const buffer = Buffer.from("PK retryable xlsx bytes");
    const ownership = resolveDemoRequestIdentity();
    const artifact = excelExportStore.put({
      buffer,
      fileName: "可重试下载.xlsx",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: buffer.length,
      generatedAt: new Date().toISOString(),
    }, ownership);

    const first = await GET(new Request(`http://localhost${artifact.downloadUrl}`));
    const second = await GET(new Request(`http://localhost${artifact.downloadUrl}`));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(buffer);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(buffer);

    expect(excelExportStore.revoke(artifact.id, ownership)).toBe(true);
    expect((await GET(new Request(`http://localhost${artifact.downloadUrl}`))).status).toBe(404);
  });

  it("拒绝非法或不存在的下载标识", async () => {
    const invalid = await GET(new Request("http://localhost/api/exports/..%2Fsecret"));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await GET(new Request("http://localhost/api/exports/not_existing_token_001"))).status).toBe(404);
  });

  it("下载标识到期后返回 404，并使用 RFC 5987 文件名编码", async () => {
    const buffer = Buffer.from("PK expired xlsx bytes");
    const artifact = excelExportStore.put({
      buffer,
      fileName: "O'Brien 报表.xlsx",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: buffer.length,
      generatedAt: "2026-01-01T00:00:00.000Z",
    }, resolveDemoRequestIdentity(), new Date("2026-01-01T00:00:00.000Z"));

    expect(encodeDownloadFileName("O'Brien 报表.xlsx")).toContain("O%27Brien");
    expect((await GET(new Request(`http://localhost${artifact.downloadUrl}`))).status).toBe(404);
  });

  it("持久化清理失败时返回脱敏 500", async () => {
    vi.spyOn(excelExportStore, "get").mockImplementationOnce(() => { throw new Error("C:\\private\\excel-exports.json.lock"); });
    const response = await GET(new Request("http://localhost/api/exports/1234567890123456"));
    expect(response.status).toBe(500);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).not.toContain("private");
  });
});
