import { z } from "zod";
import { MAX_NOTEBOOK_CELLS, notebookArtifactSchema, notebookCellSchema, type NotebookArtifact } from "@/core/notebook/definition";
import { notebookCellTimingSchema, type NotebookRun } from "@/core/notebook/contracts";
import { captureNotebookRunExpectation, parseNotebookRunReceipt, type NotebookRunExpectation } from "@/core/notebook/run-receipt";

export const MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS = 20_000;
const diagnosticCellSchema = z.object({
  cellId: z.string().min(1).max(120),
  kind: z.enum(notebookCellSchema.options.map((cell) => cell.shape.kind.value)),
  title: z.string().min(1).max(120),
  status: z.enum(["success", "failure", "blocked", "unknown"]),
  // Read-only, indented JSON of the validated cell definition, never an executable artifact.
  source: z.string().max(MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS),
  sourceChars: z.number().int().nonnegative(),
  sourceTruncated: z.boolean(),
  timing: notebookCellTimingSchema.optional(),
}).strict().refine((cell) => cell.sourceChars >= cell.source.length
  && cell.sourceTruncated === (cell.sourceChars > cell.source.length)
  && (cell.status !== "unknown" || !cell.timing), "诊断源长度或运行状态不一致");

export const harnessNotebookDiagnosticsSchema = z.object({
  version: z.literal(1),
  baseRevision: z.number().int().nonnegative(),
  editVersion: z.number().int().nonnegative().optional(),
  runId: z.string().max(160).optional(),
  status: z.enum(["failure", "unavailable"]),
  cells: z.array(diagnosticCellSchema).min(1).max(MAX_NOTEBOOK_CELLS),
  omittedCellCount: z.number().int().nonnegative().max(MAX_NOTEBOOK_CELLS),
}).strict().refine((value) => value.cells.reduce((count, cell) => count + cell.source.length, 0) <= MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS
  && value.cells.length + value.omittedCellCount <= MAX_NOTEBOOK_CELLS
  && (value.status === "unavailable" ? (value.runId === undefined && value.cells.every((cell) => cell.status === "unknown" && !cell.timing))
    : (value.runId !== undefined && value.cells.every((cell) => cell.status !== "unknown") && value.cells.some((cell) => cell.status !== "success"))),
"Notebook 诊断超过预算或包含不匹配的运行回执");
export type HarnessNotebookDiagnostics = z.infer<typeof harnessNotebookDiagnosticsSchema>;

/** Task-local collection only. Not observations, model memory, evidence or an adoptable draft. */
export class NotebookDiagnosticSession {
  private generation = 0;
  private current?: { artifact: NotebookArtifact; expected?: NotebookRunExpectation; editVersion?: number; run?: NotebookRun };

  // Call only after the ordinary full-DAG and source-authorization validation succeeds.
  begin(artifact: NotebookArtifact, editVersion?: number): number {
    this.current = { artifact: notebookArtifactSchema.parse(artifact), ...(editVersion !== undefined ? { editVersion } : {}) };
    const snapshot = this.current.artifact;
    try {
      this.current.expected = captureNotebookRunExpectation({ name: snapshot.name, revision: snapshot.baseRevision ?? 0, cells: snapshot.cells }, "ai");
    } catch { /* Invalid bindings cannot establish execution proof; keep only the unavailable diagnostic. */ }
    return ++this.generation;
  }

  recordRun(generation: number, rawRun: NotebookRun): void {
    if (!this.current?.expected || generation !== this.generation) return;
    try {
      this.current.run = parseNotebookRunReceipt(rawRun, this.current.expected);
    } catch { /* Diagnostics never turn an unverified receipt into success, timing or a new error. */ }
  }

  snapshot(authorize: (artifact: NotebookArtifact) => void): HarnessNotebookDiagnostics | undefined {
    const current = this.current;
    if (!current || current.run?.status === "success") return undefined;
    try { authorize(current.artifact); } catch { return undefined; }
    const { artifact, run, editVersion } = current;
    const priority = { failure: 0, blocked: 1, unknown: 2, success: 3 } as const;
    const receipts = new Map(run?.cells.map((receipt) => [receipt.cellId, receipt]) ?? []);
    const candidates = artifact.cells.map((cell, index) => ({ cell, index, receipt: receipts.get(cell.id) }))
      .sort((left, right) => priority[left.receipt?.status ?? "unknown"] - priority[right.receipt?.status ?? "unknown"] || left.index - right.index);
    let remaining = MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS;
    const cells: HarnessNotebookDiagnostics["cells"] = [];
    for (const { cell, receipt } of candidates) {
      if (!remaining) break;
      const fullSource = JSON.stringify(cell, null, 2);
      let source = fullSource.slice(0, remaining);
      // Do not cut a Unicode surrogate pair in the preview.
      if (source.length < fullSource.length && /[\uD800-\uDBFF]$/u.test(source)) source = source.slice(0, -1);
      if (!source) break;
      remaining -= source.length;
      cells.push({ cellId: cell.id, kind: cell.kind, title: cell.title, status: receipt?.status ?? "unknown",
        source, sourceChars: fullSource.length, sourceTruncated: source.length < fullSource.length,
        ...(receipt?.timing ? { timing: receipt.timing } : {}) });
    }
    return harnessNotebookDiagnosticsSchema.parse({ version: 1, baseRevision: artifact.baseRevision ?? 0,
      ...(editVersion !== undefined ? { editVersion } : {}), ...(run ? { runId: run.runId } : {}),
      status: run ? "failure" : "unavailable", cells, omittedCellCount: artifact.cells.length - cells.length });
  }
}
