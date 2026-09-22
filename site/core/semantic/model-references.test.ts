import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import { semanticModelReferences } from "./model-references";
import { semanticFixture } from "./test-fixture";

function semanticCell(modelId: string, id: string, modelVersion = 1): Extract<NotebookCell, { kind: "semanticQuery" }> {
  return { id, kind: "semanticQuery", title: "销售查询", inputCellId: "source", modelId, modelVersion,
    dimensions: [], measures: ["revenue"], limit: 100, outputName: `result_${id}` };
}

describe("语义模型的已保存 Notebook 引用", () => {
  it("兼容没有 Notebook 的旧产品和空定义", () => {
    expect(semanticModelReferences({}, "sales_model")).toEqual([]);
    expect(semanticModelReferences({ notebooks: {} }, "sales_model")).toEqual([]);
    expect(semanticModelReferences({ notebooks: { page_home: { name: "空白", revision: 0, cells: [] } } }, "sales_model")).toEqual([]);
  });

  it("跨页完整返回所有引用，保留同名 Notebook 和同名 Cell 的稳定标识及顺序", () => {
    const notebooks = {
      page_one: { name: "同名分析", revision: 1, cells: [semanticCell("sales_model", "first"), semanticCell("sales_model", "second")] },
      page_two: { name: "同名分析", revision: 3, cells: [semanticCell("sales_model", "first")] },
      page_legacy: { name: "旧页分析", revision: 0, cells: [semanticCell("sales_model", "fourth"), semanticCell("sales_model", "fifth")] },
    };
    expect(semanticModelReferences({ notebooks }, "sales_model")).toEqual([
      { pageId: "page_one", notebookName: "同名分析", cellId: "first", cellTitle: "销售查询" },
      { pageId: "page_one", notebookName: "同名分析", cellId: "second", cellTitle: "销售查询" },
      { pageId: "page_two", notebookName: "同名分析", cellId: "first", cellTitle: "销售查询" },
      { pageId: "page_legacy", notebookName: "旧页分析", cellId: "fourth", cellTitle: "销售查询" },
      { pageId: "page_legacy", notebookName: "旧页分析", cellId: "fifth", cellTitle: "销售查询" },
    ]);
  });

  it("只精确匹配模型 ID，同名不同 ID、大小写及前缀都不合并", () => {
    const { product, model } = semanticFixture();
    product.semanticLayer = { models: [model, { ...model, id: "sales_model_copy" }], selectedByWorkspace: {} };
    product.notebooks = { page_home: { name: "销售分析", revision: 1, cells: [
      semanticCell(model.id, "exact"), semanticCell("sales_model_copy", "same_name"),
      semanticCell("Sales_model", "different_case"), semanticCell("sales", "prefix"),
    ] } };
    expect(semanticModelReferences(product, model.id).map((reference) => reference.cellId)).toEqual(["exact"]);
    expect(semanticModelReferences(product, "sales_model_copy").map((reference) => reference.cellId)).toEqual(["same_name"]);
    expect(semanticModelReferences(product, model.name)).toEqual([]);
  });

  it("无需模型定义，引用旧版、当前版或未来版本均按相同 ID 保留", () => {
    const notebooks = { page_home: { name: "版本分析", revision: 1,
      cells: [semanticCell("sales_model", "old", 1), semanticCell("sales_model", "current", 2), semanticCell("sales_model", "future", 99)] } };
    expect(semanticModelReferences({ notebooks }, "sales_model").map((reference) => reference.cellId)).toEqual(["old", "current", "future"]);
  });

  it("仅选择模型不建立 Notebook 引用", () => {
    const { product, model } = semanticFixture();
    product.semanticLayer = { models: [model], selectedByWorkspace: { page_home: model.id, page_other: model.id } };
    expect(semanticModelReferences(product, model.id)).toEqual([]);
  });

  it("其他所有 Cell 类型中的同名标识、SQL、Python 和文本不建立模型引用", () => {
    const modelId = "sales_model";
    const cells: NotebookCell[] = [
      { id: "source", kind: "data", title: modelId, sourceDataSourceId: modelId, outputName: "source_rows" },
      { id: "sql", kind: "sql", title: modelId, inputCellIds: ["source"], outputName: "sql_rows", sql: `SELECT '${modelId}' AS modelId FROM source_rows` },
      { id: "warehouse", kind: "warehouseSql", title: modelId, connectionId: modelId, outputName: "warehouse_rows", sql: `SELECT '${modelId}'` },
      { id: "python", kind: "python", title: modelId, inputCellIds: [], fileNames: [`${modelId}.csv`], outputName: "python_rows", code: `modelId = '${modelId}'` },
      { id: "transform", kind: "transform", title: modelId, inputCellId: modelId, outputName: "transformed", steps: [{ id: "limit", type: "limit", count: 1 }] },
      { id: "table", kind: "table", title: modelId, inputCellId: modelId, columns: [modelId] },
      { id: "chart", kind: "chart", title: modelId, inputCellId: modelId, chartType: "bar", categoryField: modelId, valueFields: [modelId] },
      { id: "text", kind: "text", title: modelId, markdown: `{"kind":"semanticQuery","modelId":"${modelId}"}` },
      { id: "parameter", kind: "parameter", title: modelId, outputName: "parameter_value", parameter: { type: "text", value: modelId } },
    ];
    expect(semanticModelReferences({ notebooks: { page_home: { name: "非语义单元", revision: 1, cells } } }, modelId)).toEqual([]);
  });

  it("不修改定义，返回的引用信息也不共享可变对象", () => {
    const cell = semanticCell("sales_model", "query");
    const notebook = { name: "原始分析", revision: 4, cells: [cell] };
    const input = { notebooks: { page_home: notebook } };
    const original = structuredClone(input);
    Object.freeze(cell);
    Object.freeze(notebook.cells);
    Object.freeze(notebook);
    Object.freeze(input.notebooks);
    Object.freeze(input);
    const references = semanticModelReferences(input, "sales_model");
    references[0].notebookName = "调用方修改";
    references[0].cellTitle = "调用方修改标题";
    references.pop();
    expect(input).toEqual(original);
    expect(semanticModelReferences(input, "sales_model")).toEqual([
      { pageId: "page_home", notebookName: "原始分析", cellId: "query", cellTitle: "销售查询" },
    ]);
  });
});
