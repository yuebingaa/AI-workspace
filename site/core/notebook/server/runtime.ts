import type { NotebookRun } from "../contracts";
import type { NotebookExecutionDependencies, NotebookRunInput } from "../execution-contracts";
import { executeNotebook } from "./execution";
import { executeNotebookSql } from "./query-engine";
import { recordNotebookQuery } from "./query-log";
import { createNotebookPythonSession } from "./python-runtime";

export type { NotebookSource } from "../execution-contracts";

/** Existing API/Harness entry: preserve per-call overrides and shared query limits. */
export function runNotebook(input: NotebookRunInput & Partial<NotebookExecutionDependencies>): Promise<NotebookRun> {
  return executeNotebook(input, {
    query: input.query ?? executeNotebookSql,
    python: input.python ?? createNotebookPythonSession,
    log: input.log ?? recordNotebookQuery,
  });
}
