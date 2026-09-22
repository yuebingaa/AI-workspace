import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import { notebookFileReferences } from "./file-references";

function python(id: string, fileNames = ["sales.csv"], inputCellIds: string[] = []): Extract<NotebookCell, { kind: "python" }> {
  return { id, kind: "python", title: "读取原件", fileNames, inputCellIds, outputName: `${id}_rows`, code: "result = pd.DataFrame()" };
}
function sql(id: string, inputCellIds: string[]): Extract<NotebookCell, { kind: "sql" }> {
  return { id, kind: "sql", title: id, inputCellIds, outputName: `${id}_rows`, sql: "SELECT 1 AS value" };
}

describe("Notebook explicit file references", () => {
  it("supports legacy, empty and unrelated Notebook definitions", () => {
    expect(notebookFileReferences(undefined, "sales.csv")).toEqual([]);
    expect(notebookFileReferences({}, "sales.csv")).toEqual([]);
    expect(notebookFileReferences({ page: { name: "Empty", revision: 0, cells: [] } }, "sales.csv")).toEqual([]);
    expect(notebookFileReferences({ page: { name: "Other", revision: 1, cells: [python("other", ["other.csv"])] } }, "sales.csv")).toEqual([]);
  });

  it("matches complete file names exactly, including case", () => {
    const notebooks = { page: { name: "Sales", revision: 1, cells: [
      python("exact"), python("different_case", ["Sales.csv"]), python("prefix", ["sales.csv.csv"]), python("unicode", ["销售.csv"]),
    ] } };
    expect(notebookFileReferences(notebooks, "sales.csv").map((reference) => reference.cellId)).toEqual(["exact"]);
    expect(notebookFileReferences(notebooks, "Sales.csv").map((reference) => reference.cellId)).toEqual(["different_case"]);
    expect(notebookFileReferences(notebooks, "销售.csv").map((reference) => reference.cellId)).toEqual(["unicode"]);
    expect(notebookFileReferences(notebooks, "sales")).toEqual([]);
  });

  it("returns one reference per Cell even if its file name appears twice", () => {
    expect(notebookFileReferences({ page: { name: "Repeated", revision: 1, cells: [python("query", ["sales.csv", "sales.csv"])] } }, "sales.csv"))
      .toEqual([{ pageId: "page", notebookName: "Repeated", cellId: "query", cellTitle: "读取原件", downstreamCount: 0 }]);
  });

  it("returns all cross-page references with stable identities and display order", () => {
    const notebooks = Object.fromEntries(["page_first", "page_second", "page_legacy"].map((pageId) => [pageId,
      { name: "同名 Notebook", revision: 1, cells: Array.from({ length: 4 }, (_, index) => python(`query_${index}`)) },
    ]));
    const references = notebookFileReferences(notebooks, "sales.csv");
    expect(references).toHaveLength(12);
    expect(references).toEqual(["page_first", "page_second", "page_legacy"].flatMap((pageId) =>
      Array.from({ length: 4 }, (_, index) => ({ pageId, notebookName: "同名 Notebook", cellId: `query_${index}`,
        cellTitle: "读取原件", downstreamCount: 0 }))));
  });

  it("does not scan code, text or a same-named Data source", () => {
    const cells: NotebookCell[] = [
      { ...python("undeclared", []), code: 'result = pd.read_csv(files["sales.csv"])' },
      { id: "source", kind: "data", title: "sales.csv", sourceDataSourceId: "sales_source", outputName: "sales" },
      { ...sql("query", ["source"]), sql: "SELECT 'sales.csv' AS file_name FROM sales" },
      { id: "text", kind: "text", title: "sales.csv", markdown: 'fileNames: ["sales.csv"]' },
      { id: "parameter", kind: "parameter", title: "File name", outputName: "file_name", parameter: { type: "text", value: "sales.csv" } },
    ];
    expect(notebookFileReferences({ page: { name: "sales.csv", revision: 1, cells } }, "sales.csv")).toEqual([]);
  });

  it("counts unique transitive dependents through diamonds and explicit text references, not the Python Cell itself", () => {
    const cells: NotebookCell[] = [
      { id: "summary", kind: "text", title: "Summary", markdown: "Total {{total}}",
        references: [{ key: "total", cellId: "joined", field: "value" }] },
      { id: "table", kind: "table", title: "Table", inputCellId: "joined", columns: ["value"] },
      { id: "chart", kind: "chart", title: "Chart", inputCellId: "joined", chartType: "bar", categoryField: "value", valueFields: ["value"] },
      sql("joined", ["left", "right"]), sql("left", ["original"]), sql("right", ["original"]), python("original"),
      { id: "independent", kind: "parameter", title: "Independent", outputName: "input_value", parameter: { type: "number", value: 1 } },
      sql("unrelated", ["independent"]),
    ];
    expect(notebookFileReferences({ page: { name: "Diamond", revision: 1, cells } }, "sales.csv"))
      .toEqual([{ pageId: "page", notebookName: "Diamond", cellId: "original", cellTitle: "读取原件", downstreamCount: 6 }]);
  });

  it("counts each referencing Python independently even when their descendants overlap", () => {
    const cells: NotebookCell[] = [python("one"), python("two"), sql("joined", ["one", "two"]),
      { id: "summary", kind: "text", title: "Summary", markdown: "{{total}}", references: [{ key: "total", cellId: "joined", field: "value" }] },
    ];
    expect(notebookFileReferences({ page: { name: "Overlap", revision: 1, cells } }, "sales.csv").map((reference) => [reference.cellId, reference.downstreamCount]))
      .toEqual([["one", 2], ["two", 2]]);
  });

  it("includes a referencing downstream Python in its upstream count without double counting itself", () => {
    const cells: NotebookCell[] = [python("upstream"), python("downstream", ["sales.csv"], ["upstream"]),
      { id: "table", kind: "table", title: "Table", inputCellId: "downstream", columns: ["value"] },
    ];
    expect(notebookFileReferences({ page: { name: "Chain", revision: 1, cells } }, "sales.csv").map((reference) => [reference.cellId, reference.downstreamCount]))
      .toEqual([["upstream", 2], ["downstream", 1]]);
  });

  it("does not mutate definitions or return shared mutable objects", () => {
    const cell = python("original"), dependent = sql("child", [cell.id]);
    const notebook = { name: "Original", revision: 4, cells: [cell, dependent] };
    const notebooks = { page: notebook }, before = structuredClone(notebooks);
    Object.freeze(cell.fileNames); Object.freeze(cell.inputCellIds); Object.freeze(cell);
    Object.freeze(dependent.inputCellIds); Object.freeze(dependent);
    Object.freeze(notebook.cells); Object.freeze(notebook); Object.freeze(notebooks);
    const references = notebookFileReferences(notebooks, "sales.csv");
    references[0].notebookName = "Changed"; references[0].cellTitle = "Changed"; references[0].downstreamCount = 99;
    expect(notebooks).toEqual(before);
    expect(notebookFileReferences(notebooks, "sales.csv")[0]).toMatchObject({ notebookName: "Original", cellTitle: "读取原件", downstreamCount: 1 });
  });
});
