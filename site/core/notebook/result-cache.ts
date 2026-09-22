import type { NotebookCellRun, NotebookDocument } from "./contracts";
import { cellDependencies, cellsToRun } from "./graph";
import type { NotebookRunIdentity } from "./result-availability";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "./run-receipt";

/** Direct-input evidence only. No previous tables, global ID history or server
 * cache. Optional fields keep legacy no-reference receipts usable in their run. */
export interface NotebookInputWitness {
  readonly cellId: string;
  readonly runId: string;
  readonly resultId?: string;
  readonly dataSignature?: string;
  readonly complete?: boolean;
}
export interface NotebookCachedResult {
  result: NotebookCellRun;
  fingerprint: string;
  identity: NotebookRunIdentity;
  inputs: readonly NotebookInputWitness[];
  invalidated?: true;
}
export type NotebookResultCache = Readonly<Record<string, NotebookCachedResult>>;

/** Capture identity and input evidence from one fully matched response, before
 * combining it with other runs. The caller supplies the submitted definition's
 * fingerprint, including its source policies and attached-file metadata. */
export function cacheNotebookRun(
  document: NotebookDocument,
  rawRun: unknown,
  fingerprint: (cellId: string) => string,
  targetCellId?: string,
): Record<string, NotebookCachedResult> {
  const expected = captureNotebookRunExpectation(document, "user", targetCellId);
  const run = parseNotebookRunReceipt(rawRun, expected);
  const definitions = new Map(cellsToRun(document, targetCellId).map((cell) => [cell.id, cell]));
  const results = new Map(run.cells.map((result) => [result.cellId, result]));
  const identity: NotebookRunIdentity = { runId: run.runId, revision: run.revision, accessMode: "user" };
  return Object.fromEntries(run.cells.map((result) => {
    const ids = cellDependencies(definitions.get(result.cellId)!);
    const inputs = ids.map((cellId): NotebookInputWitness => {
      const input = results.get(cellId)!;
      if (result.status === "success" && input.status !== "success") throw new Error("成功结果缺少本次成功的上游回执");
      return { cellId, runId: run.runId, ...(input.resultRef ? {
        resultId: input.resultRef.resultId, dataSignature: input.resultRef.dataSignature, complete: input.resultRef.complete,
      } : {}) };
    });
    if (result.resultRef && (inputs.some((input) => !input.resultId)
      || JSON.stringify(result.resultRef.inputResultIds) !== JSON.stringify(inputs.map((input) => input.resultId)))) {
      throw new Error("结果输入引用与本次运行的依赖不一致");
    }
    return [result.cellId, { result, fingerprint: fingerprint(result.cellId), identity: { ...identity }, inputs }];
  }));
}

export function invalidateNotebookCachedResults(cache: NotebookResultCache, cellIds: readonly string[]): Record<string, NotebookCachedResult> {
  const invalidated = new Set(cellIds);
  return Object.fromEntries(Object.entries(cache).map(([id, result]) => [id, invalidated.has(id) ? { ...result, invalidated: true as const } : result]));
}

export interface NotebookFreshnessContext {
  fingerprint: (cellId: string) => string;
  isExpired?: (cellId: string) => boolean;
}

/** Definition freshness and input-content equivalence, not a promise that an
 * external database has not changed since this result was computed. A new run ID
 * can replace an unchanged full-table input; a same-looking preview cannot. */
export function isNotebookCachedResultFresh(cellId: string, cache: NotebookResultCache, context: NotebookFreshnessContext): boolean {
  const checked = new Map<string, boolean>();
  const checking = new Set<string>();
  const lookup = (id: string) => Object.hasOwn(cache, id) ? cache[id] : undefined;
  function fresh(id: string): boolean {
    if (checked.has(id)) return checked.get(id)!;
    if (checking.has(id)) return false;
    checking.add(id);
    let valid = false;
    try {
      const current = lookup(id);
      if (!current || current.invalidated || current.result.cellId !== id || context.isExpired?.(id)
        || current.fingerprint !== context.fingerprint(id)) return false;
      const ownReference = current.result.resultRef;
      if (ownReference && (ownReference.cellId !== id || ownReference.runId !== current.identity.runId
        || ownReference.revision !== current.identity.revision || ownReference.accessMode !== current.identity.accessMode)) return false;
      // Current errors must remain displayable, never usable as successful input.
      if (current.result.status !== "success") { valid = true; return true; }
      valid = current.inputs.every((input) => {
        const dependency = lookup(input.cellId);
        if (!dependency || dependency.result.status !== "success" || !fresh(input.cellId)
          || dependency.identity.accessMode !== current.identity.accessMode) return false;
        const reference = dependency.result.resultRef;
        if (input.runId === dependency.identity.runId && input.resultId === reference?.resultId
          && input.dataSignature === reference?.dataSignature && input.complete === reference?.complete) return true;
        return input.complete === true && reference?.complete === true
          && typeof input.dataSignature === "string" && /^[a-f0-9]{64}$/u.test(input.dataSignature)
          && input.dataSignature === reference.dataSignature;
      });
      return valid;
    } catch { return false; }
    finally { checking.delete(id); checked.set(id, valid); }
  }
  return fresh(cellId);
}
