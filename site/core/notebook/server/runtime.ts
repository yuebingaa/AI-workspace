import { createHash, randomUUID } from "node:crypto";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { executeDataRecipe } from "@/core/data";
import { compileSemanticQuery, validateSemanticModel } from "@/core/semantic/model";
import type { SemanticModel } from "@/core/semantic/contracts";
import { cellDependencies, cellsToRun } from "../graph";
import { NOTEBOOK_LIMITS, notebookRunSchema, type NotebookCellRun, type NotebookDocument, type NotebookRun, type NotebookTable } from "../contracts";
import { executeNotebookSql } from "./query-engine";
import { configuredSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { z } from "zod";
import { executeNotebookTransform } from "../transform";

export interface NotebookSource { source: DataSourceDefinition; rows: DataRow[] }
const logEntrySchema = z.object({ id: z.string(), taskId: z.string(), userId: z.string(), connectionId: z.string().max(100),
  cellId: z.string(), startedAt: z.string(), durationMs: z.number(), status: z.string(), sql: z.string().max(10_000),
  sourceIds: z.array(z.string()), returnedRows: z.number(), truncated: z.boolean(), bytesScanned: z.null() }).strict();
const logSchema = z.object({ version: z.literal(1), queries: z.array(logEntrySchema).max(100) }).strict();
// Plain protected local receipts, no UI/account/audit platform. No result rows or credentials.
function recordQuery(entry: z.infer<typeof logEntrySchema>) {
  const adapter = configuredSnapshotAdapter("notebook-query-log.json", logSchema, 2 * 1024 * 1024);
  if (!adapter) return;
  const existing = adapter.load();
  adapter.save({ version: 1, queries: [...(existing?.queries ?? []), entry].slice(-100) });
}
function aiSafeSource(input: NotebookSource, forAi: boolean, aliases: Map<string, string>): NotebookSource {
  if (!forAi) return input;
  if (input.source.aiAccessPolicy === "pending") throw new Error(`请先确认“${input.source.name}”的 AI 敏感字段处理方式`);
  const sensitive = new Set(input.source.fields.filter((field) => field.sensitiveCategories?.length).map((field) => field.name));
  return { source: input.source, rows: input.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!sensitive.has(key) || value === null) return [key, value];
    if (input.source.aiAccessPolicy === "masked" && typeof value === "string") {
      if (!aliases.has(value)) aliases.set(value, `匿名_${aliases.size + 1}`);
      return [key, aliases.get(value)!];
    }
    return [key, null];
  }))) };
}
export async function runNotebook(input: {
  document: NotebookDocument; sources: NotebookSource[]; semanticModels?: SemanticModel[];
  targetCellId?: string; signal?: AbortSignal; forAi?: boolean; userId?: string; taskId?: string;
  query?: typeof executeNotebookSql; log?: typeof recordQuery;
  connectionQuery?: (connectionId: string, sql: string, signal: AbortSignal) => Promise<NotebookTable>;
}): Promise<NotebookRun> {
  const cells = cellsToRun(input.document, input.targetCellId);
  const runId = `notebook_run_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const aliases = new Map<string, string>();
  const sources = input.sources.map((source) => aiSafeSource(source, input.forAi ?? false, aliases));
  const dataSignature = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), NOTEBOOK_LIMITS.runTimeoutMs);
  const results: NotebookCellRun[] = [];
  const outputs = new Map<string, NotebookTable>();
  let totalBytes = 0;
  try {
    for (const cell of cells) {
      const start = performance.now();
      if (cellDependencies(cell).some((id) => results.find((item) => item.cellId === id)?.status !== "success")) {
        results.push({ cellId: cell.id, status: "blocked", durationMs: 0, error: "上游步骤失败，未使用旧结果继续计算" }); continue;
      }
      let table: NotebookTable | undefined;
      let queryId: string | undefined;
      let error: string | undefined;
      try {
        if (signal.aborted) throw new Error("Notebook 运行已取消或超时");
        if (cell.kind === "data") {
          const stored = sources.find((item) => item.source.id === cell.sourceDataSourceId);
          if (!stored) throw new Error("源数据不存在或已过期，请重新导入并重新选择数据源");
          table = { fields: stored.source.fields.map(({ name, label, type }) => ({ name, label, type })), rows: stored.rows, truncated: false };
        } else if (cell.kind === "warehouseSql") {
          if (!input.connectionQuery) throw new Error("数据库连接运行时未配置");
          queryId = `query_${randomUUID()}`;
          table = await input.connectionQuery(cell.connectionId, cell.sql, signal);
        } else if (cell.kind === "sql") {
          queryId = `query_${randomUUID()}`;
          const tables = cell.inputCellIds.map((id) => {
            const previous = cells.find((item) => item.id === id)!;
            const output = outputs.get(id)!;
            if (output.truncated) throw new Error("上游结果超过 1000 行，不能对截断结果继续计算；请把聚合或筛选合并到上游 SQL");
            return { ...output, name: "outputName" in previous ? previous.outputName : "", truncated: undefined };
          }).map(({ name, fields, rows }) => ({ name, fields, rows }));
          table = await (input.query ?? executeNotebookSql)(cell.sql, tables, signal);
        } else if (cell.kind === "semanticQuery") {
          const model = input.semanticModels?.find((item) => item.id === cell.modelId && item.version === cell.modelVersion);
          const upstream = cells.find((item) => item.id === cell.inputCellId);
          if (!model || upstream?.kind !== "data" || upstream.sourceDataSourceId !== model.sourceDatasetId) throw new Error("语义模型版本或原始数据已变化，请重新选择模型");
          const source = sources.find((item) => item.source.id === model.sourceDatasetId)!;
          validateSemanticModel(model, source.source);
          const recipe = compileSemanticQuery(model, source.source, { dimensions: cell.dimensions, measures: cell.measures, limit: cell.limit });
          const result = executeDataRecipe({ ...recipe, steps: recipe.steps.slice(0, -1) }, source.source, source.rows);
          if (!result.success) throw new Error(result.error);
          table = { fields: result.fields.map(({ name, label, type }) => ({ name, label, type })), rows: result.rows.slice(0, cell.limit), truncated: result.rows.length > cell.limit };
        } else if (cell.kind === "transform") {
          table = executeNotebookTransform(cell, outputs.get(cell.inputCellId)!);
        } else if (cell.kind === "table" || cell.kind === "chart") {
          const previous = outputs.get(cell.inputCellId)!;
          const names = cell.kind === "table" ? cell.columns : [cell.categoryField, ...cell.valueFields];
          if (names.some((name) => !previous.fields.some((field) => field.name === name))) throw new Error("上游字段已变化，请重新选择表格或图表字段");
          if (cell.kind === "chart" && cell.valueFields.some((name) => previous.fields.find((field) => field.name === name)?.type !== "number")) throw new Error("图表数值列必须为数字；高精度字符串请在 SQL 中显式转换后使用");
          if (cell.kind === "chart" && (cell.chartType === "pie" || cell.chartType === "donut")
            && cell.valueFields.some((name) => previous.rows.some((row) => typeof row[name] === "number" && row[name] < 0))) throw new Error("饼图或环形图不能表示负数，请选择柱状图或折线图");
          table = { fields: previous.fields.filter((field) => names.includes(field.name)), rows: previous.rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]]))), truncated: previous.truncated };
        }
        if (signal.aborted) throw new Error("Notebook 运行已取消或超时");
        if (table) outputs.set(cell.id, table);
      } catch (caught) { error = caught instanceof Error ? caught.message.slice(0, 900) : "单元执行失败"; }
      const displayLimit = cell.kind === "data" ? 100 : NOTEBOOK_LIMITS.rows;
      const shownTable = table ? { ...table, rows: table.rows.slice(0, displayLimit), truncated: table.truncated || table.rows.length > displayLimit } : undefined;
      const result: NotebookCellRun = { cellId: cell.id, status: error ? "failure" : "success", durationMs: Math.round(performance.now() - start),
        ...(!error && table ? { resultRef: {
          resultId: `${runId}:${cell.id}`, runId, cellId: cell.id, revision: input.document.revision,
          mode: "table" as const, inputResultIds: cellDependencies(cell).map((id) => `${runId}:${id}`),
          rowCount: table.rows.length, complete: !table.truncated,
          dataSignature: createHash("sha256").update(JSON.stringify(table)).digest("hex"),
          accessMode: input.forAi ? "ai" as const : "user" as const,
          ...(cell.kind === "warehouseSql" ? { connectionId: cell.connectionId } : {}),
        } } : {}),
        ...(error ? { error } : {}), ...(!error && shownTable ? { table: shownTable } : {}), ...(queryId ? { queryId } : {}) };
      if (cell.kind === "sql" || cell.kind === "warehouseSql") (input.log ?? recordQuery)({ id: queryId ?? `query_${randomUUID()}`, taskId: input.taskId ?? runId,
        userId: input.userId ?? "local", connectionId: cell.kind === "warehouseSql" ? cell.connectionId : "local-duckdb", cellId: cell.id, startedAt, durationMs: result.durationMs,
        status: result.status, sql: cell.sql, sourceIds: sources.map((item) => item.source.id), returnedRows: shownTable?.rows.length ?? 0,
        truncated: shownTable?.truncated ?? false, bytesScanned: null });
      totalBytes += Buffer.byteLength(JSON.stringify(result));
      if (totalBytes > NOTEBOOK_LIMITS.outputBytes) throw new Error("Notebook 总结果超过 2 MiB，请缩小结果范围或分步运行");
      results.push(result);
    }
    return notebookRunSchema.parse({ runId, revision: input.document.revision, startedAt,
      status: results.every((item) => item.status === "success") ? "success" : "failure", cells: results,
      dataSignature: createHash("sha256").update(JSON.stringify({ sources: dataSignature,
        results: results.map((item) => ({ cellId: item.cellId, status: item.status, signature: item.resultRef?.dataSignature })),
      })).digest("hex"),
      notice: input.forAi
        ? cells.some((cell) => cell.kind === "warehouseSql")
          ? "AI 使用已授权数据库连接；远端结果按数据库账户权限读取，不自动脱敏。导入数据仍按既有敏感字段策略处理。"
          : "AI 使用已授权数据；敏感文本以匿名值参与查询，其他敏感值置空，结果不能用于推断原值。"
        : "本次运行读取当前源数据；结果最多展示 1000 行，截断结果不能作为下游 SQL 输入。" });
  } finally { clearTimeout(timer); }
}
