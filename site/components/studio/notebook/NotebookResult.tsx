"use client";

import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { notebookResultAvailability, type NotebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookChart } from "./NotebookChart";
import { NotebookResultTable } from "./NotebookResultTable";

export function NotebookResult({ cell, table, availability }: { cell: NotebookCell; table: NotebookTable; availability?: NotebookResultAvailability }) {
  const scope = availability ?? notebookResultAvailability(cell, { cellId: cell.id, status: "success", durationMs: 0, table });
  return <div className="notebook-result">
    {cell.kind === "chart" && <NotebookChart cell={cell} table={table} />}
    <NotebookResultTable title={cell.title} table={table} availability={scope} />
  </div>;
}
