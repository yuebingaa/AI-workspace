import type { ComponentConfig, Config, Field, Fields } from "@puckeditor/core";
import { getComponentDefinition, type ComponentRenderContext } from "@/components/registry/component-registry";
import { compatibleAggregations, compatibleFields } from "@/core/data";
import type {
  AppNodeType,
  ComponentPropsMap,
  DataAggregation,
  DataBinding,
  DataColumnBinding,
  DataFormat,
  DataSourceDefinition,
  LocalDataRuntime,
} from "@/core/models";
import type { StudioPuckComponentProps, StudioPuckComponentType } from "./types";

type ContainerType = "MetricGrid" | "DashboardGrid";
type LeafType = Exclude<StudioPuckComponentType, ContainerType>;
type BindingKind = "metric" | "chart" | "table";

const aggregationLabels: Record<DataAggregation, string> = {
  none: "原始值", sum: "求和", average: "平均值", count: "计数",
  countDistinct: "去重计数", min: "最小值", max: "最大值",
};

function defaultColumn(field: DataSourceDefinition["fields"][number], groupBy: string | null): DataColumnBinding {
  const aggregation: DataAggregation = field.name === groupBy
    ? "none"
    : field.type === "number"
      ? (field.name.includes("rate") || field.name.includes("average") ? "average" : "sum")
      : "none";
  const format: DataFormat = field.name.includes("rate")
    ? { style: "percent", decimals: 1 }
    : field.type === "number"
      ? { style: "number", decimals: 0 }
      : { style: "text" };
  return { field: field.name, label: field.label, aggregation, format };
}

function DataBindingField({ value, onChange, readOnly, kind, dataSources }: {
  value: DataBinding;
  onChange: (value: DataBinding) => void;
  readOnly?: boolean;
  kind: BindingKind;
  dataSources: DataSourceDefinition[];
}) {
  const source = dataSources.find((item) => item.id === value.dataSourceId) ?? dataSources[0];
  const measureFields = compatibleFields(source, "measure");
  const groupFields = compatibleFields(source, "group");
  const selectedField = source?.fields.find((field) => field.name === value.field) ?? measureFields[0];
  const aggregations = compatibleAggregations(selectedField);
  const update = (patch: Partial<DataBinding>) => onChange({ ...value, ...patch });

  function changeSource(dataSourceId: string) {
    const nextSource = dataSources.find((item) => item.id === dataSourceId) ?? dataSources[0];
    const nextMeasure = compatibleFields(nextSource, "measure")[0];
    const nextGroup = compatibleFields(nextSource, "group")[0];
    if (!nextSource || !nextMeasure) return;
    update({
      dataSourceId: nextSource.id,
      field: nextMeasure.name,
      aggregation: nextMeasure.supportedAggregations.includes("sum") ? "sum" : nextMeasure.supportedAggregations[0],
      groupBy: kind === "metric" ? null : nextGroup?.name ?? null,
      filters: [],
      sort: [],
      columns: kind === "table" ? nextSource.fields.slice(0, 3).map((field) => defaultColumn(field, nextGroup?.name ?? null)) : undefined,
    });
  }

  function changeField(fieldName: string) {
    const field = source?.fields.find((item) => item.name === fieldName);
    if (!field) return;
    update({
      field: field.name,
      aggregation: field.supportedAggregations.includes(value.aggregation) ? value.aggregation : field.supportedAggregations[0],
    });
  }

  function toggleColumn(fieldName: string, checked: boolean) {
    if (!source) return;
    const current = value.columns ?? [];
    if (!checked) {
      if (current.length > 1) update({ columns: current.filter((column) => column.field !== fieldName) });
      return;
    }
    const field = source.fields.find((item) => item.name === fieldName);
    if (field && !current.some((column) => column.field === fieldName)) {
      update({ columns: [...current, defaultColumn(field, value.groupBy)] });
    }
  }

  return (
    <div className="puck-binding-field">
      <label>数据源<select disabled={readOnly} value={source?.id ?? ""} onChange={(event) => changeSource(event.target.value)}>
        {dataSources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>数值字段<select disabled={readOnly} value={selectedField?.name ?? ""} onChange={(event) => changeField(event.target.value)}>
        {measureFields.map((field) => <option key={field.name} value={field.name}>{field.label} · {field.type}</option>)}
      </select></label>
      <label>聚合方式<select disabled={readOnly} value={value.aggregation} onChange={(event) => update({ aggregation: event.target.value as DataAggregation })}>
        {aggregations.map((aggregation) => <option key={aggregation} value={aggregation}>{aggregationLabels[aggregation]}</option>)}
      </select></label>
      {kind !== "metric" && <label>分组字段<select disabled={readOnly} value={value.groupBy ?? ""} onChange={(event) => update({ groupBy: event.target.value || null })}>
        {kind === "table" && <option value="">不分组</option>}
        {groupFields.map((field) => <option key={field.name} value={field.name}>{field.label} · {field.type}</option>)}
      </select></label>}
      <label>显示格式<select disabled={readOnly} value={value.format.style} onChange={(event) => update({ format: { ...value.format, style: event.target.value as DataFormat["style"] } })}>
        <option value="auto">自动</option><option value="number">数值</option><option value="currency">货币</option><option value="percent">百分比</option><option value="text">文本</option>
      </select></label>
      {kind === "table" && source && (
        <fieldset disabled={readOnly}><legend>表格列</legend>{source.fields.map((field) => (
          <label className="puck-binding-check" key={field.name}>
            <input type="checkbox" checked={value.columns?.some((column) => column.field === field.name) ?? false} onChange={(event) => toggleColumn(field.name, event.target.checked)} />
            {field.label}<small>{field.type}</small>
          </label>
        ))}</fieldset>
      )}
      <small className="puck-binding-note">字段选项来自 AppSpec 数据目录；编辑结果需生成 ChangeSet 后应用。</small>
    </div>
  );
}

function bindingField(kind: BindingKind, dataSources: DataSourceDefinition[]): Field<DataBinding> {
  return {
    type: "custom",
    label: "数据绑定",
    render: ({ value, onChange, readOnly }) => <DataBindingField value={value} onChange={onChange} readOnly={readOnly} kind={kind} dataSources={dataSources} />,
  };
}

function leafConfig<TType extends LeafType>(type: TType, context: ComponentRenderContext): ComponentConfig<{ props: StudioPuckComponentProps[TType] }> {
  const definition = getComponentDefinition(type as AppNodeType);
  const editor = definition.editor!;
  return {
    label: definition.label,
    fields: {
      ...editor.fields,
      ...(definition.dataBinding ? { binding: bindingField(definition.dataBinding, context.dataSources) } : {}),
    } as Fields<StudioPuckComponentProps[TType]>,
    defaultProps: editor.defaultProps as StudioPuckComponentProps[TType],
    render: (renderProps) => {
      const editableProps = { ...renderProps } as Record<string, unknown>;
      delete editableProps.id;
      delete editableProps.puck;
      delete editableProps.editMode;
      return <>{definition.render(editableProps as unknown as ComponentPropsMap[TType], null, renderProps.id, context)}</>;
    },
  };
}

export function createStudioPuckConfig(
  dataSources: DataSourceDefinition[],
  dataRuntime: LocalDataRuntime,
  pageId: string,
  queryRevision: string,
  onQueryExecuted?: ComponentRenderContext["onQueryExecuted"],
): Config<StudioPuckComponentProps> {
  const context: ComponentRenderContext = { dataSources, dataRuntime, pageId, queryRevision, onQueryExecuted };
  const metricGridDefinition = getComponentDefinition("MetricGrid");
  const dashboardGridDefinition = getComponentDefinition("DashboardGrid");
  return {
    categories: {
      content: { title: "内容组件", components: ["PageHeader", "InsightBanner"] },
      metrics: { title: "指标组件", components: ["MetricGrid", "MetricCard"] },
      analysis: { title: "分析组件", components: ["BarChart", "DataHealth", "DataTable"] },
      layout: { title: "布局组件", components: ["DashboardGrid"] },
    },
    components: {
      PageHeader: leafConfig("PageHeader", context), InsightBanner: leafConfig("InsightBanner", context),
      MetricCard: leafConfig("MetricCard", context), BarChart: leafConfig("BarChart", context),
      DataHealth: leafConfig("DataHealth", context), DataTable: leafConfig("DataTable", context),
      MetricGrid: {
        label: metricGridDefinition.label,
        fields: { ...metricGridDefinition.editor!.fields, children: { type: "slot", allow: ["MetricCard"] } } as Fields<StudioPuckComponentProps["MetricGrid"]>,
        defaultProps: { ...metricGridDefinition.editor!.defaultProps, children: [] },
        render: ({ id, children: Children, columns }) => <>{metricGridDefinition.render(
          { columns }, <Children className="puck-metric-slot" collisionAxis="dynamic" minEmptyHeight={90} />, id, context,
        )}</>,
      },
      DashboardGrid: {
        label: dashboardGridDefinition.label,
        fields: { children: { type: "slot", allow: ["BarChart", "DataHealth", "DataTable"] } },
        defaultProps: { children: [] },
        render: ({ id, children: Children }) => <>{dashboardGridDefinition.render(
          {}, <Children className="puck-dashboard-slot" collisionAxis="dynamic" minEmptyHeight={180} />, id, context,
        )}</>,
      },
    },
  };
}
