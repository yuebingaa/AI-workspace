"use client";

import { useEffect, useRef } from "react";
import type { NotebookCellDeletionReview as DeletionReview } from "@/core/notebook/cell-deletion";
import { notebookCellPresentation } from "./cell-presentation";

const relationLabels = { target: "当前单元", direct: "直接下游", transitive: "间接下游" } as const;

export function NotebookCellDeletionReview({ review, disabled, stale, onConfirm, onKeep }: {
  review: DeletionReview; disabled: boolean; stale: boolean; onConfirm: () => void; onKeep: () => void;
}) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView({ block: "nearest" });
  }, [review]);
  return <section className="notebook-delete notebook-cell-delete-review" role="alert" aria-label="确认删除分析步骤" tabIndex={-1} ref={region}>
    <h3>删除影响</h3>
    <p>删除此单元及 {review.cells.length - 1} 个依赖它的下游单元？正式看板不受影响。</p>
    <ul>{review.cells.map((cell) => <li key={cell.cellId}>
      <strong>{cell.title}</strong><span>{notebookCellPresentation[cell.kind].label} · {relationLabels[cell.relation]}</span>
      <small>单元 ID：{cell.cellId}{cell.outputName && <> · 输出：<code>{cell.outputName}</code></>}</small>
    </li>)}</ul>
    <p>共移除 {review.cells.length} 个步骤，保留 {review.retainedCount} 个其他步骤。原始文件、数据表、语义模型及已保存的看板 / 结果快照不会删除。</p>
    <p>仅检查本 Notebook 的显式输入与文本引用，不分析自由 SQL / Python 代码。步骤没有回收站；需要恢复时请使用删除前的项目备份。</p>
    {stale && <p className="notebook-draft-warning" role="alert">文档已变化，本次删除审阅已过期，未删除任何步骤。请关闭后重新审阅。</p>}
    <footer><button type="button" onClick={onKeep}>{stale ? "关闭过期审阅" : "保留"}</button>
      <button type="button" disabled={disabled || stale} onClick={onConfirm}>确认删除 {review.cells.length} 个单元</button></footer>
  </section>;
}
