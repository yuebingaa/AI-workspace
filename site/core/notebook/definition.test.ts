import { describe, expect, it } from "vitest";
import {
  MAX_HARNESS_NOTEBOOK_CELLS, harnessNotebookArtifactSchema, harnessNotebookCellSchema, harnessNotebookDraftSchema,
  type HarnessNotebookArtifact, type HarnessNotebookCell,
} from "@/core/harness/notebook-contracts";
import { MAX_NOTEBOOK_CELLS, notebookArtifactSchema, notebookCellSchema, notebookDraftSchema, type NotebookCell } from "./definition";
import { NOTEBOOK_LIMITS, notebookDocumentSchema, notebookLayerSchema } from "./contracts";
import { adoptNotebookDraft } from "./client-state";

const cells: NotebookCell[] = [
  { id: "data", kind: "data", title: "输入", sourceDataSourceId: "sales", outputName: "sales" },
  { id: "sql", kind: "sql", title: "查询", inputCellIds: ["data"], outputName: "queried", sql: "SELECT * FROM sales" },
  { id: "warehouse", kind: "warehouseSql", title: "远端", connectionId: "readonly", outputName: "remote", sql: "SELECT 1 AS amount" },
  { id: "recipe", kind: "transform", title: "配方", inputCellId: "sql", outputName: "cleaned", steps: [{ id: "keep", type: "selectFields", fields: ["amount"] }] },
  { id: "semantic", kind: "semanticQuery", title: "语义", inputCellId: "data", modelId: "model", modelVersion: 1, dimensions: ["region"], measures: ["revenue"], limit: 100, outputName: "metrics" },
  { id: "table", kind: "table", title: "表格", inputCellId: "recipe", columns: ["amount"] },
  { id: "chart", kind: "chart", title: "图表", inputCellId: "semantic", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  { id: "text", kind: "text", title: "说明", markdown: "合成测试定义" },
];

describe("Notebook definition ownership and compatibility", () => {
  it("keeps the legacy Harness exports as the exact same schemas and limit", () => {
    expect(harnessNotebookCellSchema).toBe(notebookCellSchema);
    expect(harnessNotebookDraftSchema).toBe(notebookDraftSchema);
    expect(harnessNotebookArtifactSchema).toBe(notebookArtifactSchema);
    expect(MAX_HARNESS_NOTEBOOK_CELLS).toBe(MAX_NOTEBOOK_CELLS);
    expect(NOTEBOOK_LIMITS.cells).toBe(30);
    const legacy: HarnessNotebookCell[] = cells;
    expect(legacy).toBe(cells);
  });

  it.each(cells)("preserves the saved $kind cell format", (cell) => {
    const stored: unknown = JSON.parse(JSON.stringify(cell));
    expect(notebookCellSchema.parse(stored)).toEqual(cell);
    expect(notebookDocumentSchema.parse({ name: "Notebook", revision: 4, cells: [stored] }).cells).toEqual([cell]);
  });

  it("retains trimming, strict keys, duplicate checks and the existing limits", () => {
    expect(notebookCellSchema.parse({ ...cells[0], title: "  输入  " }).title).toBe("输入");
    expect(notebookCellSchema.safeParse({ ...cells[0], unknown: true }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...cells[0], outputName: "bad-name" }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...cells[1], inputCellIds: ["data", "data"] }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...cells[4], measures: ["revenue", "revenue"] }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...cells[6], valueFields: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...cells[7], markdown: "x".repeat(4001) }).success).toBe(false);
    expect(notebookDraftSchema.safeParse({ name: "draft", cells: [] }).success).toBe(false);
    expect(notebookDraftSchema.safeParse({ name: "draft", cells: Array.from({ length: 31 }, () => cells[0]) }).success).toBe(false);
    expect(notebookDocumentSchema.parse({ name: "空白", revision: 0, cells: [] }).cells).toEqual([]);
  });

  it("adopts an old serialized artifact with the same evidence and revision checks", () => {
    const artifact: HarnessNotebookArtifact = {
      id: "notebook_saved", version: 1, status: "draft", name: "已保存草稿", cells,
      executionOrder: cells.map((cell) => cell.id), lineage: cells.map((cell) => ({ cellId: cell.id, dependsOn: [] })),
      sourceDataSourceIds: ["sales"], connectionIds: ["readonly"], createdAt: "2026-09-14T00:00:00.000Z",
      baseRevision: 2, analysisPlanId: "plan_saved",
      executionEvidence: { runId: "run_saved", status: "success", completedCellIds: cells.map((cell) => cell.id), summary: "已试运行" },
    };
    const restored = notebookArtifactSchema.parse(JSON.parse(JSON.stringify(artifact)));
    expect(restored).toEqual(artifact);
    const previous = notebookDocumentSchema.parse({ name: "旧定义", revision: 2, cells: [] });
    const adopted = adoptNotebookDraft(previous, restored);
    expect(adopted).toMatchObject({ revision: 3, lastDraftId: artifact.id, cells });
    expect(notebookLayerSchema.parse(JSON.parse(JSON.stringify({ page_home: adopted })))).toEqual({ page_home: adopted });
    expect(() => adoptNotebookDraft(adopted, restored)).toThrow("已经采用");
    expect(() => adoptNotebookDraft({ ...previous, revision: 3 }, restored)).toThrow("未覆盖已有步骤");
    expect(() => adoptNotebookDraft(previous, { ...restored, executionEvidence: undefined })).toThrow("试运行证据");
  });
});
