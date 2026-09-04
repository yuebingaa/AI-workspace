import type {
  DataFieldType,
  DataRecipe,
  DataRecipeExecutionResult,
  DataRecipeStep,
  DataRow,
  DataSourceDefinition,
  DataValue,
  RecipeFieldLineage,
  RecipeFieldSchema,
  RecipeOperand,
  RecipeStepExecutionSummary,
} from "@/core/models";
import { dataRecipeSchema, formatSchemaIssues, StudioValidationError } from "@/core/schemas";

interface RecipeState {
  rows: DataRow[];
  fields: RecipeFieldSchema[];
  lineage: RecipeFieldLineage[];
}

export interface RecipeRuntimeOptions {
  clock?: () => number;
}

export const MAX_RECIPE_PREVIEW_ROWS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStepType(value: unknown): DataRecipeStep["type"] {
  switch (value) {
    case "selectFields":
    case "filter":
    case "renameField":
    case "castField":
    case "deriveField":
    case "groupAggregate":
    case "sort":
    case "limit":
      return value;
    default:
      return "selectFields";
  }
}

function initialState(source: DataSourceDefinition, rows: DataRow[]): RecipeState {
  return {
    rows: structuredClone(rows),
    fields: source.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      nullable: rows.some((row) => row[field.name] === null || row[field.name] === undefined),
    })),
    lineage: source.fields.map((field) => ({
      field: field.name,
      sourceFields: [field.name],
      transformations: [],
    })),
  };
}

function fieldOf(state: RecipeState, name: string): RecipeFieldSchema {
  const field = state.fields.find((candidate) => candidate.name === name);
  if (!field) throw new StudioValidationError("数据配方字段校验失败", [`字段不存在：${name}`]);
  return field;
}

function lineageOf(state: RecipeState, name: string): RecipeFieldLineage {
  const lineage = state.lineage.find((candidate) => candidate.field === name);
  if (!lineage) throw new StudioValidationError("字段血缘校验失败", [`字段不存在：${name}`]);
  return lineage;
}

function compare(left: DataValue, right: DataValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function assertNotNull(value: DataValue | undefined, field: string, stepId: string): Exclude<DataValue, null> {
  if (value === null || value === undefined) {
    throw new StudioValidationError("数据配方空值校验失败", [`步骤“${stepId}”的字段“${field}”包含空值`]);
  }
  return value;
}

function matchesFilter(value: Exclude<DataValue, null>, step: Extract<DataRecipeStep, { type: "filter" }>): boolean {
  switch (step.operator) {
    case "equals": return value === step.value;
    case "notEquals": return value !== step.value;
    case "contains": return String(value).includes(String(step.value));
    case "greaterThan": return compare(value, step.value) > 0;
    case "greaterThanOrEqual": return compare(value, step.value) >= 0;
    case "lessThan": return compare(value, step.value) < 0;
    case "lessThanOrEqual": return compare(value, step.value) <= 0;
  }
}

function hasValidCalendarDate(value: string): boolean {
  const parts = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[T\s].*)?$/u.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function convertValue(value: DataValue | undefined, to: DataFieldType, field: string, stepId: string): Exclude<DataValue, null> {
  const present = assertNotNull(value, field, stepId);
  if (to === "string") return String(present);
  if (to === "number") {
    const converted = typeof present === "number" ? present : Number(present);
    if (!Number.isFinite(converted)) throw new StudioValidationError("数据配方类型转换失败", [`字段“${field}”的值不能转换为数值`]);
    return converted;
  }
  if (to === "boolean") {
    if (typeof present === "boolean") return present;
    if ([1, "1", "true", "是"].includes(present)) return true;
    if ([0, "0", "false", "否"].includes(present)) return false;
    throw new StudioValidationError("数据配方类型转换失败", [`字段“${field}”的值不能转换为布尔值`]);
  }
  if (typeof present === "string" && !hasValidCalendarDate(present.trim())) {
    throw new StudioValidationError("数据配方类型转换失败", [`字段“${field}”的值不是有效日期`]);
  }
  const parsed = typeof present === "number" ? new Date(present) : new Date(String(present).trim());
  if (Number.isNaN(parsed.getTime())) throw new StudioValidationError("数据配方类型转换失败", [`字段“${field}”的值不是有效日期`]);
  return parsed.toISOString().slice(0, 10);
}

function operandFields(operand: RecipeOperand): string[] {
  return operand.kind === "field" ? [operand.field] : [];
}

function numericOperand(row: DataRow, operand: RecipeOperand, state: RecipeState, stepId: string): number {
  if (operand.kind === "literal") return operand.value;
  fieldOf(state, operand.field);
  const value = assertNotNull(row[operand.field], operand.field, stepId);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StudioValidationError("派生字段计算失败", [`字段“${operand.field}”不是可计算的数值字段`]);
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function withTransformation(
  lineage: RecipeFieldLineage,
  step: DataRecipeStep,
  description: string,
  field = lineage.field,
): RecipeFieldLineage {
  return {
    field,
    sourceFields: [...lineage.sourceFields],
    transformations: [...lineage.transformations, { stepId: step.id, stepType: step.type, description }],
  };
}

function aggregate(rows: DataRow[], field: RecipeFieldSchema, aggregation: Extract<DataRecipeStep, { type: "groupAggregate" }>["aggregations"][number], stepId: string): DataValue {
  const values = rows.map((row) => assertNotNull(row[field.name], field.name, stepId));
  if (values.some((value) => typeof value === "number" && !Number.isFinite(value))) {
    throw new StudioValidationError("数据配方聚合失败", [`字段“${field.name}”包含非有限数值`]);
  }
  if (aggregation.aggregation === "count") return rows.length;
  if (aggregation.aggregation === "countDistinct") return new Set(values.map((value) => `${typeof value}:${String(value)}`)).size;
  if (aggregation.aggregation === "min") return values.reduce((result, value) => compare(value, result) < 0 ? value : result);
  if (aggregation.aggregation === "max") return values.reduce((result, value) => compare(value, result) > 0 ? value : result);
  if (field.type !== "number" || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new StudioValidationError("数据配方聚合失败", [`字段“${field.name}”不能执行 ${aggregation.aggregation} 聚合`]);
  }
  const numbers = values.filter((value): value is number => typeof value === "number");
  if (aggregation.aggregation === "average") {
    let average = 0;
    let compensation = 0;
    for (const value of numbers) {
      const scaled = value / numbers.length - compensation;
      const next = average + scaled;
      compensation = (next - average) - scaled;
      average = next;
    }
    if (!Number.isFinite(average)) throw new StudioValidationError("数据配方聚合失败", [`字段“${field.name}”的 average 聚合产生了无效数值`]);
    return average;
  }
  const sum = numbers.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum)) throw new StudioValidationError("数据配方聚合失败", [`字段“${field.name}”的 sum 聚合产生了无效数值`]);
  return sum;
}

function executeStep(state: RecipeState, step: DataRecipeStep): RecipeState {
  if (step.type === "selectFields") {
    step.fields.forEach((field) => fieldOf(state, field));
    return {
      rows: state.rows.map((row) => Object.fromEntries(step.fields.map((field) => [field, row[field] ?? null]))),
      fields: step.fields.map((field) => fieldOf(state, field)),
      lineage: step.fields.map((field) => lineageOf(state, field)),
    };
  }

  if (step.type === "filter") {
    fieldOf(state, step.field);
    return {
      ...state,
      rows: state.rows.filter((row) => matchesFilter(assertNotNull(row[step.field], step.field, step.id), step)),
    };
  }

  if (step.type === "renameField") {
    const current = fieldOf(state, step.field);
    if (step.newName !== step.field && state.fields.some((field) => field.name === step.newName)) {
      throw new StudioValidationError("数据配方重命名失败", [`目标字段已存在：${step.newName}`]);
    }
    return {
      rows: state.rows.map((row) => Object.fromEntries(Object.entries(row).map(([field, value]) => [field === step.field ? step.newName : field, value]))),
      fields: state.fields.map((field) => field.name === step.field ? { ...field, name: step.newName, label: step.newLabel ?? current.label } : field),
      lineage: state.lineage.map((lineage) => lineage.field === step.field
        ? withTransformation(lineage, step, `字段 ${step.field} 重命名为 ${step.newName}`, step.newName)
        : lineage),
    };
  }

  if (step.type === "castField") {
    fieldOf(state, step.field);
    return {
      rows: state.rows.map((row) => ({ ...row, [step.field]: convertValue(row[step.field], step.to, step.field, step.id) })),
      fields: state.fields.map((field) => field.name === step.field ? { ...field, type: step.to, nullable: false } : field),
      lineage: state.lineage.map((lineage) => lineage.field === step.field
        ? withTransformation(lineage, step, `转换为 ${step.to} 类型`)
        : lineage),
    };
  }

  if (step.type === "deriveField") {
    if (state.fields.some((field) => field.name === step.field)) throw new StudioValidationError("派生字段计算失败", [`输出字段已存在：${step.field}`]);
    const referenced = unique([...operandFields(step.left), ...operandFields(step.right)]);
    referenced.forEach((field) => fieldOf(state, field));
    const rows = state.rows.map((row) => {
      const left = numericOperand(row, step.left, state, step.id);
      const right = numericOperand(row, step.right, state, step.id);
      if (step.operator === "divide" && right === 0) throw new StudioValidationError("派生字段计算失败", [`步骤“${step.id}”发生除零错误`]);
      const value = step.operator === "add" ? left + right
        : step.operator === "subtract" ? left - right
          : step.operator === "multiply" ? left * right
            : left / right;
      if (!Number.isFinite(value)) throw new StudioValidationError("派生字段计算失败", [`步骤“${step.id}”产生了无效数值`]);
      return { ...row, [step.field]: value };
    });
    const inputLineages = referenced.map((field) => lineageOf(state, field));
    return {
      rows,
      fields: [...state.fields, { name: step.field, label: step.label, type: "number", nullable: false }],
      lineage: [...state.lineage, {
        field: step.field,
        sourceFields: unique(inputLineages.flatMap((lineage) => lineage.sourceFields)),
        transformations: [
          ...inputLineages.flatMap((lineage) => lineage.transformations),
          { stepId: step.id, stepType: step.type, description: `由 ${referenced.join("、") || "常量"} 派生` },
        ],
      }],
    };
  }

  if (step.type === "groupAggregate") {
    const groupFields = step.groupBy.map((field) => fieldOf(state, field));
    const aggregationFields = step.aggregations.map((aggregation) => ({ aggregation, field: fieldOf(state, aggregation.field) }));
    const groups = new Map<string, DataRow[]>();
    for (const row of state.rows) {
      const keyValues = step.groupBy.map((field) => assertNotNull(row[field], field, step.id));
      const key = JSON.stringify(keyValues);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const rows = [...groups.values()].map((group) => Object.fromEntries([
      ...step.groupBy.map((field) => [field, group[0][field] ?? null] as const),
      ...aggregationFields.map(({ aggregation, field }) => [aggregation.as, aggregate(group, field, aggregation, step.id)] as const),
    ]));
    const aggregateSchemas: RecipeFieldSchema[] = aggregationFields.map(({ aggregation, field }) => ({
      name: aggregation.as,
      label: aggregation.label,
      type: aggregation.aggregation === "count" || aggregation.aggregation === "countDistinct" ? "number" : field.type,
      nullable: false,
    }));
    return {
      rows,
      fields: [...groupFields.map((field) => ({ ...field, nullable: false })), ...aggregateSchemas],
      lineage: [
        ...step.groupBy.map((field) => withTransformation(lineageOf(state, field), step, `作为分组字段 ${field}`)),
        ...aggregationFields.map(({ aggregation }) => {
          const input = lineageOf(state, aggregation.field);
          return withTransformation(input, step, `${aggregation.aggregation} 聚合为 ${aggregation.as}`, aggregation.as);
        }),
      ],
    };
  }

  if (step.type === "sort") {
    step.by.forEach((sort) => fieldOf(state, sort.field));
    const rows = [...state.rows].sort((left, right) => {
      for (const sort of step.by) {
        const leftValue = assertNotNull(left[sort.field], sort.field, step.id);
        const rightValue = assertNotNull(right[sort.field], sort.field, step.id);
        const result = compare(leftValue, rightValue);
        if (result) return sort.direction === "asc" ? result : -result;
      }
      return 0;
    });
    return { ...state, rows };
  }

  return { ...state, rows: state.rows.slice(0, step.count) };
}

function failureResult(
  state: RecipeState,
  summaries: RecipeStepExecutionSummary[],
  failedStepId: string,
  error: string,
  totalDurationMs: number,
): DataRecipeExecutionResult {
  return { success: false, failedStepId, error, ...state, steps: summaries, totalDurationMs };
}

export function executeDataRecipe(
  rawRecipe: unknown,
  source: DataSourceDefinition,
  rows: DataRow[],
  options: RecipeRuntimeOptions = {},
): DataRecipeExecutionResult {
  const clock = options.clock ?? (() => performance.now());
  const sampleClock = (): number | null => {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const totalStarted = sampleClock();
  if (totalStarted === null) {
    throw new StudioValidationError("数据配方计时时钟无效", ["起始时钟必须返回有限数值"]);
  }
  const durationSince = (startedAt: number | null): number => {
    const endedAt = sampleClock();
    if (startedAt === null || endedAt === null) return 0;
    const durationMs = Math.round(endedAt - startedAt);
    return Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0;
  };
  let state = initialState(source, rows);
  const parsed = dataRecipeSchema.safeParse(rawRecipe);
  if (!parsed.success) {
    const rawSteps = isRecord(rawRecipe) && Array.isArray(rawRecipe.steps) ? rawRecipe.steps : [];
    const issue = parsed.error.issues[0];
    const stepIndex = typeof issue?.path[1] === "number" ? issue.path[1] : 0;
    const rawStep = isRecord(rawSteps[stepIndex]) ? rawSteps[stepIndex] : {};
    const failedStepId = typeof rawStep.id === "string" ? rawStep.id : "recipe_schema";
    const message = `数据配方 Schema 校验失败：${formatSchemaIssues(parsed.error, "DataRecipe").slice(0, 4).join("；")}`;
    const durationMs = durationSince(totalStarted);
    return failureResult(state, [{
      stepId: failedStepId,
      stepIndex,
      stepType: safeStepType(rawStep.type),
      status: "failure",
      inputRowCount: rows.length,
      outputRowCount: rows.length,
      durationMs,
      fields: state.fields,
      error: message,
    }], failedStepId, message, durationMs);
  }
  const recipe = parsed.data;
  if (recipe.sourceDatasetId !== source.id) {
    const message = `数据配方数据源不匹配：配方引用 ${recipe.sourceDatasetId}，当前数据源为 ${source.id}`;
    return failureResult(state, [], "recipe_source", message, durationSince(totalStarted));
  }

  const summaries: RecipeStepExecutionSummary[] = [];
  for (let index = 0; index < recipe.steps.length; index += 1) {
    const step = recipe.steps[index];
    const started = sampleClock();
    const inputRows = state.rows.length;
    let nextState: RecipeState;
    try {
      nextState = executeStep(state, step);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "数据配方执行失败：未知错误";
      const durationMs = durationSince(started);
      summaries.push({
        stepId: step.id,
        stepIndex: index,
        stepType: step.type,
        status: "failure",
        inputRowCount: inputRows,
        outputRowCount: state.rows.length,
        durationMs,
        fields: structuredClone(state.fields),
        error,
      });
      return failureResult(state, summaries, step.id, error, durationSince(totalStarted));
    }
    state = nextState;
    summaries.push({
      stepId: step.id,
      stepIndex: index,
      stepType: step.type,
      status: "success",
      inputRowCount: inputRows,
      outputRowCount: state.rows.length,
      durationMs: durationSince(started),
      fields: structuredClone(state.fields),
    });
  }
  return { success: true, ...state, steps: summaries, totalDurationMs: durationSince(totalStarted) };
}

export function recipeWithStepCount(recipe: DataRecipe, count: number): DataRecipe {
  return { ...structuredClone(recipe), steps: structuredClone(recipe.steps.slice(0, Math.max(1, Math.min(count, recipe.steps.length)))) };
}

export function createRecipePreview(result: DataRecipeExecutionResult, limit = MAX_RECIPE_PREVIEW_ROWS) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECIPE_PREVIEW_ROWS) {
    throw new StudioValidationError("数据配方预览限制无效", [`预览行数必须是 1–${MAX_RECIPE_PREVIEW_ROWS} 的整数`]);
  }
  return {
    fields: result.fields.map((field) => field.name),
    rows: result.rows.slice(0, limit),
  };
}
