import type { DataRow, DataSourceDefinition } from "@/core/models";

export type DatasetQualityProfile = {
  version: 1;
  rowCount: number;
  declaredRowCount: number;
  rowCountMatchesSource: boolean;
  columnCount: number;
  cellCount: number;
  nullCellCount: number;
  nullRate: number;
  emptyRowCount: number;
  duplicateRowCount: number;
  nonNullBlankStringCount: number;
  rules: {
    scope: "current-dataset-rows";
    nulls: "null-or-missing";
    blankStrings: "not-null";
    duplicates: "typed-all-declared-fields-excluding-first";
    emptyRows: "all-declared-fields-null";
    denominator: "rows-times-declared-columns";
    originalFile: "not-measured";
  };
};

/** Profiles only the supplied Dataset rows, never an original file or a preview estimate. */
export function profileDatasetRows(
  source: Pick<DataSourceDefinition, "fields" | "rowCount">,
  rows: readonly DataRow[],
): DatasetQualityProfile {
  const columnCount = source.fields.length;
  const cellCount = rows.length * columnCount;
  const seen = new Set<string>();
  let nullCellCount = 0;
  let emptyRowCount = 0;
  let duplicateRowCount = 0;
  let nonNullBlankStringCount = 0;

  for (const row of rows) {
    // A zero-column result has no meaningful row identity or null denominator.
    if (columnCount === 0) break;
    let nullsInRow = 0;
    const values = source.fields.map((field) => {
      const value = row[field.name] ?? null;
      if (typeof value === "number" && !Number.isFinite(value)) {
        // JSON would turn these into null, silently corrupting duplicate statistics.
        throw new Error("统计输入包含非有限数值");
      }
      if (value === null) nullsInRow += 1;
      else if (typeof value === "string" && value.trim() === "") nonNullBlankStringCount += 1;
      return value;
    });
    nullCellCount += nullsInRow;
    if (nullsInRow === columnCount) emptyRowCount += 1;
    // JSON arrays retain scalar types and declared-column order, including nulls.
    const key = JSON.stringify(values);
    if (seen.has(key)) duplicateRowCount += 1;
    else seen.add(key);
  }

  return {
    version: 1,
    rowCount: rows.length,
    declaredRowCount: source.rowCount,
    rowCountMatchesSource: rows.length === source.rowCount,
    columnCount,
    cellCount,
    nullCellCount,
    nullRate: cellCount === 0 ? 0 : nullCellCount / cellCount,
    emptyRowCount,
    duplicateRowCount,
    nonNullBlankStringCount,
    rules: {
      scope: "current-dataset-rows",
      nulls: "null-or-missing",
      blankStrings: "not-null",
      duplicates: "typed-all-declared-fields-excluding-first",
      emptyRows: "all-declared-fields-null",
      denominator: "rows-times-declared-columns",
      originalFile: "not-measured",
    },
  };
}
