import { describe, expect, it } from "vitest";
import { EDS_RULE_VERSION, EDS_TEMPLATE_VERSION } from "./built-in";
import { edsAnalysisResponseSchema, type EdsAnalysisResponse } from "./contracts";

function validResponse(): EdsAnalysisResponse {
  return {
    summary: {
      date: "2026-08-25",
      shift: "白班",
      inputRows: 20,
      matchedRows: 14,
      issueCount: 14,
      channelCount: 20,
      totalOccurrences: 14,
      totalMinutes: 28,
      sourceSheets: ["32-33", "35-36"],
    },
    issueSummary: Array.from({ length: 14 }, (_, index) => ({ label: `异常 ${index + 1}`, count: 1, minutes: 2 })),
    lineSummary: [
      { label: "线体 A", count: 7, minutes: 14 },
      { label: "线体 B", count: 7, minutes: 14 },
    ],
    configuration: { templateVersion: EDS_TEMPLATE_VERSION, ruleVersion: EDS_RULE_VERSION, comparisonMode: "custom_template" },
    comparison: { coreMatched: 560, coreTotal: 560, reportMatched: 660, reportTotal: 660, mismatchCount: 0, mismatches: [] },
    exportArtifact: {
      id: "1234567890abcdef",
      status: "ready",
      fileName: "EDS.xlsx",
      downloadUrl: "/api/exports/1234567890abcdef",
      rowCount: 30,
      fieldCount: 20,
      sizeBytes: 1_024,
      createdAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2026-09-04T00:10:00.000Z",
    },
    warnings: [],
  };
}

describe("EDS 响应跨汇总一致性", () => {
  it("接受各层合计一致的固定 14×20 响应", () => {
    expect(edsAnalysisResponseSchema.parse(validResponse())).toEqual(validResponse());

    const standard = validResponse();
    standard.configuration.comparisonMode = "not_requested";
    standard.comparison = null;
    expect(edsAnalysisResponseSchema.parse(standard)).toEqual(standard);
  });

  it("拒绝比对、KPI、分类、线体、标签或导出元数据矛盾", () => {
    const mutations: Array<(value: EdsAnalysisResponse) => void> = [
      (value) => { value.comparison!.coreMatched = 559; },
      (value) => { value.comparison!.mismatchCount = 1; },
      (value) => { value.summary.matchedRows = 13; },
      (value) => { value.issueSummary[0].count = 2; },
      (value) => { value.lineSummary[0].minutes = 13; },
      (value) => { value.issueSummary[1].label = value.issueSummary[0].label; },
      (value) => { value.lineSummary[1].label = value.lineSummary[0].label; },
      (value) => { value.summary.sourceSheets[1] = value.summary.sourceSheets[0]; },
      (value) => { value.exportArtifact.fieldCount = 19; },
      (value) => { value.summary.totalMinutes = Number.POSITIVE_INFINITY; },
      (value) => { value.issueSummary[0].minutes = Number.NaN; },
      (value) => { value.configuration.comparisonMode = "not_requested"; },
    ];

    for (const mutate of mutations) {
      const candidate = validResponse();
      mutate(candidate);
      expect(edsAnalysisResponseSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
