import {
  EDS_BUILT_IN_DEFINITION,
  EDS_DETAIL_COLUMN_INDEXES,
  type EdsSheetData,
  type EdsWorkbookSheet,
} from "@/core/eds";

const syntheticIssues = EDS_BUILT_IN_DEFINITION.issues.map((issue) => ({ ...issue }));

const syntheticLines = EDS_BUILT_IN_DEFINITION.channels
  .filter((_, index) => index % 2 === 0)
  .map((channel) => ({
    raw: channel.line,
    display: channel.displayLine,
    sheet: channel.columnIndex < 17 ? "合成35-36明细" : "合成32-33明细",
  }));

const headers = ["Line", "Instance", "Issue Description", "DT(s)", "工作日", "班次", "备注"];

function sourceRows(sheet: string): EdsSheetData {
  const rows: EdsSheetData = [[...headers]];
  const sheetLines = syntheticLines.filter((line) => line.sheet === sheet);
  sheetLines.forEach((line, lineIndex) => {
    ["EDS_Coat-1", "EDS_Coat-2"].forEach((instance, instanceIndex) => {
      syntheticIssues.forEach((issue, issueIndex) => {
        const repetitions = ((lineIndex * 2 + instanceIndex + issueIndex) % 6) + 1;
        for (let record = 0; record < repetitions; record += 1) {
          rows.push([line.raw, instance, issue.raw, 60 * ((issueIndex % 3) + 1), new Date("2026-08-25T00:00:00.000Z"), "白班", "完全虚构"]);
        }
        if (sheet === "合成35-36明细") {
          rows.push([line.raw, instance, issue.raw, 999, new Date("2026-08-24T00:00:00.000Z"), "白班", "日期隔离"]);
          rows.push([line.raw, instance, issue.raw, 999, new Date("2026-08-25T00:00:00.000Z"), "夜班", "班次隔离"]);
        }
      });
    });
  });
  rows.push([sheetLines[0].raw, "EDS_TEST-1", "SYNTHETIC_UNTRACKED_ISSUE", 600, new Date("2026-08-25T00:00:00.000Z"), "白班", "异常类别隔离"]);
  return rows;
}

function baseTemplate(): EdsSheetData {
  const rows: EdsSheetData = Array.from({ length: 36 }, () => Array<EdsSheetData[number][number]>(26).fill(null));
  rows[0][2] = new Date("2026-08-25T00:00:00.000Z");
  rows[0][3] = "白班";
  rows[0][4] = "合成 35/36 EDS 报警统计";
  rows[0][17] = "合成 32/33 EDS 报警统计";
  syntheticIssues.forEach((issue, index) => {
    rows[6 + index * 2][0] = issue.raw;
    rows[6 + index * 2][2] = issue.display;
  });
  EDS_DETAIL_COLUMN_INDEXES.forEach((columnIndex, channelIndex) => {
    const line = syntheticLines[Math.floor(channelIndex / 2)];
    rows[2][columnIndex] = line.raw;
    rows[3][columnIndex] = `EDS_Coat-${channelIndex % 2 + 1}`;
    rows[4][columnIndex] = channelIndex % 2 === 0 ? line.display : null;
    rows[5][columnIndex] = `${channelIndex % 2 + 1}#`;
  });
  return rows;
}

function populateExpected(template: EdsSheetData, sourceSheets: EdsWorkbookSheet[]): void {
  const records = sourceSheets.flatMap((sheet) => sheet.data.slice(1));
  syntheticIssues.forEach((issue, issueIndex) => {
    EDS_DETAIL_COLUMN_INDEXES.forEach((columnIndex, channelIndex) => {
      const line = syntheticLines[Math.floor(channelIndex / 2)];
      const instance = `EDS_Coat-${channelIndex % 2 + 1}`;
      const selected = records.filter((row) => row[0] === line.raw && row[1] === instance && row[2] === issue.raw && (row[4] as Date).toISOString().startsWith("2026-08-25") && row[5] === "白班");
      template[6 + issueIndex * 2][columnIndex] = selected.length;
      template[7 + issueIndex * 2][columnIndex] = selected.reduce((total, row) => total + Number(row[3]), 0) / 60;
    });
    for (const rowIndex of [6 + issueIndex * 2, 7 + issueIndex * 2]) {
      template[rowIndex][16] = EDS_DETAIL_COLUMN_INDEXES.slice(0, 12).reduce((total, column) => total + Number(template[rowIndex][column]), 0);
      template[rowIndex][25] = EDS_DETAIL_COLUMN_INDEXES.slice(12).reduce((total, column) => total + Number(template[rowIndex][column]), 0);
    }
  });
  for (const columnIndex of [...EDS_DETAIL_COLUMN_INDEXES, 16, 25]) {
    template[34][columnIndex] = Array.from({ length: 14 }, (_, issue) => Number(template[6 + issue * 2][columnIndex])).reduce((a, b) => a + b, 0);
    template[35][columnIndex] = Array.from({ length: 14 }, (_, issue) => Number(template[7 + issue * 2][columnIndex])).reduce((a, b) => a + b, 0);
  }
}

export function createSyntheticEdsFixture() {
  const sourceSheets: EdsWorkbookSheet[] = [
    { sheet: "合成32-33明细", data: sourceRows("合成32-33明细") },
    { sheet: "合成35-36明细", data: sourceRows("合成35-36明细") },
  ];
  const template = baseTemplate();
  populateExpected(template, sourceSheets);
  return {
    sourceSheets,
    templateSheets: [{ sheet: "EDS飞达异常统计", data: template }] satisfies EdsWorkbookSheet[],
  };
}
