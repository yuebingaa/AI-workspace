"use client";

import { useState } from "react";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { reconcileNotebookContextSelection, toggleNotebookContextSelection, type NotebookContextSelectionState } from "./notebook-context-selection";

export function useNotebookContextSelection(scopeKey: string, document: NotebookDocument, disabled: boolean) {
  const [state, setState] = useState<NotebookContextSelectionState>(() => ({ scopeKey, ids: [] }));
  const current = reconcileNotebookContextSelection(state, scopeKey, document);
  // Reconcile during this component's render, before children can see a stale
  // page/thread selection. The guarded update converges and retains no ID history.
  if (current !== state) setState(current);
  return {
    selectedCellIds: current.ids,
    toggle: (id: string) => {
      if (!disabled) setState((value) => toggleNotebookContextSelection(value, scopeKey, document, id));
    },
    remove: (id: string) => {
      if (!disabled) setState((value) => value.scopeKey !== scopeKey || !value.ids.includes(id) ? value
        : { scopeKey, ids: value.ids.filter((item) => item !== id) });
    },
  };
}
