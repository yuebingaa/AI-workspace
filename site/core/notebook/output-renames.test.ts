import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { notebookFingerprint } from "./client-state";
import { updateNotebook } from "./graph";
import { analyzeNotebookOutputRenames } from "./output-renames";

function parameter(id = "threshold", outputName = id): Extract<NotebookCell, { kind: "parameter" }> {
  return { id, kind: "parameter", title: `参数 ${id}`, outputName, parameter: { type: "number", value: 5 } };
}
function sql(id: string, inputCellIds: string[]): Extract<NotebookCell, { kind: "sql" }> {
  return { id, kind: "sql", title: `查询 ${id}`, outputName: id, inputCellIds, sql: "SELECT value FROM threshold" };
}
function python(id: string, inputCellIds: string[]): Extract<NotebookCell, { kind: "python" }> {
  return { id, kind: "python", title: `Python ${id}`, outputName: id, inputCellIds, fileNames: [], code: `${id} = threshold.copy()` };
}
function chart(id: string, inputCellId: string): Extract<NotebookCell, { kind: "chart" }> {
  return { id, kind: "chart", title: `图表 ${id}`, inputCellId, chartType: "bar", categoryField: "value", valueFields: ["value"] };
}
function document(cells: NotebookCell[]): NotebookDocument {
  return { name: "输出名检查合成样例", revision: 0, cells };
}
function renamed(cells: readonly NotebookCell[], id: string, outputName: string): NotebookCell[] {
  return cells.map((cell) => cell.id === id && "outputName" in cell ? { ...cell, outputName } : cell);
}

describe("Notebook output rename impact", () => {
  it("reports stable ID renames in final presentation order, without parsing source", () => {
    const cells = [parameter("a"), parameter("b")];
    const next = [parameter("b", "second"), parameter("a", "first")];
    expect(analyzeNotebookOutputRenames(cells, next)).toEqual([
      { cellId: "b", title: "参数 b", previousName: "b", nextName: "second", preservedReferences: [], codeChecks: [], affectedCellIds: ["b"] },
      { cellId: "a", title: "参数 a", previousName: "a", nextName: "first", preservedReferences: [], codeChecks: [], affectedCellIds: ["a"] },
    ]);
  });

  it("ignores title/value/code-only changes, unchanged cells, and added or removed outputs", () => {
    const cells = [parameter(), parameter("removed"), sql("query", ["threshold"])];
    const next = [{ ...parameter(), title: "标题变化", parameter: { type: "number" as const, value: 9 } },
      { ...sql("query", ["threshold"]), sql: "SELECT value + 1 FROM threshold" }, parameter("added")];
    expect(analyzeNotebookOutputRenames(cells, next)).toEqual([]);
  });

  it("does not identify a new stable ID as a rename of an old output", () => {
    expect(analyzeNotebookOutputRenames([parameter("old", "value")], [parameter("new", "renamed")])).toEqual([]);
    expect(analyzeNotebookOutputRenames([parameter("old", "value")], [parameter("new", "value")])).toEqual([]);
  });

  it("requires both versions to have outputs, including kind replacements", () => {
    const note: NotebookCell = { id: "same", kind: "text", title: "说明", markdown: "无输出" };
    expect(analyzeNotebookOutputRenames([note], [parameter("same")])).toEqual([]);
    expect(analyzeNotebookOutputRenames([parameter("same")], [note])).toEqual([]);
    expect(analyzeNotebookOutputRenames([parameter("same", "before")], [sql("same", [])]))
      .toMatchObject([{ cellId: "same", previousName: "before", nextName: "same" }]);
  });

  it("preserves existing structured ID bindings across all direct consumer kinds", () => {
    const cells: NotebookCell[] = [parameter(), sql("query", ["threshold"]), python("frame", ["threshold"]),
      { id: "transform", kind: "transform", title: "规则", inputCellId: "threshold", outputName: "changed", steps: [{ id: "limit", type: "limit", count: 10 }] },
      { id: "table", kind: "table", title: "表格", inputCellId: "threshold", columns: ["value"] },
      chart("chart", "threshold"),
      { id: "semantic", kind: "semanticQuery", title: "语义", inputCellId: "threshold", modelId: "model", modelVersion: 1, dimensions: [], measures: ["count"], limit: 10, outputName: "semantic" }];
    const [impact] = analyzeNotebookOutputRenames(cells, renamed(cells, "threshold", "minimum"));
    expect(impact.preservedReferences).toEqual(cells.slice(1).map((cell) => ({ cellId: cell.id, title: cell.title, kind: cell.kind })));
    expect(impact.codeChecks).toEqual([
      { cellId: "query", title: "查询 query", kind: "sql", reason: "input-name" },
      { cellId: "frame", title: "Python frame", kind: "python", reason: "input-name" },
    ]);
    expect(impact.affectedCellIds).toEqual(cells.map((cell) => cell.id));
  });

  it("does not call new or rebound dependencies preserved, but includes their code checks", () => {
    const cells = [parameter(), parameter("other"), sql("existing", ["threshold"]), sql("rebound", ["other"])];
    const next = [...renamed(cells, "threshold", "minimum").map((cell) => cell.id === "rebound" ? sql("rebound", ["threshold"]) : cell),
      sql("added", ["threshold"])];
    const [impact] = analyzeNotebookOutputRenames(cells, next);
    expect(impact.preservedReferences.map((cell) => cell.cellId)).toEqual(["existing"]);
    expect(impact.codeChecks.map((cell) => cell.cellId)).toEqual(["existing", "rebound", "added"]);
  });

  it("excludes removed or disconnected consumers from the final impact", () => {
    const cells = [parameter(), parameter("other"), sql("removed", ["threshold"]), sql("rebound", ["threshold"])];
    const next = [parameter("threshold", "minimum"), parameter("other"), sql("rebound", ["other"])];
    expect(analyzeNotebookOutputRenames(cells, next)).toEqual([
      { cellId: "threshold", title: "参数 threshold", previousName: "threshold", nextName: "minimum", preservedReferences: [], codeChecks: [], affectedCellIds: ["threshold"] },
    ]);
  });

  it("lists transitive descendants as affected, not as direct code checks", () => {
    const cells = [chart("visual", "joined"), sql("joined", ["left", "right"]), sql("right", ["threshold"]),
      parameter("unrelated"), python("left", ["threshold"]), parameter()];
    const [impact] = analyzeNotebookOutputRenames(cells, renamed(cells, "threshold", "minimum"));
    expect(impact.affectedCellIds).toEqual(["visual", "joined", "right", "left", "threshold"]);
    expect(impact.preservedReferences.map((cell) => cell.cellId)).toEqual(["right", "left"]);
    expect(impact.codeChecks.map((cell) => cell.cellId)).toEqual(["right", "left"]);
  });

  it("checks a Python cell's own assigned output and its declared code consumers", () => {
    const cells = [parameter(), python("frame", ["threshold"]), sql("query", ["frame"]), chart("visual", "frame")];
    const [impact] = analyzeNotebookOutputRenames(cells, renamed(cells, "frame", "filtered"));
    expect(impact.codeChecks).toEqual([
      { cellId: "frame", title: "Python frame", kind: "python", reason: "python-output" },
      { cellId: "query", title: "查询 query", kind: "sql", reason: "input-name" },
    ]);
    expect(impact.affectedCellIds).toEqual(["frame", "query", "visual"]);
  });

  it("does not flag a SQL cell's own query when only its output label changes", () => {
    const cells = [parameter(), sql("query", ["threshold"]), chart("visual", "query")];
    const [impact] = analyzeNotebookOutputRenames(cells, renamed(cells, "query", "renamed_query"));
    expect(impact.codeChecks).toEqual([]);
    expect(impact.preservedReferences).toEqual([{ cellId: "visual", title: "图表 visual", kind: "chart" }]);
  });

  it("keeps conservative code checks when the same batch edits code to use the new name", () => {
    const cells = [parameter(), sql("query", ["threshold"]), python("frame", ["threshold"])];
    const next = [parameter("threshold", "minimum"), { ...sql("query", ["threshold"]), sql: "SELECT value FROM minimum" },
      { ...python("frame", ["threshold"]), code: "frame = minimum.copy()" }];
    expect(analyzeNotebookOutputRenames(cells, next)[0].codeChecks.map((cell) => cell.cellId)).toEqual(["query", "frame"]);
  });

  it("ignores matching free text without a declared input, including warehouse SQL", () => {
    const cells: NotebookCell[] = [parameter(), parameter("other"), sql("unbound", ["other"]),
      { id: "warehouse", kind: "warehouseSql", title: "数据库查询", connectionId: "connection", outputName: "remote", sql: "SELECT * FROM threshold" },
      { id: "note", kind: "text", title: "说明", markdown: "threshold" }];
    const [impact] = analyzeNotebookOutputRenames(cells, renamed(cells, "threshold", "minimum"));
    expect(impact.codeChecks).toEqual([]);
    expect(impact.affectedCellIds).toEqual(["threshold"]);
  });

  it("never changes SQL/Python literals, comments, aliases, input values, or either document", () => {
    const cells = [parameter(), { ...sql("query", ["threshold"]), sql: "SELECT 'threshold' AS threshold_text FROM threshold AS t -- threshold" },
      { ...python("frame", ["threshold"]), code: "# threshold\nname = 'threshold'\nframe = threshold.copy()" }];
    const next = renamed(cells, "threshold", "minimum");
    const before = structuredClone(cells);
    const nextBefore = structuredClone(next);
    for (const cell of [...cells, ...next]) Object.freeze(cell);
    analyzeNotebookOutputRenames(Object.freeze(cells), Object.freeze(next));
    expect(cells).toEqual(before);
    expect(next).toEqual(nextBefore);
  });

  it("returns detached metadata without source, parameter values or mutable cell objects", () => {
    const cells = [parameter(), sql("query", ["threshold"])];
    const next = renamed(cells, "threshold", "minimum");
    const result = analyzeNotebookOutputRenames(cells, next);
    const copy = structuredClone(result);
    next[1].title = "changed later";
    expect(result).toEqual(copy);
    expect(JSON.stringify(result)).not.toContain("SELECT");
    expect(JSON.stringify(result)).not.toContain("parameter");
  });

  it("leaves name collision rejection to the existing atomic final-document validation", () => {
    const current = document([parameter("a"), parameter("b")]);
    const next = renamed(current.cells, "a", "b");
    expect(analyzeNotebookOutputRenames(current.cells, next)).toHaveLength(1);
    expect(() => updateNotebook(current, next)).toThrow("输出名称重复：b");
    expect(current.revision).toBe(0);
    expect(current.cells.map((cell) => "outputName" in cell ? cell.outputName : "")).toEqual(["a", "b"]);
  });

  it("supports a legal simultaneous name exchange with final graph validation", () => {
    const current = document([parameter("a"), parameter("b"), sql("query", ["a", "b"])]);
    const next = renamed(renamed(current.cells, "a", "b"), "b", "a");
    const committed = updateNotebook(current, next);
    expect(committed.revision).toBe(1);
    expect(analyzeNotebookOutputRenames(current.cells, committed.cells).map(({ cellId, previousName, nextName }) => ({ cellId, previousName, nextName })))
      .toEqual([{ cellId: "a", previousName: "a", nextName: "b" }, { cellId: "b", previousName: "b", nextName: "a" }]);
    expect(committed.cells[2]).toEqual(current.cells[2]);
  });

  it("uses existing fingerprints to invalidate only the renamed branch, without another state store", () => {
    const current = document([parameter(), sql("query", ["threshold"]), chart("visual", "query"), parameter("other")]);
    const next = updateNotebook(current, renamed(current.cells, "threshold", "minimum"));
    for (const id of ["threshold", "query", "visual"]) {
      expect(notebookFingerprint(next, id, [], [])).not.toBe(notebookFingerprint(current, id, [], []));
    }
    expect(notebookFingerprint(next, "other", [], [])).toBe(notebookFingerprint(current, "other", [], []));
  });
});
