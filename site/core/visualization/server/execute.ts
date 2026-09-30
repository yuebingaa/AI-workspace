import { z } from "zod";
import { dataTableSchema, type DataTable } from "@/core/datasets/table-contracts";
import { parseChartDefinitionV2, visualizationDataKey } from "../definition";
import { visualizationCapabilities as limits } from "../capabilities";
import { compileVisualization, visualizationQueryTable } from "../plan";
import { assertVisualTableValues, materializedVisualizationSchema, visualizationDataHash, visualizationHash, type MaterializedVisualization, type VisualizationIdentity } from "../result";

/** Structurally compatible with NotebookQueryExecutor; composition owns the actual engine. */
export type VisualizationQuery = (sql: string, tables: ReturnType<typeof visualizationQueryTable>[], signal?: AbortSignal) => Promise<DataTable>;
const sourceReferenceSchema = z.object({
  runId: z.string().min(1).max(160), cellId: z.string().min(1).max(120), resultId: z.string().min(1).max(240),
  revision: z.number().int().nonnegative(), accessMode: z.enum(["user", "ai"]),
  complete: z.literal(true), rowCount: z.number().int().nonnegative().max(limits.maxInputRows), dataSignature: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type VisualizationSourceReference = z.infer<typeof sourceReferenceSchema>;
export interface VisualizationExecutionInput {
  definition: unknown; table: DataTable; reference: VisualizationSourceReference;
  expected: VisualizationIdentity & { inputCellId: string }; signal?: AbortSignal;
}

/** Request-local full-table computation. The host must authorize and resolve input;
 * this module has no result lookup, model calls, credentials, storage or HTTP.
 */
export async function executeVisualization(input: VisualizationExecutionInput, query: VisualizationQuery): Promise<MaterializedVisualization> {
  input.signal?.throwIfAborted();
  const definition = parseChartDefinitionV2(input.definition), reference = sourceReferenceSchema.safeParse(input.reference);
  if (!reference.success) throw Error("图表输入缺少完整的当前运行引用。");
  const ref = reference.data, expected = input.expected;
  if (ref.runId !== expected.runId || ref.revision !== expected.revision || ref.accessMode !== expected.accessMode
    || ref.cellId !== expected.inputCellId || ref.resultId !== `${ref.runId}:${ref.cellId}`) throw Error("图表输入不是本次已授权运行的结果。");
  if (input.table.rows.length > limits.maxInputRows || new TextEncoder().encode(JSON.stringify(input.table)).byteLength > limits.maxInputBytes) throw Error("图表输入超过当前计算范围，请先在上游筛选或汇总。");
  const parsedTable = dataTableSchema.safeParse(input.table);
  if (!parsedTable.success || parsedTable.data.truncated || ref.rowCount !== parsedTable.data.rows.length) throw Error("图表必须使用完整上游，不能把展示切片作为正式输入。");
  const table = parsedTable.data;
  if (await visualizationHash(JSON.stringify(table)) !== ref.dataSignature) throw Error("图表输入内容与运行引用不一致。");
  const plan = compileVisualization(definition, table), source = visualizationQueryTable(plan, table);
  // Reuse the caller's existing bounded local SQL engine, exactly once. No JS aggregation.
  input.signal?.throwIfAborted();
  const output = await query(plan.sql, [source], input.signal);
  input.signal?.throwIfAborted(); // A late response cannot become a successful cancelled run.
  const validated = dataTableSchema.safeParse(output);
  if (!validated.success) throw Error("图表查询返回了无效表格。");
  const computed = validated.data;
  if (computed.truncated || computed.rows.length > limits.maxResultRows) throw Error("图表结果超过展示范围，未生成正式图；请明确设置 Top N 或增加聚合。");
  if (computed.fields.length !== plan.fields.length || computed.fields.some((field, index) => field.name !== plan.fields[index].name || field.type !== plan.fields[index].type)) throw Error("图表结果类型不匹配或精度超限；不会静默转换 decimal / bigint。");
  assertVisualTableValues(computed, definition.encoding.y, plan.numericMode);
  const visualTable: DataTable = { fields: plan.fields, rows: computed.rows, truncated: false };
  const result: MaterializedVisualization = { table: visualTable, visualResult: {
    schemaVersion: 2, runId: ref.runId, revision: ref.revision, accessMode: ref.accessMode,
    dataDefinitionKey: visualizationDataKey(definition), dataDefinitionHash: await visualizationDataHash(definition), tableHash: await visualizationHash(JSON.stringify(visualTable)),
    inputResultIds: [ref.resultId], inputRowCount: table.rows.length, outputRowCount: visualTable.rows.length,
    fields: plan.fields, mode: definition.data.mode, numericMode: plan.numericMode,
    inputScope: "complete", explicitLimit: definition.data.limit ?? null,
  } };
  input.signal?.throwIfAborted();
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > limits.maxResultBytes) throw Error("图表结果超过 2 MiB，请缩小结果范围。");
  return materializedVisualizationSchema.parse(result);
}
