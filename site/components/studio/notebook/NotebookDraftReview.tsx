import { Button } from "@/components/ui/button";
import { useMemo } from "react";
import type { NotebookArtifact } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { adoptNotebookDraft, notebookDiff } from "@/core/notebook/client-state";
import { cellReviewSource, sourceDiff } from "./cell-source";
import { NotebookSource } from "./NotebookSource";
import { analyzeNotebookOutputRenames } from "@/core/notebook/output-renames";
import { NotebookOutputRenameReview } from "./NotebookOutputRenameReview";

export function NotebookDraftReview({ document, draft, disabled, blockedReason, previewing = false, onAdopt, onDismiss }: {
  document: NotebookDocument; draft: NotebookArtifact; disabled: boolean; blockedReason?: string;
  previewing?: boolean;
  onAdopt: () => void; onDismiss: () => void;
}) {
  const review = useMemo(() => {
    const changes = notebookDiff(document, draft);
    const entries = draft.cells.map((cell, index) => {
      const previous = document.cells.find((item) => item.id === cell.id);
      const oldIndex = document.cells.findIndex((item) => item.id === cell.id);
      return { cell, previous, oldIndex, index, status: !previous ? "新增" : JSON.stringify(previous) !== JSON.stringify(cell) ? "修改" : oldIndex !== index ? "移动" : "不变" };
    }).filter((entry) => entry.status !== "不变");
    for (const [index, cell] of document.cells.entries()) if (!draft.cells.some((item) => item.id === cell.id)) entries.push({ cell, previous: cell, oldIndex: index, index: -1, status: "移除" });
    let error = "";
    try { adoptNotebookDraft(document, draft); } catch (caught) { error = caught instanceof Error ? caught.message : "草稿暂时无法采用"; }
    return { changes, entries, error, renames: analyzeNotebookOutputRenames(document.cells, draft.cells) };
  }, [document, draft]);
  return <section className="notebook-draft" aria-label="AI Notebook 草稿">
    <header><b>{previewing ? "✧ 正在预览 AI 更改 · 待确认" : "✧ AI 草稿待采用"}</b><span>{draft.executionEvidence?.status === "success" ? previewing ? "生成阶段试运行通过" : "已通过数据试运行" : "仅结构校验"}</span></header>
    <p>{draft.name} · 新增 {review.changes.added.length}、修改 {review.changes.changed.length}、移除 {review.changes.removed.length} 个单元</p>
    {document.name !== draft.name && <p>文档名称：{document.name} → {draft.name}</p>}
    <NotebookOutputRenameReview renames={review.renames} />
    <details><summary>查看变更和步骤 · {review.entries.length} 项</summary>
      {review.entries.map(({ cell, previous, status, oldIndex, index }) => <article className="notebook-draft-cell" key={cell.id} aria-label={`草稿${status} ${cell.title}`}>
        <header><span className={`notebook-draft-badge ${status === "移除" ? "removed" : "added"}`}>{status}</span><b>{cell.title}</b><small>{status === "移动" ? `第 ${oldIndex + 1} 步 → 第 ${index + 1} 步` : index < 0 ? `原第 ${oldIndex + 1} 步` : `第 ${index + 1} 步`}</small></header>
        {status !== "移动" && <NotebookSource value="" language="单元定义与处理逻辑" label={`${cell.title} 修改对照`} lines={sourceDiff(previous ? cellReviewSource(previous) : undefined, status === "移除" ? undefined : cellReviewSource(cell))} />}
      </article>)}
      {!review.entries.length && <p>单元内容与顺序保持不变。</p>}
    </details>
    {review.error && <p className="notebook-draft-warning" role="status">{review.error}</p>}
    {blockedReason && <p className="notebook-draft-warning" role="status">{blockedReason}</p>}
    <footer><small>{previewing ? "下方为草稿运行结果；确认后保存步骤，看板保持不变。" : "相关步骤一并采用；看板仍需单独确认。"}</small><Button variant="secondary" type="button" onClick={onDismiss}>{previewing ? "撤销预览" : "暂不采用"}</Button><Button variant="primary" type="button" className="notebook-primary" disabled={disabled || Boolean(review.error) || Boolean(blockedReason)} onClick={onAdopt}>{previewing ? "确认更改" : "采用草稿"}</Button></footer>
  </section>;
}
