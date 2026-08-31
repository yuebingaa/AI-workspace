import type { Data, Slot } from "@puckeditor/core";
import type {
  BarChartProps,
  DataHealthProps,
  DataTableProps,
  InsightBannerProps,
  MetricCardProps,
  MetricGridProps,
  PageHeaderProps,
} from "@/core/models";

export interface StudioPuckComponentProps {
  PageHeader: PageHeaderProps;
  InsightBanner: InsightBannerProps;
  MetricCard: MetricCardProps;
  MetricGrid: MetricGridProps & { children: Slot };
  DashboardGrid: { children: Slot };
  BarChart: BarChartProps;
  DataHealth: DataHealthProps;
  DataTable: DataTableProps;
}

export type StudioPuckData = Data<StudioPuckComponentProps>;
export type StudioPuckComponentType = keyof StudioPuckComponentProps;
