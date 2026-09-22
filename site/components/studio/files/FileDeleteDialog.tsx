"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { NotebookFileReference } from "@/core/notebook/file-references";
import { containDialogFocus } from "../dialog-focus";

export function FileDeleteDialog({ name, references, recoverable, disabled, fallbackFocusRef, onConfirm, onClose }: {
  name: string; recoverable: boolean; disabled?: boolean;
  references: NotebookFileReference[];
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const id = useId(), dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null), confirmRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [acknowledgedImpact, setAcknowledgedImpact] = useState<string | null>(null);
  // Acknowledgement only covers the currently displayed file and complete reference list.
  const impactKey = JSON.stringify([name, references]);
  const requiresAcknowledgement = references.length > 0;
  const acknowledged = acknowledgedImpact === impactKey;
  const blocked = disabled || (requiresAcknowledgement && !acknowledged);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = fallbackFocusRef.current;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (trigger?.isConnected) trigger.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
  }, [fallbackFocusRef]);

  function dismiss() {
    if (!submittingRef.current) onClose();
  }
  async function confirm() {
    if (submittingRef.current || blocked) return;
    submittingRef.current = true;
    setPending(true); setError(""); dialogRef.current?.focus();
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件删除失败，请重试。");
      requestAnimationFrame(() => confirmRef.current?.focus());
    } finally {
      submittingRef.current = false; setPending(false);
    }
  }

  return <dialog ref={dialogRef} className="file-delete-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={pending} tabIndex={-1}
    onKeyDown={(event) => { event.stopPropagation(); containDialogFocus(event); }}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
    }}>
    <h2 id={`${id}-title`}>删除文件</h2>
    <div id={`${id}-description`} className="file-delete-description">
      <p>确定删除 <code>{name}</code> 吗？</p>
      <p className="file-delete-note">{recoverable
        ? "文件将移入回收站，可从回收站恢复。"
        : "将移除本次会话的原件。如需完整原件，请重新导入。"}</p>
      <p className="file-delete-note">已导入的数据表和 Notebook 定义会保留。读取此文件名的 Python 及下游再次运行可能受影响；已有显示结果不会自动重新计算。</p>
    </div>
    <section className="file-delete-impact" aria-label="原件删除影响">
      {requiresAcknowledgement ? <>
        <h3>{references.length} 个 Python 步骤引用此文件名</h3>
        <ul>{references.slice(0, 10).map((reference) => <li key={JSON.stringify([reference.pageId, reference.cellId])}>
          <span>{reference.notebookName} · {reference.cellTitle}</span>
          <small>页面 {reference.pageId} · 步骤 {reference.cellId} · 下游 {reference.downstreamCount} 个步骤</small>
        </li>)}</ul>
        {references.length > 10 && <p>另有 {references.length - 10} 个引用未展开；确认范围包含全部 {references.length} 个引用。</p>}
        <p>按当前各工作界面的 Notebook 定义检查，引用按文件名匹配，不绑定文件 ID；同名原件或本次上传的文件可能影响实际读取。每个步骤的下游数量单独计算，可能重叠。</p>
      </> : <p>当前 Notebook 定义中未发现该文件名的显式引用；不检查自由代码或未采用草稿。</p>}
    </section>
    {requiresAcknowledgement && <label className="file-delete-ack">
      <input type="checkbox" checked={acknowledged} disabled={pending || disabled}
        onChange={(event) => setAcknowledgedImpact(event.target.checked ? impactKey : null)} />
      <span>我已了解：读取该原件的步骤及下游可能无法重跑。{recoverable ? "恢复原件后需手动重新运行。" : "重新导入原件后需手动重新运行。"}</span>
    </label>}
    {error && <p className="file-delete-error" role="alert">{error}</p>}
    <div className="file-delete-actions">
      <button type="button" ref={cancelRef} disabled={pending} onClick={dismiss}>取消</button>
      <button type="button" ref={confirmRef} className="file-delete-confirm" disabled={pending || blocked} onClick={() => void confirm()}>{pending ? "正在删除…" : error ? "重试删除" : "删除"}</button>
    </div>
  </dialog>;
}
