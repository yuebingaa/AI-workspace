import { Children, type ReactNode, useEffect, useMemo } from "react";
import type { Field } from "@puckeditor/core";
import { BarChart, DataHealth, DataTable, MetricCard } from "@/components/data-components";
import { executeRecordedBinding } from "@/core/data";
import type { AppNode, AppNodeType, ComponentPropsMap, DataBinding, DataSourceDefinition, LocalDataRuntime, QueryComponentKind, QueryExecutionRecord } from "@/core/models";
import { componentPropsSchemas } from "@/core/schemas";
import { componentTypographyStyle } from "@/components/data-components/typography";

export interface ComponentRenderContext {
  dataSources: DataSourceDefinition[];
  dataRuntime: LocalDataRuntime;
  pageId: string;
  queryRevision: string;
  onQueryExecuted?: (record: QueryExecutionRecord) => void;
  highlightedNodeIds?: string[];
  changeFeedback?: "preview" | "applied";
}

interface ComponentDefinition<TType extends AppNodeType> {
  label: string;
  icon: string;
  propsSchema: typeof componentPropsSchemas[TType];
  render: (props: ComponentPropsMap[TType], children: ReactNode, nodeId: string, context: ComponentRenderContext) => ReactNode;
  dataBinding?: "metric" | "chart" | "table";
  editor?: {
    fields: Partial<{ [TProp in keyof ComponentPropsMap[TType]]: Field<ComponentPropsMap[TType][TProp]> }>;
    defaultProps: ComponentPropsMap[TType];
  };
}

const defaultBinding: DataBinding = {
  dataSourceId: "dataset_retail_orders",
  field: "revenue",
  aggregation: "sum",
  groupBy: null,
  filters: [],
  sort: [],
  limit: 12,
  format: { style: "number", decimals: 0 },
};

const typographyFields = {
  fontFamily: { type: "select", label: "字体", options: [
    { label: "系统默认", value: "system" },
    { label: "微软雅黑", value: "yahei" },
    { label: "Arial", value: "arial" },
    { label: "宋体", value: "serif" },
    { label: "等宽字体", value: "monospace" },
  ] },
  fontSize: { type: "number", label: "字号", min: 8, max: 72 },
  fontColor: { type: "text", label: "字体颜色（#RRGGBB）" },
  fontWeight: { type: "select", label: "字重", options: [
    { label: "常规", value: "regular" },
    { label: "中等", value: "medium" },
    { label: "半粗", value: "semibold" },
    { label: "加粗", value: "bold" },
  ] },
  fontStyle: { type: "select", label: "字形", options: [{ label: "正常", value: "normal" }, { label: "斜体", value: "italic" }] },
  textDecoration: { type: "select", label: "文字装饰", options: [{ label: "无", value: "none" }, { label: "下划线", value: "underline" }] },
} as const;

const defaultTypography = {
  fontFamily: "system",
  fontSize: 16,
  fontColor: "#10211d",
  fontWeight: "semibold",
  fontStyle: "normal",
  textDecoration: "none",
} as const;

function bindingError(nodeId: string, error: unknown) {
  return (
    <article className="data-binding-error" data-node-id={nodeId} role="alert">
      <b>数据绑定无效</b>
      <p>{error instanceof Error ? error.message : "无法计算当前组件的数据"}</p>
    </article>
  );
}

function nodeChangeFeedback(nodeId: string, context: ComponentRenderContext) {
  return context.highlightedNodeIds?.includes(nodeId) ? context.changeFeedback : undefined;
}

function useRecordedBinding<TKind extends QueryComponentKind>(
  kind: TKind,
  binding: DataBinding,
  nodeId: string,
  context: ComponentRenderContext,
) {
  const bindingKey = JSON.stringify(binding);
  const semanticBinding = useMemo(() => JSON.parse(bindingKey) as DataBinding, [bindingKey]);
  const execution = useMemo(() => executeRecordedBinding(
    kind,
    semanticBinding,
    context.dataSources,
    context.dataRuntime,
    { componentId: nodeId, pageId: context.pageId, revision: context.queryRevision },
  ), [context.dataRuntime, context.dataSources, context.pageId, context.queryRevision, kind, nodeId, semanticBinding]);
  const onQueryExecuted = context.onQueryExecuted;
  useEffect(() => {
    onQueryExecuted?.(execution.record);
  }, [execution.record, onQueryExecuted]);
  return execution;
}

function BoundMetricCard({ props, nodeId, context }: { props: ComponentPropsMap["MetricCard"]; nodeId: string; context: ComponentRenderContext }) {
  const execution = useRecordedBinding("metric", props.binding, nodeId, context);
  if (!execution.success) return bindingError(nodeId, execution.error);
  return <MetricCard {...props} value={execution.result.value} nodeId={nodeId} changeFeedback={nodeChangeFeedback(nodeId, context)} />;
}

function BoundBarChart({ props, nodeId, context }: { props: ComponentPropsMap["BarChart"]; nodeId: string; context: ComponentRenderContext }) {
  const execution = useRecordedBinding("chart", props.binding, nodeId, context);
  if (!execution.success) return bindingError(nodeId, execution.error);
  return <BarChart {...props} {...execution.result} nodeId={nodeId} changeFeedback={nodeChangeFeedback(nodeId, context)} />;
}

function BoundDataTable({ props, nodeId, context }: { props: ComponentPropsMap["DataTable"]; nodeId: string; context: ComponentRenderContext }) {
  const execution = useRecordedBinding("table", props.binding, nodeId, context);
  if (!execution.success) return bindingError(nodeId, execution.error);
  return <DataTable {...props} {...execution.result} nodeId={nodeId} changeFeedback={nodeChangeFeedback(nodeId, context)} />;
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
        ...typographyFields,
        eyebrow: { type: "text", label: "页面标签" },
        title: { type: "text", label: "标题" },
        description: { type: "textarea", label: "页面说明" },
        dateRange: { type: "text", label: "日期范围" },
      },
      defaultProps: { eyebrow: "新页面", title: "数据分析", description: "输入页面说明", dateRange: "过去 12 个月", ...defaultTypography, fontSize: 38, fontWeight: "regular" },
    },
    render: (props, _children, nodeId, context) => (
      <div className="dash-head" data-node-id={nodeId} data-change-feedback={nodeChangeFeedback(nodeId, context)}>
        <div><span className="eyebrow">{props.eyebrow}</span><h1 style={componentTypographyStyle(props)}>{props.title}</h1><p>{props.description}</p></div>
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
        ...typographyFields,
        title: { type: "text", label: "洞察标题" },
        description: { type: "textarea", label: "洞察内容" },
        actionLabel: { type: "text", label: "按钮文字" },
      },
      defaultProps: { title: "AI 洞察", description: "输入洞察内容", actionLabel: "查看分析", ...defaultTypography },
    },
    render: (props, _children, nodeId, context) => (
      <div className="ai-insight" data-node-id={nodeId} data-change-feedback={nodeChangeFeedback(nodeId, context)}>
        <span className="spark">✦</span>
        <div><b style={componentTypographyStyle(props)}>{props.title}</b><p>{props.description}</p></div>
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
    render: (props, children, nodeId, context) => {
      const columnCount = Math.max(props.columns, Children.count(children));
      return <div className={`metrics columns-${Math.min(columnCount, 4)}`} data-node-id={nodeId} data-change-feedback={nodeChangeFeedback(nodeId, context)}>{children}</div>;
    },
  },
  MetricCard: {
    label: "指标卡",
    icon: "◇",
    dataBinding: "metric",
    propsSchema: componentPropsSchemas.MetricCard,
    editor: {
      fields: {
        ...typographyFields,
        label: { type: "text", label: "指标名称" },
        trend: { type: "text", label: "趋势" },
        isNew: {
          type: "radio",
          label: "突出显示",
          options: [{ label: "否", value: false }, { label: "是", value: true }],
        },
      },
      defaultProps: { label: "新指标", trend: "—", isNew: true, binding: structuredClone(defaultBinding), ...defaultTypography, fontSize: 13 },
    },
    render: (props, _children, nodeId, context) => <BoundMetricCard props={props} nodeId={nodeId} context={context} />,
  },
  DashboardGrid: {
    label: "分析图表组",
    icon: "▦",
    propsSchema: componentPropsSchemas.DashboardGrid,
    editor: { fields: {}, defaultProps: {} },
    render: (_props, children, nodeId, context) => <div className="dash-grid" data-node-id={nodeId} data-change-feedback={nodeChangeFeedback(nodeId, context)}>{children}</div>,
  },
  BarChart: {
    label: "数据图表",
    icon: "⌁",
    dataBinding: "chart",
    propsSchema: componentPropsSchemas.BarChart,
    editor: {
      fields: {
        ...typographyFields,
        title: { type: "text", label: "图表标题" },
        subtitle: { type: "text", label: "图表说明" },
        chartType: {
          type: "select",
          label: "图表类型",
          options: [
            { label: "柱状图", value: "bar" },
            { label: "折线图", value: "line" },
            { label: "面积图", value: "area" },
            { label: "饼图", value: "pie" },
            { label: "环形图", value: "donut" },
          ],
        },
        color: {
          type: "select",
          label: "柱形颜色",
          options: [
            { label: "绿色", value: "green" },
            { label: "蓝色", value: "blue" },
            { label: "紫色", value: "violet" },
            { label: "橙色", value: "orange" },
            { label: "红色", value: "red" },
            { label: "青色", value: "teal" },
          ],
        },
        showValues: {
          type: "radio",
          label: "柱顶数值",
          options: [{ label: "隐藏", value: false }, { label: "显示", value: true }],
        },
      },
      defaultProps: {
        title: "新增柱状图",
        subtitle: "绑定本地数据",
        chartType: "bar",
        color: "green",
        showValues: false,
        ...defaultTypography,
        binding: { ...structuredClone(defaultBinding), groupBy: "month" },
      },
    },
    render: (props, _children, nodeId, context) => <BoundBarChart props={props} nodeId={nodeId} context={context} />,
  },
  DataHealth: {
    label: "数据健康度",
    icon: "◉",
    propsSchema: componentPropsSchemas.DataHealth,
    editor: {
      fields: {
        ...typographyFields,
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
        ...defaultTypography,
      },
    },
    render: (props, _children, nodeId, context) => <DataHealth {...props} nodeId={nodeId} changeFeedback={nodeChangeFeedback(nodeId, context)} />,
  },
  DataTable: {
    label: "区域表现表",
    icon: "▤",
    dataBinding: "table",
    propsSchema: componentPropsSchemas.DataTable,
    editor: {
      fields: {
        ...typographyFields,
        title: { type: "text", label: "表格标题" },
        subtitle: { type: "text", label: "表格说明" },
        actionLabel: { type: "text", label: "操作按钮" },
        density: { type: "select", label: "行距", options: [{ label: "舒适", value: "comfortable" }, { label: "紧凑", value: "compact" }] },
        stripedRows: { type: "select", label: "斑马纹", options: [{ label: "关闭", value: false }, { label: "开启", value: true }] },
        accentColor: { type: "select", label: "强调色", options: [
          { label: "绿色", value: "green" },
          { label: "蓝色", value: "blue" },
          { label: "紫色", value: "violet" },
          { label: "橙色", value: "orange" },
          { label: "红色", value: "red" },
          { label: "青色", value: "teal" },
        ] },
      },
      defaultProps: {
        title: "新增数据表",
        subtitle: "绑定本地数据",
        actionLabel: "下载数据",
        density: "comfortable",
        stripedRows: false,
        accentColor: "green",
        ...defaultTypography,
        binding: {
          ...structuredClone(defaultBinding),
          groupBy: "region",
          limit: 5,
          columns: [
            { field: "region", label: "区域", aggregation: "none", format: { style: "text" } },
            { field: "revenue", label: "收入", aggregation: "sum", format: { style: "currency", currency: "CNY", decimals: 0 } },
          ],
        },
      },
    },
    render: (props, _children, nodeId, context) => <BoundDataTable props={props} nodeId={nodeId} context={context} />,
  },
};

export function getComponentDefinition<TType extends AppNodeType>(type: TType): ComponentDefinition<TType> {
  return componentRegistry[type];
}

export function renderRegisteredNode(node: AppNode, children: ReactNode, context: ComponentRenderContext): ReactNode {
  const definition = getComponentDefinition(node.type) as ComponentDefinition<AppNodeType>;
  return definition.render(node.props, children, node.id, context);
}
