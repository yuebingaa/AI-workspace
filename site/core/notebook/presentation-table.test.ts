import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import type { NotebookTable } from "./contracts";
import { projectPresentationTable } from "./presentation-table";

const input: NotebookTable = { fields: [
  { name: "category", label: "分类", type: "string" }, { name: "value", label: "指标", type: "number" },
  { name: "exact", label: "精确值", type: "string" }, { name: "enabled", label: "有效", type: "boolean" },
], rows: [{ category: "A", value: 0, exact: "9007199254740993.00001", enabled: false },
  { category: null, value: null, exact: "0.00000000000000001", enabled: true }], truncated: false };
const chart: Extract<NotebookCell, { kind: "chart" }> = { id: "chart", kind: "chart", title: "图表",
  inputCellId: "source", chartType: "bar", categoryField: "category", valueFields: ["value"] };

describe("Notebook presentation table projection", () => {
  it("preserves source metadata order, requested row property order, scalars and input immutability", () => {
    const before = structuredClone(input);
    const cell: Extract<NotebookCell, { kind: "table" }> = { id: "table", kind: "table", title: "展示",
      inputCellId: "source", columns: ["enabled", "exact", "value"] };
    const output = projectPresentationTable(cell, input);
    expect(output.fields.map((field) => field.name)).toEqual(["value", "exact", "enabled"]);
    expect(Object.keys(output.rows[0])).toEqual(["enabled", "exact", "value"]);
    expect(output.rows).toEqual([
      { enabled: false, exact: "9007199254740993.00001", value: 0 },
      { enabled: true, exact: "0.00000000000000001", value: null },
    ]);
    expect(output.truncated).toBe(false);
    expect(input).toEqual(before);
    expect(output.rows).not.toBe(input.rows);
  });

  it.each([false, true])("retains completeness and all rows before the execution display limit (truncated=%s)", (truncated) => {
    const source = { ...input, rows: Array.from({ length: 1_324 }, () => input.rows[0]), truncated };
    const output = projectPresentationTable(chart, source);
    expect(output.rows).toHaveLength(1_324);
    expect(output.truncated).toBe(truncated);
    expect(output.fields.map((field) => field.name)).toEqual(["category", "value"]);
  });

  it("keeps empty results, null numeric cells and a category reused as a value", () => {
    expect(projectPresentationTable(chart, { ...input, rows: [] })).toMatchObject({ rows: [], truncated: false });
    const output = projectPresentationTable({ ...chart, categoryField: "value" }, input);
    expect(output.fields.map((field) => field.name)).toEqual(["value"]);
    expect(output.rows).toEqual([{ value: 0 }, { value: null }]);
  });

  it("rejects missing fields before numeric type checks", () => {
    expect(() => projectPresentationTable({ ...chart, categoryField: "missing", valueFields: ["exact"] }, input))
      .toThrow("上游字段已变化，请重新选择表格或图表字段");
    expect(() => projectPresentationTable({ id: "table", kind: "table", title: "表格", inputCellId: "source", columns: ["missing"] }, input))
      .toThrow("上游字段已变化，请重新选择表格或图表字段");
  });

  it("does not reinterpret precise strings as chart numbers", () => {
    expect(() => projectPresentationTable({ ...chart, valueFields: ["exact"] }, input))
      .toThrow("图表数值列必须为数字；高精度字符串请在 SQL 中显式转换后使用");
  });

  it.each(["bar", "line", "area", "pie", "donut"] as const)("preserves %s negative and non-negative behavior", (chartType) => {
    const negative = { ...input, rows: [{ category: "adjustment", value: -1, exact: "-1", enabled: true }] };
    const project = () => projectPresentationTable({ ...chart, chartType }, negative);
    if (chartType === "pie" || chartType === "donut") expect(project).toThrow("饼图或环形图不能表示负数，请选择柱状图或折线图");
    else expect(project().rows).toEqual([{ category: "adjustment", value: -1 }]);
    expect(projectPresentationTable({ ...chart, chartType }, input).rows).toEqual([{ category: "A", value: 0 }, { category: null, value: null }]);
  });
});
