"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { containDialogFocus } from "../dialog-focus";

export function FileDeleteDialog({ name, recoverable, disabled, fallbackFocusRef, onConfirm, onClose }: {
  name: string; recoverable: boolean; disabled?: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const id = useId(), dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null), confirmRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState("");

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
    if (submittingRef.current || disabled) return;
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
        ? "文件将移入回收站，可随时恢复。已导入的数据表和 Notebook 分析会保留。"
        : "将移除本次会话的原件，已导入的数据表和 Notebook 分析会保留。如需完整原件，请重新导入。"}</p>
    </div>
    {error && <p className="file-delete-error" role="alert">{error}</p>}
    <div className="file-delete-actions">
      <button type="button" ref={cancelRef} disabled={pending} onClick={dismiss}>取消</button>
      <button type="button" ref={confirmRef} className="file-delete-confirm" disabled={pending || disabled} onClick={() => void confirm()}>{pending ? "正在删除…" : error ? "重试删除" : "删除"}</button>
    </div>
  </dialog>;
}
