import { getComponentDefinition } from "@/components/registry/component-registry";
import type { AppPage, AppSpec, DataProduct } from "@/core/models";
import type { StudioRole } from "@/core/permissions";

function getLayerNodes(page: AppPage | undefined) {
  return page?.root.children ?? [];
}

interface PageStructurePanelProps {
  dataProduct: DataProduct;
  appSpec: AppSpec;
  activePageId: string;
  onPageChange: (pageId: string) => void;
  role: StudioRole;
  onRenamePage: (pageId: string, currentTitle: string) => void;
  activeDataSourceId: string;
  onOpenDataSource: (dataSourceId: string) => void;
  onUploadCsv: () => void;
}

export function PageStructurePanel({ dataProduct, appSpec, activePageId, onPageChange, role, onRenamePage, activeDataSourceId, onOpenDataSource, onUploadCsv }: PageStructurePanelProps) {
  const activePage = appSpec.pages.find((page) => page.id === activePageId);

  return (
    <aside className="left-panel panel">
      <div className="panel-title"><span>页面与结构</span><button type="button" disabled title="本里程碑仅开放页面重命名" aria-label="新建页面">＋</button></div>
      <nav className="page-list" aria-label="页面列表">
        {appSpec.navigation.map((item, index) => (
          <div className="page-list-row" key={item.id}>
            <button type="button" className={activePageId === item.pageId ? "selected" : ""} onClick={() => onPageChange(item.pageId)}>
              <span className="icon">{index === 0 ? "▦" : index === 1 ? "⌁" : "◉"}</span>{item.title}
            </button>
            {role === "admin" ? (
              <button type="button" className="page-structure-edit" title="重命名页面" onClick={() => onRenamePage(item.pageId, item.title)}>编辑</button>
            ) : <span>···</span>}
          </div>
        ))}
      </nav>

      <div className="section-label">当前页面图层</div>
      <div className="layer-tree">
        <div><span>⌄</span><b>{activePage?.title}</b></div>
        {getLayerNodes(activePage).map((node) => {
          const definition = getComponentDefinition(node.type);
          return (
            <div key={node.id} className={`indent ${node.type === "DashboardGrid" ? "selected-layer" : ""}`}>
              <span>{definition.icon}</span>{definition.label}
            </div>
          );
        })}
      </div>

      <div className="section-label data-source-section-head"><span>数据源</span><button type="button" onClick={onUploadCsv}>上传 CSV</button></div>
      <div className="data-source-card-list">
        {dataProduct.datasets.map((dataset) => (
          <div key={dataset.id} className={`data-card${activeDataSourceId === dataset.id ? " active" : ""}`} onClick={() => onOpenDataSource(dataset.id)}>
            <div className="data-head"><span className="db">⌘</span><div><b>{dataset.name}</b><small>{dataset.rowCount.toLocaleString("zh-CN")} 行 · {dataset.columnCount} 列</small></div></div>
            <div className="quality"><span>数据质量</span><b>{dataset.qualityScore}%</b></div>
            <div className="quality-bar"><i style={{ width: `${dataset.qualityScore}%` }} /></div>
            {dataset.ephemeral && <small className="dataset-retention">临时数据 · {dataset.expiresAt ? `${new Date(dataset.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 到期` : "服务重启后失效"}</small>}
            <button type="button" onClick={() => onOpenDataSource(dataset.id)}>查看字段、预览与记录 →</button>
          </div>
        ))}
      </div>
    </aside>
  );
}
