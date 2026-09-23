import type { HarnessToolName } from "@/core/harness/contracts";
import { HarnessToolArgumentsError } from "@/core/harness/tools/errors";
import { NotebookSearchStateError } from "@/core/harness/notebook-cell-search";
import { NotebookSearchError } from "@/core/notebook/search";
import { NotebookSubmissionError } from "@/core/harness/notebook-submission-error";
import { notebookSearchFailureMessage, notebookToolFailureMessage, sanitizeToolArgumentIssues,
  type NotebookSearchFailureDto, type NotebookToolFailureDto } from "../../../runtime/dsh/tool-diagnostics.mjs";

/** Recognition is server-only; callers must reauthorize before exposing the DTO. */
export function trustedNotebookSearchFailure(name: string, error: unknown): NotebookSearchFailureDto | undefined {
  if (name !== "cellSearch" || !(error instanceof NotebookSearchError || error instanceof NotebookSearchStateError)) return;
  const dto: NotebookSearchFailureDto = { error: { code: error.code } };
  return notebookSearchFailureMessage(dto, name) ? dto : undefined;
}

/** Submission rejection is diagnostic only, never a recoverable read-only search. */
export function trustedNotebookToolFailure(name: string, error: unknown): NotebookToolFailureDto | undefined {
  const searchFailure = trustedNotebookSearchFailure(name, error);
  if (searchFailure) return searchFailure;
  if (name !== "submitNotebookDraft" || !(error instanceof NotebookSubmissionError)) return;
  const dto: NotebookToolFailureDto = { error: { code: error.code } };
  return notebookToolFailureMessage(dto, name) ? dto : undefined;
}

/** Public execution diagnostics, never raw exception messages or rejected values. */
export function dshToolErrorMessage(input: {
  name: HarnessToolName;
  parameters: Record<string, unknown>;
  error: unknown;
  signal: AbortSignal;
  authorizeCurrentAccess(): void;
}): string {
  const generic = `${input.name} 执行失败。`;
  const toolFailure = trustedNotebookToolFailure(input.name, input.error);
  const argumentError = input.error instanceof HarnessToolArgumentsError && input.error.toolName === input.name ? input.error : undefined;
  if (!toolFailure && !argumentError) return generic;
  try {
    input.signal.throwIfAborted();
    input.authorizeCurrentAccess();
    input.signal.throwIfAborted();
    if (toolFailure) return notebookToolFailureMessage(toolFailure, input.name) ?? generic;
    const issues = sanitizeToolArgumentIssues(argumentError?.issueSummary, input.parameters);
    return `${input.name} 参数校验失败（invalid_tool_arguments）：${issues.map(issue => `${issue.path}: ${issue.code}`).join("；")}。请按工具定义修正参数。`;
  } catch {
    // The engine's check owns cancellation/revocation state. Diagnostics must
    // neither disclose errors from that check nor replace the original failure.
    return generic;
  }
}
