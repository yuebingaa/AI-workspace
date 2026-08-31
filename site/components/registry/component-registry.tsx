import { Children, type ReactNode } from "react";
import type { Field } from "@puckeditor/core";
import { BarChart, DataHealth, DataTable, MetricCard } from "@/components/data-components";
import type { AppNode, AppNodeType, ComponentPropsMap } from "@/core/models";
import { componentPropsSchemas } from "@/core/schemas";

interface ComponentDefinition<TType extends AppNodeType> {
  label: string;
  icon: string;
  propsSchema: typeof componentPropsSchemas[TType];
  render: (props: ComponentPropsMap[TType], children: ReactNode, nodeId: string) => ReactNode;
  editor?: {
    fields: Partial<{ [TProp in keyof ComponentPropsMap[TType]]: Field<ComponentPropsMap[TType][TProp]> }>;
    defaultProps: ComponentPropsMap[TType];
  };
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
    editor: {
      fields: {
        eyebrow: { type: "text", label: "页面标签" },
        title: { type: "text", label: "标题" },
        description: { type: "textarea", label: "页面说明" },
        dateRange: { type: "text", label: "日期范围" },
      },
      defaultProps: { eyebrow: "新页面", title: "数据分析", description: "输入页面说明", dateRange: "过去 12 个月" },
    },
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
    editor: {
      fields: {
        title: { type: "text", label: "洞察标题" },
        description: { type: "textarea", label: "洞察内容" },
        actionLabel: { type: "text", label: "按钮文字" },
      },
      defaultProps: { title: "AI 洞察", description: "输入洞察内容", actionLabel: "查看分析" },
    },
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
    editor: {
      fields: { columns: { type: "number", label: "默认列数", min: 1, max: 4 } },
      defaultProps: { columns: 3 },
    },
    render: (props, children, nodeId) => {
      const columnCount = Math.max(props.columns, Children.count(children));
      return <div className={`metrics columns-${Math.min(columnCount, 4)}`} data-node-id={nodeId}>{children}</div>;
    },
  },
  MetricCard: {
    label: "指标卡",
    icon: "◇",
    propsSchema: componentPropsSchemas.MetricCard,
    editor: {
      fields: {
        label: { type: "text", label: "指标名称" },
        value: { type: "text", label: "指标值" },
        trend: { type: "text", label: "趋势" },
        isNew: {
          type: "radio",
          label: "突出显示",
          options: [{ label: "否", value: false }, { label: "是", value: true }],
        },
      },
      defaultProps: { label: "新指标", value: "0", trend: "—", isNew: true },
    },
    render: (props) => <MetricCard {...props} />,
  },
  DashboardGrid: {
    label: "分析图表组",
    icon: "▦",
    propsSchema: componentPropsSchemas.DashboardGrid,
    editor: { fields: {}, defaultProps: {} },
    render: (_props, children, nodeId) => <div className="dash-grid" data-node-id={nodeId}>{children}</div>,
  },
  BarChart: {
    label: "月度收入趋势",
    icon: "⌁",
    propsSchema: componentPropsSchemas.BarChart,
    editor: {
      fields: {
        title: { type: "text", label: "图表标题" },
        subtitle: { type: "text", label: "图表说明" },
      },
      defaultProps: {
        title: "新增柱状图",
        subtitle: "模拟数据",
        labels: ["一月", "二月", "三月"],
        values: [48, 72, 61],
        yAxis: ["100", "75", "50", "25", "0"],
      },
    },
    render: (props) => <BarChart {...props} />,
  },
  DataHealth: {
    label: "数据健康度",
    icon: "◉",
    propsSchema: componentPropsSchemas.DataHealth,
    editor: {
      fields: {
        title: { type: "text", label: "组件标题" },
        subtitle: { type: "text", label: "刷新说明" },
        score: { type: "number", label: "健康分", min: 0, max: 100 },
      },
      defaultProps: {
        title: "数据健康度",
        subtitle: "模拟数据",
        score: 90,
        items: [
          { label: "完整性", value: "95%", status: "ok" },
          { label: "时效性", value: "88%", status: "warn" },
        ],
      },
    },
    render: (props) => <DataHealth {...props} />,
  },
  DataTable: {
    label: "区域表现表",
    icon: "▤",
    propsSchema: componentPropsSchemas.DataTable,
    editor: {
      fields: {
        title: { type: "text", label: "表格标题" },
        subtitle: { type: "text", label: "表格说明" },
        actionLabel: { type: "text", label: "操作按钮" },
      },
      defaultProps: {
        title: "新增数据表",
        subtitle: "模拟数据",
        actionLabel: "下载数据",
        columns: [{ key: "item", label: "项目" }, { key: "value", label: "数值" }],
        rows: [{ item: "示例", value: "100" }],
      },
    },
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
