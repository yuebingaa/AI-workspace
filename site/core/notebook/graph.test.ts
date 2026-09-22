import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { affectedCells, cellsToRun, notebookDependencyCandidates, updateNotebook, validateNotebook } from "./graph";

function data(id: string): Extract<NotebookCell, { kind: "data" }> {
  return { id, kind: "data", title: id, outputName: id, sourceDataSourceId: "source" };
}
function query(id: string, inputCellIds: string[]): NotebookCell {
  return { id, kind: "sql", title: id, outputName: id, inputCellIds, sql: "SELECT 1 AS value" };
}
function chart(id: string, inputCellId: string): NotebookCell {
  return { id, kind: "chart", title: id, inputCellId, chartType: "bar", categoryField: "name", valueFields: ["value"] };
}
function document(cells: NotebookCell[]): NotebookDocument {
  return { name: "合成依赖测试", revision: 0, cells };
}

describe("Notebook display order and dependency scheduling", () => {
  it("validates forward references without reordering the displayed or supplied document", () => {
    const doc = document([chart("visual", "summary"), query("summary", ["source"]), data("source")]);
    const original = structuredClone(doc);
    expect(validateNotebook(doc).map((cell) => cell.id)).toEqual(["visual", "summary", "source"]);
    expect(cellsToRun(doc).map((cell) => cell.id)).toEqual(["source", "summary", "visual"]);
    expect(doc).toEqual(original);
  });
  it("preserves every old legal document order including independent text and source branches", () => {
    const cells: NotebookCell[] = [data("a"), query("b", ["a"]),
      { id: "note", kind: "text", title: "说明", markdown: "合成说明" }, data("other"), chart("c", "b")];
    expect(cellsToRun(document(cells))).toEqual(cells);
    expect(validateNotebook(document([]))).toEqual([]);
    expect(cellsToRun(document([]))).toEqual([]);
  });
  it("always chooses the first currently ready cell in display order, not a FIFO batch", () => {
    const doc = document([query("dependent", ["parent"]), data("parent"), data("independent")]);
    expect(cellsToRun(doc).map((cell) => cell.id)).toEqual(["parent", "dependent", "independent"]);
  });
  it("runs a reversed diamond ancestor closure exactly once and excludes unrelated cells", () => {
    const doc = document([chart("visual", "joined"), query("joined", ["left", "right"]),
      query("right", ["root"]), data("unrelated"), query("left", ["root"]), data("root")]);
    expect(cellsToRun(doc, "visual").map((cell) => cell.id)).toEqual(["root", "right", "left", "joined", "visual"]);
    expect(cellsToRun(doc, "root").map((cell) => cell.id)).toEqual(["root"]);
  });
  it("keeps whole-document validation even when the requested branch is valid", () => {
    const doc = document([data("valid"), query("broken", ["missing"])]);
    expect(() => cellsToRun(doc, "valid")).toThrow(/依赖不存在.*missing/u);
    expect(() => cellsToRun(document([data("valid")]), "unknown")).toThrow("要运行的单元不存在");
  });
  it("reports duplicate IDs and output names before creating a scheduling graph", () => {
    expect(() => validateNotebook(document([data("a"), data("a")]))).toThrow("单元 ID 重复：a");
    expect(() => validateNotebook(document([data("a"), { ...data("b"), outputName: "a" }])))
      .toThrow("输出名称重复：a");
  });
  it("distinguishes absent dependencies from cells without a declared table output", () => {
    expect(() => validateNotebook(document([query("query", ["missing"])]))).toThrow(/依赖不存在.*missing/u);
    const note: NotebookCell = { id: "note", kind: "text", title: "说明", markdown: "不是输出" };
    for (const unavailable of [note, chart("visual", "source")]) {
      expect(() => validateNotebook(document([data("source"), unavailable, query("query", [unavailable.id])])))
        .toThrow(/依赖未提供表格输出/u);
    }
  });
  it("rejects a self-reference explicitly", () => {
    expect(() => validateNotebook(document([query("self", ["self"])]))).toThrow(/不能依赖自身.*self/u);
  });
  it("rejects a cycle and dependent blocked cells without calling any executor", () => {
    const doc = document([data("independent"), query("a", ["b"]), query("b", ["a"]), chart("dependent", "b")]);
    expect(() => validateNotebook(doc)).toThrow(/循环依赖/u);
    expect(() => cellsToRun(doc, "independent")).toThrow(/循环依赖/u);
  });
  it("preserves existing strict rejection of repeated declared inputs", () => {
    expect(() => validateNotebook(document([data("a"), query("query", ["a", "a"])]))).toThrow("输入单元不能重复");
  });
  it("updates only the document revision when accepting a new display order", () => {
    const doc = { ...document([data("a"), query("b", ["a"])]), lastDraftId: "accepted" };
    const reordered = updateNotebook(doc, [...doc.cells].reverse());
    expect(reordered).toEqual({ ...doc, revision: 1, cells: [...doc.cells].reverse() });
    expect(cellsToRun(reordered).map((cell) => cell.id)).toEqual(["a", "b"]);
    expect(doc.revision).toBe(0);
  });
});

describe("Notebook dependency choices and invalidation", () => {
  it("offers outputs before or after a cell while excluding itself and every descendant", () => {
    const cells = [query("grandchild", ["child"]), query("child", ["current"]), data("before"),
      query("current", ["after"]), chart("view", "current"), data("after")];
    expect(notebookDependencyCandidates(cells, "current").map((cell) => cell.id)).toEqual(["before", "after"]);
    expect([...affectedCells(cells, ["current"])]).toEqual(["current", "child", "view", "grandchild"]);
  });
  it("handles deletion and incomplete drafts without requiring them to validate", () => {
    const cells = [query("child", ["removed"]), query("grandchild", ["child"]), data("safe")];
    expect([...affectedCells(cells, ["removed"])]).toEqual(["removed", "child", "grandchild"]);
    expect(notebookDependencyCandidates(cells, "removed").map((cell) => cell.id)).toEqual(["safe"]);
    expect(notebookDependencyCandidates(cells, "new").map((cell) => cell.id)).toEqual(["child", "grandchild", "safe"]);
  });
  it("terminates on an in-progress cyclic draft and never offers a descendant as an input", () => {
    const cells = [query("a", ["b"]), query("b", ["a"]), data("safe")];
    expect([...affectedCells(cells, ["a"])]).toEqual(["a", "b"]);
    expect(notebookDependencyCandidates(cells, "a").map((cell) => cell.id)).toEqual(["safe"]);
  });
});
