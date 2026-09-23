export interface SafeToolArgumentIssue { path: string; code: string }
export function sanitizeToolArgumentIssues(summaries: unknown, parameters: Record<string, unknown>): SafeToolArgumentIssue[];
export function toolArgumentFailureMessage(body: unknown, parameters: Record<string, unknown>): string | undefined;
export type NotebookSearchFailureCode = 'notebook_search_anchor_not_found' | 'notebook_search_anchor_required'
  | 'notebook_search_version_stale' | 'notebook_search_run_stale' | 'notebook_search_budget_exceeded';
export interface NotebookSearchFailureDto { error: { code: NotebookSearchFailureCode } }
export function notebookSearchFailureMessage(body: unknown, toolName: string): string | undefined;
export type NotebookSubmissionFailureCode = 'notebook_submit_version_stale' | 'notebook_submit_no_changes'
  | 'notebook_submit_run_required' | 'notebook_submit_receipt_mismatch';
export interface NotebookSubmissionFailureDto { error: { code: NotebookSubmissionFailureCode } }
export type NotebookToolFailureDto = NotebookSearchFailureDto | NotebookSubmissionFailureDto;
export function notebookToolFailureMessage(body: unknown, toolName: string): string | undefined;
