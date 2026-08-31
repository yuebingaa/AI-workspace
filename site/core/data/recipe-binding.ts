import type {
  ChangeSet,
  DataBinding,
  DataColumnBinding,
  DataFormat,
  DataRecipe,
  DataSourceDefinition,
} from "@/core/models";
import { dataRecipeSchema, StudioValidationError } from "@/core/schemas";

interface RecipeBindingTarget {
  pageId: string;
  nodeId: string;
}

function displayFormat(field: string, type: DataSourceDefinition["fields"][number]["type"]): DataFormat {
  if (type !== "number") return { style: "text" };
  if (field.includes("rate")) return { style: "percent", decimals: 1 };
  if (field.includes("revenue") || field.includes("value")) return { style: "currency", currency: "CNY", decimals: 0 };
  return { style: "number", decimals: 2 };
}

export function createRecipeBindingChangeSet(
  rawRecipe: unknown,
  source: DataSourceDefinition,
  target: RecipeBindingTarget,
  clock: () => number = Date.now,
): ChangeSet {
  const parsed = dataRecipeSchema.safeParse(rawRecipe);
  if (!parsed.success) throw new StudioValidationError("配方绑定生成失败", ["DataRecipe 未通过 Schema 校验"]);
  const recipe: DataRecipe = parsed.data;
  if (recipe.sourceDatasetId !== source.id) throw new StudioValidationError("配方绑定生成失败", ["配方数据源与当前数据源不一致"]);

  const aliases = new Map(source.fields.map((field) => [field.name, field.name]));
  const filters: DataBinding["filters"] = [];
  let grouping: { groupBy: string; columns: DataColumnBinding[]; field: string; aggregation: DataBinding["aggregation"] } | null = null;
  let sort: DataBinding["sort"] = [];
  let limit = 20;

  function originalField(field: string): string {
    const original = aliases.get(field);
    if (!original) throw new StudioValidationError("配方绑定生成失败", [`字段“${field}”不是可绑定到原始数据源的字段`]);
    return original;
  }

  for (const step of recipe.steps) {
    if (step.type === "selectFields") {
      const selected = new Set(step.fields);
      for (const field of [...aliases.keys()]) if (!selected.has(field)) aliases.delete(field);
    } else if (step.type === "filter") {
      filters.push({ field: originalField(step.field), operator: step.operator, value: step.value });
    } else if (step.type === "renameField") {
      const original = originalField(step.field);
      aliases.delete(step.field);
      aliases.set(step.newName, original);
    } else if (step.type === "deriveField") {
      aliases.set(step.field, "");
    } else if (step.type === "groupAggregate") {
      if (step.groupBy.length !== 1) throw new StudioValidationError("配方绑定生成失败", ["当前组件绑定只支持一个分组字段"]);
      const groupOriginal = originalField(step.groupBy[0]);
      const groupDefinition = source.fields.find((field) => field.name === groupOriginal)!;
      const columns: DataColumnBinding[] = [{
        field: groupOriginal,
        label: groupDefinition.label,
        aggregation: "none",
        format: displayFormat(groupOriginal, groupDefinition.type),
      }];
      const outputAliases = new Map<string, string>([[step.groupBy[0], groupOriginal]]);
      for (const aggregation of step.aggregations) {
        const original = originalField(aggregation.field);
        const definition = source.fields.find((field) => field.name === original);
        if (!definition || !definition.supportedAggregations.includes(aggregation.aggregation)) {
          throw new StudioValidationError("配方绑定生成失败", [`字段“${aggregation.field}”不支持 ${aggregation.aggregation} 聚合`]);
        }
        if (columns.some((column) => column.field === original)) {
          throw new StudioValidationError("配方绑定生成失败", [`组件绑定不能重复输出字段：${original}`]);
        }
        columns.push({
          field: original,
          label: aggregation.label,
          aggregation: aggregation.aggregation,
          format: displayFormat(original, definition.type),
        });
        outputAliases.set(aggregation.as, original);
      }
      grouping = {
        groupBy: groupOriginal,
        columns,
        field: columns[1].field,
        aggregation: columns[1].aggregation,
      };
      aliases.clear();
      outputAliases.forEach((value, key) => aliases.set(key, value));
    } else if (step.type === "sort") {
      sort = step.by.map((item) => ({ field: originalField(item.field), direction: item.direction }));
    } else if (step.type === "limit") {
      limit = step.count;
    }
  }

  const fallbackFields = [...aliases.entries()]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([, original]) => source.fields.find((field) => field.name === original))
    .filter((field): field is DataSourceDefinition["fields"][number] => Boolean(field));
  const columns = grouping?.columns ?? fallbackFields.map((field) => ({
    field: field.name,
    label: field.label,
    aggregation: "none" as const,
    format: displayFormat(field.name, field.type),
  }));
  if (!columns.length) throw new StudioValidationError("配方绑定生成失败", ["配方没有可绑定的输出字段"]);

  const binding: DataBinding = {
    dataSourceId: source.id,
    field: grouping?.field ?? columns[0].field,
    aggregation: grouping?.aggregation ?? "none",
    groupBy: grouping?.groupBy ?? null,
    filters,
    sort,
    limit: Math.min(limit, 500),
    format: columns.find((column) => column.field === (grouping?.field ?? columns[0].field))?.format ?? { style: "auto" },
    columns,
  };
  const timestamp = clock();
  return {
    id: `changeset_recipe_binding_${timestamp}`,
    title: `应用数据配方绑定：${recipe.name}`,
    status: "ready",
    operations: [{
      id: `operation_recipe_binding_${timestamp}`,
      type: "updateNodeProps",
      label: "应用配方数据绑定",
      description: `将配方“${recipe.name}”的筛选、聚合、排序和限制转换为表格绑定`,
      pageId: target.pageId,
      nodeId: target.nodeId,
      props: { binding },
    }],
  };
}
