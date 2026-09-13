import type { HarnessRequest } from "./contracts";
import {
  harnessNotebookArtifactSchema,
  harnessNotebookDraftSchema,
  type HarnessNotebookArtifact,
  type HarnessNotebookCell,
  type HarnessNotebookDraft,
} from "./notebook-contracts";
import { StudioValidationError } from "@/core/schemas/errors";
import { normalizeNotebookSql } from "@/core/notebook/sql";
import type { HarnessAnalysisPlanArtifact } from "./analysis-plan-contracts";
import { assertNotebookMatchesAnalysisPlan } from "./analysis-planner";

interface NotebookDataOutput {
  fields: Set<string> | null;
  sourceDataSourceId: string;
}

export interface CreateHarnessNotebookArtifactOptions {
  request: HarnessRequest;
  allowedDataSourceIds: string[];
  now(): number;
  id(): string;
  analysisPlan?: HarnessAnalysisPlanArtifact;
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

function requireUpstreamOutput(
  outputs: Map<string, NotebookDataOutput>,
  cell: Extract<HarnessNotebookCell, { inputCellId: string }>,
): NotebookDataOutput {
  const output = outputs.get(cell.inputCellId);
  if (!output) {
    throw new StudioValidationError("Notebook 草稿校验失败", [
      `单元“${cell.title}”必须引用排在它之前、且能返回表格数据的单元：${cell.inputCellId}`,
    ]);
  }
  return output;
}

function requireFields(cellTitle: string, available: Set<string> | null, requested: string[]): void {
  if (!available) return; // SQL output columns are verified by actual execution, not guessed.
  const missing = [...new Set(requested)].filter((field) => !available.has(field));
  if (missing.length) {
    throw new StudioValidationError("Notebook 草稿校验失败", [
      `单元“${cellTitle}”引用了上游不存在的字段：${missing.join("、")}`,
    ]);
  }
}

function notebookArtifactId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^[^A-Za-z]+/u, "").slice(0, 100);
  return `notebook_${safe || "draft"}`.slice(0, 120);
}

export function createHarnessNotebookArtifact(
  rawDraft: HarnessNotebookDraft,
  options: CreateHarnessNotebookArtifactOptions,
): HarnessNotebookArtifact {
  const draft = harnessNotebookDraftSchema.parse(rawDraft);
  if (draft.analysisPlanId && !options.analysisPlan) {
    throw new StudioValidationError("Notebook 草稿校验失败", ["引用的 Analysis Plan 不属于当前 Harness 任务或已经失效。"]);
  }
  if (options.analysisPlan) assertNotebookMatchesAnalysisPlan(options.analysisPlan, draft);
  const ids = draft.cells.map((cell) => cell.id);
  const duplicateId = duplicate(ids);
  if (duplicateId) throw new StudioValidationError("Notebook 草稿校验失败", [`单元 ID 不能重复：${duplicateId}`]);

  const outputNames = draft.cells.flatMap((cell) => "outputName" in cell ? [cell.outputName] : []);
  const duplicateOutput = duplicate(outputNames);
  if (duplicateOutput) throw new StudioValidationError("Notebook 草稿校验失败", [`输出变量名不能重复：${duplicateOutput}`]);

  const allowed = new Set(options.allowedDataSourceIds);
  const sources = new Map(options.request.appSpec.dataSources.map((source) => [source.id, source]));
  const outputs = new Map<string, NotebookDataOutput>();
  const lineage: HarnessNotebookArtifact["lineage"] = [];
  const usedSourceIds = new Set<string>();
  const usedConnectionIds = new Set<string>();

  for (const cell of draft.cells) {
    if (cell.kind === "warehouseSql") {
      if (!options.request.notebookContext?.connections?.some((connection) => connection.id === cell.connectionId && connection.allowAi)) {
        throw new StudioValidationError("Notebook 草稿校验失败", ["数据库连接未授权给当前 Agent：" + cell.connectionId]);
      }
      normalizeNotebookSql(cell.sql);
      outputs.set(cell.id, { fields: null, sourceDataSourceId: "" });
      usedConnectionIds.add(cell.connectionId);
      lineage.push({ cellId: cell.id, dependsOn: [] });
      continue;
    }
    if (cell.kind === "data") {
      const source = sources.get(cell.sourceDataSourceId);
      if (!source || !allowed.has(source.id)) {
        throw new StudioValidationError("Notebook 草稿校验失败", [
          `数据单元“${cell.title}”只能使用当前工作界面的数据源：${cell.sourceDataSourceId}`,
        ]);
      }
      outputs.set(cell.id, { fields: new Set(source.fields.map((field) => field.name)), sourceDataSourceId: source.id });
      usedSourceIds.add(source.id);
      lineage.push({ cellId: cell.id, dependsOn: [] });
      continue;
    }

    if (cell.kind === "text") {
      lineage.push({ cellId: cell.id, dependsOn: [] });
      continue;
    }

    if (cell.kind === "sql") {
      normalizeNotebookSql(cell.sql);
      for (const id of cell.inputCellIds) if (!outputs.has(id)) throw new StudioValidationError("Notebook 草稿校验失败", ["SQL 必须引用排在它之前的表格输出：" + id]);
      outputs.set(cell.id, { fields: null, sourceDataSourceId: "" });
      lineage.push({ cellId: cell.id, dependsOn: cell.inputCellIds });
      continue;
    }

    const upstream = requireUpstreamOutput(outputs, cell);
    lineage.push({ cellId: cell.id, dependsOn: [cell.inputCellId] });

    if (cell.kind === "transform") {
      // The recipe executor validates evolving fields against the actual input.
      outputs.set(cell.id, { fields: null, sourceDataSourceId: upstream.sourceDataSourceId });
      continue;
    }

    if (cell.kind === "semanticQuery") {
      const model = options.request.semanticModel;
      if (!model || model.id !== cell.modelId || model.version !== cell.modelVersion) {
        throw new StudioValidationError("Notebook 草稿校验失败", [
          `语义查询单元“${cell.title}”必须使用本次选中的语义模型及版本。`,
        ]);
      }
      if (model.sourceDatasetId !== upstream.sourceDataSourceId || draft.cells.find((item) => item.id === cell.inputCellId)?.kind !== "data") {
        throw new StudioValidationError("Notebook 草稿校验失败", [
          `语义查询单元“${cell.title}”的上游数据与模型数据源不一致。`,
        ]);
      }
      requireFields(cell.title, new Set(model.dimensions.map((item) => item.key)), cell.dimensions);
      requireFields(cell.title, new Set(model.measures.map((item) => item.key)), cell.measures);
      outputs.set(cell.id, {
        fields: new Set([...cell.dimensions, ...cell.measures]),
        sourceDataSourceId: upstream.sourceDataSourceId,
      });
      continue;
    }

    if (cell.kind === "table") {
      requireFields(cell.title, upstream.fields, cell.columns);
      continue;
    }

    requireFields(cell.title, upstream.fields, [cell.categoryField, ...cell.valueFields]);
  }

  if (!usedSourceIds.size && !usedConnectionIds.size) {
    throw new StudioValidationError("Notebook 草稿校验失败", ["Notebook 至少需要一个当前工作界面的 Data 单元。"]);
  }

  return harnessNotebookArtifactSchema.parse({
    id: notebookArtifactId(options.id()),
    version: 1,
    status: "draft",
    name: draft.name,
    cells: draft.cells,
    executionOrder: ids,
    lineage,
    sourceDataSourceIds: [...usedSourceIds],
    ...(usedConnectionIds.size ? { connectionIds: [...usedConnectionIds] } : {}),
    createdAt: new Date(options.now()).toISOString(),
    ...(draft.analysisPlanId ? { analysisPlanId: draft.analysisPlanId } : {}),
  });
}
