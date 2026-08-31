import { BarChart, DataHealth, DataTable, MetricCard } from "@/components/data-components";
import type { AppNode } from "@/core/models";

export function AppSpecRenderer({ node }: { node: AppNode }) {
  switch (node.type) {
    case "PageRoot":
      return <>{node.children?.map((child) => <AppSpecRenderer key={child.id} node={child} />)}</>;
    case "PageHeader":
      return (
        <div className="dash-head" data-node-id={node.id}>
          <div>
            <span className="eyebrow">{node.props.eyebrow}</span>
            <h1>{node.props.title}</h1>
            <p>{node.props.description}</p>
          </div>
          <div className="date-chip">{node.props.dateRange}　⌄</div>
        </div>
      );
    case "InsightBanner":
      return (
        <div className="ai-insight" data-node-id={node.id}>
          <span className="spark">✦</span>
          <div><b>{node.props.title}</b><p>{node.props.description}</p></div>
          <button type="button">{node.props.actionLabel}</button>
        </div>
      );
    case "MetricGrid": {
      const columnCount = Math.max(node.props.columns, node.children?.length ?? 0);
      return (
        <div className={`metrics columns-${Math.min(columnCount, 4)}`} data-node-id={node.id}>
          {node.children?.map((child) => <AppSpecRenderer key={child.id} node={child} />)}
        </div>
      );
    }
    case "MetricCard":
      return <MetricCard {...node.props} />;
    case "DashboardGrid":
      return (
        <div className="dash-grid" data-node-id={node.id}>
          {node.children?.map((child) => <AppSpecRenderer key={child.id} node={child} />)}
        </div>
      );
    case "BarChart":
      return <BarChart {...node.props} />;
    case "DataHealth":
      return <DataHealth {...node.props} />;
    case "DataTable":
      return <DataTable {...node.props} />;
  }
}
