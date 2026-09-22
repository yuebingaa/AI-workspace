import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { confirmNotebookCellSave, isNotebookCellSaveStale, prepareNotebookCellSave } from "./output-rename-review";

const parameter: Extract<NotebookCell, { kind: "parameter" }> = {
  id: "threshold", kind: "parameter", title: "门槛", outputName: "threshold", parameter: { type: "number", value: 5 },
};
const sql: Extract<NotebookCell, { kind: "sql" }> = {
  id: "query", kind: "sql", title: "查询", inputCellIds: [parameter.id], outputName: "query_result", sql: "SELECT value FROM threshold",
};
const document: NotebookDocument = { name: "合成文档", revision: 2, cells: [parameter, sql] };

describe("Notebook cell save review", () => {
  it("validates the entire candidate and leaves the saved document untouched pending confirmation", () => {
    const before = structuredClone(document);
    const edited = { ...parameter, outputName: "new_threshold" };
    const review = prepareNotebookCellSave(document, edited);
    expect(review.candidate).toEqual({ ...document, revision: 3, cells: [edited, sql] });
    expect(review.renames).toMatchObject([{ cellId: parameter.id, previousName: "threshold", nextName: "new_threshold" }]);
    expect(document).toEqual(before);
    expect(review.candidate.cells[1]).toEqual(sql);
  });
  it("does not request rename confirmation for edits that only change values or titles", () => {
    const review = prepareNotebookCellSave(document, { ...parameter, title: "新标题", parameter: { type: "number", value: 10 } });
    expect(review.renames).toEqual([]);
    expect(review.candidate.revision).toBe(3);
  });
  it("validates duplicate names before offering confirmation", () => {
    expect(() => prepareNotebookCellSave(document, { ...parameter, outputName: sql.outputName })).toThrow();
    expect(document.cells[0]).toEqual(parameter);
  });
  it("validates the proposed graph before offering confirmation", () => {
    expect(() => prepareNotebookCellSave(document, { ...sql, outputName: "new_query", inputCellIds: [sql.id] })).toThrow();
    expect(document.cells[1]).toEqual(sql);
  });
  it("rejects an edit whose cell no longer exists instead of silently dropping it", () => {
    expect(() => prepareNotebookCellSave(document, { ...parameter, id: "removed" })).toThrow("已不在当前文档");
  });
  it("accepts an equivalent current snapshot and does not mutate or increment the candidate again", () => {
    const review = prepareNotebookCellSave(document, { ...parameter, outputName: "new_threshold" });
    expect(isNotebookCellSaveStale(structuredClone(document), review)).toBe(false);
    expect(confirmNotebookCellSave(structuredClone(document), review)).toBe(review.candidate);
    expect(document.revision).toBe(2);
    expect(review.candidate.revision).toBe(3);
  });
  it.each([
    { ...document, revision: 3 },
    { ...document, name: "另一个文档" },
    { ...document, lastDraftId: "new_draft" },
    { ...document, cells: [sql, parameter] },
    { ...document, cells: [sql] },
    { ...document, cells: [{ ...parameter, parameter: { type: "number", value: 20 } }, sql] },
  ] satisfies NotebookDocument[])("rejects stale confirmation without overwriting revision or same-revision changes: %j", (current) => {
    const review = prepareNotebookCellSave(document, { ...parameter, outputName: "new_threshold" });
    const before = structuredClone(current);
    expect(isNotebookCellSaveStale(current, review)).toBe(true);
    expect(() => confirmNotebookCellSave(current, review)).toThrow("不会覆盖当前文档");
    expect(current).toEqual(before);
  });
});
