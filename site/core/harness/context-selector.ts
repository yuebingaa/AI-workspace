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
}

export const HARNESS_INITIAL_SYSTEM_PROMPT = `你是服务端 DeepSeekHarness 规划器。只返回 JSON 对象，不返回 Markdown 或推理内容。每轮只选择一个动作：使用允许工具时返回 {"message":"中文说明","action":{"type":"tool","toolCallId":"稳定标识","name":"工具名","arguments":{}}}；无后续工具且只读任务结束时返回 {"message":"中文结论","action":{"type":"complete"}}。修改只能调用 createChangeSetPreview 生成待确认变更，绝不应用。`;
export const HARNESS_FOLLOWUP_SYSTEM_PROMPT = "只返回一个 JSON 动作。根据目标、最近观察、允许工具和目标 ID 选择下一工具；无工具时返回 complete。修改只能生成待确认预览，绝不应用。";

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

const modificationPattern = /修改|改为|更名|更新|新增|添加|删除|移除|移动|排序|标题|组件/;
const datasetPattern = /数据集|数据源|零售|retail_orders|基本信息|行数|列数|质量/iu;
const fieldPattern = /字段|schema|列信息/iu;
const recipePattern = /配方|血缘|转换|派生|聚合|recipe/iu;
const appPattern = /页面|组件|画布|appspec/iu;

function flattenNodes(node: AppNode, parentId?: string): Array<{ node: AppNode; parentId?: string }> {
  return [
    { node, ...(parentId ? { parentId } : {}) },
    ...(node.children?.flatMap((child) => flattenNodes(child, node.id)) ?? []),
  ];
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
  const selected = directlyMatched.length > 0
    ? directlyMatched
    : looselyMatched.length > 0
      ? looselyMatched
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
  if (!datasetPattern.test(request.instruction) && !fieldPattern.test(request.instruction) && !recipePattern.test(request.instruction)) return [];
  const mentioned = request.appSpec.dataSources.filter((source) => (
    request.instruction.includes(source.id) || request.instruction.includes(source.name)
  ));
  const sources = mentioned.length > 0 ? mentioned : request.appSpec.dataSources.slice(0, 1);
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
      return { ...base, result: { fieldCount: Array.isArray(data.fields) ? data.fields.length : 0, truncated: data.truncated === true } };
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
  const wantsChange = modificationPattern.test(request.instruction);
  const wantsRecipe = recipePattern.test(request.instruction);

  if ((datasetPattern.test(request.instruction) || wantsRecipe) && !called.has("inspectDataset")) return ["inspectDataset"];
  if (fieldPattern.test(request.instruction) && !called.has("inspectFields")) return ["inspectFields"];
  if (wantsRecipe && !called.has("validateDataRecipe")) return ["validateDataRecipe"];
  if (wantsRecipe && !called.has("previewDataRecipe")) return ["previewDataRecipe"];
  if (appPattern.test(request.instruction) && !wantsChange && !called.has("inspectAppSpec")) return ["inspectAppSpec"];
  if (wantsChange && !called.has("createChangeSetPreview") && studioCapabilities[request.role].updateNodeProps) return ["createChangeSetPreview"];
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
  const goal = sanitizeHarnessText(request.instruction).slice(0, compacted ? 300 : 600);
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) throw new StudioValidationError("Harness 上下文选择失败", ["当前页面不存在"]);

  if (observations.length > 0) {
    return {
      compacted,
      toolNames,
      editableNodes,
      context: {
        phase: "followUp",
        iteration,
        goal,
        lastObservation: compactObservation(observations.at(-1), compacted),
        allowedNextTools: toolNames,
        targetPageId: page.id,
        allowedTargets: editableNodes.map(({ pageId, nodeId, type, editableProperties, currentValues }) => ({
          pageId,
          nodeId,
          type,
          editableProperties,
          currentValues,
        })),
        rule: "只选择一个允许工具；修改只能生成待确认预览，不得应用。",
      },
    };
  }

  return {
    compacted,
    toolNames,
    editableNodes,
    context: {
      phase: "initial",
      iteration,
      goal,
      currentPage: { id: page.id, title: page.title, route: page.route },
      allowedTargets: editableNodes,
      datasets: datasetSummaries(request, compacted),
      recipes: recipePattern.test(request.instruction)
        ? request.recipes.slice(0, compacted ? 3 : 6).map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            sourceDatasetId: recipe.sourceDatasetId,
            stepTypes: recipe.steps.map((step) => step.type),
          }))
        : [],
      role: request.role,
      allowedNextTools: toolNames,
      rule: "只选择一个允许工具；只读工具可执行，修改只能生成待确认预览，不得应用。",
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
