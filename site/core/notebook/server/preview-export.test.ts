import { parse } from "csv-parse/sync";
import { describe, expect, it, vi } from "vitest";
import { createTableCsv } from "@/core/exports/table-csv";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookDocument } from "../contracts";
import { notebookResultAvailability } from "../result-availability";
import { notebookOrderedPreview } from "../table-preview";
import { runNotebook } from "./runtime";

const seed: NotebookDocument["cells"][number] = { id: "seed", kind: "parameter", title: "合成输入", outputName: "seed",
  parameter: { type: "number", value: 1 } };

describe("real execution to preview-only CSV boundary", () => {
  it("exports only 100 source / 1000 transform preview rows while retaining a complete 1324-row receipt", async () => {
    const { source } = semanticFixture();
    const rows = Array.from({ length: 1324 }, (_, index) => ({ region: `Region ${index}`, amount: index }));
    const document: NotebookDocument = { name: "合成预览", revision: 1, cells: [
      { id: "data", kind: "data", title: "源数据", sourceDataSourceId: source.id, outputName: "records" },
      { id: "transform", kind: "transform", title: "完整转换", inputCellId: "data", outputName: "copied",
        steps: [{ id: "all", type: "limit", count: 1324 }] },
    ] };
    const query = vi.fn(), log = vi.fn();
    const run = await runNotebook({ document, sources: [{ source, rows }], query, log });
    expect(run.status).toBe("success");
    const before = structuredClone(run);
    const inputCsv = createTableCsv(run.cells[0].table!);
    const output = run.cells[1];
    const scope = notebookResultAvailability(document.cells[1], output,
      { runId: run.runId, revision: run.revision, accessMode: "user" });
    expect(scope).toMatchObject({ completeness: "complete", knownRowCount: 1324, previewRowCount: 1000, previewOnly: true });
    const ordered = notebookOrderedPreview(output.table!, { fieldName: "amount", direction: "descending" });
    const outputCsv = createTableCsv({ ...output.table!, rows: ordered.rows });
    expect(inputCsv.rowCount).toBe(100);
    expect(outputCsv.rowCount).toBe(1000);
    expect(parse(inputCsv.content, { bom: true, columns: true })).toHaveLength(100);
    const records = parse(outputCsv.content, { bom: true, columns: true });
    expect(records).toHaveLength(1000);
    expect(records[0]).toEqual({ region: "Region 999", amount: "999" });
    expect(records.at(-1)).toEqual({ region: "Region 0", amount: "0" });
    expect(run).toEqual(before);
    expect(query).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not promote a truly truncated SQL preview into a complete download or execute a second query", async () => {
    const document: NotebookDocument = { name: "截断查询", revision: 1, cells: [seed,
      { id: "sql", kind: "sql", title: "超预览行数", inputCellIds: [seed.id], outputName: "large",
        sql: "SELECT i::DOUBLE AS value FROM range(1324) t(i) ORDER BY i" },
    ] };
    const log = vi.fn();
    const run = await runNotebook({ document, sources: [], log });
    expect(run.status).toBe("success");
    expect(run.cells[1].resultRef).toMatchObject({ complete: false, rowCount: 1000 });
    const csv = createTableCsv(run.cells[1].table!);
    expect(parse(csv.content, { bom: true, columns: true })).toHaveLength(1000);
    expect(csv.rowCount).toBe(1000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(run.cells[1].table!.truncated).toBe(true);
  }, 15000);

  it("preserves exact strings from SQL without interpreting formulas, dates or large numeric text", async () => {
    const document: NotebookDocument = { name: "文本预览", revision: 1, cells: [seed,
      { id: "sql", kind: "sql", title: "文本", inputCellIds: [seed.id], outputName: "strings",
        sql: "SELECT '00123' AS code, '900719925474099312345' AS big, '2026-01-02' AS day, '=1+1' AS formula, -7::DOUBLE AS amount, TRUE AS active, NULL::VARCHAR AS empty" },
    ] };
    const run = await runNotebook({ document, sources: [], log: vi.fn() });
    expect(run.status).toBe("success");
    const csv = createTableCsv(run.cells[1].table!);
    expect(parse(csv.content, { bom: true, columns: true })).toEqual([
      { code: "00123", big: "900719925474099312345", day: "2026-01-02", formula: "'=1+1", amount: "-7", active: "true", empty: "" },
    ]);
    expect(csv.protectedCellCount).toBe(1);
    expect(run.cells[1].table!.rows[0].formula).toBe("=1+1");
  }, 15000);

  it("keeps a successful zero-row SQL export as a header-only file, not a failed query", async () => {
    const document: NotebookDocument = { name: "空预览", revision: 1, cells: [seed,
      { id: "sql", kind: "sql", title: "空结果", inputCellIds: [seed.id], outputName: "empty",
        sql: "SELECT 1::DOUBLE AS amount WHERE false" },
    ] };
    const run = await runNotebook({ document, sources: [], log: vi.fn() });
    expect(run.status).toBe("success");
    const csv = createTableCsv(run.cells[1].table!);
    expect(csv).toMatchObject({ content: '\uFEFF"amount"\r\n', rowCount: 0, columnCount: 1, protectedCellCount: 0 });
  }, 15000);
});
