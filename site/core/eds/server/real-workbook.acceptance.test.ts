import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/eds/analyze/route";
import { GET as downloadExport } from "@/app/api/exports/[token]/route";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { analyzeEdsWorkbook } from "../analysis";
import { edsAnalysisResponseSchema } from "../contracts";
import { readEdsXlsx } from "./workbook";

const sourcePath = process.env.EDS_REAL_SOURCE_PATH;
const templatePath = process.env.EDS_REAL_TEMPLATE_PATH;
const EXPECTED_SOURCE_SHA256 = "f44cd94decbdf797b0606258cb7dfe704fc34eb68e35fcecbf41d1a5409434c3";
const EXPECTED_TEMPLATE_SHA256 = "aaddae8b24140a0c5fadae715a8b2324c76e722b28f7075941da94c20006f04e";
if (process.env.npm_lifecycle_event === "test:eds:real" && (!sourcePath || !templatePath)) {
  throw new Error("test:eds:real 需要 EDS_REAL_SOURCE_PATH 和 EDS_REAL_TEMPLATE_PATH 两个原始工作簿路径");
}

describe.skipIf(!sourcePath || !templatePath)("EDS 真实工作簿验收", () => {
  let sourceBytes: Buffer;
  let templateBytes: Buffer;

  beforeAll(async () => {
    [sourceBytes, templateBytes] = await Promise.all([readFile(sourcePath!), readFile(templatePath!)]);
    expect(createHash("sha256").update(sourceBytes).digest("hex"), "input.xlsx 原件哈希已变化").toBe(EXPECTED_SOURCE_SHA256);
    expect(createHash("sha256").update(templateBytes).digest("hex"), "output.xlsx 原件哈希已变化").toBe(EXPECTED_TEMPLATE_SHA256);
  });

  beforeEach(() => excelExportStore.clear());

  it("只读解析原始材料并保持完整数值零差异", async () => {
    const [source, template] = await Promise.all([
      readEdsXlsx({ buffer: sourceBytes, originalFileName: "input.xlsx" }),
      readEdsXlsx({ buffer: templateBytes, originalFileName: "output.xlsx" }),
    ]);
    const result = analyzeEdsWorkbook(source, template);

    expect(result.summary).toMatchObject({ inputRows: 4_651, matchedRows: 293, totalOccurrences: 293 });
    expect(result.summary.totalMinutes).toBeCloseTo(231.77731666666662, 10);
    expect(result.comparison).toMatchObject({
      coreMatched: 560,
      coreTotal: 560,
      reportMatched: 660,
      reportTotal: 660,
      mismatchCount: 0,
    });
  });

  it("仅上传 input.xlsx 即按内置版本生成并可下载零差异报表", async () => {
    const form = new FormData();
    form.set("source", new File([Uint8Array.from(sourceBytes)], "input.xlsx", { type: "application/octet-stream" }));
    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const result = edsAnalysisResponseSchema.parse(await response.json());
    expect(result.configuration).toEqual({
      templateVersion: "EDS-REPORT-2026.09",
      ruleVersion: "EDS-RULES-2026.09",
      comparisonMode: "not_requested",
    });
    expect(result.comparison).toBeNull();
    expect(result.summary).toMatchObject({ inputRows: 4_651, matchedRows: 293, totalOccurrences: 293 });

    const downloaded = await downloadExport(new Request(`http://localhost${result.exportArtifact.downloadUrl}`));
    expect(downloaded.status).toBe(200);
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    const [source, exported] = await Promise.all([
      readEdsXlsx({ buffer: sourceBytes, originalFileName: "input.xlsx" }),
      readEdsXlsx({ buffer: downloadedBytes, originalFileName: result.exportArtifact.fileName }),
    ]);
    expect(analyzeEdsWorkbook(source, exported).comparison).toMatchObject({
      coreMatched: 560,
      reportMatched: 660,
      mismatchCount: 0,
    });
  });

  it("高级验收经 multipart API 读取相同原始字节", async () => {
    const form = new FormData();
    form.set("source", new File([Uint8Array.from(sourceBytes)], "input.xlsx", { type: "application/octet-stream" }));
    form.set("template", new File([Uint8Array.from(templateBytes)], "output.xlsx", { type: "application/octet-stream" }));
    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const result = edsAnalysisResponseSchema.parse(await response.json());
    expect(result.summary).toMatchObject({ inputRows: 4_651, matchedRows: 293, totalOccurrences: 293 });
    expect(result.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });

    const downloaded = await downloadExport(new Request(`http://localhost${result.exportArtifact.downloadUrl}`));
    expect(downloaded.status).toBe(200);
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(result.exportArtifact.sizeBytes);
    expect(downloadedBytes.subarray(0, 2).toString()).toBe("PK");
    const [source, exported] = await Promise.all([
      readEdsXlsx({ buffer: sourceBytes, originalFileName: "input.xlsx" }),
      readEdsXlsx({ buffer: downloadedBytes, originalFileName: result.exportArtifact.fileName }),
    ]);
    expect(analyzeEdsWorkbook(source, exported).comparison).toMatchObject({
      coreMatched: 560,
      reportMatched: 660,
      mismatchCount: 0,
    });
  });
});
