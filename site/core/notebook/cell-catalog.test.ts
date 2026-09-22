import { describe, expect, it } from "vitest";
import { notebookCellSchema, type NotebookCell, type NotebookArtifact } from "./definition";
import { adoptNotebookDraft } from "./client-state";
import { cellDependencies } from "./graph";
import { cellSearchSchema } from "@/core/harness/notebook-cell-search";
import { NOTEBOOK_CELL_KINDS, notebookCellCatalog, requiresSuccessfulNotebookTrial } from "./cell-catalog";
import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  isNotebookCellCapabilityEnabled,
  notebookCapabilityReason,
  type NotebookCapabilities,
} from "./capabilities";

const cells: NotebookCell[] = [
  { id: "data", kind: "data", title: "Data", sourceDataSourceId: "synthetic", outputName: "data_rows" },
  { id: "sql", kind: "sql", title: "SQL", inputCellIds: ["data"], outputName: "sql_rows", sql: "select * from data_rows" },
  { id: "python", kind: "python", title: "Python", inputCellIds: ["data"], fileNames: [], outputName: "python_rows", code: "python_rows = data_rows.copy()" },
  { id: "warehouseSql", kind: "warehouseSql", title: "Warehouse", connectionId: "synthetic", outputName: "warehouse_rows", sql: "select 1 as value" },
  { id: "semanticQuery", kind: "semanticQuery", title: "Semantic", inputCellId: "data", modelId: "synthetic", modelVersion: 1, dimensions: [], measures: ["total"], limit: 100, outputName: "semantic_rows" },
  { id: "transform", kind: "transform", title: "Transform", inputCellId: "data", outputName: "transform_rows", steps: [{ id: "limit", type: "limit", count: 10 }] },
  { id: "table", kind: "table", title: "Table", inputCellId: "data", columns: ["value"] },
  { id: "chart", kind: "chart", title: "Chart", inputCellId: "data", chartType: "bar", categoryField: "category", valueFields: ["value"] },
  { id: "text", kind: "text", title: "Text", markdown: "Synthetic note" },
  { id: "parameter", kind: "parameter", title: "Parameter", outputName: "parameter_rows", parameter: { type: "number", value: 10 } },
];

describe("Notebook closed Cell catalog", () => {
  it("covers precisely the canonical schema, preserving the existing CellSearch enum order", () => {
    expect(NOTEBOOK_CELL_KINDS).toEqual(["data", "sql", "python", "warehouseSql", "semanticQuery", "transform", "table", "chart", "text", "parameter"]);
    expect([...NOTEBOOK_CELL_KINDS].sort()).toEqual(notebookCellSchema.options.map((schema) => schema.shape.kind.value).sort());
    expect(Object.keys(notebookCellCatalog)).toEqual(NOTEBOOK_CELL_KINDS);
    for (const kind of NOTEBOOK_CELL_KINDS) expect(cellSearchSchema.parse({ kind }).kind).toBe(kind);
    expect(cellSearchSchema.safeParse({ kind: "unregistered" }).success).toBe(false);
    expect(Object.isFrozen(NOTEBOOK_CELL_KINDS)).toBe(true);
  });

  it("keeps stored Python definitions valid while gating only their runtime capability", () => {
    const disabled: NotebookCapabilities = {
      python: { enabled: false, reason: "Python capability disabled for this deployment" },
    };
    expect(notebookCellSchema.safeParse(cells.find((cell) => cell.kind === "python")).success).toBe(true);
    for (const kind of NOTEBOOK_CELL_KINDS) {
      expect(isNotebookCellCapabilityEnabled(DEFAULT_NOTEBOOK_CAPABILITIES, kind)).toBe(true);
      expect(isNotebookCellCapabilityEnabled(disabled, kind)).toBe(kind !== "python");
      expect(notebookCapabilityReason(disabled, kind)).toBe(kind === "python" ? disabled.python.reason : undefined);
    }
    expect(notebookCellCatalog.python.capability).toBe("python");
    expect(NOTEBOOK_CELL_KINDS.filter((kind) => notebookCellCatalog[kind].capability !== null)).toEqual(["python"]);
  });

  it.each(cells)("enforces the declared $kind trial requirement without granting runtime permissions", (cell) => {
    expect(notebookCellSchema.safeParse(cell).success).toBe(true);
    const required = ["sql", "python", "warehouseSql", "transform", "parameter"].includes(cell.kind);
    expect(requiresSuccessfulNotebookTrial(cell)).toBe(required);
    const selected = cell.kind === "data" ? [cell] : [cells[0], cell];
    const artifact: NotebookArtifact = { id: "draft", version: 1, status: "draft", name: "Synthetic",
      cells: selected, executionOrder: selected.map((item) => item.id),
      lineage: selected.map((item) => ({ cellId: item.id, dependsOn: cellDependencies(item) })),
      sourceDataSourceIds: ["synthetic"], createdAt: "2026-09-16T00:00:00.000Z", baseRevision: 0 };
    const document = { name: "Notebook", revision: 0, cells: [] };
    const before = structuredClone(artifact);
    if (required) {
      expect(() => adoptNotebookDraft(document, artifact)).toThrow("缺少成功试运行证据");
      expect(() => adoptNotebookDraft(document, { ...artifact, executionEvidence: {
        runId: "run", status: "failure", completedCellIds: [], summary: "failed",
      } })).toThrow("缺少成功试运行证据");
    } else expect(adoptNotebookDraft(document, artifact).cells).toEqual(selected);
    const accepted = adoptNotebookDraft(document, { ...artifact, executionEvidence: {
      runId: "run", status: "success", completedCellIds: selected.map((item) => item.id), summary: "passed",
    } });
    expect(accepted.cells).toEqual(selected);
    expect(accepted.revision).toBe(1);
    expect(artifact).toEqual(before);
  });
});
