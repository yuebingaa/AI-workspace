import type { DataBinding, DataSourceDefinition } from "./data-binding";
import type { DataRecipe } from "./data-recipe";
import type { SemanticLayer } from "@/core/semantic/contracts";
import type { NotebookDocument } from "@/core/notebook/contracts";

export interface DatasetReference {
  id: string;
  name: string;
  workspaceId?: string;
  shared?: boolean;
  rowCount: number;
  columnCount: number;
  qualityScore: number;
  expiresAt?: string;
  ephemeral?: boolean;
  sensitiveFieldCount?: number;
  aiAccessPolicy?: "not-required" | "pending" | "masked" | "exclude-sensitive-samples";
}

export const FONT_FAMILIES = ["system", "yahei", "arial", "serif", "monospace"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const FONT_WEIGHTS = ["regular", "medium", "semibold", "bold"] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export interface TypographyProps {
  fontFamily?: FontFamily;
  fontSize?: number;
  fontColor?: string;
  fontWeight?: FontWeight;
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
}

export interface PageHeaderProps extends TypographyProps { eyebrow: string; title: string; description: string; dateRange: string }
export interface InsightBannerProps extends TypographyProps { title: string; description: string; actionLabel: string }
export interface MetricGridProps { columns: number }
export interface MetricCardProps extends TypographyProps { label: string; trend: string; isNew?: boolean; binding: DataBinding }
export const BAR_CHART_COLORS = ["green", "blue", "violet", "orange", "red", "teal"] as const;
export type BarChartColor = (typeof BAR_CHART_COLORS)[number];
export const CHART_TYPES = ["bar", "line", "area", "pie", "donut"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export interface BarChartProps extends TypographyProps {
  title: string;
  subtitle: string;
  color?: BarChartColor;
  chartType?: ChartType;
  showValues?: boolean;
  binding: DataBinding;
}
export interface DataHealthProps extends TypographyProps {
  title: string;
  subtitle: string;
  score: number;
  items: Array<{ label: string; value: string; status: "ok" | "warn" }>;
}
export interface DataTableProps extends TypographyProps {
  title: string;
  subtitle: string;
  actionLabel: string;
  density?: "comfortable" | "compact";
  stripedRows?: boolean;
  accentColor?: BarChartColor;
  binding: DataBinding;
}

export type EmptyComponentProps = Record<never, never>;

export interface ComponentPropsMap {
  PageRoot: EmptyComponentProps;
  PageHeader: PageHeaderProps;
  InsightBanner: InsightBannerProps;
  MetricGrid: MetricGridProps;
  MetricCard: MetricCardProps;
  DashboardGrid: EmptyComponentProps;
  BarChart: BarChartProps;
  DataHealth: DataHealthProps;
  DataTable: DataTableProps;
}

export type AppNodeType = keyof ComponentPropsMap;

interface TypedAppNode<TType extends AppNodeType> {
  id: string;
  type: TType;
  props: ComponentPropsMap[TType];
  children?: AppNode[];
}

export type AppNode = { [TType in AppNodeType]: TypedAppNode<TType> }[AppNodeType];

export interface AppPage { id: string; title: string; route: string; root: AppNode }
export interface NavigationItem { id: string; title: string; pageId: string }
export interface AppSpec {
  id: string;
  siteId: string;
  schemaVersion: "1.0";
  dataSources: DataSourceDefinition[];
  navigation: NavigationItem[];
  pages: AppPage[];
}

interface ChangeOperationBase {
  id: string;
  label: string;
  description: string;
  pageId: string;
}

export type ChangeOperation =
  | (ChangeOperationBase & { type: "addPage"; page: AppPage; navigationItem: NavigationItem })
  | (ChangeOperationBase & { type: "deletePage" })
  | (ChangeOperationBase & { type: "addNode"; parentId: string; node: AppNode; position?: number })
  | (ChangeOperationBase & { type: "updateNodeProps"; nodeId: string; props: Record<string, unknown> })
  | (ChangeOperationBase & { type: "removeNode"; nodeId: string })
  | (ChangeOperationBase & { type: "moveNode"; nodeId: string; parentId: string; position: number })
  | (ChangeOperationBase & { type: "updatePage"; title?: string; route?: string });

export interface ChangeSet {
  id: string;
  title: string;
  status: "draft" | "ready";
  operations: ChangeOperation[];
}

export interface DataProduct {
  id: string;
  name: string;
  schemaVersion: "1.0";
  datasets: DatasetReference[];
  recipes: DataRecipe[];
  semanticLayer?: SemanticLayer;
  notebooks?: Record<string, NotebookDocument>;
  appSpec: AppSpec;
}
