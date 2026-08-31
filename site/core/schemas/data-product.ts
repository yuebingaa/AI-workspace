import { z } from "zod";
import type {
  AppNode,
  AppNodeType,
  AppPage,
  AppSpec,
  ChangeOperation,
  ChangeSet,
  ComponentPropsMap,
  DataProduct,
  DataRecipe,
} from "@/core/models";
import { dataBindingSchema, dataSourceDefinitionSchema } from "./data-binding";

const idSchema = z.string().trim().min(1);
const textSchema = z.string();

export const componentPropsSchemas: {
  [TType in AppNodeType]: z.ZodType<ComponentPropsMap[TType]>;
} = {
  PageRoot: z.object({}).strict(),
  PageHeader: z.object({
    eyebrow: textSchema,
    title: textSchema,
    description: textSchema,
    dateRange: textSchema,
  }).strict(),
  InsightBanner: z.object({
    title: textSchema,
    description: textSchema,
    actionLabel: textSchema,
  }).strict(),
  MetricGrid: z.object({ columns: z.number().int().min(1).max(4) }).strict(),
  MetricCard: z.object({
    label: textSchema,
    trend: textSchema,
    isNew: z.boolean().optional(),
    binding: dataBindingSchema,
  }).strict(),
  DashboardGrid: z.object({}).strict(),
  BarChart: z.object({
    title: textSchema,
    subtitle: textSchema,
    binding: dataBindingSchema,
  }).strict(),
  DataHealth: z.object({
    title: textSchema,
    subtitle: textSchema,
    score: z.number().min(0).max(100),
    items: z.array(z.object({
      label: textSchema,
      value: textSchema,
      status: z.enum(["ok", "warn"]),
    }).strict()),
  }).strict(),
  DataTable: z.object({
    title: textSchema,
    subtitle: textSchema,
    actionLabel: textSchema,
    binding: dataBindingSchema,
  }).strict(),
};

function nodeSchema<TType extends AppNodeType>(type: TType) {
  return z.object({
    id: idSchema,
    type: z.literal(type),
    props: componentPropsSchemas[type],
    children: z.array(z.lazy(() => appNodeSchema)).optional(),
  }).strict();
}

export const appNodeSchema: z.ZodType<AppNode> = z.lazy(() => z.discriminatedUnion("type", [
  nodeSchema("PageRoot"),
  nodeSchema("PageHeader"),
  nodeSchema("InsightBanner"),
  nodeSchema("MetricGrid"),
  nodeSchema("MetricCard"),
  nodeSchema("DashboardGrid"),
  nodeSchema("BarChart"),
  nodeSchema("DataHealth"),
  nodeSchema("DataTable"),
])) as z.ZodType<AppNode>;

export const appPageSchema: z.ZodType<AppPage> = z.object({
  id: idSchema,
  title: textSchema,
  route: z.string().startsWith("/"),
  root: appNodeSchema,
}).strict();

export const appSpecSchema: z.ZodType<AppSpec> = z.object({
  id: idSchema,
  siteId: idSchema,
  schemaVersion: z.literal("1.0"),
  dataSources: z.array(dataSourceDefinitionSchema).min(1),
  navigation: z.array(z.object({ id: idSchema, title: textSchema, pageId: idSchema }).strict()),
  pages: z.array(appPageSchema).min(1),
}).strict();

export const dataRecipeSchema: z.ZodType<DataRecipe> = z.object({
  id: idSchema,
  name: textSchema,
  sourceDatasetId: idSchema,
  status: z.enum(["draft", "ready"]),
  steps: z.array(z.discriminatedUnion("type", [
    z.object({ id: idSchema, type: z.literal("filter"), field: idSchema, operator: textSchema, value: textSchema }).strict(),
    z.object({ id: idSchema, type: z.literal("derive"), field: idSchema, expression: textSchema }).strict(),
    z.object({ id: idSchema, type: z.literal("export"), format: z.enum(["xlsx", "csv"]) }).strict(),
  ])),
}).strict();

export const changeOperationSchema: z.ZodType<ChangeOperation> = z.discriminatedUnion("type", [
  z.object({
    id: idSchema,
    type: z.literal("addNode"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    parentId: idSchema,
    node: appNodeSchema,
    position: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("updateNodeProps"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    nodeId: idSchema,
    props: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("removeNode"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    nodeId: idSchema,
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("moveNode"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    nodeId: idSchema,
    parentId: idSchema,
    position: z.number().int().min(0),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("updatePage"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    title: textSchema.optional(),
    route: z.string().startsWith("/").optional(),
  }).strict(),
]) as z.ZodType<ChangeOperation>;

export const changeSetSchema: z.ZodType<ChangeSet> = z.object({
  id: idSchema,
  title: textSchema,
  status: z.enum(["draft", "ready"]),
  operations: z.array(changeOperationSchema).min(1),
}).strict();

export const dataProductSchema: z.ZodType<DataProduct> = z.object({
  id: idSchema,
  name: textSchema,
  schemaVersion: z.literal("1.0"),
  datasets: z.array(z.object({
    id: idSchema,
    name: textSchema,
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    qualityScore: z.number().min(0).max(100),
  }).strict()),
  recipes: z.array(dataRecipeSchema),
  appSpec: appSpecSchema,
}).strict();

export function parseComponentProps<TType extends AppNodeType>(
  type: TType,
  props: unknown,
): ComponentPropsMap[TType] {
  return componentPropsSchemas[type].parse(props);
}
