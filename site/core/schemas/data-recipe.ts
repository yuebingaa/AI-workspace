import { z } from "zod";
import type { DataRecipe, DataRecipeStep, RecipeOperand } from "@/core/models";

const idSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "标识只能包含英文、数字、下划线或连字符，并以英文字母开头");
const fieldSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "字段名只能包含英文、数字或下划线，并以英文字母开头");

export const recipeOperandSchema: z.ZodType<RecipeOperand> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), field: fieldSchema }).strict(),
  z.object({ kind: z.literal("literal"), value: z.number().finite() }).strict(),
]);

const recipeAggregationSchema = z.enum(["sum", "average", "count", "countDistinct", "min", "max"]);
const filterOperatorSchema = z.enum([
  "equals",
  "notEquals",
  "contains",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
]);

export const dataRecipeStepSchema: z.ZodType<DataRecipeStep> = z.discriminatedUnion("type", [
  z.object({
    id: idSchema,
    type: z.literal("selectFields"),
    fields: z.array(fieldSchema).min(1).max(100),
  }).strict().superRefine((step, context) => {
    if (new Set(step.fields).size !== step.fields.length) context.addIssue({ code: "custom", path: ["fields"], message: "选择字段不能重复" });
  }),
  z.object({
    id: idSchema,
    type: z.literal("filter"),
    field: fieldSchema,
    operator: filterOperatorSchema,
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("renameField"),
    field: fieldSchema,
    newName: fieldSchema,
    newLabel: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("castField"),
    field: fieldSchema,
    to: z.enum(["string", "number", "date", "boolean"]),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("deriveField"),
    field: fieldSchema,
    label: z.string().trim().min(1).max(100),
    operator: z.enum(["add", "subtract", "multiply", "divide"]),
    left: recipeOperandSchema,
    right: recipeOperandSchema,
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("groupAggregate"),
    groupBy: z.array(fieldSchema).min(1).max(5),
    aggregations: z.array(z.object({
      field: fieldSchema,
      aggregation: recipeAggregationSchema,
      as: fieldSchema,
      label: z.string().trim().min(1).max(100),
    }).strict()).min(1).max(20),
  }).strict().superRefine((step, context) => {
    if (new Set(step.groupBy).size !== step.groupBy.length) context.addIssue({ code: "custom", path: ["groupBy"], message: "分组字段不能重复" });
    const aliases = step.aggregations.map((aggregation) => aggregation.as);
    if (new Set(aliases).size !== aliases.length) context.addIssue({ code: "custom", path: ["aggregations"], message: "聚合输出字段不能重复" });
    const collisions = aliases.filter((alias) => step.groupBy.includes(alias));
    if (collisions.length) context.addIssue({ code: "custom", path: ["aggregations"], message: `聚合字段不能覆盖分组字段：${collisions.join("、")}` });
  }),
  z.object({
    id: idSchema,
    type: z.literal("sort"),
    by: z.array(z.object({ field: fieldSchema, direction: z.enum(["asc", "desc"]) }).strict()).min(1).max(10),
  }).strict().superRefine((step, context) => {
    const fields = step.by.map((sort) => sort.field);
    if (new Set(fields).size !== fields.length) context.addIssue({ code: "custom", path: ["by"], message: "排序字段不能重复" });
  }),
  z.object({
    id: idSchema,
    type: z.literal("limit"),
    count: z.number().int().min(1).max(10_000),
  }).strict(),
]) as z.ZodType<DataRecipeStep>;

export const dataRecipeSchema: z.ZodType<DataRecipe> = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  sourceDatasetId: idSchema,
  outputDatasetId: idSchema,
  status: z.enum(["draft", "ready"]),
  steps: z.array(dataRecipeStepSchema).min(1).max(50),
}).strict().superRefine((recipe, context) => {
  const ids = recipe.steps.map((step) => step.id);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) context.addIssue({ code: "custom", path: ["steps"], message: `步骤 ID 不能重复：${duplicateIds.join("、")}` });

  const signatures = recipe.steps.map((step) => {
    const entries = Object.entries(step).filter(([key]) => key !== "id");
    return JSON.stringify(Object.fromEntries(entries));
  });
  const duplicateIndexes = signatures.flatMap((signature, index) => signatures.indexOf(signature) === index ? [] : [index]);
  duplicateIndexes.forEach((index) => context.addIssue({ code: "custom", path: ["steps", index], message: "存在语义完全重复的配方步骤" }));
});
