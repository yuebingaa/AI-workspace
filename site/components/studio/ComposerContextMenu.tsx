import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal, flushSync } from "react-dom";

export interface ComposerDataOption { id: string; name: string; detail?: string }
export interface ComposerResultOption extends ComposerDataOption { kind: "recipe" | "artifact" }
type MenuSection = "data" | "results" | "connections" | "semantic";

interface ComposerContextMenuProps {
  anchor: HTMLElement;
  workspaces: ComposerDataOption[];
  activeWorkspaceId: string;
  dataSources: ComposerDataOption[];
  activeDataSourceId: string;
  results: ComposerResultOption[];
  semanticModels?: ComposerDataOption[];
  activeSemanticModelId?: string;
  onSelectSemanticModel?: (id: string | null) => void;
  onManageSemanticModels?: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onChooseFiles: () => void;
  onImportData: () => void;
  onSelectWorkspace: (id: string) => void;
  onSelectDataSource: (id: string) => void;
  onSelectResult: (result: ComposerResultOption) => void;
}

function menuPosition(anchor: HTMLElement) {
  const box = anchor.getBoundingClientRect();
  const width = Math.min(264, window.innerWidth - 24);
  const left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
  return {
    left,
    bottom: Math.max(12, Math.min(window.innerHeight - box.top + 16, window.innerHeight - 230)),
    width,
    narrow: window.innerWidth < 620,
    submenuLeft: left + width + 300 < window.innerWidth - 12 ? left + width + 4 : Math.max(12, left - 300),
    submenuWidth: Math.min(296, window.innerWidth - 24),
  };
}

function ContextIcon({ kind }: { kind: "file" | "data" | "results" | "connections" | "search" | "semantic" }) {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    {kind === "file" ? <path d="m7 11 5-5a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l8-8m-5 10 7-7" />
      : kind === "data" || kind === "search" ? <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>
        : kind === "results" ? <><rect x="5" y="3" width="12" height="11" rx="1" /><path d="M3 6H2v11h12v-1M8 7h6m-6 3h6m-3-5v7" /></>
          : <><ellipse cx="10" cy="4" rx="6" ry="2.5" /><path d="M4 4v11c0 3.3 12 3.3 12 0V4M4 9.5c0 3.3 12 3.3 12 0" /></>}
  </svg>;
}

export function ComposerContextMenu({ anchor, workspaces, activeWorkspaceId, dataSources, activeDataSourceId, results, semanticModels = [], activeSemanticModelId, onSelectSemanticModel, onManageSemanticModels, onClose, onChooseFiles, onImportData, onSelectWorkspace, onSelectDataSource, onSelectResult }: ComposerContextMenuProps) {
  const [position, setPosition] = useState(() => menuPosition(anchor));
  const [section, setSection] = useState<MenuSection | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (item: ComposerDataOption) => `${item.name} ${item.detail ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
  const filteredWorkspaces = workspaces.filter(matches);
  const filteredSources = dataSources.filter(matches);
  const filteredResults = results.filter(matches);
  const filteredModels = semanticModels.filter(matches);

  useEffect(() => {
    const updatePosition = () => setPosition(menuPosition(anchor));
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !rootRef.current?.contains(target) && !submenuRef.current?.contains(target)) onClose();
    };
    window.addEventListener("resize", updatePosition);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("pointerdown", outside);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  function openSection(next: MenuSection, focusSearch = false) {
    const update = () => {
      if (section !== next) setQuery("");
      setSection(next);
    };
    if (focusSearch) {
      flushSync(update);
      searchRef.current?.focus();
    } else update();
  }

  function returnToRoot() {
    const previousSection = section;
    flushSync(() => setSection(null));
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-section="${previousSection}"]`)?.focus();
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (section) {
        returnToRoot();
      } else onClose(true);
      return;
    }
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" && !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (event.key === "ArrowRight" && target.dataset.section) {
      event.preventDefault();
      openSection(target.dataset.section as MenuSection, true);
    } else if (event.key === "ArrowLeft" && submenuRef.current?.contains(target)) {
      event.preventDefault();
      returnToRoot();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'));
      const current = buttons.indexOf(target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : current < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0)
          : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  function handleBlur() {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused && !anchor.contains(focused) && !rootRef.current?.contains(focused) && !submenuRef.current?.contains(focused)) onClose();
    });
  }

  const title = section === "data" ? "工作界面与数据表" : section === "results" ? "处理配方或结果" : section === "semantic" ? "语义模型" : "数据连接";
  const pick = (action: () => void) => { action(); onClose(true); };

  return createPortal(<>
    <div
      id="composer-context-menu"
      className="composer-context-menu"
      role="menu"
      aria-label="添加上下文菜单"
      ref={rootRef}
      hidden={position.narrow && Boolean(section)}
      style={{ left: position.left, bottom: position.bottom, width: position.width }}
      onKeyDown={handleKeys}
      onBlur={handleBlur}
    >
      <button type="button" role="menuitem" onPointerEnter={() => { if (!position.narrow) setSection(null); }} onClick={() => pick(onChooseFiles)}><ContextIcon kind="file" /><span>添加文件或图片</span></button>
      {([
        ["data", "选择工作界面与数据表"],
        ["results", "添加处理配方或结果"],
        ["semantic", "选择语义模型"],
        ["connections", "选择数据连接"],
      ] as const).map(([id, label]) => <button
        key={id} data-section={id} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={section === id}
        onPointerEnter={(event) => { if (event.pointerType === "mouse" && !position.narrow) openSection(id); }}
        onClick={() => openSection(id, true)}
      ><ContextIcon kind={id} /><span>{label}</span><span className="context-menu-chevron" aria-hidden="true">›</span></button>)}
    </div>
    {section && <div
      className={`composer-context-submenu${position.narrow ? " compact" : ""}`}
      ref={submenuRef} role="menu" aria-label={title}
      style={{ left: position.narrow ? Math.min(position.left, window.innerWidth - position.submenuWidth - 12) : position.submenuLeft, bottom: position.bottom, width: position.submenuWidth, maxHeight: Math.min(340, window.innerHeight - position.bottom - 12) }}
      onKeyDown={handleKeys} onBlur={handleBlur}
    >
      <div className="context-submenu-heading">{position.narrow && <button type="button" aria-label="返回上下文菜单" onClick={returnToRoot}>‹</button>}<span>{title}</span></div>
      <label className="context-menu-search"><ContextIcon kind="search" /><input ref={searchRef} aria-label={`搜索${title}`} placeholder={section === "connections" ? "筛选数据连接…" : "搜索…"} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="context-menu-options">
        {section === "data" && <>
          {filteredSources.length > 0 && <><p>当前工作界面的数据表</p>{filteredSources.map((source) => <button key={source.id} type="button" role="menuitemradio" aria-checked={source.id === activeDataSourceId} onClick={() => pick(() => onSelectDataSource(source.id))}><span className="context-option-symbol">▦</span><span><b>{source.name}</b><small>{source.detail ?? "导入的数据表"}</small></span>{source.id === activeDataSourceId && <i>✓</i>}</button>)}</>}
          {filteredWorkspaces.length > 0 && <><p>工作界面</p>{filteredWorkspaces.map((workspace) => <button key={workspace.id} type="button" role="menuitemradio" aria-checked={workspace.id === activeWorkspaceId} onClick={() => pick(() => onSelectWorkspace(workspace.id))}><span className="context-option-symbol">▣</span><span><b>{workspace.name}</b><small>{workspace.detail ?? "切换界面及其数据上下文"}</small></span>{workspace.id === activeWorkspaceId && <i>✓</i>}</button>)}</>}
          {!filteredSources.length && !filteredWorkspaces.length && <div className="context-menu-empty">没有匹配的工作界面或数据表</div>}
          {!dataSources.length && !query && <div className="context-menu-empty">当前界面还没有数据表<button type="button" onClick={() => pick(onImportData)}>导入本地表格</button></div>}
        </>}
        {section === "results" && <>
          {filteredResults.map((result) => <button key={`${result.kind}:${result.id}`} type="button" role="menuitem" onClick={() => pick(() => onSelectResult(result))}><span className="context-option-symbol">▤</span><span><b>{result.name}</b><small>{result.detail}</small></span><em>{result.kind === "recipe" ? "引用" : "查看"}</em></button>)}
          {!filteredResults.length && <div className="context-menu-empty">{query ? "没有匹配的配方或结果" : "暂无处理配方或结果"}<small>导入表格或完成 AI 数据处理后，会显示在这里。</small></div>}
        </>}
        {section === "semantic" && <>
          {filteredModels.map((model) => <button key={model.id} type="button" role="menuitemradio" aria-checked={model.id === activeSemanticModelId} onClick={() => pick(() => onSelectSemanticModel?.(model.id))}><span className="context-option-symbol">◇</span><span><b>{model.name}</b><small>{model.detail}</small></span>{model.id === activeSemanticModelId && <i>✓</i>}</button>)}
          {!filteredModels.length && <div className="context-menu-empty">{query ? "没有匹配的语义模型" : "当前工作界面暂无语义模型"}<small>先导入数据，再定义业务维度和指标口径。</small></div>}
          {activeSemanticModelId && <button type="button" role="menuitem" onClick={() => pick(() => onSelectSemanticModel?.(null))}>不使用语义模型</button>}
          {onManageSemanticModels && <button type="button" role="menuitem" onClick={() => pick(onManageSemanticModels)}>创建 / 管理语义模型</button>}
        </>}
        {section === "connections" && <div className="context-menu-empty context-connections-empty"><ContextIcon kind="connections" /><b>{query ? "没有匹配的数据连接" : "暂无已连接的数据库"}</b><small>数据库连接功能尚未接入。你可以先添加本地 CSV 或 Excel 表格。</small><button type="button" onClick={() => pick(onImportData)}>导入本地表格</button></div>}
      </div>
      <p className="context-menu-footnote">{section === "data" ? "选择数据表会更新分析对象；选择界面会同步切换看板。" : section === "results" ? "引用配方会填入分析问题；AI 处理结果可在看板中查看。" : section === "semantic" ? "选择模型会同步分析数据表；指标遵循已保存的计算口径。" : "连接入口已预留"}</p>
    </div>}
  </>, document.body);
}
