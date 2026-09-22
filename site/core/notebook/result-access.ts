import type { NotebookResultReference, NotebookTable } from "./contracts";

/** Server-owned publication after successful execution; never a public access token. */
export interface NotebookResultPublication {
  reference: NotebookResultReference;
  table: NotebookTable;
}

/** Synchronous, optional handoff of the current target's complete materialized result. */
export type NotebookResultPublisher = (publication: NotebookResultPublication) => void;
