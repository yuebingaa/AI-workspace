import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "./contracts";
import { MAX_NOTEBOOK_CONTEXT_SELECTION, normalizeNotebookContextSelection,
  notebookContextSelectedCellIdsSchema, notebookContextSelectionMetadata } from "./context-selection";

function document(): NotebookDocument {
  return { name: "选择元数据", revision: 4, cells: [
    { id: "threshold", kind: "parameter", title: "阈值", outputName: "limit_value", parameter: { type: "text", value: "PRIVATE_VALUE" } },
    { id: "query", kind: "sql", title: "计算", outputName: "totals", inputCellIds: ["threshold"], sql: "SELECT 'PRIVATE_SQL' FROM limit_value" },
    { id: "note", kind: "text", title: "说明", markdown: "PRIVATE_MARKDOWN" },
  ] };
}

describe("Notebook 当前请求选择", () => {
  it("只投影 ID、种类、标题和声明输出，不投影参数值、源码或结果", () => {
    const doc = document(), before = structuredClone(doc), ids = ["query", "threshold", "note"];
    expect(notebookContextSelectionMetadata(doc, ids)).toEqual({ status: "declared", cells: [
      { id: "query", kind: "sql", title: "计算", outputName: "totals" },
      { id: "threshold", kind: "parameter", title: "阈值", outputName: "limit_value" },
      { id: "note", kind: "text", title: "说明" },
    ] });
    expect(doc).toEqual(before); expect(ids).toEqual(["query", "threshold", "note"]);
  });
  it("稳定 ID 在改名后重新获得当前标签而不是保留旧值副本", () => {
    const doc = document(); doc.cells[0].title = "新阈值";
    expect(notebookContextSelectionMetadata(doc, ["threshold"]).cells[0].title).toBe("新阈值");
  });
  it("UI 过滤删除项和重复项并保留选择顺序，不修改输入", () => {
    const ids = ["note", "deleted", "threshold", "note", "../../outside", "constructor"];
    expect(normalizeNotebookContextSelection(document(), ids)).toEqual(["note", "threshold"]);
    expect(ids).toHaveLength(6);
  });
  it("UI 和严格 Schema 共用十个选择上限，但请求不会静默截断", () => {
    const doc: NotebookDocument = { name: "合成", revision: 0, cells: Array.from({ length: 12 }, (_, i) =>
      ({ id: `cell_${i}`, kind: "text", title: `说明 ${i}`, markdown: "" })) };
    const ids = doc.cells.map((cell) => cell.id);
    expect(normalizeNotebookContextSelection(doc, ids)).toEqual(ids.slice(0, MAX_NOTEBOOK_CONTEXT_SELECTION));
    expect(() => notebookContextSelectionMetadata(doc, ids)).toThrow();
  });
  it("空选择没有伪造任何声明", () => {
    expect(notebookContextSelectionMetadata(document(), [])).toEqual({ status: "declared", cells: [] });
  });
  it.each(["deleted", "constructor", "toString"])("未知 ID %s 不能被原型或其他文档补全", (id) => {
    expect(() => notebookContextSelectionMetadata(document(), [id])).toThrow("不存在");
  });
  it.each(["", "123", "../cell", "cell.x", "x".repeat(121), "中文"])("沿用单元标识符限制：%s", (id) => {
    expect(notebookContextSelectedCellIdsSchema.safeParse([id]).success).toBe(false);
  });
  it("重复 ID 请求拒绝，包括经原 ID 规范化后相同的值", () => {
    expect(notebookContextSelectedCellIdsSchema.safeParse(["threshold", " threshold "]).success).toBe(false);
  });
});
