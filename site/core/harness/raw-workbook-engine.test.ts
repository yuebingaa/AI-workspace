import { describe, expect, it } from "vitest";
import type { EdsWorkbookSheet } from "@/core/eds";
import { indexRawWorkbook, queryRawWorkbook } from "./raw-workbook-engine";

const sheets: EdsWorkbookSheet[] = [
  {
    sheet: "白班明细",
    data: [
      ["生产异常明细"],
      ["Line", "IssueDescription", "DT(s)", "班次"],
      ["A5FNL01", "飞达超时", 60, "白班"],
      ["A5FNL01", "吸料失败", 30, "白班"],
      ["A5FNL02", "飞达超时", 90, "白班"],
    ],
  },
  {
    sheet: "夜班明细",
    data: [
      ["Line", "IssueDescription", "DT(s)", "班次"],
      ["A5FNL01", "飞达超时", 120, "夜班"],
      ["A5FNL02", "吸料失败", 45, "夜班"],
    ],
  },
];

describe("EDS 原始工作簿结构化扫描与查询", () => {
  it("完整扫描全部工作表、数据行和单元格，并识别表头与字段概况", () => {
    const index = indexRawWorkbook(sheets, "a".repeat(64));

    expect(index).toMatchObject({
      datasetVersion: "a".repeat(64),
      scannedRowCount: 8,
      scannedDataRowCount: 5,
      scannedCellCount: 20,
    });
    expect(index.sheets.map((sheet) => ({ name: sheet.name, headerRow: sheet.headerRow, dataRows: sheet.dataRowNumbers.length }))).toEqual([
      { name: "白班明细", headerRow: 2, dataRows: 3 },
      { name: "夜班明细", headerRow: 1, dataRows: 2 },
    ]);
    expect(index.sheets[0].columns[2]).toMatchObject({
      header: "DT(s)",
      inferredType: "number",
      nonEmptyCount: 3,
      minimum: 30,
      maximum: 90,
      average: 60,
    });
    expect(indexRawWorkbook(sheets, "a".repeat(64))).toBe(index);
  });

  it("跨工作表对全部匹配行做精确分组聚合，而不是只计算返回样本", () => {
    const index = indexRawWorkbook(sheets, "b".repeat(64));
    const result = queryRawWorkbook(index, {
      mode: "aggregate",
      sheetName: "*",
      filters: [{ column: "IssueDescription", operator: "contains", value: "飞达" }],
      groupBy: ["Line"],
      aggregations: [
        { operation: "count", alias: "异常次数" },
        { operation: "sum", column: "DT(s)", alias: "异常秒数" },
        { operation: "average", column: "DT(s)", alias: "平均秒数" },
      ],
      orderBy: [{ field: "异常秒数", direction: "descending" }],
      limit: 1,
    });

    expect(result).toMatchObject({
      scanComplete: true,
      scannedDataRowCount: 5,
      matchedRowCount: 3,
      returnedCount: 1,
      hasMore: true,
      groups: [{ Line: "A5FNL01", 异常次数: 2, 异常秒数: 180, 平均秒数: 90 }],
    });
  });

  it("筛选完整数据后只返回有限且带工作表与原始行号的证据", () => {
    const index = indexRawWorkbook(sheets, "c".repeat(64));
    const result = queryRawWorkbook(index, {
      mode: "rows",
      sheetName: "*",
      select: ["Line", "IssueDescription", "DT(s)", "$sheet", "$row"],
      filters: [{ column: "Line", operator: "equals", value: "A5FNL01" }],
      orderBy: [{ field: "DT(s)", direction: "descending" }],
      limit: 2,
    });

    expect(result).toMatchObject({
      scannedDataRowCount: 5,
      matchedRowCount: 3,
      returnedCount: 2,
      hasMore: true,
    });
    expect(result.rows?.[0]).toEqual({
      source: { sheet: "夜班明细", rowNumber: 2 },
      values: { Line: "A5FNL01", IssueDescription: "飞达超时", "DT(s)": 120, $sheet: "夜班明细", $row: 2 },
    });
  });

  it("拒绝跨表不存在的列，避免静默漏算", () => {
    const index = indexRawWorkbook(sheets, "d".repeat(64));
    expect(() => queryRawWorkbook(index, {
      mode: "rows",
      sheetName: "*",
      select: ["不存在字段"],
    })).toThrow("不存在列");
  });
});
