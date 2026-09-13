import { z } from "zod";

export const MAX_SEMANTIC_MODELS = 30;
export const SEMANTIC_AGGREGATIONS = ["sum", "average", "count", "countDistinct", "min", "max"] as const;
export const semanticAggregationLabels = { sum: "求和", average: "平均值", count: "计数", countDistinct: "去重计数", min: "最小值", max: "最大值" } as const;
const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const field = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/u)
  .refine((value) => !["constructor", "prototype", "__proto__"].includes(value), "不能使用保留字段名");
const member = { key: field, label: z.string().trim().min(1).max(100), field, description: z.string().trim().max(300) };

export const semanticModelSchema = z.object({
  id: identifier,
  version: z.number().int().min(1).max(1_000_000),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  sourceDatasetId: identifier,
  dimensions: z.array(z.object(member).strict()).max(20),
  measures: z.array(z.object({ ...member, aggregation: z.enum(SEMANTIC_AGGREGATIONS) }).strict()).min(1).max(20),
}).strict().superRefine((model, context) => {
  const keys = [...model.dimensions, ...model.measures].map((item) => item.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["measures"], message: "维度和指标标识不能重复" });
  const dimensionFields = model.dimensions.map((item) => item.field);
  if (new Set(dimensionFields).size !== dimensionFields.length) context.addIssue({ code: "custom", path: ["dimensions"], message: "同一字段不能重复定义为维度" });
});
export type SemanticModel = z.infer<typeof semanticModelSchema>;

export const semanticLayerSchema = z.object({
  models: z.array(semanticModelSchema).max(MAX_SEMANTIC_MODELS),
  selectedByWorkspace: z.record(identifier, identifier),
}).strict().superRefine((layer, context) => {
  const ids = layer.models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["models"], message: "语义模型 ID 不能重复" });
  if (Object.values(layer.selectedByWorkspace).some((id) => !ids.includes(id))) context.addIssue({ code: "custom", path: ["selectedByWorkspace"], message: "选中的语义模型不存在" });
  if (Object.keys(layer.selectedByWorkspace).length > 100) context.addIssue({ code: "custom", path: ["selectedByWorkspace"], message: "工作界面选择数量超过限制" });
});
export type SemanticLayer = z.infer<typeof semanticLayerSchema>;

export const semanticQuerySchema = z.object({
  dimensions: z.array(field).max(5),
  measures: z.array(field).min(1).max(20),
  limit: z.number().int().min(1).max(100),
}).strict().superRefine((query, context) => {
  for (const key of ["dimensions", "measures"] as const) {
    if (new Set(query[key]).size !== query[key].length) context.addIssue({ code: "custom", path: [key], message: "查询成员不能重复" });
  }
});
export type SemanticQuery = z.infer<typeof semanticQuerySchema>;
