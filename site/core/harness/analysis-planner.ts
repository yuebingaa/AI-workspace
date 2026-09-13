import { StudioValidationError } from "@/core/schemas/errors";
import type { HarnessRequest } from "./contracts";
import {
  harnessAnalysisPlanArtifactSchema,
  harnessAnalysisPlanDraftSchema,
  type HarnessAnalysisPlanArtifact,
  type HarnessAnalysisPlanDraft,
  type HarnessAnalysisStep,
} from "./analysis-plan-contracts";
import type { HarnessNotebookCell, HarnessNotebookDraft } from "./notebook-contracts";

interface PlannedOutput {
  fields: Set<string> | null;
  sourceDataSourceIds: Set<string>;
  kind: HarnessAnalysisStep["kind"];
}

export interface CreateHarnessAnalysisPlanOptions {
  request: HarnessRequest;
  allowedDataSourceIds: string[];
  now(): number;
  id(): string;
}

function uniqueDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

function requireFields(title: string, available: Set<string> | null, requested: string[]): void {
  if (!available) return;
  const missing = [...new Set(requested)].filter((field) => !available.has(field));
  if (missing.length) throw new StudioValidationError("Analysis Plan 校验失败", [`步骤“${title}”引用了上游不存在的字段：${missing.join("、")}`]);
}

function planArtifactId(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^[^A-Za-z]+/u, "").slice(0, 100);
  return `analysis_${safe || "plan"}`.slice(0, 120);
}

export function createHarnessAnalysisPlanArtifact(
  rawDraft: HarnessAnalysisPlanDraft,
  options: CreateHarnessAnalysisPlanOptions,
): HarnessAnalysisPlanArtifact {
  const draft = harnessAnalysisPlanDraftSchema.parse(rawDraft);
  const duplicateId = uniqueDuplicate(draft.steps.map((step) => step.id));
  if (duplicateId) throw new StudioValidationError("Analysis Plan 校验失败", [`步骤 ID 不能重复：${duplicateId}`]);

  const sources = new Map(options.request.appSpec.dataSources.map((source) => [source.id, source]));
  const allowedSources = new Set(options.allowedDataSourceIds);
  const outputs = new Map<string, PlannedOutput>();
  const usedSourceIds = new Set<string>();
  const usedConnectionIds = new Set<string>();

  for (const step of draft.steps) {
    if (step.kind === "warehouseSql") {
      if (!options.request.notebookContext?.connections?.some((connection) => connection.id === step.connectionId && connection.allowAi)) {
        throw new StudioValidationError("Analysis Plan 校验失败", ["数据库连接未授权给当前 Agent：" + step.connectionId]);
      }
      outputs.set(step.id, { kind: step.kind, fields: null, sourceDataSourceIds: new Set() });
      usedConnectionIds.add(step.connectionId);
      continue;
    }
    const missingDependency = step.dependsOn.find((id) => !outputs.has(id));
    if (missingDependency) {
      throw new StudioValidationError("Analysis Plan 校验失败", [
        `步骤“${step.title}”必须依赖排在它之前、且能返回数据的步骤：${missingDependency}`,
      ]);
    }

    if (step.kind === "data") {
      const source = sources.get(step.sourceDataSourceId);
      if (!source || !allowedSources.has(source.id)) {
        throw new StudioValidationError("Analysis Plan 校验失败", [`数据步骤“${step.title}”只能使用当前工作界面的数据源：${step.sourceDataSourceId}`]);
      }
      outputs.set(step.id, { kind: step.kind, fields: new Set(source.fields.map((field) => field.name)), sourceDataSourceIds: new Set([source.id]) });
      usedSourceIds.add(source.id);
      continue;
    }

    if (step.kind === "text") continue;
    const upstream = step.dependsOn.map((id) => outputs.get(id)!);
    if (upstream.some((output) => !["data", "semanticQuery", "sql", "warehouseSql", "transform"].includes(output.kind))) {
      throw new StudioValidationError("Analysis Plan 校验失败", [`步骤“${step.title}”只能依赖产生表格数据的步骤。`]);
    }
    const upstreamSourceIds = new Set(upstream.flatMap((output) => [...output.sourceDataSourceIds]));

    if (step.kind === "semanticQuery") {
      const model = options.request.semanticModel;
      if (!model || model.id !== step.modelId || model.version !== step.modelVersion) {
        throw new StudioValidationError("Analysis Plan 校验失败", [`语义查询步骤“${step.title}”必须使用本次选中的语义模型及版本。`]);
      }
      if (upstream[0].kind !== "data" || upstreamSourceIds.size !== 1 || !upstreamSourceIds.has(model.sourceDatasetId)) {
        throw new StudioValidationError("Analysis Plan 校验失败", [`语义查询步骤“${step.title}”必须直接依赖模型对应的原始数据步骤。`]);
      }
      requireFields(step.title, new Set(model.dimensions.map((item) => item.key)), step.dimensions);
      requireFields(step.title, new Set(model.measures.map((item) => item.key)), step.measures);
      outputs.set(step.id, { kind: step.kind, fields: new Set([...step.dimensions, ...step.measures]), sourceDataSourceIds: upstreamSourceIds });
      continue;
    }

    if (step.kind === "sql" || step.kind === "transform") {
      outputs.set(step.id, { kind: step.kind, fields: null, sourceDataSourceIds: upstreamSourceIds });
      continue;
    }

    if (step.kind === "table") requireFields(step.title, upstream[0].fields, step.columns);
    else requireFields(step.title, upstream[0].fields, [step.categoryField, ...step.valueFields]);
  }

  if (!usedSourceIds.size && !usedConnectionIds.size) throw new StudioValidationError("Analysis Plan 校验失败", ["分析计划至少需要一个当前工作界面的 Data 或已授权数据库查询步骤。"]);
  const kinds = new Set(draft.steps.map((step) => step.kind));
  const missingDeliverable = draft.deliverables.find((deliverable) => (
    deliverable === "chart" ? !kinds.has("chart") : deliverable === "table" ? !kinds.has("table") : !kinds.has("text")
  ));
  if (missingDeliverable) throw new StudioValidationError("Analysis Plan 校验失败", [`计划声明了 ${missingDeliverable} 交付物，但没有对应步骤。`]);

  return harnessAnalysisPlanArtifactSchema.parse({
    ...draft,
    id: planArtifactId(options.id()),
    version: 1,
    status: "planned",
    executionOrder: draft.steps.map((step) => step.id),
    sourceDataSourceIds: [...usedSourceIds],
    ...(usedConnectionIds.size ? { connectionIds: [...usedConnectionIds] } : {}),
    createdAt: new Date(options.now()).toISOString(),
  });
}

function notebookDependencies(cell: HarnessNotebookCell): string[] {
  if (cell.kind === "sql") return cell.inputCellIds;
  if ("inputCellId" in cell) return [cell.inputCellId];
  return [];
}

export function assertNotebookMatchesAnalysisPlan(plan: HarnessAnalysisPlanArtifact, draft: HarnessNotebookDraft): void {
  if (draft.analysisPlanId !== plan.id) throw new StudioValidationError("Notebook 草稿校验失败", ["Notebook 草稿没有引用本次 Analysis Plan。"]);
  if (draft.cells.length !== plan.steps.length) throw new StudioValidationError("Notebook 草稿校验失败", ["Notebook 单元数量与 Analysis Plan 步骤数量不一致。"]);
  if (JSON.stringify(draft.cells.map((cell) => cell.id)) !== JSON.stringify(plan.executionOrder)) {
    throw new StudioValidationError("Notebook 草稿校验失败", ["Notebook 单元顺序与 Analysis Plan 执行顺序不一致。"]);
  }
  const cells = new Map(draft.cells.map((cell) => [cell.id, cell]));
  for (const step of plan.steps) {
    const cell = cells.get(step.id);
    if (!cell || cell.kind !== step.kind) throw new StudioValidationError("Notebook 草稿校验失败", [`计划步骤“${step.id}”没有编译为相同类型的 Notebook 单元。`]);
    if (JSON.stringify(notebookDependencies(cell)) !== JSON.stringify(step.dependsOn)) {
      throw new StudioValidationError("Notebook 草稿校验失败", [`Notebook 单元“${cell.title}”的依赖与 Analysis Plan 不一致。`]);
    }
    if (step.kind === "data" && cell.kind === "data" && step.sourceDataSourceId !== cell.sourceDataSourceId) {
      throw new StudioValidationError("Notebook 草稿校验失败", [`Notebook 数据单元“${cell.title}”更换了计划数据源。`]);
    }
    if (step.kind === "warehouseSql" && cell.kind === "warehouseSql" && step.connectionId !== cell.connectionId) {
      throw new StudioValidationError("Notebook 草稿校验失败", ["Notebook 更换了计划中的数据库连接"]);
    }
    if (step.kind === "semanticQuery" && cell.kind === "semanticQuery" && (
      step.modelId !== cell.modelId || step.modelVersion !== cell.modelVersion
      || JSON.stringify(step.dimensions) !== JSON.stringify(cell.dimensions)
      || JSON.stringify(step.measures) !== JSON.stringify(cell.measures)
    )) throw new StudioValidationError("Notebook 草稿校验失败", [`Notebook 语义查询单元“${cell.title}”改变了计划口径。`]);
    if (step.kind === "table" && cell.kind === "table" && JSON.stringify(step.columns) !== JSON.stringify(cell.columns)) {
      throw new StudioValidationError("Notebook 草稿校验失败", [`Notebook 表格单元“${cell.title}”改变了计划字段。`]);
    }
    if (step.kind === "chart" && cell.kind === "chart" && (
      step.chartType !== cell.chartType || step.categoryField !== cell.categoryField
      || JSON.stringify(step.valueFields) !== JSON.stringify(cell.valueFields)
    )) throw new StudioValidationError("Notebook 草稿校验失败", [`Notebook 图表单元“${cell.title}”改变了计划配置。`]);
  }
}
