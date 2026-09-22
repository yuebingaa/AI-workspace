import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotebookIcon, NotebookInsertToolbar } from "./NotebookChrome";
import { notebookCellSchema } from "@/core/notebook/definition";
import { notebookCellPresentation, notebookToolbarOrder } from "./cell-presentation";

const toolbarLabels = ["SQL", "Python", "数据库 SQL", "说明", "参数", "图表", "表格", "数据处理", "语义查询", "数据"];
const accessibleLabels = ["SQL", "Python", "数据库 SQL", "说明", "参数", "图表", "表格", "DataRecipe", "语义查询", "Data"];

describe("Notebook cell presentation compatibility", () => {
  it("covers each canonical kind exactly once without changing toolbar order", () => {
    const kinds = notebookCellSchema.options.map((schema) => schema.shape.kind.value);
    expect(Object.keys(notebookCellPresentation).sort()).toEqual([...kinds].sort());
    expect([...notebookToolbarOrder].sort()).toEqual([...kinds].sort());
    expect(notebookToolbarOrder).toEqual(["sql", "python", "warehouseSql", "text", "parameter", "chart", "table", "transform", "semanticQuery", "data"]);
    expect(notebookToolbarOrder.map((kind) => notebookCellPresentation[kind].toolbarLabel)).toEqual(toolbarLabels);
    expect(notebookToolbarOrder.map((kind) => notebookCellPresentation[kind].label)).toEqual(accessibleLabels);
    expect(notebookToolbarOrder.map((kind) => notebookCellPresentation[kind].sourceLabel))
      .toEqual(["SQL", "Python", "SQL", "配置", "配置", "配置", "配置", "处理规则", "配置", "配置"]);
  });
  it("adds the parameter entry while keeping the previous toolbar entries in relative order", () => {
    const html = renderToStaticMarkup(<NotebookInsertToolbar disabled={false} onAdd={() => {}} />);
    expect([...html.matchAll(/<span>(.*?)<\/span>/gu)].map((match) => match[1])).toEqual(toolbarLabels);
    expect([...html.matchAll(/aria-label="＋ (.*?)"/gu)].map((match) => match[1])).toEqual(accessibleLabels);
    expect(html.match(/<svg /gu)).toHaveLength(10);
    expect(html).not.toContain("disabled=");
    expect(html).toContain('title="用 pandas / NumPy 处理数据"');
    expect(html).toContain('title="用 DataRecipe 筛选、计算和汇总"');
  });
  it("disables every existing toolbar control when editing is locked", () => {
    const html = renderToStaticMarkup(<NotebookInsertToolbar disabled onAdd={() => {}} />);
    expect(html.match(/disabled=""/gu)).toHaveLength(10);
  });
  it("can remove a disabled capability from creation without changing the canonical catalog", () => {
    const available = notebookToolbarOrder.filter((kind) => kind !== "python");
    const html = renderToStaticMarkup(<NotebookInsertToolbar disabled={false} availableKinds={available} onAdd={() => {}} />);
    expect(html).not.toContain('aria-label="＋ Python"');
    expect(html.match(/<button /gu)).toHaveLength(9);
    expect(notebookToolbarOrder).toContain("python");
  });
  it("preserves the existing shared SQL/Python and data/connection icons", () => {
    const icon = (kind: Parameters<typeof NotebookIcon>[0]["kind"]) => renderToStaticMarkup(<NotebookIcon kind={kind} />);
    expect(icon("sql")).toBe(icon("python"));
    expect(icon("data")).toBe(icon("warehouseSql"));
    expect(icon("chart")).not.toBe(icon("table"));
    expect(icon("ask")).not.toBe(icon("upload"));
  });
});
