import type { NotebookCell } from "./definition";
import { affectedCells, cellDependencies } from "./graph";

export interface NotebookOutputReference {
  readonly cellId: string;
  readonly title: string;
  readonly kind: NotebookCell["kind"];
}

export interface NotebookOutputCodeCheck extends NotebookOutputReference {
  readonly kind: "sql" | "python";
  readonly reason: "input-name" | "python-output";
}

export interface NotebookOutputRename {
  readonly cellId: string;
  readonly title: string;
  readonly previousName: string;
  readonly nextName: string;
  readonly preservedReferences: readonly NotebookOutputReference[];
  readonly codeChecks: readonly NotebookOutputCodeCheck[];
  readonly affectedCellIds: readonly string[];
}

/**
 * Explain an edit using declared cell IDs, never by interpreting source text.
 * Callers still validate the entire final document before committing it. This
 * analysis neither changes cells nor certifies that free SQL/Python is correct.
 */
export function analyzeNotebookOutputRenames(
  previousCells: readonly NotebookCell[],
  nextCells: readonly NotebookCell[],
): NotebookOutputRename[] {
  const previousById = new Map(previousCells.map((cell) => [cell.id, cell]));
  const renames: NotebookOutputRename[] = [];
  for (const cell of nextCells) {
    const previous = previousById.get(cell.id);
    if (!previous || !("outputName" in previous) || !("outputName" in cell)
      || previous.outputName === cell.outputName) continue;

    const references = nextCells.filter((consumer) => cellDependencies(consumer).includes(cell.id));
    const preservedReferences = references.filter((consumer) => {
      const original = previousById.get(consumer.id);
      return original && cellDependencies(original).includes(cell.id);
    }).map((consumer) => ({ cellId: consumer.id, title: consumer.title, kind: consumer.kind }));

    // Even code edited in the same batch requires review. An output rename in
    // Python also changes the variable the runtime expects that cell to assign.
    const codeChecks: NotebookOutputCodeCheck[] = [];
    for (const candidate of nextCells) {
      if (candidate.id === cell.id && candidate.kind === "python") {
        codeChecks.push({ cellId: candidate.id, title: candidate.title, kind: "python", reason: "python-output" });
      }
      if ((candidate.kind === "sql" || candidate.kind === "python") && candidate.inputCellIds.includes(cell.id)) {
        codeChecks.push({ cellId: candidate.id, title: candidate.title, kind: candidate.kind, reason: "input-name" });
      }
    }
    const affected = affectedCells([...nextCells], [cell.id]);
    renames.push({
      cellId: cell.id, title: cell.title, previousName: previous.outputName, nextName: cell.outputName,
      preservedReferences, codeChecks,
      affectedCellIds: nextCells.filter((candidate) => affected.has(candidate.id)).map((candidate) => candidate.id),
    });
  }
  return renames;
}
