import { z } from "zod";
import { notebookCellSchema, pythonCellSchema, type NotebookArtifact } from "@/core/notebook/definition";
import { notebookDocumentSchema, type NotebookDocument, type NotebookRun } from "@/core/notebook/contracts";
import { cellDependencies } from "@/core/notebook/graph";
import { analyzeNotebookOutputRenames } from "@/core/notebook/output-renames";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "@/core/notebook/run-receipt";
import { StudioValidationError } from "@/core/schemas";
import type { HarnessRequest, HarnessToolExecutionResult, HarnessToolName } from "./contracts";
import type { HarnessToolContext } from "./tools/contracts";
import { createHarnessNotebookArtifact } from "./notebook";
import { notebookTextResults } from "./notebook-text-results";
import { cellSearchSchema, searchNotebookCellSession } from "./notebook-cell-search";
import { NotebookSubmissionError } from "./notebook-submission-error";
export { cellSearchSchema } from "./notebook-cell-search";

// One instance per Harness task. Never persisted or shared across requests.
export interface NotebookCellSession {
  document: NotebookDocument;
  editVersion: number;
  run?: NotebookRun;
  runVersion?: number;
  lastRunVersion?: number;
}

export function usesNotebookCellTools(request: HarnessRequest): boolean {
  return Boolean(request.notebookContext) && (Boolean(request.notebookContext?.selectedCellIds?.length)
    || /单元|\bcell(?:s|search)?\b|参数|\bparameters?\b|变量|血缘|上游|下游|依赖关系|python|pandas|numpy/iu.test(request.instruction));
}

export function wantsNotebookParameters(request: HarnessRequest): boolean {
  return Boolean(request.notebookContext && (/参数|\bparameters?\b/iu.test(request.instruction)
    || request.notebookContext.document.cells.some((cell) => cell.kind === "parameter")));
}

export function wantsNotebookPython(request: HarnessRequest): boolean {
  return /python|pandas|numpy|DataFrame|openpyxl/iu.test(request.instruction)
    || Boolean(request.notebookContext?.document.cells.some((cell) => cell.kind === "python"));
}
export function canonicalNotebookTool(name: HarnessToolName): HarnessToolName {
  return name === "createPythonCell" ? "editNotebookCells" : name;
}

export function isNotebookInspection(request: HarnessRequest): boolean {
  if (!usesNotebookCellTools(request)) return false;
  const instruction = request.instruction.replace(/(?:不要|无需|不必|禁止|不)(?:再|去)?(?:修改|编辑|创建|新增|删除|运行|执行)[^，。；]*/gu, "")
    .replace(/(?:运行|执行)(?:结果|状态|回执|记录)/gu, "结果");
  const readsSelection = Boolean(request.notebookContext?.selectedCellIds?.length)
    && /看看|看一下|说明(?:一下|这些|这个|所选|含义)|含义|是什么|为什么|\bdescribe\b/iu.test(instruction);
  return (readsSelection || /查找|搜索|检索|查看|读取|解释|来源|血缘|上游|下游|依赖|引用|谁.*(?:生成|使用)|哪里.*定义|\b(?:find|search|inspect|read|explain|trace)\b/iu.test(instruction))
    && !/新增|创建|添加|修改|替换|删除|移除|编辑|重跑|运行|执行|生成(?:.*单元|.*图表)|修复|\b(?:create|edit|add|delete|remove|run|execute|update|modify)\b/iu.test(instruction);
}

const cellId = z.string().min(1).max(120);
const version = z.number().int().nonnegative();
export const editNotebookCellsSchema = z.object({
  editVersion: version,
  cells: z.array(notebookCellSchema).max(10),
  removeCellIds: z.array(cellId).max(10).default([]),
  afterCellId: cellId.nullable().optional(),
}).strict();
export const notebookSessionVersionSchema = z.object({ editVersion: version }).strict();
export const createPythonCellSchema = z.object({ editVersion: version, cell: pythonCellSchema, afterCellId: cellId.nullable().optional() }).strict();
export function createPythonCell(args: z.infer<typeof createPythonCellSchema>, context: HarnessToolContext): HarnessToolExecutionResult {
  return editNotebookCells({ editVersion: args.editVersion, cells: [args.cell], removeCellIds: [], afterCellId: args.afterCellId }, context);
}

function fail(message: string): never {
  throw new StudioValidationError("Notebook 单元操作失败", [message]);
}
function session(context: HarnessToolContext, expectedVersion?: number): NotebookCellSession {
  context.signal?.throwIfAborted();
  const state = context.notebookCellSession;
  if (!context.request.notebookContext || !state) fail("当前任务没有 Notebook 单元编辑会话，请在 Notebook 中发起任务。");
  if (expectedVersion !== undefined && state.editVersion !== expectedVersion) fail("草稿版本已变化，请先 CellSearch 读取最新 editVersion。");
  return state;
}
function artifactFor(document: NotebookDocument, context: HarnessToolContext): NotebookArtifact {
  const artifact = createHarnessNotebookArtifact({ name: document.name, cells: document.cells }, {
    request: context.request,
    allowedDataSourceIds: context.request.notebookContext!.sourceIds,
    id: context.id, now: context.now,
  });
  artifact.baseRevision = context.request.notebookContext!.document.revision;
  return artifact;
}
function indexOf(document: NotebookDocument) {
  return document.cells.map((cell, index) => ({ id: cell.id, kind: cell.kind, title: cell.title,
    index, dependsOn: cellDependencies(cell), ...("outputName" in cell ? { outputName: cell.outputName } : {}) }));
}

export function cellSearch(args: z.infer<typeof cellSearchSchema>, context: HarnessToolContext): HarnessToolExecutionResult {
  return searchNotebookCellSession(args, context, session(context));
}

export function editNotebookCells(args: z.infer<typeof editNotebookCellsSchema>, context: HarnessToolContext): HarnessToolExecutionResult {
  const state = session(context, args.editVersion);
  if (!args.cells.length && !args.removeCellIds.length) fail("没有提供任何单元修改。");
  const upserts = new Map(args.cells.map((cell) => [cell.id, cell]));
  const removed = new Set(args.removeCellIds);
  if (upserts.size !== args.cells.length || removed.size !== args.removeCellIds.length) fail("单元 ID 不能重复。");
  if (args.cells.some((cell) => removed.has(cell.id))) fail("同一单元不能同时修改和移除。");
  const existing = new Set(state.document.cells.map((cell) => cell.id));
  if (args.removeCellIds.some((id) => !existing.has(id))) fail("只能移除当前草稿中存在的单元。");
  const cells = state.document.cells.filter((cell) => !removed.has(cell.id)).map((cell) => upserts.get(cell.id) ?? cell);
  const additions = args.cells.filter((cell) => !existing.has(cell.id));
  const anchor = args.afterCellId;
  if (anchor !== undefined && anchor !== null && !cells.some((cell) => cell.id === anchor)) fail("插入位置不存在或已被移除。");
  const position = anchor === null ? 0 : anchor === undefined ? cells.length : cells.findIndex((cell) => cell.id === anchor) + 1;
  cells.splice(position, 0, ...additions);
  const next = notebookDocumentSchema.parse({ ...state.document, cells });
  const artifact = artifactFor(next, context); // Validate the entire DAG and source access before committing any edit.
  const outputRenames = analyzeNotebookOutputRenames(state.document.cells, next.cells);
  context.signal?.throwIfAborted();
  state.document = next;
  state.editVersion += 1;
  if (state.runVersion !== undefined) state.lastRunVersion = state.runVersion;
  state.run = undefined;
  state.runVersion = undefined;
  context.notebookDiagnostics?.begin(artifact, state.editVersion);
  return { summary: `已更新本次任务草稿：新增 ${additions.length}、修改 ${args.cells.length - additions.length}、移除 ${removed.size} 个单元；尚未运行或保存。`,
    data: { editVersion: state.editVersion, status: "edited", changedCellIds: [...upserts.keys()],
      removedCellIds: [...removed], cellCount: cells.length,
      cells: indexOf(next).filter((cell) => upserts.has(cell.id)),
      ...(outputRenames.length ? { outputRenames,
        renameNotice: "结构化引用按单元 ID 保留，未自动改写 SQL / Python；请检查 codeChecks 中的输入引用及 Python 输出赋值，再真实试运行。影响检查不是代码正确性的证明。" } : {}),
      next: "runNotebookCells" } };
}

export async function runNotebookCells(args: z.infer<typeof notebookSessionVersionSchema>, context: HarnessToolContext): Promise<HarnessToolExecutionResult> {
  const state = session(context, args.editVersion);
  if (!context.notebookRunner) fail("Notebook 执行器未配置，无法试运行单元。");
  const artifact = artifactFor(state.document, context);
  const expected = captureNotebookRunExpectation({ name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells }, "ai");
  const diagnosticGeneration = context.notebookDiagnostics?.begin(artifact, state.editVersion);
  state.run = undefined;
  state.runVersion = undefined;
  const rawRun = await context.notebookRunner(structuredClone(artifact), context);
  session(context, args.editVersion); // Ignore cancelled or superseded late results.
  let run: NotebookRun;
  try { run = parseNotebookRunReceipt(rawRun, expected); }
  catch { fail("执行回执与本次草稿不一致，不能作为验证证据。"); }
  state.run = run;
  state.runVersion = state.editVersion;
  state.lastRunVersion = state.editVersion;
  if (diagnosticGeneration !== undefined) context.notebookDiagnostics?.recordRun(diagnosticGeneration, run);
  return { summary: run.status === "success" ? state.editVersion
    ? `${run.cells.length} 个单元试运行通过，可提交修改对照。`
    : `${run.cells.length} 个单元试运行通过。本轮未修改单元，可依据本次有效结果回答；若请求需要修改，请先编辑并重新运行，通过后再提交。`
    : "单元试运行未通过。请根据具体错误修改草稿后重跑，当前没有可采用的结果。",
    data: { editVersion: state.editVersion, runId: run.runId, status: run.status,
      ...notebookTextResults(run),
      notice: run.notice, completedCellIds: run.cells.filter((cell) => cell.status === "success").map((cell) => cell.cellId),
      errors: run.cells.filter((cell) => cell.status !== "success").map((cell) => ({ cellId: cell.cellId, status: cell.status, error: cell.error,
        ...(cell.timing ? { timing: cell.timing } : {}) })),
      ...(run.cells.some((cell) => cell.timing) ? { timings: run.cells.filter((cell) => cell.timing)
        .map((cell) => ({ cellId: cell.cellId, ...cell.timing })) } : {}),
      results: run.cells.filter((cell) => cell.table && artifact.cells.find((item) => item.id === cell.cellId)?.kind !== "data").slice(-3)
        .map((cell) => ({ cellId: cell.cellId, resultRef: cell.resultRef, fields: cell.table!.fields,
          rows: cell.table!.rows.slice(0, 5), returnedRows: cell.table!.rows.length, truncated: cell.table!.truncated })),
      ...(run.status !== "success" ? { next: "editNotebookCells" }
        : state.editVersion ? { next: "submitNotebookDraft" } : {}) } };
}

export function submitNotebookDraft(args: z.infer<typeof notebookSessionVersionSchema>, context: HarnessToolContext): HarnessToolExecutionResult {
  const state = session(context);
  if (state.editVersion !== args.editVersion) throw new NotebookSubmissionError("notebook_submit_version_stale");
  if (!state.editVersion) throw new NotebookSubmissionError("notebook_submit_no_changes");
  if (state.runVersion !== state.editVersion || state.run?.status !== "success") throw new NotebookSubmissionError("notebook_submit_run_required");
  const artifact = artifactFor(state.document, context);
  const expected = captureNotebookRunExpectation({ name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells }, "ai");
  let run: NotebookRun;
  try { run = parseNotebookRunReceipt(state.run, expected); }
  catch { throw new NotebookSubmissionError("notebook_submit_receipt_mismatch"); }
  artifact.executionEvidence = { runId: run.runId, status: "success",
    completedCellIds: run.cells.map((cell) => cell.cellId),
    summary: `${run.cells.length} 个单元已试运行；图表还需在 Notebook 中查看渲染结果。` };
  return { summary: `“${artifact.name}”已生成待确认的单元修改对照。`,
    data: { notebookArtifactId: artifact.id, editVersion: state.editVersion, name: artifact.name,
      status: "draft", cellCount: artifact.cells.length, execution: artifact.executionEvidence },
    notebookArtifact: artifact };
}
