import { Children, type ReactNode } from "react";
import { BarChart, DataHealth, DataTable, MetricCard } from "@/components/data-components";
import type { AppNode, AppNodeType, ComponentPropsMap } from "@/core/models";
import { componentPropsSchemas } from "@/core/schemas";

interface ComponentDefinition<TType extends AppNodeType> {
  label: string;
  icon: string;
  propsSchema: typeof componentPropsSchemas[TType];
  render: (props: ComponentPropsMap[TType], children: ReactNode, nodeId: string) => ReactNode;
}

type ComponentRegistry = {
  [TType in AppNodeType]: ComponentDefinition<TType>;
};

export const componentRegistry: ComponentRegistry = {
  PageRoot: {
    label: "页面根节点",
    icon: "⌄",
    propsSchema: componentPropsSchemas.PageRoot,
    render: (_props, children) => <>{children}</>,
  },
  PageHeader: {
    label: "页面标题",
    icon: "▤",
    propsSchema: componentPropsSchemas.PageHeader,
    render: (props, _children, nodeId) => (
      <div className="dash-head" data-node-id={nodeId}>
        <div><span className="eyebrow">{props.eyebrow}</span><h1>{props.title}</h1><p>{props.description}</p></div>
        <div className="date-chip">{props.dateRange}　⌄</div>
      </div>
    ),
  },
  InsightBanner: {
    label: "AI 洞察",
    icon: "✦",
    propsSchema: componentPropsSchemas.InsightBanner,
    render: (props, _children, nodeId) => (
      <div className="ai-insight" data-node-id={nodeId}>
        <span className="spark">✦</span>
        <div><b>{props.title}</b><p>{props.description}</p></div>
        <button type="button">{props.actionLabel}</button>
      </div>
    ),
  },
  MetricGrid: {
    label: "核心指标组",
    icon: "▦",
    propsSchema: componentPropsSchemas.MetricGrid,
    render: (props, children, nodeId) => {
      const columnCount = Math.max(props.columns, Children.count(children));
      return <div className={`metrics columns-${Math.min(columnCount, 4)}`} data-node-id={nodeId}>{children}</div>;
    },
  },
  MetricCard: {
    label: "指标卡",
    icon: "◇",
    propsSchema: componentPropsSchemas.MetricCard,
    render: (props) => <MetricCard {...props} />,
  },
  DashboardGrid: {
    label: "分析图表组",
    icon: "▦",
    propsSchema: componentPropsSchemas.DashboardGrid,
    render: (_props, children, nodeId) => <div className="dash-grid" data-node-id={nodeId}>{children}</div>,
  },
  BarChart: {
    label: "月度收入趋势",
    icon: "⌁",
    propsSchema: componentPropsSchemas.BarChart,
    render: (props) => <BarChart {...props} />,
  },
  DataHealth: {
    label: "数据健康度",
    icon: "◉",
    propsSchema: componentPropsSchemas.DataHealth,
    render: (props) => <DataHealth {...props} />,
  },
  DataTable: {
    label: "区域表现表",
    icon: "▤",
    propsSchema: componentPropsSchemas.DataTable,
    render: (props) => <DataTable {...props} />,
  },
};

export function getComponentDefinition<TType extends AppNodeType>(type: TType): ComponentDefinition<TType> {
  return componentRegistry[type];
}

export function renderRegisteredNode(node: AppNode, children: ReactNode): ReactNode {
  const definition = getComponentDefinition(node.type) as ComponentDefinition<AppNodeType>;
  return definition.render(node.props, children, node.id);
}
