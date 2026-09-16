import type { DataRow, DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { NotebookDocument, NotebookSqlTable, NotebookTable } from "./contracts";
import type { CatalogReference } from "@/core/metadata/contracts";

export interface NotebookSource { source: DataSourceDefinition; rows: DataRow[] }

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
  python?: (signal: AbortSignal) => Promise<NotebookPythonSession>;
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
}
