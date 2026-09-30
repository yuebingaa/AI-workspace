import type { DataRow, DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { NotebookDocument, NotebookRun, NotebookSqlTable, NotebookTable } from "./contracts";
import type { NotebookArtifact } from "./definition";
import type { CatalogReference } from "@/core/metadata/contracts";
import type { NotebookResultPublisher } from "./result-access";
import type { NotebookCapabilities } from "./capabilities";
import type { NotebookProgressObserver } from "./live-progress";

export interface NotebookSource { source: DataSourceDefinition; rows: DataRow[] }

/** Task-local execution input; no conversation, tool state, credentials or UI state. */
export interface NotebookDraftExecutionContext {
  revision: number;
  sources: NotebookSource[];
  semanticModels: SemanticModel[];
  taskId: string;
  signal?: AbortSignal;
  onProgress?: NotebookProgressObserver;
}

/** A caller validates the receipt and owns whether a successful draft is adopted. */
export type NotebookDraftRunner = (
  artifact: NotebookArtifact, context: NotebookDraftExecutionContext,
) => Promise<NotebookRun>;

export type NotebookRuntimeInfoReader = () => Promise<Record<string, unknown>>;

export interface NotebookPythonFile { name: string; bytes: Uint8Array }
export interface NotebookPythonResult { table: NotebookTable; stdout: string; stderr: string }
export interface NotebookPythonSession {
  execute(input: { code: string; outputName: string; tables: NotebookSqlTable[]; files: NotebookPythonFile[] }, signal: AbortSignal): Promise<NotebookPythonResult>;
  close(): Promise<void>;
}

/** A local SQL executor must retain complete/truncated result and cancellation semantics. */
export type NotebookQueryExecutor = (
  sql: string, tables: NotebookSqlTable[], signal?: AbortSignal, timeoutMs?: number,
) => Promise<NotebookTable>;

/** Connection scope and credentials are resolved by the caller, never by a cell. */
export type NotebookConnectionQuery = (connectionId: string, sql: string, signal: AbortSignal) => Promise<NotebookTable & { catalogRef?: CatalogReference }>;

export interface NotebookQueryLogEntry {
  id: string;
  taskId: string;
  userId: string;
  connectionId: string;
  cellId: string;
  startedAt: string;
  durationMs: number;
  status: string;
  sql: string;
  sourceIds: string[];
  returnedRows: number;
  truncated: boolean;
  bytesScanned: null;
  runId?: string;
  revision?: number;
  inputResultIds?: string[];
  catalogRef?: CatalogReference;
}

export interface NotebookExecutionDependencies {
  query: NotebookQueryExecutor;
  /** Optional composition port for complete upstream chart computation; never browser slices. */
  visualize?: NotebookQueryExecutor;
  python?: (signal: AbortSignal) => Promise<NotebookPythonSession>;
  /** Runtime gates are checked independently of the persisted Notebook definition. */
  capabilities?: NotebookCapabilities;
  /** Save-only, current target handoff; successful run and cleanup precede publication. */
  publishResult?: NotebookResultPublisher;
  // Synchronous by contract: a failed receipt write must still reject the run.
  log: (entry: NotebookQueryLogEntry) => void;
}

export interface NotebookRunInput {
  document: NotebookDocument;
  sources: NotebookSource[];
  semanticModels?: SemanticModel[];
  targetCellId?: string;
  signal?: AbortSignal;
  forAi?: boolean;
  userId?: string;
  taskId?: string;
  connectionQuery?: NotebookConnectionQuery;
  pythonFiles?: NotebookPythonFile[];
  onProgress?: NotebookProgressObserver;
}
