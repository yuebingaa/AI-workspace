import { z } from "zod";
import { dataFieldSchema, dataTableSchema, type DataTable } from "@/core/datasets/table-contracts";
import { visualizationDataKey, type ChartDefinitionV2 } from "./definition";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = { runId: z.string().min(1).max(160), revision: z.number().int().nonnegative(), accessMode: z.enum(["user", "ai"]) };
export const visualResultMetadataSchema = z.object({
  schemaVersion: z.literal(2), ...identity, dataDefinitionKey: z.string().min(1).max(500_000), dataDefinitionHash: hash, tableHash: hash,
  inputResultIds: z.array(z.string().min(1).max(240)).length(1), inputRowCount: z.number().int().nonnegative().max(50_000),
  outputRowCount: z.number().int().nonnegative().max(1000), fields: z.array(dataFieldSchema).min(2).max(5),
  mode: z.enum(["rows", "aggregate"]), numericMode: z.enum(["safe-integer", "float64"]),
  inputScope: z.literal("complete"), explicitLimit: z.number().int().min(1).max(1000).nullable(),
}).strict();
export const materializedVisualizationSchema = z.object({
  table: dataTableSchema.extend({ rows: dataTableSchema.shape.rows.max(1000) }),
  visualResult: visualResultMetadataSchema,
}).strict().refine(value => !value.table.truncated && value.table.rows.length === value.visualResult.outputRowCount
  && JSON.stringify(value.table.fields) === JSON.stringify(value.visualResult.fields), "图表结果不完整或元数据不一致");
export type MaterializedVisualization = z.infer<typeof materializedVisualizationSchema>;
export type VisualizationIdentity = Pick<MaterializedVisualization["visualResult"], "runId" | "revision" | "accessMode">;

export async function visualizationHash(serialized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const visualizationDataHash = (definition: ChartDefinitionV2) => visualizationHash(visualizationDataKey(definition));

export function assertVisualTableValues(table: DataTable, measure: string, numericMode: "safe-integer" | "float64") {
  if (table.fields.find(field => field.name === measure)?.type !== "number") throw Error("图表指标必须保持数值类型。");
  for (const row of table.rows) {
    if (Object.keys(row).length !== table.fields.length || table.fields.some(field => !Object.hasOwn(row, field.name))) throw Error("图表结果列与定义不一致。");
    for (const field of table.fields) {
      const value = row[field.name];
      if (value === null) continue;
      if (field.type === "date" ? !z.iso.date().safeParse(value).success : typeof value !== field.type) throw Error("图表结果值与字段类型不一致。");
      if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
        || (field.name === measure && numericMode === "safe-integer" && !Number.isSafeInteger(value)))) throw Error("图表计算结果超过安全数值范围，请保留精确表格。");
    }
  }
}

/** Consistency check, not authorization. Expected identity must be captured by the host. */
export async function parseMaterializedVisualization(raw: unknown, definition: ChartDefinitionV2,
  expected: VisualizationIdentity & { inputResultId: string; inputRowCount: number }): Promise<MaterializedVisualization> {
  const parsed = materializedVisualizationSchema.safeParse(raw);
  if (!parsed.success) throw Error("图表计算结果格式无效或不完整。");
  const result = parsed.data, metadata = result.visualResult;
  if (metadata.runId !== expected.runId || metadata.revision !== expected.revision || metadata.accessMode !== expected.accessMode
    || metadata.inputResultIds[0] !== expected.inputResultId || metadata.inputRowCount !== expected.inputRowCount
    || metadata.mode !== definition.data.mode || metadata.explicitLimit !== (definition.data.limit ?? null)
    || metadata.dataDefinitionKey !== visualizationDataKey(definition) || metadata.dataDefinitionHash !== await visualizationDataHash(definition)
    || metadata.tableHash !== await visualizationHash(JSON.stringify(result.table))) throw Error("图表结果与本次定义或运行不一致，不能作为正式结果。");
  const expectedNames = [...definition.data.dimensions, ...definition.data.measures].map(field => field.as);
  if (JSON.stringify(result.table.fields.map(field => field.name)) !== JSON.stringify(expectedNames)) throw Error("图表结果字段与定义不一致。");
  assertVisualTableValues(result.table, definition.encoding.y, metadata.numericMode);
  return result;
}
