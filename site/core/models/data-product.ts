export interface DatasetReference {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  qualityScore: number;
}

export type DataRecipeStep =
  | { id: string; type: "filter"; field: string; operator: string; value: string }
  | { id: string; type: "derive"; field: string; expression: string }
  | { id: string; type: "export"; format: "xlsx" | "csv" };

export interface DataRecipe {
  id: string;
  name: string;
  sourceDatasetId: string;
  status: "draft" | "ready";
  steps: DataRecipeStep[];
}

export interface PageHeaderProps { eyebrow: string; title: string; description: string; dateRange: string }
export interface InsightBannerProps { title: string; description: string; actionLabel: string }
export interface MetricGridProps { columns: number }
export interface MetricCardProps { label: string; value: string; trend: string; isNew?: boolean }
export interface BarChartProps { title: string; subtitle: string; labels: string[]; values: number[]; yAxis: string[] }
export interface DataHealthProps {
  title: string;
  subtitle: string;
  score: number;
  items: Array<{ label: string; value: string; status: "ok" | "warn" }>;
}
export interface DataTableProps {
  title: string;
  subtitle: string;
  actionLabel: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
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
  | (ChangeOperationBase & { type: "addNode"; parentId: string; node: AppNode; position?: number })
  | (ChangeOperationBase & { type: "updateNodeProps"; nodeId: string; props: Record<string, unknown> })
  | (ChangeOperationBase & { type: "removeNode"; nodeId: string });

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
  appSpec: AppSpec;
}
