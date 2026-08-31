import type {
  AppNode,
  AppSpec,
  DataAggregation,
  DataBinding,
  DataSourceDefinition,
  DataSourceField,
} from "@/core/models";
import { StudioValidationError } from "@/core/schemas/errors";

function bindingForNode(node: AppNode): DataBinding | undefined {
  if (node.type === "MetricCard" || node.type === "BarChart" || node.type === "DataTable") {
    return node.props.binding;
  }
}

function fieldByName(source: DataSourceDefinition, fieldName: string): DataSourceField | undefined {
  return source.fields.find((field) => field.name === fieldName);
}

function validateAggregation(
  field: DataSourceField,
  aggregation: DataAggregation,
  subject: string,
  issues: string[],
) {
  if (!field.supportedAggregations.includes(aggregation)) {
    issues.push(`${subject}：字段“${field.label}”不支持 ${aggregation} 聚合`);
  }
}

export function dataBindingIssues(
  node: AppNode,
  dataSources: DataSourceDefinition[],
): string[] {
  const binding = bindingForNode(node);
  if (!binding) return [];

  const issues: string[] = [];
  const subject = `组件“${node.id}”`;
  const source = dataSources.find((item) => item.id === binding.dataSourceId);
  if (!source) return [`${subject}引用了不存在的数据源：${binding.dataSourceId}`];

  const measure = fieldByName(source, binding.field);
  if (!measure) {
    issues.push(`${subject}引用了不存在的字段：${binding.field}`);
  } else {
    validateAggregation(measure, binding.aggregation, subject, issues);
  }

  if (binding.groupBy && !fieldByName(source, binding.groupBy)) {
    issues.push(`${subject}引用了不存在的分组字段：${binding.groupBy}`);
  }
  for (const filter of binding.filters) {
    if (!fieldByName(source, filter.field)) issues.push(`${subject}筛选引用了不存在的字段：${filter.field}`);
  }
  for (const sort of binding.sort) {
    if (!fieldByName(source, sort.field)) issues.push(`${subject}排序引用了不存在的字段：${sort.field}`);
  }

  if (node.type === "MetricCard" && binding.groupBy) {
    issues.push(`${subject}的指标卡绑定不能设置分组字段`);
  }
  if (node.type === "BarChart") {
    if (!binding.groupBy) issues.push(`${subject}的柱状图绑定必须设置分组字段`);
    if (measure && measure.type !== "number" && !["count", "countDistinct"].includes(binding.aggregation)) {
      issues.push(`${subject}的柱状图数值字段必须是数值类型`);
    }
  }
  if (node.type === "DataTable") {
    if (!binding.columns?.length) issues.push(`${subject}的表格绑定至少需要一列`);
    for (const column of binding.columns ?? []) {
      const field = fieldByName(source, column.field);
      if (!field) {
        issues.push(`${subject}的表格列引用了不存在的字段：${column.field}`);
      } else {
        validateAggregation(field, column.aggregation, `${subject}的表格列`, issues);
      }
    }
  }
  return issues;
}

function visit(node: AppNode, callback: (node: AppNode) => void) {
  callback(node);
  node.children?.forEach((child) => visit(child, callback));
}

export function assertValidAppSpecDataBindings(appSpec: AppSpec): void {
  const issues: string[] = [];
  for (const page of appSpec.pages) {
    visit(page.root, (node) => issues.push(...dataBindingIssues(node, appSpec.dataSources)));
  }
  if (issues.length) throw new StudioValidationError("数据绑定校验失败", issues);
}

export function compatibleAggregations(field: DataSourceField | undefined): DataAggregation[] {
  return field?.supportedAggregations ?? ["none"];
}

export function compatibleFields(
  source: DataSourceDefinition | undefined,
  usage: "measure" | "group" | "table",
): DataSourceField[] {
  if (!source) return [];
  if (usage === "measure") {
    return source.fields.filter((field) => field.type === "number" && field.aggregatable);
  }
  if (usage === "group") {
    return source.fields.filter((field) => field.type === "string" || field.type === "date");
  }
  return source.fields;
}
