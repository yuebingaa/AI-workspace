import { NOTEBOOK_LIMITS } from "@/core/notebook/contracts";
import { DEFAULT_HARNESS_LIMITS, type HarnessToolName } from "./contracts";

// A Notebook run owns its 30 s execution deadline. Leave bounded room for
// validation, receipt serialization and closing the isolated Python session.
export const NOTEBOOK_TOOL_TIMEOUT_MS = NOTEBOOK_LIMITS.runTimeoutMs + 5_000;

export function harnessToolTimeoutMs(name: HarnessToolName, explicitLimitMs?: number): number {
  const normalLimit = name === "runNotebookCells" || name === "createNotebookDraft"
    ? NOTEBOOK_TOOL_TIMEOUT_MS : DEFAULT_HARNESS_LIMITS.toolCallTimeoutMs;
  return explicitLimitMs === undefined ? normalLimit : Math.min(normalLimit, explicitLimitMs);
}
