import { describe, expect, it } from "vitest";
import { EXCEL_EXPORT_TTL_MS, excelExportArtifactSchema, type ExcelExportArtifact } from "./contracts";

function artifact(): ExcelExportArtifact {
  return {
    id: "export_contract_test_001",
    status: "ready",
    fileName: "合同测试.xlsx",
    downloadUrl: "/api/exports/export_contract_test_001",
    rowCount: 1,
    fieldCount: 1,
    sizeBytes: 4,
    createdAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T00:10:00.000Z",
  };
}

describe("Excel 导出工件合同", () => {
  it("只接受创建后固定 10 分钟到期的工件", () => {
    expect(EXCEL_EXPORT_TTL_MS).toBe(600_000);
    expect(excelExportArtifactSchema.safeParse(artifact()).success).toBe(true);
    expect(excelExportArtifactSchema.safeParse({ ...artifact(), expiresAt: "2026-09-04T00:09:59.999Z" }).success).toBe(false);
    expect(excelExportArtifactSchema.safeParse({ ...artifact(), expiresAt: "2099-09-04T00:10:00.000Z" }).success).toBe(false);
    expect(excelExportArtifactSchema.safeParse({ ...artifact(), expiresAt: "2026-09-03T23:59:00.000Z" }).success).toBe(false);
  });

  it("文件名合同拒绝可能污染下载响应头的控制字符", () => {
    for (const fileName of ["safe.xlsx\r\nX-Injected: yes.xlsx", "safe\u0000name.xlsx", "safe\u007fname.xlsx"]) {
      expect(excelExportArtifactSchema.safeParse({ ...artifact(), fileName }).success).toBe(false);
    }
  });
});
