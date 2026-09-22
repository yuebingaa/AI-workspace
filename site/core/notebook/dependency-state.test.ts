import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "./contracts";
import { moveNotebookCell, notebookFingerprint } from "./client-state";
import { affectedCells, updateNotebook } from "./graph";

function document(): NotebookDocument {
  return { name: "显示与执行", revision: 3, lastDraftId: "accepted", cells: [
    { id: "data", kind: "data", title: "原始数据", sourceDataSourceId: "synthetic", outputName: "raw" },
    { id: "query", kind: "sql", title: "查询", inputCellIds: ["data"], outputName: "totals", sql: "SELECT * FROM raw" },
    { id: "chart", kind: "chart", title: "图", inputCellId: "query", chartType: "bar", categoryField: "region", valueFields: ["amount"] },
    { id: "note", kind: "text", title: "独立说明", markdown: "不参与查询" },
  ] };
}
describe("重排后的结果新鲜度", () => {
  it("纯线性依赖重排保留内容指纹，但递增文档版本和保留采用标记", () => {
    const before = document();
    const moved = moveNotebookCell(moveNotebookCell(before, "chart", -1), "chart", -1);
    expect(moved.cells.map((cell) => cell.id)).toEqual(["chart", "data", "query", "note"]);
    expect(moved.revision).toBe(5);
    expect(moved.lastDraftId).toBe("accepted");
    expect(notebookFingerprint(moved, "chart", [], [])).toBe(notebookFingerprint(before, "chart", [], []));
    expect(before.cells[0].id).toBe("data");
  });
  it("编辑后方上游只使相关指纹失效，不使独立说明失效", () => {
    const before = moveNotebookCell(document(), "query", -1);
    const after = updateNotebook(before, before.cells.map((cell) => cell.kind === "data" ? { ...cell, sourceDataSourceId: "new_source" } : cell));
    expect(notebookFingerprint(after, "chart", [], [])).not.toBe(notebookFingerprint(before, "chart", [], []));
    expect(notebookFingerprint(after, "note", [], [])).toBe(notebookFingerprint(before, "note", [], []));
    expect([...affectedCells(after.cells, ["data"])].sort()).toEqual(["chart", "data", "query"]);
  });
  it("非法循环编辑不修改原文档、版本、采用标记或可用结果指纹", () => {
    const before = document(), copy = structuredClone(before);
    const fingerprint = notebookFingerprint(before, "chart", [], []);
    expect(() => updateNotebook(before, before.cells.map((cell) => cell.kind === "sql" ? { ...cell, inputCellIds: ["query"] } : cell))).toThrow("不能依赖自身");
    expect(before).toEqual(copy);
    expect(notebookFingerprint(before, "chart", [], [])).toBe(fingerprint);
  });
});
