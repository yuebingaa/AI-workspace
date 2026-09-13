import type { DataSourceDefinition } from "@/core/models";
import type { HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import { executeDataRecipe } from "@/core/data/recipe-runtime";
import type { NotebookTable } from "./contracts";

/** Recipe consumes a complete upstream table, never its UI preview. */
export function executeNotebookTransform(
  cell: Extract<HarnessNotebookCell, { kind: "transform" }>, input: NotebookTable,
): NotebookTable {
  if (input.truncated) throw new Error("不能对截断结果执行 DataRecipe；请先在上游 SQL 中筛选或聚合");
  const source: DataSourceDefinition = {
    id: cell.inputCellId, name: cell.title, sourceType: "json", rowCount: input.rows.length,
    columnCount: input.fields.length, qualityScore: 100, updatedAt: new Date(0).toISOString(),
    fields: input.fields.map((field) => ({ ...field, aggregatable: field.type === "number",
      supportedAggregations: field.type === "number"
        ? ["none", "sum", "average", "count", "countDistinct", "min", "max"]
        : ["none", "count", "countDistinct", "min", "max"],
    })),
  };
  const result = executeDataRecipe({ id: cell.id, name: cell.title, sourceDatasetId: source.id,
    outputDatasetId: cell.outputName, status: "ready", steps: cell.steps }, source, input.rows);
  if (!result.success) throw new Error(`DataRecipe 步骤 ${result.failedStepId}：${result.error}`);
  return { fields: result.fields.map(({ name, label, type }) => ({ name, label, type })), rows: result.rows, truncated: false };
}
