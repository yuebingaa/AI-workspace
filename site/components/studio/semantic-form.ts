import type { DataSourceDefinition } from "@/core/models";
import { semanticModelSchema, type SemanticModel } from "@/core/semantic/contracts";

// UI messages only. The domain layer remains responsible for validating saves and queries.
export function semanticDraftErrors(draft: SemanticModel, source?: DataSourceDefinition, models: SemanticModel[] = []) {
  const errors: Record<string, string> = {};
  const result = semanticModelSchema.safeParse(draft);
  if (!result.success) for (const issue of result.error.issues) {
    if (issue.code === "custom" && issue.path.length === 1 && ["dimensions", "measures"].includes(String(issue.path[0]))) continue;
    const path = issue.path.join("."), last = issue.path.at(-1);
    errors[path] = path === "name" ? "请输入模型名称，最多 100 个字。"
      : path === "sourceDatasetId" ? "请选择来源数据表。"
      : path === "description" ? "业务说明不能超过 500 个字。"
      : path === "measures" ? "至少添加一个指标，最多 20 个。"
      : path === "dimensions" ? "最多添加 20 个维度。"
      : last === "key" ? "以英文字母开头，仅使用字母、数字和下划线；不能使用保留名称。"
      : last === "label" ? "请输入业务名称，最多 100 个字。"
      : last === "field" ? "请选择有效的数据字段。"
      : last === "description" ? "口径说明不能超过 300 个字。"
      : last === "aggregation" ? "请选择支持的计算方式。"
      : "模型格式不完整，请检查后重试。";
  }
  if (!source) errors.sourceDatasetId = "来源数据表不可用，请先导入或重新选择。";
  if (models.some(model => model.id !== draft.id && model.name.trim() === draft.name.trim())) errors.name = "已有同名模型，请换一个名称。";
  const keys = new Map<string, string>(), fields = new Map<string, string>();
  for (const kind of ["dimensions", "measures"] as const) draft[kind].forEach((member, index) => {
    const path = `${kind}.${index}`, key = member.key.trim(), fieldName = member.field.trim();
    const previous = keys.get(key);
    if (previous) errors[`${previous}.key`] = errors[`${path}.key`] = "这个标识已被使用，维度和指标的标识需各不相同。";
    keys.set(key, path);
    if (kind === "dimensions") {
      const previousField = fields.get(fieldName);
      if (previousField) errors[`${previousField}.field`] = errors[`${path}.field`] = "这个字段已被用作维度，请选择其他字段。";
      fields.set(fieldName, path);
    }
    const field = source?.fields.find(item => item.name === fieldName);
    if (source && !field) errors[`${path}.field`] = "这个字段已不可用，请重新选择。";
    const measure = kind === "measures" ? draft.measures[index] : undefined;
    if (field && measure && (!field.supportedAggregations.includes(measure.aggregation)
      || (["sum", "average"].includes(measure.aggregation) && field.type !== "number"))) {
      errors[`${path}.aggregation`] = "当前字段不支持这种计算方式，请重新选择。";
    }
  });
  return errors;
}
