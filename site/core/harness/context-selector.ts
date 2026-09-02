import { z } from "zod";
import type { AppNode } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { componentPropsSchemas, StudioValidationError } from "@/core/schemas";
import type {
  HarnessEditableNodeSummary,
  HarnessObservation,
  HarnessRequest,
  HarnessTaskComplexity,
  HarnessToolName,
} from "./contracts";
import { sanitizeHarnessText } from "./security";

export const HARNESS_CONTEXT_BUDGETS = {
  simpleReadOnly: {
    maxRequestInputChars: 7_000,
    maxToolResultChars: 2_400,
    maxToolResultEntries: 12,
    maxTotalInputChars: 12_000,
    maxTotalPromptTokens: 3_500,
  },
  multiStep: {
    maxRequestInputChars: 10_000,
    maxToolResultChars: 4_000,
    maxToolResultEntries: 16,
    maxTotalInputChars: 32_000,
    maxTotalPromptTokens: 8_000,
  },
} as const;

export const DEFAULT_HARNESS_CONTEXT_BUDGET = HARNESS_CONTEXT_BUDGETS.multiStep;

export interface HarnessContextBudget {
  maxRequestInputChars: number;
  maxToolResultChars: number;
  maxToolResultEntries: number;
  maxTotalInputChars: number;
  maxTotalPromptTokens: number;
}

export interface HarnessTaskProfile {
  complexity: HarnessTaskComplexity;
  maxModelCalls: number;
  maxToolCalls: number;
}

export interface HarnessWorkingMemory {
  confirmedDataSources: Array<{ id: string; rowCount?: number; columnCount?: number; qualityScore?: number }>;
  confirmedFields: Array<{ name: string; type?: string }>;
  completedTools: HarnessToolName[];
  keyStatistics: string[];
  pendingGoals: string[];
  missingCapabilities: string[];
}

export interface HarnessContextSelection {
  context: Record<string, unknown>;
  toolNames: HarnessToolName[];
  editableNodes: HarnessEditableNodeSummary[];
  compacted: boolean;
  workingMemory: HarnessWorkingMemory;
  toolObservationChars: number;
  toolObservationEntries: number;
  blockingReason?: string;
}

const HARNESS_ACTION_PROTOCOL = `仅返回一个JSON对象，禁止Markdown和推理，一次一种动作。精确示例：{"type":"callTool","message":"检查","toolCallId":"c1","name":"inspectDataset","arguments":{}}；{"type":"complete","message":"完成"}；{"type":"blocked","message":"受阻","missingRequirements":["字段"]}。`;

export const HARNESS_INITIAL_SYSTEM_PROMPT = `${HARNESS_ACTION_PROTOCOL}只用允许工具；有工具必须调用。写操作只能显式调用createChangeSetPreview生成待确认变更，不得complete或自动应用。`;
export const HARNESS_FOLLOWUP_SYSTEM_PROMPT = `${HARNESS_ACTION_PROTOCOL}有工具必须调用；无工具且只读目标满足才complete，缺条件才blocked。写操作只能createChangeSetPreview。`;

export function harnessSystemPrompt(iteration: number) {
  return iteration > 1 ? HARNESS_FOLLOWUP_SYSTEM_PROMPT : HARNESS_INITIAL_SYSTEM_PROMPT;
}

export function estimateHarnessModelInputChars(
  context: Record<string, unknown>,
  tools: unknown[],
  iteration: number,
) {
  return harnessSystemPrompt(iteration).length + JSON.stringify({ ...context, tools }).length;
}

const modificationPattern = /修改|改为|更名|更新|新增|添加|生成|创建|删除|移除|移动|排序|标题|组件|指标/;
const datasetPattern = /数据集|数据源|销售|订单|客户|零售|retail_orders|基本信息|行数|列数|质量/iu;
const fieldPattern = /字段|schema|列信息/iu;
const detailedFieldPattern = /字段分析|空值|唯一值|示例值|最小值|最大值|平均值|inspectFields/iu;
const recipePattern = /配方|血缘|转换|派生|聚合|异常订单|复购|recipe/iu;
const appInspectionPattern = /检查页面|页面结构|组件结构|画布结构|appspec/iu;
const excelPattern = /Excel|xlsx|电子表格|下载文件/iu;

interface HarnessIntent {
  wantsChange: boolean;
  wantsData: boolean;
  wantsFields: boolean;
  wantsRecipe: boolean;
  wantsAppInspection: boolean;
  wantsExcel: boolean;
  relevantDataSourceIds: string[];
  relevantRecipeIds: string[];
}

function flattenNodes(node: AppNode, parentId?: string): Array<{ node: AppNode; parentId?: string }> {
  return [
    { node, ...(parentId ? { parentId } : {}) },
    ...(node.children?.flatMap((child) => flattenNodes(child, node.id)) ?? []),
  ];
}

function bindingDataSourceId(node: AppNode): string | undefined {
  const binding = "binding" in node.props ? node.props.binding : undefined;
  return binding && typeof binding === "object" && "dataSourceId" in binding && typeof binding.dataSourceId === "string"
    ? binding.dataSourceId
    : undefined;
}

export function resolveHarnessPageDataSourceIds(request: HarnessRequest): string[] {
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) return [];
  const boundIds = flattenNodes(page.root).flatMap(({ node }) => bindingDataSourceId(node) ?? []);
  const mentionedIds = request.appSpec.dataSources
    .filter((source) => request.instruction.includes(source.id) || request.instruction.includes(source.name))
    .map((source) => source.id);
  return [...new Set([...mentionedIds, ...boundIds])]
    .filter((id) => request.appSpec.dataSources.some((source) => source.id === id));
}

function harnessIntent(request: HarnessRequest): HarnessIntent {
  const relevantDataSourceIds = resolveHarnessPageDataSourceIds(request);
  const wantsRecipe = recipePattern.test(request.instruction);
  const wantsData = datasetPattern.test(request.instruction) || fieldPattern.test(request.instruction) || wantsRecipe;
  const affirmativeInstruction = request.instruction
    .replace(/不要修改页面/giu, "")
    .replace(/不要创建\s*ChangeSet/giu, "")
    .replace(/不要(?:修改|创建|新增|添加|生成)[^，。；]*/giu, "");
  return {
    wantsChange: modificationPattern.test(affirmativeInstruction),
    wantsData,
    wantsFields: detailedFieldPattern.test(request.instruction) || wantsRecipe,
    wantsRecipe,
    wantsAppInspection: appInspectionPattern.test(affirmativeInstruction),
    wantsExcel: excelPattern.test(request.instruction),
    relevantDataSourceIds,
    relevantRecipeIds: request.recipes
      .filter((recipe) => relevantDataSourceIds.includes(recipe.sourceDatasetId))
      .map((recipe) => recipe.id),
  };
}

export function classifyHarnessTask(request: HarnessRequest): HarnessTaskProfile {
  const intent = harnessIntent(request);
  const complexity: HarnessTaskComplexity = intent.wantsChange
    || intent.wantsRecipe
    || intent.wantsExcel
    || intent.wantsAppInspection
    ? "multiStep"
    : "simpleReadOnly";
  return complexity === "simpleReadOnly"
    ? { complexity, maxModelCalls: 2, maxToolCalls: 2 }
    : { complexity, maxModelCalls: 4, maxToolCalls: 6 };
}

function propertyNames(node: AppNode): string[] {
  const schema = componentPropsSchemas[node.type];
  const jsonSchema = zodObjectProperties(schema);
  return Object.keys(jsonSchema).sort();
}

function zodObjectProperties(schema: (typeof componentPropsSchemas)[keyof typeof componentPropsSchemas]): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  return jsonSchema.properties ?? {};
}

function primitiveValues(node: AppNode, compacted: boolean): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  const maxEntries = compacted ? 2 : 6;
  for (const [key, rawValue] of Object.entries(node.props)) {
    if (!["string", "number", "boolean"].includes(typeof rawValue)) continue;
    if (typeof rawValue === "string") values[key] = rawValue.slice(0, compacted ? 48 : 80);
    else values[key] = rawValue as number | boolean;
    if (Object.keys(values).length >= maxEntries) break;
  }
  return values;
}

function relevantEditableNodes(request: HarnessRequest, compacted: boolean): HarnessEditableNodeSummary[] {
  if (!studioCapabilities[request.role].updateNodeProps) return [];
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) return [];
  const instruction = request.instruction.toLocaleLowerCase("zh-CN");
  const candidates = flattenNodes(page.root)
    .filter(({ node }) => node.type !== "PageRoot")
    .map(({ node, parentId }) => {
      const values = primitiveValues(node, compacted);
      const searchable = [node.id, node.type, ...Object.values(values).map(String)].join(" ").toLocaleLowerCase("zh-CN");
      const score = [node.id, ...Object.values(values).map(String)]
        .reduce((total, value) => total + (instruction.includes(value.toLocaleLowerCase("zh-CN")) ? 10 : 0), 0)
        + (instruction.includes(node.type.toLocaleLowerCase("zh-CN")) ? 4 : 0)
        + (instruction.includes("标题") && ["MetricCard", "BarChart", "PageHeader"].includes(node.type) ? 1 : 0)
        + (searchable.includes(instruction) ? 1 : 0);
      return { node, parentId, values, score };
    });
  const directlyMatched = candidates.filter((candidate) => candidate.score >= 10).sort((left, right) => right.score - left.score);
  const looselyMatched = candidates.filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score);
  const metricCandidates = /指标|复购率/.test(request.instruction)
    ? candidates.filter((candidate) => candidate.node.type === "MetricGrid" || candidate.node.type === "MetricCard")
    : [];
  const selected = directlyMatched.length > 0
    ? directlyMatched
    : looselyMatched.length > 0
      ? looselyMatched
      : metricCandidates.length > 0
        ? metricCandidates
        : modificationPattern.test(request.instruction) ? candidates : [];
  return selected.slice(0, compacted ? 4 : 8).map(({ node, parentId, values }) => ({
    pageId: page.id,
    nodeId: node.id,
    type: node.type,
    ...(parentId ? { parentId } : {}),
    editableProperties: propertyNames(node),
    currentValues: values,
  }));
}

function datasetSummaries(request: HarnessRequest, compacted: boolean) {
  const intent = harnessIntent(request);
  if (!intent.wantsData) return [];
  const sources = request.appSpec.dataSources.filter((source) => intent.relevantDataSourceIds.includes(source.id));
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    rowCount: source.rowCount,
    columnCount: source.columnCount,
    qualityScore: source.qualityScore,
    fields: source.fields.map((field) => compacted
      ? { name: field.name, type: field.type }
      : {
          name: field.name,
          label: field.label,
          type: field.type,
          aggregatable: field.aggregatable,
          supportedAggregations: field.supportedAggregations,
        }),
  }));
}

function compactObservation(observation: HarnessObservation | undefined, compacted: boolean) {
  if (!observation) return undefined;
  const data = observation.data && typeof observation.data === "object" && !Array.isArray(observation.data)
    ? observation.data as Record<string, unknown>
    : {};
  const base = {
    tool: observation.toolName,
    summary: sanitizeHarnessText(observation.summary).slice(0, compacted ? 240 : 420),
  };
  switch (observation.toolName) {
    case "inspectDataset":
      return { ...base, result: pick(data, ["id", "name", "rowCount", "columnCount", "qualityScore", "fieldCount", "truncated"]) };
    case "inspectFields":
      return {
        ...base,
        result: {
          fields: Array.isArray(data.fields) ? data.fields.slice(0, compacted ? 8 : 16).map((field) => {
            const item = field && typeof field === "object" ? field as Record<string, unknown> : {};
            return pick(item, ["field", "label", "type", "nullCount", "uniqueCount", "minimum", "maximum", "average"]);
          }) : [],
          fieldCount: Array.isArray(data.fields) ? data.fields.length : 0,
          truncated: data.truncated === true,
        },
      };
    case "previewDataRecipe":
      return { ...base, result: pick(data, ["outputRowCount", "fields", "steps", "lineage", "truncated"]) };
    case "validateDataRecipe":
      return { ...base, result: pick(data, ["valid", "outputRowCount", "outputFields"]) };
    case "inspectAppSpec":
      return { ...base, result: pick(data, ["pageId", "nodeCount", "targetIds", "truncated"]) };
    case "createChangeSetPreview":
      return { ...base, result: pick(data, ["changeSetId", "operationCount", "operationTypes", "affectedPages"]) };
  }
}

function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function observationEntryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce<number>((total, item) => total + observationEntryCount(item), 0);
  if (value && typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length + entries.reduce<number>((total, item) => total + observationEntryCount(item), 0);
  }
  return 0;
}

function buildWorkingMemory(request: HarnessRequest, observations: HarnessObservation[]): HarnessWorkingMemory {
  const intent = harnessIntent(request);
  const completedTools = [...new Set(observations.map((observation) => observation.toolName))];
  const confirmedDataSources: HarnessWorkingMemory["confirmedDataSources"] = [];
  const confirmedFields = new Map<string, { name: string; type?: string }>();
  const keyStatistics: string[] = [];

  for (const observation of observations) {
    const data = record(observation.data);
    if (observation.toolName === "inspectDataset") {
      const id = typeof data.id === "string" ? data.id : intent.relevantDataSourceIds[0];
      if (id) confirmedDataSources.push({
        id,
        ...(numberValue(data.rowCount) !== undefined ? { rowCount: numberValue(data.rowCount) } : {}),
        ...(numberValue(data.columnCount) !== undefined ? { columnCount: numberValue(data.columnCount) } : {}),
        ...(numberValue(data.qualityScore) !== undefined ? { qualityScore: numberValue(data.qualityScore) } : {}),
      });
      if (numberValue(data.rowCount) !== undefined && numberValue(data.columnCount) !== undefined) {
        keyStatistics.push(`${id ?? "数据源"}: ${data.rowCount} 行 / ${data.columnCount} 列`);
      }
    }
    if (observation.toolName === "inspectFields") {
      for (const rawField of Array.isArray(data.fields) ? data.fields : []) {
        const field = record(rawField);
        const name = typeof field.field === "string" ? field.field : typeof field.name === "string" ? field.name : undefined;
        if (name) confirmedFields.set(name, { name, ...(typeof field.type === "string" ? { type: field.type } : {}) });
      }
    }
    if (observation.toolName === "previewDataRecipe" || observation.toolName === "validateDataRecipe") {
      const outputRowCount = numberValue(data.outputRowCount);
      if (outputRowCount !== undefined) keyStatistics.push(`配方输出 ${outputRowCount} 行`);
    }
  }

  const pendingGoals: string[] = [];
  if (intent.wantsData && !completedTools.includes("inspectDataset")) pendingGoals.push("确认数据集概览");
  if (intent.wantsFields && !completedTools.includes("inspectFields")) pendingGoals.push("确认分析字段");
  if (intent.wantsRecipe && !completedTools.some((tool) => tool === "previewDataRecipe" || tool === "validateDataRecipe")) pendingGoals.push("预览数据配方");
  if (intent.wantsChange && !completedTools.includes("createChangeSetPreview")) pendingGoals.push("生成待确认页面变更");
  if (intent.wantsExcel) pendingGoals.push("提供 Excel 下载");
  const availableAnalysisComplete = (!intent.wantsData || completedTools.includes("inspectDataset"))
    && (!intent.wantsFields || completedTools.includes("inspectFields"))
    && (!intent.wantsRecipe || completedTools.some((tool) => tool === "previewDataRecipe" || tool === "validateDataRecipe"));

  return {
    confirmedDataSources: [...new Map(confirmedDataSources.map((source) => [source.id, source])).values()].slice(0, 4),
    confirmedFields: [...confirmedFields.values()].slice(0, 20),
    completedTools,
    keyStatistics: [...new Set(keyStatistics)].slice(0, 8),
    pendingGoals,
    missingCapabilities: intent.wantsExcel && availableAnalysisComplete ? ["缺少 Excel 导出能力"] : [],
  };
}

function selectedToolNames(request: HarnessRequest, observations: HarnessObservation[]): HarnessToolName[] {
  const called = new Set(observations.map((observation) => observation.toolName));
  const intent = harnessIntent(request);
  const canChange = studioCapabilities[request.role].updateNodeProps;

  if (intent.wantsData && !called.has("inspectDataset")) return ["inspectDataset"];
  if (intent.wantsFields && !called.has("inspectFields")) return ["inspectFields"];
  if (intent.wantsRecipe && !called.has("previewDataRecipe") && !called.has("validateDataRecipe")) {
    return ["previewDataRecipe"];
  }
  if (intent.wantsRecipe && called.has("validateDataRecipe") && !called.has("previewDataRecipe")) return ["previewDataRecipe"];
  if (intent.wantsAppInspection && !intent.wantsChange && !called.has("inspectAppSpec")) return ["inspectAppSpec"];
  if (intent.wantsChange && !called.has("createChangeSetPreview") && canChange) return ["createChangeSetPreview"];
  return [];
}

function excelCapabilityBlockingReason(request: HarnessRequest, observations: HarnessObservation[]): string | undefined {
  const intent = harnessIntent(request);
  if (!intent.wantsExcel) return undefined;
  const called = new Set(observations.map((observation) => observation.toolName));
  const availableAnalysisComplete = (!intent.wantsData || called.has("inspectDataset"))
    && (!intent.wantsFields || called.has("inspectFields"))
    && (!intent.wantsRecipe || called.has("previewDataRecipe") || called.has("validateDataRecipe"));
  return availableAnalysisComplete
    ? "已完成当前可用的数据检查与配方预览，但缺少 Excel 导出能力，无法提供真实下载。任务已停止，正式 AppSpec 未修改。"
    : undefined;
}

export function buildHarnessContextSelection(
  request: HarnessRequest,
  observations: HarnessObservation[],
  iteration: number,
  compacted = false,
): HarnessContextSelection {
  const editableNodes = relevantEditableNodes(request, compacted);
  const toolNames = selectedToolNames(request, observations);
  const intent = harnessIntent(request);
  const goal = sanitizeHarnessText(request.instruction).slice(0, compacted ? 240 : 420);
  const workingMemory = buildWorkingMemory(request, observations);
  const latestObservation = compactObservation(observations.at(-1), compacted);
  const toolObservationChars = latestObservation ? JSON.stringify(latestObservation).length : 0;
  const toolObservationEntries = latestObservation ? observationEntryCount(latestObservation) : 0;
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) throw new StudioValidationError("Harness 上下文选择失败", ["当前页面不存在"]);
  const blockingReason = intent.wantsData && intent.relevantDataSourceIds.length === 0
    ? "当前页面没有可解析的数据源，无法执行数据分析。"
    : intent.wantsRecipe && intent.relevantRecipeIds.length === 0
      ? "当前数据源没有可执行的数据配方，无法生成计算预览。"
      : excelCapabilityBlockingReason(request, observations);

  if (observations.length > 0) {
    return {
      compacted,
      toolNames,
      editableNodes,
      workingMemory,
      toolObservationChars,
      toolObservationEntries,
      ...(blockingReason ? { blockingReason } : {}),
      context: {
        phase: "followUp",
        taskMode: intent.wantsChange ? "write" : "readOnly",
        iteration,
        goalSummary: goal,
        workingMemory,
        latestObservation,
        targetPageId: page.id,
        allowedTargets: editableNodes.map(({ pageId, nodeId, type, editableProperties, currentValues }) => ({
          pageId,
          nodeId,
          type,
          editableProperties,
          currentValues,
        })),
      },
    };
  }

  return {
    compacted,
    toolNames,
    editableNodes,
    workingMemory,
    toolObservationChars,
    toolObservationEntries,
    ...(blockingReason ? { blockingReason } : {}),
    context: {
      phase: "initial",
      taskMode: intent.wantsChange ? "write" : "readOnly",
      iteration,
      goalSummary: goal,
      workingMemory,
      currentPage: { id: page.id, title: page.title, route: page.route },
      allowedTargets: editableNodes,
      datasets: datasetSummaries(request, compacted),
      recipes: intent.wantsRecipe
        ? request.recipes.filter((recipe) => intent.relevantRecipeIds.includes(recipe.id)).slice(0, compacted ? 3 : 6).map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            sourceDatasetId: recipe.sourceDatasetId,
            stepTypes: recipe.steps.map((step) => step.type),
          }))
        : [],
      role: request.role,
    },
  };
}

export function resolveHarnessContextBudget(
  input?: Partial<HarnessContextBudget>,
  complexity: HarnessTaskComplexity = "multiStep",
): HarnessContextBudget {
  const budget = { ...HARNESS_CONTEXT_BUDGETS[complexity], ...input };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new StudioValidationError("Harness 上下文预算无效", [`预算 ${name} 必须为正整数`]);
    }
  }
  return budget;
}
