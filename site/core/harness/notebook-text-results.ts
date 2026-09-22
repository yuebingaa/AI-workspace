import type { NotebookRun } from "@/core/notebook/contracts";

/** Bounded observations of an already verified run, not persisted output or a new query. */
export function notebookTextResults(run: NotebookRun) {
  const results = run.cells.filter((cell) => cell.status === "success" && cell.text !== undefined);
  if (!results.length) return {};
  return {
    textResults: results.slice(-3).map((cell) => ({ cellId: cell.cellId, text: cell.text!.slice(0, 800),
      truncated: cell.text!.length > 800, characterCount: cell.text!.length })),
    textResultsOmitted: Math.max(0, results.length - 3),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Reconcile generic budget truncation with the original, already bounded text observations.
 * Never restore removed text; preserve original length and explicitly count lost entries.
 */
export function preserveNotebookTextResultMetadata(source: unknown, compacted: unknown): unknown {
  const original = record(source), next = record(compacted);
  if (!original || !next || !Array.isArray(original.textResults)) return compacted;
  const originals = original.textResults.map(record).filter((item) => item && typeof item.cellId === "string"
    && typeof item.text === "string" && typeof item.truncated === "boolean"
    && typeof item.characterCount === "number" && Number.isSafeInteger(item.characterCount) && item.characterCount >= item.text.length);
  const byId = new Map(originals.map((item) => [item!.cellId, item!]));
  const used = new Set<string>();
  const retained = (Array.isArray(next.textResults) ? next.textResults : []).flatMap((raw) => {
    const item = record(raw);
    if (!item || typeof item.cellId !== "string" || typeof item.text !== "string" || used.has(item.cellId)) return [];
    const previous = byId.get(item.cellId);
    if (!previous || typeof previous.text !== "string") return [];
    used.add(item.cellId);
    return [{ cellId: item.cellId, text: item.text, truncated: previous.truncated === true || item.text !== previous.text,
      characterCount: previous.characterCount }];
  });
  const omitted = typeof original.textResultsOmitted === "number" && Number.isSafeInteger(original.textResultsOmitted)
    ? Math.max(0, original.textResultsOmitted) : 0;
  return { ...next, textResults: retained, textResultsOmitted: omitted + originals.length - retained.length };
}
