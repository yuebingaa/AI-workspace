import type { NotebookCell } from "./definition";
import type { NotebookTextReference } from "./text-references";
import type { NotebookCapabilityName } from "./capabilities";

type CellCatalog = {
  readonly [Kind in NotebookCell["kind"]]: {
    readonly kind: Kind;
    /** Existing draft adoption rule, not an authorization or runtime capability. */
    readonly requiresSuccessfulTrial: boolean;
    /** Optional runtime gate. Stored definitions stay valid when a gate is disabled. */
    readonly capability: NotebookCapabilityName | null;
  };
};

// Closed, compile-time catalog. Keep the existing CellSearch order; browser
// presentation order and server implementation selection are separate concerns.
export const notebookCellCatalog = {
  data: { kind: "data", requiresSuccessfulTrial: false, capability: null },
  sql: { kind: "sql", requiresSuccessfulTrial: true, capability: null },
  python: { kind: "python", requiresSuccessfulTrial: true, capability: "python" },
  warehouseSql: { kind: "warehouseSql", requiresSuccessfulTrial: true, capability: null },
  semanticQuery: { kind: "semanticQuery", requiresSuccessfulTrial: false, capability: null },
  transform: { kind: "transform", requiresSuccessfulTrial: true, capability: null },
  table: { kind: "table", requiresSuccessfulTrial: false, capability: null },
  chart: { kind: "chart", requiresSuccessfulTrial: false, capability: null },
  text: { kind: "text", requiresSuccessfulTrial: false, capability: null },
  parameter: { kind: "parameter", requiresSuccessfulTrial: true, capability: null },
} as const satisfies CellCatalog;

export const NOTEBOOK_CELL_KINDS = Object.freeze(Object.values(notebookCellCatalog).map((entry) => entry.kind));

export function requiresSuccessfulNotebookTrial(cell: Pick<NotebookCell, "kind"> & { references?: readonly NotebookTextReference[] }): boolean {
  return notebookCellCatalog[cell.kind].requiresSuccessfulTrial || (cell.kind === "text" && Boolean(cell.references?.length));
}
