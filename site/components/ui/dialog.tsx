"use client";

import { forwardRef, useRef, type ComponentPropsWithoutRef } from "react";
import { Dialog as DialogPrimitive, AlertDialog as AlertDialogPrimitive } from "@radix-ui/themes";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(function DialogContent({
  className = "", onOpenAutoFocus, onCloseAutoFocus, onPointerDownOutside, ...props
}, ref) {
  // Capture before a child with autoFocus runs during commit (e.g. the API key field).
  const returnTo = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <DialogPrimitive.Content {...props} ref={ref} className={`ui-dialog-content ${className}`}
      onOpenAutoFocus={event => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && event.target instanceof HTMLElement && !event.target.contains(active)) returnTo.current = active;
        onOpenAutoFocus?.(event);
      }}
      onCloseAutoFocus={event => { onCloseAutoFocus?.(event); if (!event.defaultPrevented) { event.preventDefault(); if (returnTo.current?.isConnected) returnTo.current.focus(); } }}
      onPointerDownOutside={onPointerDownOutside ?? (event => event.preventDefault())} />;
});

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "取消", onConfirm, onCancel }: {
  open: boolean; title: string; description: string; confirmLabel: string; cancelLabel?: string; onConfirm(): void; onCancel(): void;
}) {
  const returnTo = useRef<HTMLElement | null>(null);
  return <AlertDialogPrimitive.Root open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <AlertDialogPrimitive.Content maxWidth="460px" className="ui-confirm-dialog"
        onOpenAutoFocus={() => { returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => { event.preventDefault(); if (returnTo.current?.isConnected) returnTo.current.focus(); }}>
        <AlertDialogPrimitive.Title>{title}</AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description>{description}</AlertDialogPrimitive.Description>
        <div className="ui-dialog-actions">
          <AlertDialogPrimitive.Cancel><Button>{cancelLabel}</Button></AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action><Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button></AlertDialogPrimitive.Action>
        </div>
      </AlertDialogPrimitive.Content>
  </AlertDialogPrimitive.Root>;
}
