"use client";

import { Button } from "@/components/ui/button";
import { useRef, useState } from "react";
import { Popover } from "@radix-ui/themes";

/** Presentation-only menu; the panel retains all mutation and review guards. */
export function NotebookCellMenu({ cellId, title, disabled, first, last, onMove, onDelete }: {
  cellId: string; title: string; disabled: boolean; first: boolean; last: boolean;
  onMove(direction: -1 | 1): void; onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const reviewing = useRef(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger><Button variant="ghost" type="button" className="notebook-cell-menu-trigger" data-cell-menu-id={cellId}
      aria-label="更多操作" title="更多操作" disabled={disabled}>···</Button></Popover.Trigger>
    <Popover.Content className="notebook-cell-menu" aria-label={`${title}的更多操作`} align="end" sideOffset={6} collisionPadding={12}
      onCloseAutoFocus={event => { if (reviewing.current) { event.preventDefault(); reviewing.current = false; } }}>
      <span>整理单元</span>
      <Button variant="ghost" type="button" aria-label={`上移 ${title}`} disabled={disabled || first} onClick={() => { setOpen(false); onMove(-1); }}>↑ 上移单元</Button>
      <Button variant="ghost" type="button" aria-label={`下移 ${title}`} disabled={disabled || last} onClick={() => { setOpen(false); onMove(1); }}>↓ 下移单元</Button>
      <Button variant="ghost" type="button" data-delete-cell-id={cellId} disabled={disabled} onClick={() => { reviewing.current = true; setOpen(false); onDelete(); }}>删除</Button>
    </Popover.Content>
  </Popover.Root>;
}
