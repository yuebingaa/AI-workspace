"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { parameterValueChanges } from "@/core/notebook/parameter-recompute";
import { INITIAL_NOTEBOOK_AUTO_RUN_STATE, NotebookAutoRunScheduler } from "./auto-run-scheduler";

export function useNotebookAutoRun({ document, contextKey, editing, busy, hidden, canEdit, externalBusy, onRun, onCancelAutomatic }: {
  document: NotebookDocument; contextKey: string; editing: boolean; busy: boolean; hidden: boolean; canEdit: boolean; externalBusy: boolean;
  onRun: (cellIds: string[]) => void; onCancelAutomatic: () => void;
}) {
  const [state, setState] = useState(INITIAL_NOTEBOOK_AUTO_RUN_STATE);
  const [scheduler] = useState(() => new NotebookAutoRunScheduler(setState));
  const documentKey = JSON.stringify(document);
  useLayoutEffect(() => {
    scheduler.update({ documentKey, contextKey, editing, busy, hidden, canEdit, externalBusy }, { run: onRun, cancelAutomatic: onCancelAutomatic });
  }, [scheduler, documentKey, contextKey, editing, busy, hidden, canEdit, externalBusy, onRun, onCancelAutomatic]);
  useEffect(() => () => scheduler.dispose(), [scheduler]);
  return {
    ...state,
    setEnabled: (enabled: boolean) => scheduler.setEnabled(enabled),
    approvedSave: (previous: NotebookDocument, next: NotebookDocument) => scheduler.approve(
      JSON.stringify(previous), JSON.stringify(next), parameterValueChanges(previous, next),
    ),
    clearPending: () => scheduler.clearPending(),
  };
}
