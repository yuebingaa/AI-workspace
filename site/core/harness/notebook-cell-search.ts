import { z } from "zod";
import { NOTEBOOK_CELL_KINDS } from "@/core/notebook/cell-catalog";
import { buildNotebookSearchIndex, searchNotebookIndex, type NotebookIndexEntry } from "@/core/notebook/search";
import { StudioValidationError } from "@/core/schemas";
import type { HarnessToolExecutionResult } from "./contracts";
import type { HarnessToolContext } from "./tools/contracts";
import type { NotebookCellSession } from "./notebook-cell-tools";

export const cellSearchSchema = z.object({
  query: z.string().max(160).optional(), cellId: z.string().min(1).max(120).optional(),
  variable: z.string().min(1).max(120).optional(),
  kind: z.enum(NOTEBOOK_CELL_KINDS).optional(),
  searchIn: z.enum(["metadata", "source"]).default("metadata"),
  direction: z.enum(["self", "upstream", "downstream", "both"]).default("self"),
  depth: z.number().int().min(1).max(30).default(30),
  view: z.enum(["summary", "source", "lineage", "output"]).default("source"),
  offset: z.number().int().min(0).max(30).default(0),
  sourceOffset: z.number().int().min(0).max(80_000).default(0),
  linkOffset: z.number().int().min(0).max(60).default(0),
  rowOffset: z.number().int().min(0).max(1_000).default(0),
  fieldOffset: z.number().int().min(0).max(100).default(0),
  editVersion: z.number().int().nonnegative().optional(), runId: z.string().min(1).max(160).optional(),
}).strict().refine((value) => !(value.cellId && value.variable), "cellId 与 variable 只能选择一个定位方式");

const searchStateMessages = {
  notebook_search_version_stale: "草稿版本已变化，请重新搜索，不能续读旧索引。",
  notebook_search_run_stale: "运行结果已变化或失效，请重新读取输出，不能续读旧运行。",
  notebook_search_budget_exceeded: "单元检索摘要超过当前工具预算，请缩小检索范围。",
} as const;

/** Preserve the existing validation category without exporting run IDs or input values. */
export class NotebookSearchStateError extends StudioValidationError {
  constructor(readonly code: keyof typeof searchStateMessages) {
    super("Notebook 检索失败", [searchStateMessages[code]]);
    this.name = "NotebookSearchStateError";
  }
}

function fail(code: keyof typeof searchStateMessages): never { throw new NotebookSearchStateError(code); }
function summary(entry: NotebookIndexEntry) {
  return { id: entry.id, kind: entry.kind, title: entry.title, index: entry.index,
    ...(entry.outputName ? { outputName: entry.outputName } : {}) };
}

export function searchNotebookCellSession(args: z.infer<typeof cellSearchSchema>, context: HarnessToolContext, state: NotebookCellSession): HarnessToolExecutionResult {
  if (args.editVersion !== undefined && args.editVersion !== state.editVersion) fail("notebook_search_version_stale");
  const index = buildNotebookSearchIndex(state.document);
  const { anchor, matches } = searchNotebookIndex(index, args);
  const target = anchor ?? matches[args.offset]?.entry;
  const runCurrent = Boolean(state.run && state.runVersion === state.editVersion && state.run.revision === state.document.revision);
  if (args.runId && (!runCurrent || state.run?.runId !== args.runId)) fail("notebook_search_run_stale");
  const runStatus = runCurrent ? state.run!.status
    : state.run || state.lastRunVersion !== undefined ? "stale" : "notRun";
  const source = target && args.view === "source" ? index.sourceById.get(target.id)! : "";
  const data = {
    editVersion: state.editVersion, baseRevision: state.document.revision,
    totalCells: index.entries.length, matchedCount: matches.length,
    cells: matches.slice(args.offset, args.offset + 5).map(({ entry, relation, distance }) => ({ ...summary(entry),
      ...(args.direction !== "self" ? { relation, distance } : {}) })),
    nextOffset: args.offset + 5 < matches.length ? args.offset + 5 : null,
    neighbors: target && args.view === "source" ? index.entries.slice(Math.max(0, target.index - 1), target.index + 2).map(summary) : [],
    ...(anchor ? { anchorCellId: anchor.id } : {}),
    source: source.slice(args.sourceOffset, args.sourceOffset + 2_000),
    sourceCellId: source ? target!.id : undefined,
    sourceTruncated: args.sourceOffset + 2_000 < source.length,
    nextSourceOffset: args.sourceOffset + 2_000 < source.length ? args.sourceOffset + 2_000 : null,
    runStatus,
  };
  const links = target ? [
    ...target.inputs.map((input) => ({ relation: "upstream", cellId: input.cellId, variable: input.variable })),
    ...target.downstream.map((cellId) => ({ relation: "downstream", cellId, variable: target.outputName! })),
  ] : [];
  const lineage = args.view === "lineage" && target ? {
    cellId: target.id, definedVariable: target.outputName ?? null,
    basis: "declaredNotebookBindings", linkCount: links.length,
    links: links.slice(args.linkOffset, args.linkOffset + 5),
    nextLinkOffset: args.linkOffset + 5 < links.length ? args.linkOffset + 5 : null,
    sourceDataSourceIds: target.sourceDataSourceIds, connectionIds: target.connectionIds,
    ...(target.sourceFileNames.length ? { sourceFileNames: target.sourceFileNames } : {}),
  } : undefined;
  const cellRun = runCurrent && target ? state.run!.cells.find((cell) => cell.cellId === target.id) : undefined;
  const table = cellRun?.status === "success" && cellRun.resultRef?.accessMode === "ai"
    && cellRun.resultRef.cellId === target?.id && cellRun.resultRef.runId === state.run?.runId
    && cellRun.resultRef.revision === state.document.revision ? cellRun.table : undefined;
  const fields = table?.fields.slice(args.fieldOffset, args.fieldOffset + 5) ?? [];
  let valueLimit = 200;
  let outputRows = fields.length ? table!.rows.slice(args.rowOffset, args.rowOffset + 5) : [];
  const outputBase = args.view === "output" ? {
    cellId: target?.id ?? null,
    availability: !target ? "noMatch" : !runCurrent ? runStatus
      : !cellRun ? "unavailable" : cellRun.status !== "success" ? cellRun.status
      : !cellRun.table ? "noTable" : !table ? "unavailable" : "available",
    ...(runCurrent ? { runId: state.run!.runId } : {}),
    ...(cellRun?.error ? { error: cellRun.error } : {}),
    ...(cellRun?.stdout ? { stdout: cellRun.stdout } : {}),
    ...(cellRun?.stderr ? { stderr: cellRun.stderr } : {}),
    logsTruncated: false,
  } : undefined;
  const outputPage = () => {
    if (!outputBase || !table) return outputBase;
    let truncatedValues = 0;
    const rows = outputRows.map((row) => Object.fromEntries(fields.map((field) => {
      const value = row[field.name];
      if (typeof value === "string" && value.length > valueLimit) {
        truncatedValues += 1;
        return [field.name, value.slice(0, valueLimit)];
      }
      return [field.name, value];
    })));
    const ref = cellRun!.resultRef!;
    return { ...outputBase, resultRef: { resultId: ref.resultId, runId: ref.runId, cellId: ref.cellId,
      revision: ref.revision, dataSignature: ref.dataSignature, accessMode: ref.accessMode },
      rowCount: cellRun!.resultRef?.rowCount ?? table.rows.length, availableRows: table.rows.length,
      resultComplete: cellRun!.resultRef!.complete, tableTruncated: table.truncated,
      fieldCount: table.fields.length, fields,
      nextFieldOffset: args.fieldOffset + fields.length < table.fields.length ? args.fieldOffset + fields.length : null,
      rowOffset: args.rowOffset, rows, returnedRows: rows.length,
      nextRowOffset: rows.length && args.rowOffset + rows.length < table.rows.length ? args.rowOffset + rows.length : null,
      truncatedValues, valueCharacterLimit: valueLimit,
    };
  };
  const resultData = () => ({ ...data, ...(lineage ? { lineage } : {}), ...(outputBase ? { output: outputPage() } : {}) });
  while (JSON.stringify(resultData()).length > (context.resultBudgetChars ?? 4_000)) {
    if (data.cells.length > 1) { data.cells.pop(); data.nextOffset = args.offset + data.cells.length; }
    else if (data.neighbors.length > 1) data.neighbors = data.neighbors.filter((cell) => cell.id === target?.id);
    else if (data.source.length > 1) {
      const chunk = data.source;
      const resize = (length: number) => {
        data.source = chunk.slice(0, length);
        data.sourceTruncated = args.sourceOffset + length < source.length;
        data.nextSourceOffset = data.sourceTruncated ? args.sourceOffset + length : null;
      };
      let low = 0; let high = chunk.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        resize(middle);
        if (JSON.stringify(resultData()).length <= (context.resultBudgetChars ?? 4_000)) low = middle;
        else high = middle - 1;
      }
      if (!low) fail("notebook_search_budget_exceeded");
      resize(low);
    } else if (lineage && lineage.links.length > 1) {
      lineage.links.pop(); lineage.nextLinkOffset = args.linkOffset + lineage.links.length;
    } else if (outputBase && ((outputBase.stdout?.length ?? 0) > 100 || (outputBase.stderr?.length ?? 0) > 100)) {
      if (outputBase.stdout) outputBase.stdout = outputBase.stdout.slice(0, Math.max(100, Math.floor(outputBase.stdout.length / 2)));
      if (outputBase.stderr) outputBase.stderr = outputBase.stderr.slice(0, Math.max(100, Math.floor(outputBase.stderr.length / 2)));
      outputBase.logsTruncated = true;
    } else if (outputRows.length > 1) outputRows = outputRows.slice(0, -1);
    else if (fields.length > 1) fields.pop();
    else if (valueLimit > 20) valueLimit = Math.floor(valueLimit / 2);
    else fail("notebook_search_budget_exceeded");
  }
  context.signal?.throwIfAborted();
  return { summary: `Notebook 共 ${index.entries.length} 个单元，本次匹配 ${matches.length} 个。${args.view === "output"
    ? `输出状态：${outputBase!.availability}；仅读取本次任务的有效运行回执。`
    : "依赖来自单元声明；源码与索引不代表运行结论。"}`, data: resultData() };
}
