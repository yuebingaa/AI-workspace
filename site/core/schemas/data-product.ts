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
} from "@/core/models";
import { BAR_CHART_COLORS, CHART_TYPES, FONT_FAMILIES, FONT_WEIGHTS } from "@/core/models";
import { dataBindingSchema, dataSourceDefinitionSchema } from "./data-binding";
import { dataRecipeSchema } from "./data-recipe";
import { semanticLayerSchema } from "@/core/semantic/contracts";
import { notebookLayerSchema } from "@/core/notebook/contracts";

const idSchema = z.string().trim().min(1);
const textSchema = z.string();
const typographySchemaShape = {
  fontFamily: z.enum(FONT_FAMILIES).optional(),
  fontSize: z.number().int().min(8).max(72).optional(),
  fontColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "字体颜色必须是六位十六进制颜色").optional(),
  fontWeight: z.enum(FONT_WEIGHTS).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  textDecoration: z.enum(["none", "underline"]).optional(),
} as const;

export const componentPropsSchemas: {
  [TType in AppNodeType]: z.ZodType<ComponentPropsMap[TType]>;
} = {
  PageRoot: z.object({}).strict(),
  PageHeader: z.object({
    ...typographySchemaShape,
    eyebrow: textSchema,
    title: textSchema,
    description: textSchema,
    dateRange: textSchema,
  }).strict(),
  InsightBanner: z.object({
    ...typographySchemaShape,
    title: textSchema,
    description: textSchema,
    actionLabel: textSchema,
  }).strict(),
  MetricGrid: z.object({ columns: z.number().int().min(1).max(4) }).strict(),
  MetricCard: z.object({
    ...typographySchemaShape,
    label: textSchema,
    trend: textSchema,
    isNew: z.boolean().optional(),
    binding: dataBindingSchema,
  }).strict(),
  DashboardGrid: z.object({}).strict(),
  BarChart: z.object({
    ...typographySchemaShape,
    title: textSchema,
    subtitle: textSchema,
    color: z.enum(BAR_CHART_COLORS).optional(),
    chartType: z.enum(CHART_TYPES).optional(),
    showValues: z.boolean().optional(),
    binding: dataBindingSchema,
  }).strict(),
  DataHealth: z.object({
    ...typographySchemaShape,
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
    ...typographySchemaShape,
    title: textSchema,
    subtitle: textSchema,
    actionLabel: textSchema,
    density: z.enum(["comfortable", "compact"]).optional(),
    stripedRows: z.boolean().optional(),
    accentColor: z.enum(BAR_CHART_COLORS).optional(),
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
  // A new local project is genuinely empty. Bound components are still checked
  // by assertValidAppSpecDataBindings, so missing referenced sources remain invalid.
  dataSources: z.array(dataSourceDefinitionSchema),
  navigation: z.array(z.object({ id: idSchema, title: textSchema, pageId: idSchema }).strict()),
  pages: z.array(appPageSchema).min(1),
}).strict();

export const changeOperationSchema: z.ZodType<ChangeOperation> = z.discriminatedUnion("type", [
  z.object({
    id: idSchema,
    type: z.literal("addPage"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
    page: appPageSchema,
    navigationItem: z.object({ id: idSchema, title: textSchema, pageId: idSchema }).strict(),
  }).strict(),
  z.object({
    id: idSchema,
    type: z.literal("deletePage"),
    label: textSchema,
    description: textSchema,
    pageId: idSchema,
  }).strict(),
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
    workspaceId: idSchema.optional(),
    shared: z.boolean().optional(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    qualityScore: z.number().min(0).max(100),
    expiresAt: z.iso.datetime().optional(),
    ephemeral: z.boolean().optional(),
    sensitiveFieldCount: z.number().int().nonnegative().optional(),
    aiAccessPolicy: z.enum(["not-required", "pending", "masked", "exclude-sensitive-samples"]).optional(),
  }).strict()),
  recipes: z.array(dataRecipeSchema),
  semanticLayer: semanticLayerSchema.optional(),
  notebooks: notebookLayerSchema.optional(),
  appSpec: appSpecSchema,
}).strict();

export function parseComponentProps<TType extends AppNodeType>(
  type: TType,
  props: unknown,
): ComponentPropsMap[TType] {
  return componentPropsSchemas[type].parse(props);
}
