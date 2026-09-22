export type NotebookRunKind = "manual" | "auto";
export interface NotebookRunLease {
  readonly id: number;
  readonly kind: NotebookRunKind;
  readonly controller: AbortController;
}

/** One in-flight request per mounted Notebook. Cancellation does not release
 * the lock: even an abort-ignoring transport must settle before another starts.
 * The caller separately checks the current document/project before applying data.
 */
export function createNotebookRunControl() {
  let active: NotebookRunLease | null = null;
  let sequence = 0;
  return {
    start(kind: NotebookRunKind): NotebookRunLease | null {
      if (active) return null;
      active = Object.freeze({ id: ++sequence, kind, controller: new AbortController() });
      return active;
    },
    current(): NotebookRunLease | null { return active; },
    owns(lease: NotebookRunLease): boolean { return active === lease; },
    isCurrent(lease: NotebookRunLease): boolean { return active === lease && !lease.controller.signal.aborted; },
    cancel(kind?: NotebookRunKind): boolean {
      if (!active || (kind && active.kind !== kind)) return false;
      active.controller.abort();
      return true;
    },
    finish(lease: NotebookRunLease): boolean {
      if (active !== lease) return false;
      active = null;
      return true;
    },
  };
}
export type NotebookRunControl = ReturnType<typeof createNotebookRunControl>;
