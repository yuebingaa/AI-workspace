import { Button } from "@/components/ui/button";
import { useEffect, useRef } from "react";
import type { NotebookOutputRename } from "@/core/notebook/output-renames";
import { notebookCellPresentation } from "./cell-presentation";

type OutputRenames = readonly NotebookOutputRename[];

export function NotebookOutputRenameReview({ renames }: { renames: OutputRenames }) {
  if (!renames.length) return null;
  return <div className="notebook-output-rename-review">
    <b>输出变量改名影响</b>
    <p>结构化输入按单元 ID 保持关联；不会自动改写自由 SQL / Python 代码。</p>
    <ul>{renames.map((rename) => <li key={rename.cellId}>
      <p><strong>{rename.title}</strong>：<code>{rename.previousName}</code> → <code>{rename.nextName}</code></p>
      <p>保持输入关联：{rename.preservedReferences.length ? rename.preservedReferences.map((cell) => `${cell.title}（${notebookCellPresentation[cell.kind].label}）`).join("、") : "没有保留的直接下游引用"}。</p>
      {rename.codeChecks.length > 0 && <div className="notebook-output-rename-checks"><p>以下代码需要核对，即使已经手动修改，也请运行验证：</p><ul>{rename.codeChecks.map((check) => <li key={`${check.cellId}:${check.reason}`}>
        <strong>{check.title}</strong>（{notebookCellPresentation[check.kind].label}）：{check.reason === "python-output" ? <>确认代码实际产生 <code>{rename.nextName}</code> 输出变量。</> : <>检查输入引用是否使用 <code>{rename.nextName}</code>。</>}
      </li>)}</ul></div>}
      <p>此单元及 {rename.affectedCellIds.filter((id) => id !== rename.cellId).length} 个下游单元需手动重新运行；保存不会自动执行。</p>
    </li>)}</ul>
  </div>;
}

export function NotebookOutputRenameConfirmation({ renames, disabled, stale, onConfirm, onBack }: {
  renames: OutputRenames; disabled: boolean; stale: boolean; onConfirm: () => void; onBack: () => void;
}) {
  const region = useRef<HTMLElement | null>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return <section className="notebook-output-rename-confirmation" aria-label="确认输出变量改名" tabIndex={-1} ref={region}>
    <NotebookOutputRenameReview renames={renames} />
    {stale && <p className="notebook-draft-warning" role="alert">文档已变化，本次待保存内容已过期，不会覆盖当前文档。请关闭后重新编辑。</p>}
    <footer><Button variant="secondary" type="button" onClick={onBack}>{stale ? "关闭过期编辑" : "返回编辑"}</Button><Button variant="primary" type="button" className="notebook-primary" disabled={disabled || stale} onClick={onConfirm}>确认改名并保存</Button></footer>
  </section>;
}
