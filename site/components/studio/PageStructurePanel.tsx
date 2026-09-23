import type { AppSpec } from "@/core/models";
import { LEGACY_DEMO_PAGE_IDS } from "@/core/workspaces";
import { StudioIcon } from "./StudioIcon";

interface PageStructurePanelProps {
  appSpec: Pick<AppSpec, "navigation">;
  activePageId: string;
  onPageChange: (pageId: string) => void;
}

export function PageStructurePanel({ appSpec, activePageId, onPageChange }: PageStructurePanelProps) {
  const visibleNavigation = appSpec.navigation.filter((item) => !LEGACY_DEMO_PAGE_IDS.has(item.pageId));

  return (
    <aside className="left-panel panel interface-selection-panel" aria-label="工作界面选择">
      <h2 className="interface-selection-heading">工作界面</h2>
      {visibleNavigation.length > 0 ? (
        <nav className="interface-selection-list" aria-label="工作界面列表">
          {visibleNavigation.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activePageId === item.pageId ? "page" : undefined}
              title={item.title}
              onClick={() => onPageChange(item.pageId)}
            >
              <StudioIcon name="pages" />
              <span className="interface-selection-name">{item.title}</span>
              {activePageId === item.pageId && <span className="interface-selection-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </nav>
      ) : <p className="interface-selection-empty">暂无工作界面</p>}
    </aside>
  );
}
