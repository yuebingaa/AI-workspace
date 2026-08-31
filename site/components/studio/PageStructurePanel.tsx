import type { AppNode, AppPage, AppSpec, DataProduct } from "@/core/models";

const nodeLabels: Record<AppNode["type"], string> = {
  PageRoot: "页面根节点",
  PageHeader: "页面标题",
  InsightBanner: "AI 洞察",
  MetricGrid: "核心指标组",
  MetricCard: "指标卡",
  DashboardGrid: "分析图表组",
  BarChart: "月度收入趋势",
  DataHealth: "数据健康度",
  DataTable: "区域表现表",
};

const nodeIcons: Record<AppNode["type"], string> = {
  PageRoot: "⌄",
  PageHeader: "▤",
  InsightBanner: "✦",
  MetricGrid: "▦",
  MetricCard: "◇",
  DashboardGrid: "▦",
  BarChart: "⌁",
  DataHealth: "◉",
  DataTable: "▤",
};

function getLayerNodes(page: AppPage | undefined) {
  return page?.root.children ?? [];
}

interface PageStructurePanelProps {
  dataProduct: DataProduct;
  appSpec: AppSpec;
  activePageId: string;
  onPageChange: (pageId: string) => void;
}

export function PageStructurePanel({ dataProduct, appSpec, activePageId, onPageChange }: PageStructurePanelProps) {
  const activePage = appSpec.pages.find((page) => page.id === activePageId);
  const dataset = dataProduct.datasets[0];

  return (
    <aside className="left-panel panel">
      <div className="panel-title"><span>页面与结构</span><button type="button" aria-label="新建页面">＋</button></div>
      <nav className="page-list" aria-label="页面列表">
        {appSpec.navigation.map((item, index) => (
          <button key={item.id} type="button" className={activePageId === item.pageId ? "selected" : ""} onClick={() => onPageChange(item.pageId)}>
            <span className="icon">{index === 0 ? "▦" : index === 1 ? "⌁" : "◉"}</span>{item.title}<span>···</span>
          </button>
        ))}
      </nav>

      <div className="section-label">当前页面图层</div>
      <div className="layer-tree">
        <div><span>⌄</span><b>{activePage?.title}</b></div>
        {getLayerNodes(activePage).map((node) => (
          <div key={node.id} className={`indent ${node.type === "BarChart" || node.type === "DashboardGrid" ? "selected-layer" : ""}`}>
            <span>{nodeIcons[node.type]}</span>{nodeLabels[node.type]}
          </div>
        ))}
      </div>

      {dataset && (
        <div className="data-card">
          <div className="data-head"><span className="db">⌘</span><div><b>{dataset.name}</b><small>{dataset.rowCount.toLocaleString("zh-CN")} 行 · {dataset.columnCount} 列</small></div></div>
          <div className="quality"><span>数据质量</span><b>{dataset.qualityScore}%</b></div>
          <div className="quality-bar"><i style={{ width: `${dataset.qualityScore}%` }} /></div>
          <button type="button">查看字段与配方 →</button>
        </div>
      )}
    </aside>
  );
}
