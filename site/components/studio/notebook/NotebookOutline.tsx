import { Button } from "@/components/ui/button";
import type { NotebookCell } from "@/core/notebook/definition";
import { NotebookIcon } from "./NotebookChrome";

export function NotebookOutline({ cells, activeId, onNavigate }: { cells: NotebookCell[]; activeId?: string; onNavigate(id: string): void }) {
  if (!cells.length) return null;
  return <nav className="notebook-outline" aria-label="Notebook 文档大纲">
    <header><span>文档大纲</span><small>{cells.length}</small></header>
    {cells.map((cell, index) => <Button variant="ghost" type="button" key={cell.id} aria-current={activeId === cell.id ? "step" : undefined}
      title={cell.title} onClick={() => onNavigate(cell.id)}>
      <span>{String(index + 1).padStart(2, "0")}</span><NotebookIcon kind={cell.kind} /><span>{cell.title}</span>
    </Button>)}
  </nav>;
}
