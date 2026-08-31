import { z } from "zod";
import type {
  DataBinding,
  DataColumnBinding,
  DataFilter,
  DataFormat,
  DataSort,
  DataSourceDefinition,
  DataSourceField,
} from "@/core/models";

const idSchema = z.string().trim().min(1);

export const dataAggregationSchema = z.enum([
  "none",
  "sum",
  "average",
  "count",
  "countDistinct",
  "min",
  "max",
]);

export const dataFormatSchema: z.ZodType<DataFormat> = z.object({
  style: z.enum(["auto", "text", "number", "currency", "percent"]),
  currency: z.enum(["CNY", "USD"]).optional(),
  notation: z.enum(["standard", "compact"]).optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
}).strict();

export const dataFilterSchema: z.ZodType<DataFilter> = z.object({
  field: idSchema,
  operator: z.enum([
    "equals",
    "notEquals",
    "contains",
    "greaterThan",
    "greaterThanOrEqual",
    "lessThan",
    "lessThanOrEqual",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict();

export const dataSortSchema: z.ZodType<DataSort> = z.object({
  field: idSchema,
  direction: z.enum(["asc", "desc"]),
}).strict();

export const dataColumnBindingSchema: z.ZodType<DataColumnBinding> = z.object({
  field: idSchema,
  label: z.string().optional(),
  aggregation: dataAggregationSchema,
  format: dataFormatSchema,
}).strict();

export const dataBindingSchema: z.ZodType<DataBinding> = z.object({
  dataSourceId: idSchema,
  field: idSchema,
  aggregation: dataAggregationSchema,
  groupBy: idSchema.nullable(),
  filters: z.array(dataFilterSchema),
  sort: z.array(dataSortSchema),
  limit: z.number().int().min(1).max(500),
  format: dataFormatSchema,
  columns: z.array(dataColumnBindingSchema).min(1).max(20).optional(),
}).strict();

export const dataSourceFieldSchema: z.ZodType<DataSourceField> = z.object({
  name: idSchema,
  label: z.string().trim().min(1),
  type: z.enum(["string", "number", "date", "boolean"]),
  aggregatable: z.boolean(),
  supportedAggregations: z.array(dataAggregationSchema).min(1),
}).strict().superRefine((field, context) => {
  if (!field.aggregatable && field.supportedAggregations.some((item) => item !== "none" && item !== "count" && item !== "countDistinct")) {
    context.addIssue({ code: "custom", message: "不可聚合字段不能声明数值聚合方式" });
  }
});

export const dataSourceDefinitionSchema: z.ZodType<DataSourceDefinition> = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  qualityScore: z.number().min(0).max(100),
  fields: z.array(dataSourceFieldSchema).min(1),
}).strict().superRefine((source, context) => {
  const names = source.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", path: ["fields"], message: "字段名称不能重复" });
  }
  if (source.columnCount !== source.fields.length) {
    context.addIssue({ code: "custom", path: ["columnCount"], message: "列数必须与字段目录数量一致" });
  }
});
