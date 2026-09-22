import type { NotebookCell } from "@/core/notebook/definition";
import { notebookCellPresentation } from "./cell-presentation";

/** Display metadata only: no parameter value, source code or cached output. */
export interface NotebookContextOption {
  id: string;
  name: string;
  kind: NotebookCell["kind"];
  detail: string;
}
export function notebookContextOptions(cells: readonly NotebookCell[]): NotebookContextOption[] {
  return cells.map((cell) => ({ id: cell.id, name: cell.title, kind: cell.kind,
    detail: `${notebookCellPresentation[cell.kind].label}${"outputName" in cell ? ` · ${cell.outputName}` : " · 已保存定义"}`,
  }));
}

export function NotebookContextOptions({ options, selectedIds, limit, disabled, query, onToggle }: {
  options: readonly NotebookContextOption[]; selectedIds: readonly string[]; limit: number; disabled: boolean;
  query: string; onToggle: (id: string) => void;
}) {
  const normalized = query.trim().toLocaleLowerCase();
  const matching = options.filter((option) => `${option.name} ${option.detail}`.toLocaleLowerCase().includes(normalized));
  const groups = [{ name: "参数", options: matching.filter((option) => option.kind === "parameter") },
    { name: "其他单元", options: matching.filter((option) => option.kind !== "parameter") }];
  return <>
    {groups.map((group) => group.options.length > 0 && <span className="notebook-context-option-group" key={group.name}>
      <p>{group.name}</p>
      {group.options.map((option) => {
        const selected = selectedIds.includes(option.id);
        return <button type="button" key={option.id} role="menuitemcheckbox" aria-checked={selected}
          disabled={disabled || (!selected && selectedIds.length >= limit)} title={`${option.name} · ${option.detail}`}
          onClick={() => onToggle(option.id)}>
          <span className="context-option-symbol" aria-hidden="true">{option.kind === "parameter" ? "⌁" : "▤"}</span>
          <span><b>{option.name}</b><small>{option.detail}</small></span>{selected && <i aria-hidden="true">✓</i>}
        </button>;
      })}
    </span>)}
    {!matching.length && <div className="context-menu-empty">{query ? "没有匹配的 Notebook 参数或单元" : "当前工作界面暂无 Notebook 单元"}<small>仅列出当前文档已保存的定义；未保存的编辑不会加入。</small></div>}
    {selectedIds.length >= limit && <p className="notebook-context-limit" role="status">已选择 {limit} 项，请先移除一项再添加。</p>}
    {disabled && <p className="notebook-context-limit" role="status">请先完成当前编辑或运行，再调整 Notebook 上下文。</p>}
  </>;
}

export function NotebookContextChips({ options, selectedIds, disabled, onRemove }: {
  options: readonly NotebookContextOption[]; selectedIds: readonly string[]; disabled: boolean; onRemove: (id: string) => void;
}) {
  const selected = selectedIds.flatMap((id) => {
    const option = options.find((candidate) => candidate.id === id);
    return option ? [option] : [];
  });
  if (!selected.length) return null;
  return <section className="notebook-context-selection" aria-label="已选择的 Notebook 上下文">
    <div className="notebook-context-selection-chips">{selected.map((option) => <span className="composer-context-chip" key={option.id} title={`${option.name} · ${option.detail}`}>
      <span aria-hidden="true">{option.kind === "parameter" ? "⌁" : "▤"}</span><b>{option.name}</b>
      <button type="button" disabled={disabled} aria-label={`移除 Notebook 上下文 ${option.name}`} onClick={() => onRemove(option.id)}>×</button>
    </span>)}</div>
    <small>仅当前窗口的关注对象；选择本身不会读取或运行数据，不代表本次已有可用结果。</small>
  </section>;
}
