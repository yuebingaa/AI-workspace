import { z } from "zod";
import { NOTEBOOK_CELL_KINDS } from "@/core/notebook/cell-catalog";
import { pythonCellSchema, type NotebookCell } from "@/core/notebook/definition";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { PROJECT_FORMAT, projectManifestSchema } from "../contracts";
import { PROJECT_INSPECTION_LIMITS, projectInspectionSchema, type ProjectInspection } from "../inspection";

const knownKinds = new Set<string>(NOTEBOOK_CELL_KINDS);
const identitySchema = pythonCellSchema.pick({ id: true, title: true });
const displayKindSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new Error("项目定义无法安全生成只读预览"); }

function sourceOf(cell: NotebookCell): { language: "sql" | "python" | "markdown"; text: string } | null {
  if (cell.kind === "sql" || cell.kind === "warehouseSql") return { language: "sql", text: cell.sql };
  if (cell.kind === "python") return { language: "python", text: cell.code };
  if (cell.kind === "text") return { language: "markdown", text: cell.markdown };
  return null;
}

/**
 * Only the current formal Notebook layer can contain opaque, unknown cells.
 * A private validation copy substitutes inert text sentinels, so the original
 * strict manifest schema still checks every other field, known cell and history.
 * Neither this copy nor unknown payloads leave this function or become runnable.
 */
export function inspectProjectManifest(value: unknown): ProjectInspection {
  if (!record(value) || value.format !== PROJECT_FORMAT) invalid();
  let validationInput = value;
  const unsupported = new Map<string, Map<number, { id: string; title: string; kind?: string }>>();
  if (record(value.state)) {
    const state = value.state;
    if (typeof state.version !== "number" || !Number.isInteger(state.version) || state.version > STUDIO_STORAGE_VERSION) invalid();
    if (record(state.dataProduct) && state.dataProduct.notebooks !== undefined) {
      if (!record(state.dataProduct.notebooks)) invalid();
      const books = Object.entries(state.dataProduct.notebooks);
      if (books.length > PROJECT_INSPECTION_LIMITS.notebooks) invalid();
      const validationBooks = Object.fromEntries(books.map(([key, book]) => {
        if (!record(book) || !Array.isArray(book.cells) || book.cells.length > PROJECT_INSPECTION_LIMITS.cells) invalid();
        // Check opaque payload bytes before replacing anything for validation.
        if (new TextEncoder().encode(JSON.stringify(book)).byteLength > PROJECT_INSPECTION_LIMITS.notebookBytes) invalid();
        const unknownCells = new Map<number, { id: string; title: string; kind?: string }>();
        const cells = book.cells.map((cell: unknown, index) => {
          if (!record(cell) || typeof cell.kind !== "string" || !cell.kind.trim()) invalid();
          if (knownKinds.has(cell.kind)) return cell;
          if (state.version !== STUDIO_STORAGE_VERSION) invalid();
          const identity = identitySchema.parse({ id: cell.id, title: cell.title });
          const displayKind = displayKindSchema.safeParse(cell.kind);
          unknownCells.set(index, { ...identity, ...(displayKind.success ? { kind: displayKind.data } : {}) });
          return { ...identity, kind: "text", markdown: "Unsupported cell; validation sentinel only." };
        });
        unsupported.set(key, unknownCells);
        return [key, { ...book, cells }];
      }));
      validationInput = { ...value, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: validationBooks } } };
    }
  }
  const manifest = projectManifestSchema.parse(validationInput);
  let remainingSourceCharacters = PROJECT_INSPECTION_LIMITS.totalSourceCharacters;
  let unknownCellCount = 0, omittedSourceCount = 0;
  const notebooks = Object.entries(manifest.state?.dataProduct.notebooks ?? {}).map(([key, book], bookIndex) => ({
    index: bookIndex + 1,
    name: book.name,
    revision: book.revision,
    cells: book.cells.map((cell, cellIndex): ProjectInspection["notebooks"][number]["cells"][number] => {
      const identity = unsupported.get(key)?.get(cellIndex);
      if (identity) {
        unknownCellCount += 1;
        return { index: cellIndex + 1, ...identity, support: "unknown" };
      }
      const base = { index: cellIndex + 1, id: cell.id, title: cell.title, support: "known" as const, kind: cell.kind };
      const source = sourceOf(cell);
      if (!source) return base;
      if (!remainingSourceCharacters) { omittedSourceCount += 1; return base; }
      const text = source.text.slice(0, Math.min(PROJECT_INSPECTION_LIMITS.sourceCharacters, remainingSourceCharacters));
      remainingSourceCharacters -= text.length;
      return { ...base, source: { language: source.language, text, truncated: text.length < source.text.length } };
    }),
  }));
  return projectInspectionSchema.parse({
    mode: "read-only",
    project: { name: manifest.name, updatedAt: manifest.updatedAt, stateRevision: manifest.stateRevision },
    notebooks, unknownCellCount, omittedSourceCount,
  });
}
