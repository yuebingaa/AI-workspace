import { z } from "zod";
import { compileModelPlanDraft, modelPlanDraftSchema } from "@/core/ai/operation-output";
import { createExecutionState, previewChangeSet } from "@/core/changesets";
import { getEdsWorkspaceReports } from "@/core/eds";
import {
  analyzeDataSourceFields,
  executeDataRecipe,
  recipeWithStepCount,
} from "@/core/data";
import type { AppNode, LocalDataRuntime } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { StudioValidationError } from "@/core/schemas";
import type {
  HarnessEditableNodeSummary,
  HarnessRequest,
  HarnessToolExecutionResult,
  HarnessToolName,
} from "./contracts";
import { jsonByteLength, sanitizeHarnessText } from "./security";
import { resolveHarnessPageDataSourceIds } from "./context-selector";

export const MAX_HARNESS_TOOL_RESULT_BYTES = 6_000;
export const DEFAULT_HARNESS_TOOL_RESULT_ENTRIES = 16;

export interface HarnessToolContext {
  request: HarnessRequest;
  dataRuntime: LocalDataRuntime;
  now(): number;
  id(): string;
  resultBudgetChars?: number;
  resultBudgetEntries?: number;
  excelExporter?: HarnessExcelExporter;
}

export interface HarnessExcelExporterArgs {
  recipeId: string;
  fileName?: string;
}

export type HarnessExcelExporter = (
  args: HarnessExcelExporterArgs,
  context: HarnessToolContext,
) => Promise<HarnessToolExecutionResult>;

interface HarnessToolDefinition<Name extends HarnessToolName, Args> {
  name: Name;
  description: string;
  mode: "readOnly" | "changePreview";
  schema: z.ZodType<Args>;
  execute(args: Args, context: HarnessToolContext): HarnessToolExecutionResult | Promise<HarnessToolExecutionResult>;
}

function defineTool<Name extends HarnessToolName, Args>(definition: HarnessToolDefinition<Name, Args>) {
  return definition;
}

function sourceAndRows(context: HarnessToolContext, dataSourceId: string) {
  const source = context.request.appSpec.dataSources.find((candidate) => candidate.id === dataSourceId);
  if (!source) throw new StudioValidationError("Harness 数据源校验失败", [`数据源不存在：${dataSourceId}`]);
  const rows = context.dataRuntime.rowsByDataSourceId[dataSourceId];
  if (!rows) throw new StudioValidationError("Harness 数据源校验失败", [`数据源没有可用的服务端运行数据：${dataSourceId}`]);
  return { source, rows };
}

function recipeContext(context: HarnessToolContext, recipeId: string, stepCount?: number) {
  const recipe = context.request.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new StudioValidationError("Harness 配方校验失败", [`数据配方不存在：${recipeId}`]);
  const { source, rows } = sourceAndRows(context, recipe.sourceDatasetId);
  return { recipe: stepCount === undefined ? recipe : recipeWithStepCount(recipe, stepCount), source, rows };
}

function compactNodes(node: AppNode): Array<{ id: string; type: AppNode["type"]; childCount: number }> {
  return [
    { id: node.id, type: node.type, childCount: node.children?.length ?? 0 },
    ...(node.children?.flatMap(compactNodes) ?? []),
  ];
}

const analyzeEdsReports = defineTool({
  name: "analyzeEdsReports",
  description: "读取 EDS 工作区中全部日期/班次的派生汇总，返回 KPI、主要线体、主要异常类别和跨班次差异。只读；不接触原始工作簿或逐行明细。",
  mode: "readOnly",
  schema: z.object({}).strict(),
  execute: (_args, context) => {
    if (!context.request.edsWorkspace) {
      throw new StudioValidationError("EDS AI 分析失败", ["当前工作区没有已校验的 EDS 派生报告"]);
    }
    const reports = getEdsWorkspaceReports(context.request.edsWorkspace);
    const baseline = reports[0];
    const includeExpandedRankings = reports.length <= 4;
    const summaries = reports.map((report, index) => {
      const topLines = [...report.lineSummary].sort((left, right) => right.count - left.count).slice(0, includeExpandedRankings ? 3 : 1);
      const topIssues = [...report.issueSummary].sort((left, right) => right.minutes - left.minutes).slice(0, includeExpandedRankings ? 5 : 1);
      return {
        date: report.summary.date,
        shift: report.summary.shift,
        current: report.summary.date === context.request.edsWorkspace?.summary.date
          && report.summary.shift === context.request.edsWorkspace?.summary.shift,
        inputRows: report.summary.inputRows,
        matchedRows: report.summary.matchedRows,
        hitRatePercent: report.summary.inputRows === 0 ? 0 : report.summary.matchedRows / report.summary.inputRows * 100,
        totalOccurrences: report.summary.totalOccurrences,
        totalMinutes: report.summary.totalMinutes,
        deltaFromFirst: index === 0 ? null : {
          occurrences: report.summary.totalOccurrences - baseline.summary.totalOccurrences,
          minutes: report.summary.totalMinutes - baseline.summary.totalMinutes,
          hitRatePercentagePoints: (
            report.summary.inputRows === 0 ? 0 : report.summary.matchedRows / report.summary.inputRows * 100
          ) - (baseline.summary.inputRows === 0 ? 0 : baseline.summary.matchedRows / baseline.summary.inputRows * 100),
        },
        topLines: topLines.map((item) => ({ label: item.label, occurrences: item.count, minutes: item.minutes })),
        topIssues: topIssues.map((item) => ({ label: item.label, occurrences: item.count, minutes: item.minutes })),
      };
    });
    return {
      summary: `已读取 ${reports.length} 份 EDS 派生报告，包含各班次 KPI、主要线体、主要异常类别及相对首份报告的差异；未读取原始行。`,
      data: {
        reportCount: reports.length,
        baseline: { date: baseline.summary.date, shift: baseline.summary.shift },
        reports: summaries,
        templateVersion: context.request.edsWorkspace.configuration.templateVersion,
        ruleVersion: context.request.edsWorkspace.configuration.ruleVersion,
        rawRowsIncluded: false,
      },
    };
  },
});

const inspectDataset = defineTool({
  name: "inspectDataset",
  description: "检查数据源概览、真实行列数、质量和字段名称。只读。",
  mode: "readOnly",
  schema: z.object({ dataSourceId: z.string().min(1).max(120) }).strict(),
  execute: ({ dataSourceId }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    return {
      summary: `数据源“${source.name}”包含 ${rows.length} 行、${source.fields.length} 个字段，质量 ${source.qualityScore}%。`,
      data: {
        id: source.id,
        name: source.name,
        rowCount: rows.length,
        columnCount: source.fields.length,
        qualityScore: source.qualityScore,
        fields: source.fields.map((field) => ({ name: field.name, label: field.label, type: field.type })),
        fieldCount: source.fields.length,
      },
    };
  },
});

const inspectFields = defineTool({
  name: "inspectFields",
  description: "分析字段类型、空值、唯一值、数值范围和少量示例。只读。",
  mode: "readOnly",
  schema: z.object({
    dataSourceId: z.string().min(1).max(120),
    fields: z.array(z.string().min(1).max(120)).max(30).optional(),
  }).strict(),
  execute: ({ dataSourceId, fields }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    const allowed = fields ? new Set(fields) : null;
    if (allowed) {
      const missing = [...allowed].filter((field) => !source.fields.some((candidate) => candidate.name === field));
      if (missing.length) throw new StudioValidationError("Harness 字段校验失败", [`字段不存在：${missing.join("、")}`]);
    }
    const analyses = analyzeDataSourceFields(source, rows)
      .filter((analysis) => !allowed || allowed.has(analysis.field))
      .map((analysis) => {
        const field = source.fields.find((candidate) => candidate.name === analysis.field);
        const sensitive = field?.sensitiveCategories ?? [];
        const samples = sensitive.length === 0
          ? analysis.samples.slice(0, 3)
          : source.aiAccessPolicy === "masked"
            ? [`[已脱敏：${sensitive.join("/")}]`]
            : [];
        return { ...analysis, samples, sensitiveCategories: sensitive };
      });
    return { summary: `已分析 ${analyses.length} 个字段，输入 ${rows.length} 行。`, data: { dataSourceId, fields: analyses } };
  },
});

const previewDataRecipe = defineTool({
  name: "previewDataRecipe",
  description: "按顺序执行现有 DataRecipe，返回最多 10 行预览、步骤摘要和字段血缘。只读。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    stepCount: z.number().int().min(1).max(50).optional(),
  }).strict(),
  execute: ({ recipeId, stepCount }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId, stepCount);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方预览失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”执行成功：${result.steps.length} 步，${rows.length} 行输入，${result.rows.length} 行输出。`,
      data: {
        fields: result.fields,
        outputRowCount: result.rows.length,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          stepType: step.stepType,
          inputRowCount: step.inputRowCount,
          outputRowCount: step.outputRowCount,
          durationMs: step.durationMs,
        })),
        lineage: result.lineage,
      },
    };
  },
});

const validateDataRecipe = defineTool({
  name: "validateDataRecipe",
  description: "使用现有 DataRecipe Schema 和本地执行器验证配方。只读。",
  mode: "readOnly",
  schema: z.object({ recipeId: z.string().min(1).max(120) }).strict(),
  execute: ({ recipeId }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方验证失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”通过 Schema 和 ${result.steps.length} 个执行步骤验证。`,
      data: { valid: true, outputRowCount: result.rows.length, outputFields: result.fields },
    };
  },
});

const exportDataRecipeToExcel = defineTool({
  name: "exportDataRecipeToExcel",
  description: "把已成功预览的 DataRecipe 结果导出为临时 XLSX 下载文件。只导出配方结果，不修改 AppSpec。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    fileName: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  execute: async (args, context) => {
    if (!context.excelExporter) throw new StudioValidationError("Excel 导出能力不可用", ["服务端没有配置 Excel 导出器"]);
    return context.excelExporter(args, context);
  },
});

const inspectAppSpec = defineTool({
  name: "inspectAppSpec",
  description: "检查 AppSpec 页面、组件树和可用数据源。只读。",
  mode: "readOnly",
  schema: z.object({ pageId: z.string().min(1).max(120).optional() }).strict(),
  execute: ({ pageId }, context) => {
    const pages = pageId
      ? context.request.appSpec.pages.filter((page) => page.id === pageId)
      : context.request.appSpec.pages;
    if (!pages.length) throw new StudioValidationError("Harness AppSpec 校验失败", [`页面不存在：${pageId}`]);
    return {
      summary: `已检查 ${pages.length} 个页面和 ${pages.reduce((total, page) => total + compactNodes(page.root).length, 0)} 个节点。`,
      data: {
        pages: pages.map((page) => ({ id: page.id, title: page.title, route: page.route, nodes: compactNodes(page.root) })),
        dataSourceIds: context.request.appSpec.dataSources.map((source) => source.id),
      },
    };
  },
});

const createChangeSetPreview = defineTool({
  name: "createChangeSetPreview",
  description: "把模型操作编译并校验为待确认 ChangeSet。只生成预览，绝不应用正式状态。",
  mode: "changePreview",
  schema: modelPlanDraftSchema,
  execute: (draft, context) => {
    const changeSet = compileModelPlanDraft(draft, context.request.instruction, {
      now: context.now,
      idFactory: context.id,
    });
    const preview = previewChangeSet(createExecutionState(context.request.appSpec), changeSet, context.request.role);
    if (!preview.preview) throw new StudioValidationError("Harness ChangeSet 预览失败", ["未生成有效预览"]);
    return {
      summary: `已生成 ${changeSet.operations.length} 项待确认变更，正式 AppSpec 尚未修改。`,
      data: {
        changeSetId: changeSet.id,
        operationCount: changeSet.operations.length,
        operationTypes: changeSet.operations.map((operation) => operation.type),
        affectedPages: [...new Set(changeSet.operations.map((operation) => operation.pageId))],
      },
      pendingChangeSet: changeSet,
    };
  },
});

export const harnessToolRegistry = {
  analyzeEdsReports,
  inspectDataset,
  inspectFields,
  previewDataRecipe,
  validateDataRecipe,
  exportDataRecipeToExcel,
  inspectAppSpec,
  createChangeSetPreview,
} satisfies Record<HarnessToolName, HarnessToolDefinition<HarnessToolName, unknown>>;

interface HarnessToolCatalogOptions {
  names?: HarnessToolName[];
  editableNodes?: HarnessEditableNodeSummary[];
  instruction?: string;
  request?: HarnessRequest;
}

function stringEnum(values: string[]) {
  return { type: "string", enum: [...new Set(values)] };
}

function relevantProperties(node: HarnessEditableNodeSummary, instruction: string) {
  const titleKeys = new Set(["label", "title", "subtitle", "eyebrow"]);
  const explicitlyNamed = node.editableProperties.filter((property) => instruction.toLocaleLowerCase("zh-CN").includes(property.toLocaleLowerCase("zh-CN")));
  if (instruction.includes("标题")) {
    const titles = node.editableProperties.filter((property) => titleKeys.has(property));
    if (titles.length > 0) return titles;
  }
  if (instruction.includes("描述")) return node.editableProperties.filter((property) => property === "description");
  return explicitlyNamed.length > 0 ? explicitlyNamed : node.editableProperties.filter((property) => property !== "binding").slice(0, 6);
}

function primitivePropertySchema(value: string | number | boolean | undefined) {
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string", maxLength: 500 };
}

function compactMetricPropsSchema(request: HarnessRequest): Record<string, unknown> {
  const dataSourceIds = resolveHarnessPageDataSourceIds(request);
  const fields = request.appSpec.dataSources
    .filter((source) => dataSourceIds.includes(source.id))
    .flatMap((source) => source.fields.map((field) => field.name));
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "trend", "binding"],
    properties: {
      label: { type: "string", maxLength: 100 },
      trend: { type: "string", maxLength: 100 },
      isNew: { type: "boolean" },
      binding: {
        type: "object",
        additionalProperties: false,
        required: ["dataSourceId", "field", "aggregation", "groupBy", "filters", "sort", "limit", "format"],
        properties: {
          dataSourceId: stringEnum(dataSourceIds),
          field: stringEnum(fields),
          aggregation: stringEnum(["none", "sum", "average", "count", "countDistinct", "min", "max"]),
          groupBy: { anyOf: [stringEnum(fields), { type: "null" }] },
          filters: { type: "array", maxItems: 0 },
          sort: { type: "array", maxItems: 0 },
          limit: { type: "integer", minimum: 1, maximum: 10_000 },
          format: {
            type: "object",
            additionalProperties: false,
            required: ["style"],
            properties: {
              style: stringEnum(["auto", "text", "number", "currency", "percent"]),
              currency: stringEnum(["CNY", "USD"]),
              notation: stringEnum(["standard", "compact"]),
              decimals: { type: "integer", minimum: 0, maximum: 8 },
              prefix: { type: "string", maxLength: 20 },
              suffix: { type: "string", maxLength: 20 },
            },
          },
        },
      },
    },
  };
}

function compactChangePreviewSchema(options: HarnessToolCatalogOptions): Record<string, unknown> {
  const editableNodes = options.editableNodes ?? [];
  const instruction = options.instruction ?? "";
  const updateVariants = editableNodes.map((node) => {
    const propertyNames = relevantProperties(node, instruction);
    const properties = Object.fromEntries(propertyNames.map((property) => [
      property,
      primitivePropertySchema(node.currentValues[property]),
    ]));
    return {
      type: "object",
      additionalProperties: false,
      required: ["type", "pageId", "nodeId", "props"],
      properties: {
        type: stringEnum(["updateNodeProps"]),
        pageId: stringEnum([node.pageId]),
        nodeId: stringEnum([node.nodeId]),
        props: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties,
        },
      },
    };
  });
  const metricParents = editableNodes.filter((node) => node.type === "MetricGrid");
  const metricProps = options.request ? compactMetricPropsSchema(options.request) : {};
  const addMetricVariants = /生成|创建|新增|添加|指标|复购率/.test(instruction)
    ? metricParents.map((parent) => ({
        type: "object",
        additionalProperties: false,
        required: ["type", "pageId", "parentId", "node"],
        properties: {
          type: stringEnum(["addNode"]),
          pageId: stringEnum([parent.pageId]),
          parentId: stringEnum([parent.nodeId]),
          position: { type: "integer", minimum: 0 },
          node: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "props"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,119}$" },
              type: stringEnum(["MetricCard"]),
              props: metricProps,
            },
          },
        },
      }))
    : [];
  const operationVariants = addMetricVariants.length > 0 ? addMetricVariants : updateVariants;
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "operations"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2_000 },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: operationVariants.length === 1 ? operationVariants[0] : { oneOf: operationVariants },
      },
    },
  };
}

function scopedToolParameters(tool: (typeof harnessToolRegistry)[HarnessToolName], options: HarnessToolCatalogOptions) {
  if (!options.request) return z.toJSONSchema(tool.schema) as Record<string, unknown>;
  const dataSourceIds = resolveHarnessPageDataSourceIds(options.request);
  const fieldNames = options.request.appSpec.dataSources
    .filter((source) => dataSourceIds.includes(source.id))
    .flatMap((source) => source.fields.map((field) => field.name));
  const recipeIds = options.request.recipes
    .filter((recipe) => dataSourceIds.includes(recipe.sourceDatasetId))
    .map((recipe) => recipe.id);
  if (tool.name === "inspectDataset") {
    return { type: "object", additionalProperties: false, required: ["dataSourceId"], properties: { dataSourceId: stringEnum(dataSourceIds) } };
  }
  if (tool.name === "inspectFields") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["dataSourceId"],
      properties: {
        dataSourceId: stringEnum(dataSourceIds),
        fields: { type: "array", maxItems: 30, items: stringEnum(fieldNames) },
      },
    };
  }
  if (tool.name === "previewDataRecipe") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["recipeId"],
      properties: { recipeId: stringEnum(recipeIds), stepCount: { type: "integer", minimum: 1, maximum: 50 } },
    };
  }
  if (tool.name === "validateDataRecipe") {
    return { type: "object", additionalProperties: false, required: ["recipeId"], properties: { recipeId: stringEnum(recipeIds) } };
  }
  if (tool.name === "exportDataRecipeToExcel") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["recipeId"],
      properties: {
        recipeId: stringEnum(recipeIds),
        fileName: { type: "string", minLength: 1, maxLength: 100, description: "仅文件名，不得包含路径；可省略" },
      },
    };
  }
  return z.toJSONSchema(tool.schema) as Record<string, unknown>;
}

export function harnessToolCatalog(options: HarnessToolCatalogOptions = {}) {
  const names = options.names ? new Set(options.names) : null;
  return Object.values(harnessToolRegistry).filter((tool) => !names || names.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    mode: tool.mode,
    parameters: tool.name === "createChangeSetPreview" && options.editableNodes
      ? compactChangePreviewSchema(options)
      : scopedToolParameters(tool, options),
  }));
}

function truncateString(value: string, limit = 300) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compactValue(value: unknown, maxEntries: number, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, depth === 0 ? 500 : 220);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[已省略深层结果]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxEntries).map((item) => compactValue(item, Math.max(3, Math.floor(maxEntries / 2)), depth + 1));
    return value.length > maxEntries ? [...items, { truncated: true, omittedCount: value.length - maxEntries }] : items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const selected = entries.slice(0, maxEntries).map(([key, child]) => [key, compactValue(child, Math.max(3, Math.floor(maxEntries / 2)), depth + 1)]);
  if (entries.length > maxEntries) selected.push(["truncated", true], ["omittedPropertyCount", entries.length - maxEntries]);
  return Object.fromEntries(selected);
}

export function compactHarnessToolResult(
  result: HarnessToolExecutionResult,
  maxChars = MAX_HARNESS_TOOL_RESULT_BYTES,
  maxEntries = DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
): HarnessToolExecutionResult {
  if (JSON.stringify(result.data).length <= maxChars) return result;
  let data = compactValue(result.data, maxEntries);
  let pass = 0;
  while (JSON.stringify(data).length > maxChars && pass < 3) {
    data = compactValue(data, Math.max(2, Math.floor(maxEntries / (2 ** (pass + 1)))));
    pass += 1;
  }
  if (JSON.stringify(data).length > maxChars) {
    data = { truncated: true, summaryOnly: truncateString(result.summary, Math.max(80, maxChars - 80)) };
  }
  if (JSON.stringify(data).length > maxChars) {
    throw new StudioValidationError("Harness 工具结果过大", ["工具结果压缩后仍超过上下文预算"]);
  }
  return {
    ...result,
    summary: `${result.summary}（结果已按上下文预算截断）`,
    data,
  };
}

export async function executeHarnessTool(
  rawName: string,
  rawArguments: unknown,
  context: HarnessToolContext,
): Promise<HarnessToolExecutionResult> {
  if (!(rawName in harnessToolRegistry)) {
    throw new StudioValidationError("Harness 工具校验失败", [`不允许调用工具：${sanitizeHarnessText(rawName, "未知工具")}`]);
  }
  const name = rawName as HarnessToolName;
  const tool = harnessToolRegistry[name];
  if (tool.mode === "changePreview" && !studioCapabilities[context.request.role].updateNodeProps) {
    throw new StudioValidationError("Harness 工具权限校验失败", [`${context.request.role} 无权生成修改型工具预览`]);
  }
  const run = async <Args>(definition: HarnessToolDefinition<HarnessToolName, Args>) => {
    const parsed = definition.schema.safeParse(rawArguments);
    if (!parsed.success) throw new StudioValidationError("Harness 工具参数校验失败", [`工具 ${name} 的参数不符合定义`]);
    return definition.execute(parsed.data, context);
  };
  const result = await (() => {
    switch (name) {
      case "analyzeEdsReports": return run(analyzeEdsReports);
      case "inspectDataset": return run(inspectDataset);
      case "inspectFields": return run(inspectFields);
      case "previewDataRecipe": return run(previewDataRecipe);
      case "validateDataRecipe": return run(validateDataRecipe);
      case "exportDataRecipeToExcel": return run(exportDataRecipeToExcel);
      case "inspectAppSpec": return run(inspectAppSpec);
      case "createChangeSetPreview": return run(createChangeSetPreview);
    }
  })();
  const compacted = compactHarnessToolResult(
    result,
    context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES,
    context.resultBudgetEntries ?? DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
  );
  if (jsonByteLength(compacted.data) > (context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES) * 4) {
    throw new StudioValidationError("Harness 工具结果过大", [`工具 ${name} 的结果压缩后仍超过安全字节限制`]);
  }
  return { ...compacted, summary: sanitizeHarnessText(compacted.summary).slice(0, 500) };
}
