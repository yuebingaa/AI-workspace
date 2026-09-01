import { z } from "zod";
import type { AppNode } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { componentPropsSchemas, StudioValidationError } from "@/core/schemas";
import type {
  HarnessEditableNodeSummary,
  HarnessObservation,
  HarnessRequest,
  HarnessToolName,
} from "./contracts";
import { sanitizeHarnessText } from "./security";

export const DEFAULT_HARNESS_CONTEXT_BUDGET = {
  maxRequestInputChars: 10_000,
  maxToolResultChars: 4_000,
  maxToolResultEntries: 16,
  maxTotalInputChars: 18_000,
} as const;

export interface HarnessContextBudget {
  maxRequestInputChars: number;
  maxToolResultChars: number;
  maxToolResultEntries: number;
  maxTotalInputChars: number;
}

export interface HarnessContextSelection {
  context: Record<string, unknown>;
  toolNames: HarnessToolName[];
  editableNodes: HarnessEditableNodeSummary[];
  compacted: boolean;
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

interface HarnessIntent {
  wantsChange: boolean;
  wantsData: boolean;
  wantsFields: boolean;
  wantsRecipe: boolean;
  wantsAppInspection: boolean;
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
    relevantDataSourceIds,
    relevantRecipeIds: request.recipes
      .filter((recipe) => relevantDataSourceIds.includes(recipe.sourceDatasetId))
      .map((recipe) => recipe.id),
  };
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

function selectedToolNames(request: HarnessRequest, observations: HarnessObservation[]): HarnessToolName[] {
  const called = new Set(observations.map((observation) => observation.toolName));
  const intent = harnessIntent(request);
  const canChange = studioCapabilities[request.role].updateNodeProps;

  if (observations.length === 0 && intent.wantsRecipe && intent.wantsChange) {
    return [
      "inspectDataset",
      "inspectFields",
      "previewDataRecipe",
      "validateDataRecipe",
      ...(canChange ? ["createChangeSetPreview" as const] : []),
    ];
  }
  if (intent.wantsData && !called.has("inspectDataset")) return ["inspectDataset"];
  if (intent.wantsFields && !called.has("inspectFields")) return ["inspectFields"];
  if (intent.wantsRecipe && !called.has("previewDataRecipe") && !called.has("validateDataRecipe")) {
    return ["previewDataRecipe", "validateDataRecipe"];
  }
  if (intent.wantsRecipe && called.has("validateDataRecipe") && !called.has("previewDataRecipe")) return ["previewDataRecipe"];
  if (intent.wantsAppInspection && !intent.wantsChange && !called.has("inspectAppSpec")) return ["inspectAppSpec"];
  if (intent.wantsChange && !called.has("createChangeSetPreview") && canChange) return ["createChangeSetPreview"];
  return [];
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
  const goal = sanitizeHarnessText(request.instruction).slice(0, compacted ? 300 : 600);
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) throw new StudioValidationError("Harness 上下文选择失败", ["当前页面不存在"]);
  const blockingReason = intent.wantsData && intent.relevantDataSourceIds.length === 0
    ? "当前页面没有可解析的数据源，无法执行数据分析。"
    : intent.wantsRecipe && intent.relevantRecipeIds.length === 0
      ? "当前数据源没有可执行的数据配方，无法生成计算预览。"
      : undefined;

  if (observations.length > 0) {
    return {
      compacted,
      toolNames,
      editableNodes,
      ...(blockingReason ? { blockingReason } : {}),
      context: {
        phase: "followUp",
        taskMode: intent.wantsChange ? "write" : "readOnly",
        iteration,
        goal,
        lastObservation: compactObservation(observations.at(-1), compacted),
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
    ...(blockingReason ? { blockingReason } : {}),
    context: {
      phase: "initial",
      taskMode: intent.wantsChange ? "write" : "readOnly",
      iteration,
      goal,
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

export function resolveHarnessContextBudget(input?: Partial<HarnessContextBudget>): HarnessContextBudget {
  const budget = { ...DEFAULT_HARNESS_CONTEXT_BUDGET, ...input };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new StudioValidationError("Harness 上下文预算无效", [`预算 ${name} 必须为正整数`]);
    }
  }
  return budget;
}
