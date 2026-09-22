import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { confirmNotebookCellDeletion, isNotebookCellDeletionStale, prepareNotebookCellDeletion } from "./cell-deletion";
import { notebookCapabilityMutationIssue } from "./capabilities";

function parameter(id: string): Extract<NotebookCell, { kind: "parameter" }> {
  return { id, kind: "parameter", title: id, outputName: `${id}_rows`, parameter: { type: "number", value: 1 } };
}
function query(id: string, inputCellIds: string[]): Extract<NotebookCell, { kind: "sql" }> {
  return { id, kind: "sql", title: id, inputCellIds, outputName: `${id}_rows`, sql: "SELECT 1 AS value" };
}
function document(cells: NotebookCell[]): NotebookDocument {
  return { name: "Synthetic deletion review", revision: 4, lastDraftId: "previous_draft", cells };
}

describe("Notebook Cell cascade deletion review", () => {
  it("lists direct, transitive, diamond and text dependents once in document display order", () => {
    const current = document([
      { id: "text", kind: "text", title: "Summary", markdown: "{{total}}", references: [{ key: "total", cellId: "joined", field: "value" }] },
      { id: "chart", kind: "chart", title: "Chart", inputCellId: "joined", chartType: "bar", categoryField: "value", valueFields: ["value"] },
      query("joined", ["left", "right"]), query("right", ["target"]), query("independent", ["source"]),
      query("target", ["source"]), query("left", ["target"]), parameter("source"), parameter("unrelated"),
    ]);
    const before = structuredClone(current), review = prepareNotebookCellDeletion(current, "target");
    expect(review.targetId).toBe("target");
    expect(review.baseline).toBe(JSON.stringify(current));
    expect(review.cells).toEqual([
      { cellId: "text", title: "Summary", kind: "text", relation: "transitive" },
      { cellId: "chart", title: "Chart", kind: "chart", relation: "transitive" },
      { cellId: "joined", title: "joined", kind: "sql", outputName: "joined_rows", relation: "transitive" },
      { cellId: "right", title: "right", kind: "sql", outputName: "right_rows", relation: "direct" },
      { cellId: "target", title: "target", kind: "sql", outputName: "target_rows", relation: "target" },
      { cellId: "left", title: "left", kind: "sql", outputName: "left_rows", relation: "direct" },
    ]);
    expect(review.retainedCount).toBe(3);
    const next = confirmNotebookCellDeletion(current, review);
    expect(next.cells.map((cell) => cell.id)).toEqual(["independent", "source", "unrelated"]);
    expect(next).toMatchObject({ name: current.name, revision: 5, lastDraftId: "previous_draft" });
    expect(current).toEqual(before);
  });

  it("recognizes explicit text dependencies as direct without scanning static text or SQL source", () => {
    const current = document([parameter("target"), parameter("other"),
      { id: "bound_text", kind: "text", title: "Bound text", markdown: "{{value}}", references: [{ key: "value", cellId: "target", field: "value" }] },
      { id: "static_text", kind: "text", title: "target", markdown: "target target_rows" },
      { ...query("source_mention", ["other"]), sql: "SELECT 'target_rows' AS value FROM other_rows" },
    ]);
    const review = prepareNotebookCellDeletion(current, "target");
    expect(review.cells.map((cell) => [cell.cellId, cell.relation])).toEqual([["target", "target"], ["bound_text", "direct"]]);
    expect(review.retainedCount).toBe(3);
    expect(confirmNotebookCellDeletion(current, review).cells.map((cell) => cell.id)).toEqual(["other", "static_text", "source_mention"]);
  });

  it("deletes an isolated leaf while retaining its upstream and shared sibling branch", () => {
    const current = document([parameter("source"), query("target", ["source"]), query("sibling", ["source"])]);
    const review = prepareNotebookCellDeletion(current, "target");
    expect(review.cells.map((cell) => cell.cellId)).toEqual(["target"]);
    expect(review.retainedCount).toBe(2);
    expect(confirmNotebookCellDeletion(current, review).cells).toEqual([current.cells[0], current.cells[2]]);
  });

  it("allows deleting the only Cell or the whole dependent graph to an empty Notebook", () => {
    for (const current of [document([parameter("target")]), document([parameter("target"), query("child", ["target"])])]) {
      const review = prepareNotebookCellDeletion(current, "target");
      expect(review.retainedCount).toBe(0);
      expect(confirmNotebookCellDeletion(current, review)).toEqual({ ...current, revision: 5, cells: [] });
    }
  });

  it("distinguishes same-title Cells by stable ID", () => {
    const current = document([
      { ...parameter("first"), title: "同名步骤" }, { ...parameter("second"), title: "同名步骤" },
      { ...query("dependent", ["second"]), title: "同名步骤" },
    ]);
    const review = prepareNotebookCellDeletion(current, "second");
    expect(review.cells.map((cell) => cell.cellId)).toEqual(["second", "dependent"]);
    expect(confirmNotebookCellDeletion(current, review).cells).toEqual([current.cells[0]]);
  });

  it("rejects a missing target before review and again at confirmation", () => {
    const current = document([parameter("target")]), before = structuredClone(current);
    expect(() => prepareNotebookCellDeletion(current, "missing")).toThrow("已不在当前文档");
    const review = prepareNotebookCellDeletion(current, "target");
    expect(() => confirmNotebookCellDeletion(current, { ...review, targetId: "missing" })).toThrow("已不在当前文档");
    expect(current).toEqual(before);
  });

  it("accepts an equivalent snapshot and increments the revision exactly once", () => {
    const current = document([parameter("source"), query("target", ["source"])]), review = prepareNotebookCellDeletion(current, "target");
    const equivalent = structuredClone(current);
    expect(isNotebookCellDeletionStale(equivalent, review)).toBe(false);
    const next = confirmNotebookCellDeletion(equivalent, review);
    expect(next.revision).toBe(current.revision + 1);
    expect(() => confirmNotebookCellDeletion(next, review)).toThrow("确认已过期");
    expect(equivalent).toEqual(current);
  });

  it.each([
    ["revision", (current: NotebookDocument) => { current.revision += 1; }],
    ["document title", (current: NotebookDocument) => { current.name = "Changed title"; }],
    ["adopted draft", (current: NotebookDocument) => { current.lastDraftId = "another_draft"; }],
    ["Cell title at same revision", (current: NotebookDocument) => { current.cells[1].title = "Changed Cell title"; }],
    ["Cell definition at same revision", (current: NotebookDocument) => { current.cells[0] = { ...parameter("source"), parameter: { type: "number", value: 2 } }; }],
    ["display order at same revision", (current: NotebookDocument) => { current.cells.reverse(); }],
    ["new dependent at same revision", (current: NotebookDocument) => { current.cells.push(query("new_child", ["target"])); }],
    ["removed target", (current: NotebookDocument) => { current.cells.pop(); }],
    ["replaced document at same revision", (current: NotebookDocument) => { current.cells = [parameter("replacement")]; }],
  ] satisfies Array<[string, (current: NotebookDocument) => void]>)("rejects stale %s without modifying the current document", (_reason, change) => {
    const current = document([parameter("source"), query("target", ["source"])]), review = prepareNotebookCellDeletion(current, "target");
    change(current);
    const before = structuredClone(current);
    expect(isNotebookCellDeletionStale(current, review)).toBe(true);
    expect(() => confirmNotebookCellDeletion(current, review)).toThrow("未删除任何单元");
    expect(current).toEqual(before);
  });

  it("recomputes deletion from the document instead of trusting altered display metadata", () => {
    const current = document([parameter("source"), query("target", ["source"]), query("child", ["target"]), parameter("unrelated")]);
    const review = prepareNotebookCellDeletion(current, "target");
    review.cells = [{ cellId: "source", title: "Wrong display", kind: "parameter", relation: "target" }];
    review.retainedCount = 999;
    expect(confirmNotebookCellDeletion(current, review).cells.map((cell) => cell.id)).toEqual(["source", "unrelated"]);
    review.cells = [];
    expect(confirmNotebookCellDeletion(current, review).cells.map((cell) => cell.id)).toEqual(["source", "unrelated"]);
  });

  it("can repair a dangling dependency or cyclic draft by deleting the broken branch", () => {
    const dangling = document([query("target", ["missing"]), query("child", ["target"]), parameter("safe")]);
    const cyclic = document([query("target", ["child"]), query("child", ["target"]), parameter("safe")]);
    for (const current of [dangling, cyclic]) {
      const before = structuredClone(current), review = prepareNotebookCellDeletion(current, "target");
      expect(review.cells.map((cell) => cell.cellId)).toEqual(["target", "child"]);
      expect(confirmNotebookCellDeletion(current, review).cells).toEqual([parameter("safe")]);
      expect(current).toEqual(before);
    }
  });

  it("still validates every remaining Cell at confirmation and rejects a broken surviving branch", () => {
    const current = document([parameter("target"), query("broken_survivor", ["missing"])]), before = structuredClone(current);
    const review = prepareNotebookCellDeletion(current, "target");
    expect(() => confirmNotebookCellDeletion(current, review)).toThrow("依赖不存在");
    expect(current).toEqual(before);
  });

  it("allows explicit deletion of disabled Python while the automated mutation guard remains closed", () => {
    const python: NotebookCell = { id: "python", kind: "python", title: "Unavailable Python", inputCellIds: ["source"],
      fileNames: ["sales.csv"], outputName: "python_rows", code: 'python_rows = pd.read_csv(files["sales.csv"])' };
    const current = document([parameter("source"), python, query("child", ["python"]), query("independent", ["source"])]);
    const review = prepareNotebookCellDeletion(current, "python");
    expect(review.cells.map((cell) => cell.cellId)).toEqual(["python", "child"]);
    const next = confirmNotebookCellDeletion(current, review);
    expect(next.cells.map((cell) => cell.id)).toEqual(["source", "independent"]);
    expect(notebookCapabilityMutationIssue({ python: { enabled: false } }, current.cells, next.cells)).toContain("能力关闭期间不能移除");
    expect(current.cells[1]).toEqual(python);
  });

  it("is immutable and keeps detached review and result objects", () => {
    const current = document([parameter("source"), query("target", ["source"])]), before = structuredClone(current);
    for (const cell of current.cells) {
      if (cell.kind === "parameter") Object.freeze(cell.parameter);
      if (cell.kind === "sql") Object.freeze(cell.inputCellIds);
      Object.freeze(cell);
    }
    Object.freeze(current.cells); Object.freeze(current);
    const review = prepareNotebookCellDeletion(current, "target");
    review.cells[0].title = "Edited display";
    const next = confirmNotebookCellDeletion(current, review);
    next.cells[0].title = "Edited result";
    expect(current).toEqual(before);
    expect(prepareNotebookCellDeletion(current, "target").cells[0].title).toBe("target");
  });
});
