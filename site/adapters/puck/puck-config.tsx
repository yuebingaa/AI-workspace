import type { ComponentConfig, Config, Fields } from "@puckeditor/core";
import { getComponentDefinition } from "@/components/registry/component-registry";
import type { AppNodeType, ComponentPropsMap } from "@/core/models";
import type { StudioPuckComponentProps, StudioPuckComponentType } from "./types";

type ContainerType = "MetricGrid" | "DashboardGrid";
type LeafType = Exclude<StudioPuckComponentType, ContainerType>;

function leafConfig<TType extends LeafType>(
  type: TType,
): ComponentConfig<{ props: StudioPuckComponentProps[TType] }> {
  const definition = getComponentDefinition(type as AppNodeType);
  const editor = definition.editor!;
  return {
    label: definition.label,
    fields: editor.fields as Fields<StudioPuckComponentProps[TType]>,
    defaultProps: editor.defaultProps as StudioPuckComponentProps[TType],
    render: (renderProps) => {
      const editableProps = { ...renderProps } as Record<string, unknown>;
      delete editableProps.id;
      delete editableProps.puck;
      delete editableProps.editMode;
      return <>{definition.render(editableProps as unknown as ComponentPropsMap[TType], null, renderProps.id)}</>;
    },
  };
}

const metricGridDefinition = getComponentDefinition("MetricGrid");
const dashboardGridDefinition = getComponentDefinition("DashboardGrid");

export const studioPuckConfig: Config<StudioPuckComponentProps> = {
  categories: {
    content: { title: "内容组件", components: ["PageHeader", "InsightBanner"] },
    metrics: { title: "指标组件", components: ["MetricGrid", "MetricCard"] },
    analysis: { title: "分析组件", components: ["BarChart", "DataHealth", "DataTable"] },
    layout: { title: "布局组件", components: ["DashboardGrid"] },
  },
  components: {
    PageHeader: leafConfig("PageHeader"),
    InsightBanner: leafConfig("InsightBanner"),
    MetricCard: leafConfig("MetricCard"),
    BarChart: leafConfig("BarChart"),
    DataHealth: leafConfig("DataHealth"),
    DataTable: leafConfig("DataTable"),
    MetricGrid: {
      label: metricGridDefinition.label,
      fields: {
        ...metricGridDefinition.editor!.fields,
        children: { type: "slot", allow: ["MetricCard"] },
      } as Fields<StudioPuckComponentProps["MetricGrid"]>,
      defaultProps: { ...metricGridDefinition.editor!.defaultProps, children: [] },
      render: ({ id, children: Children, columns }) => (
        <>{metricGridDefinition.render(
          { columns },
          <Children className="puck-metric-slot" collisionAxis="dynamic" minEmptyHeight={90} />,
          id,
        )}</>
      ),
    },
    DashboardGrid: {
      label: dashboardGridDefinition.label,
      fields: {
        children: { type: "slot", allow: ["BarChart", "DataHealth", "DataTable"] },
      },
      defaultProps: { children: [] },
      render: ({ id, children: Children }) => (
        <>{dashboardGridDefinition.render(
          {},
          <Children className="puck-dashboard-slot" collisionAxis="dynamic" minEmptyHeight={180} />,
          id,
        )}</>
      ),
    },
  },
};
